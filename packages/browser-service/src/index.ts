import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { redactSecrets } from "@gpt-dev/audit-service";
import type { WorkspaceDatabase } from "@gpt-dev/persistence";
import { WorkspaceError } from "@gpt-dev/schemas";
import { z } from "zod/v4";

export const BrowserAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url() }),
  z.object({ type: z.literal("click"), selector: z.string().min(1).max(512) }),
  z.object({ type: z.literal("fill"), selector: z.string().min(1).max(512), value: z.string().max(4096) }),
  z.object({ type: z.literal("press"), selector: z.string().min(1).max(512), key: z.string().min(1).max(64) }),
  z.object({ type: z.literal("wait"), milliseconds: z.number().int().min(0).max(30_000) }),
  z.object({ type: z.literal("screenshot"), name: z.string().regex(/^[a-zA-Z0-9._-]+\.png$/) })
]);

export type BrowserAction = z.infer<typeof BrowserAction>;

function assertAllowedUrl(value: string, allowedHosts: Set<string>): void {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new WorkspaceError("FORBIDDEN", "Only HTTP(S) browser navigation is allowed");
  if (!allowedHosts.has(url.hostname)) throw new WorkspaceError("FORBIDDEN", `Browser host is not approved: ${url.hostname}`);
  if (url.username || url.password) throw new WorkspaceError("FORBIDDEN", "Credentials in browser URLs are forbidden");
}

export class BrowserService {
  async createScript(artifactDirectory: string, actions: BrowserAction[], allowedHosts: string[]): Promise<string> {
    if (actions.length > 100) throw new WorkspaceError("VALIDATION", "Too many browser actions");
    const hosts = new Set(allowedHosts);
    for (const action of actions) if (action.type === "navigate") assertAllowedUrl(action.url, hosts);
    const serialized = JSON.stringify(actions);
    const script = `
import { chromium } from '/usr/lib/node_modules/playwright/index.mjs';
import { writeFile } from 'node:fs/promises';
const actions = ${serialized};
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const events = { console: [], pageErrors: [], failedRequests: [], responses: [] };
page.on('console', m => events.console.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => events.pageErrors.push(String(e)));
page.on('requestfailed', r => events.failedRequests.push({ url: r.url(), error: r.failure()?.errorText }));
page.on('response', r => { if (r.status() >= 400) events.responses.push({ url: r.url(), status: r.status() }); });
await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
for (const action of actions) {
  if (action.type === 'navigate') await page.goto(action.url, { waitUntil: 'networkidle', timeout: 30000 });
  else if (action.type === 'click') await page.locator(action.selector).click();
  else if (action.type === 'fill') await page.locator(action.selector).fill(action.value);
  else if (action.type === 'press') await page.locator(action.selector).press(action.key);
  else if (action.type === 'wait') await page.waitForTimeout(action.milliseconds);
  else if (action.type === 'screenshot') await page.screenshot({ path: '/artifacts/' + action.name, fullPage: true });
}
await page.context().tracing.stop({ path: '/artifacts/trace.zip' });
await writeFile('/artifacts/browser-events.json', JSON.stringify(events, null, 2));
await browser.close();
`;
    const path = resolve(artifactDirectory, "browser-check.mjs");
    await writeFile(path, script, { encoding: "utf8", mode: 0o640 });
    return path;
  }
}

export interface DevServerRecord {
  id: string;
  projectId: string;
  worktreeId: string;
  containerId: string;
  networkName: string;
  port: number;
  status: "starting" | "ready" | "stopped" | "failed";
  createdAt: string;
  stoppedAt?: string;
}

async function docker(args: string[], allowFailure = false): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) resolvePromise(stdout.trim());
      else reject(new WorkspaceError("EXECUTION_FAILED", redactSecrets(stderr.trim() || `docker exited ${String(code)}`)));
    });
  });
}

async function dockerSucceeds(args: string[]): Promise<boolean> {
  return await new Promise((resolvePromise) => {
    const child = spawn("docker", args, { stdio: "ignore" });
    child.on("error", () => resolvePromise(false));
    child.on("close", (code) => resolvePromise(code === 0));
  });
}

export class DevServerService {
  constructor(private readonly database: WorkspaceDatabase) {}

  async start(input: {
    projectId: string; worktreeId: string; worktreePath: string; image: string;
    executable: string; args: string[]; port: number;
  }): Promise<DevServerRecord> {
    const existing = this.database.db.prepare("SELECT id FROM dev_servers WHERE worktree_id=? AND status IN ('starting','ready') LIMIT 1").get(input.worktreeId) as { id: string } | undefined;
    if (existing) throw new WorkspaceError("CONFLICT", `Worktree already has active dev server: ${existing.id}`);
    const id = randomUUID();
    const networkName = `gptdev-preview-${input.worktreeId}`;
    const name = `gptdev-dev-${input.worktreeId}`;
    const workspace = await stat(input.worktreePath);
    await docker(["network", "create", "--internal", networkName], true);
    await docker(["rm", "--force", name], true);
    const containerId = await docker([
      "run", "--detach", "--name", name,
      "--network", networkName, "--network-alias", "workspace.test",
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--memory", "1g", "--cpus", "1", "--pids-limit", "128",
      "--user", `${workspace.uid}:${workspace.gid}`, "--env", "HOME=/tmp", "--env", `PORT=${input.port}`,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--workdir", "/workspace",
      "--mount", `type=bind,source=${input.worktreePath},target=/workspace`,
      input.image, input.executable, ...input.args
    ]);
    const record: DevServerRecord = {
      id, projectId: input.projectId, worktreeId: input.worktreeId, containerId, networkName,
      port: input.port, status: "starting", createdAt: new Date().toISOString()
    };
    this.database.db.prepare(`
      INSERT INTO dev_servers (id, project_id, worktree_id, container_id, network_name, port, status, created_at)
      VALUES (@id,@projectId,@worktreeId,@containerId,@networkName,@port,@status,@createdAt)
    `).run(record);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const ready = await dockerSucceeds(["exec", containerId, "node", "-e", `fetch('http://127.0.0.1:${input.port}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`]);
      const running = await docker(["inspect", "--format", "{{.State.Running}}", containerId], true);
      if (running.trim() !== "true") break;
      if (ready) {
        this.database.db.prepare("UPDATE dev_servers SET status='ready' WHERE id=?").run(id);
        return this.get(id);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    const logs = await docker(["logs", "--tail", "100", containerId], true);
    this.database.db.prepare("UPDATE dev_servers SET status='failed' WHERE id=?").run(id);
    throw new WorkspaceError("EXECUTION_FAILED", `Development server did not become ready: ${redactSecrets(logs)}`);
  }

  get(id: string): DevServerRecord {
    const row = this.database.db.prepare(`
      SELECT id, project_id AS projectId, worktree_id AS worktreeId, container_id AS containerId,
        network_name AS networkName, port, status, created_at AS createdAt, stopped_at AS stoppedAt
      FROM dev_servers WHERE id=?
    `).get(id) as DevServerRecord | undefined;
    if (!row) throw new WorkspaceError("NOT_FOUND", `Unknown dev server: ${id}`);
    return row;
  }

  async stop(id: string): Promise<DevServerRecord> {
    const record = this.get(id);
    await docker(["rm", "--force", record.containerId], true);
    await docker(["network", "rm", record.networkName], true);
    this.database.db.prepare("UPDATE dev_servers SET status='stopped', stopped_at=? WHERE id=?").run(new Date().toISOString(), id);
    return this.get(id);
  }
}
