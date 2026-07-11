import { createReadStream } from "node:fs";
import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { resolveContained } from "@gpt-dev/projects";
import { WorkspaceError } from "@gpt-dev/schemas";

const PROJECT_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const HANDOFF_FILE = /^([a-f0-9-]{36})--([a-z0-9][a-z0-9._-]{1,63})\.bundle$/;

async function command(executable: string, args: string[], options: { cwd?: string; stdinFile?: string; maxBytes?: number } = {}): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: [options.stdinFile ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    const maxBytes = options.maxBytes ?? 1_000_000;
    let stdout = "";
    let stderr = "";
    let inputError: Error | undefined;
    if (!child.stdout || !child.stderr) {
      reject(new WorkspaceError("INTERNAL", "Failed to capture command output"));
      return;
    }
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < maxBytes) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < maxBytes) stderr += chunk; });
    child.on("error", reject);
    if (options.stdinFile && child.stdin) {
      void pipeline(createReadStream(options.stdinFile), child.stdin).catch((error: unknown) => {
        inputError = error instanceof Error ? error : new Error(String(error));
        child.kill("SIGKILL");
      });
    }
    child.on("close", (code) => {
      if (inputError) reject(inputError);
      else if (code === 0) resolvePromise(stdout.trim());
      else reject(new WorkspaceError("EXECUTION_FAILED", stderr.trim() || `${basename(executable)} exited ${String(code)}`));
    });
  });
}

export interface HandoffSenderOptions {
  outboxDir: string;
  sshTarget: string;
  sshKeyPath: string;
  knownHostsPath: string;
  maxBytes: number;
}

export interface SentHandoff {
  handoffId: string;
  projectId: string;
  branch: string;
  commit: string;
  bytes: number;
}

export class HandoffSender {
  constructor(private readonly options: HandoffSenderOptions) {}

  async send(projectId: string, worktreePath: string): Promise<SentHandoff> {
    if (!PROJECT_ID.test(projectId)) throw new WorkspaceError("VALIDATION", "Invalid project ID");
    const status = await command("git", ["status", "--porcelain"], { cwd: worktreePath });
    if (status) throw new WorkspaceError("CONFLICT", "Commit the task worktree before handing it to Hetzner");
    const branch = await command("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: worktreePath });
    if (!branch) throw new WorkspaceError("CONFLICT", "Handoff requires a named Git branch");
    const commit = await command("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    const handoffId = randomUUID();
    await mkdir(this.options.outboxDir, { recursive: true, mode: 0o700 });
    const bundlePath = resolve(this.options.outboxDir, `${handoffId}--${projectId}.bundle`);
    await command("git", ["bundle", "create", bundlePath, branch], { cwd: worktreePath });
    const info = await stat(bundlePath);
    if (info.size > this.options.maxBytes) {
      await rm(bundlePath, { force: true });
      throw new WorkspaceError("VALIDATION", `Handoff exceeds ${this.options.maxBytes} bytes`);
    }
    try {
      await command("/usr/bin/ssh", [
        "-i", this.options.sshKeyPath,
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${this.options.knownHostsPath}`,
        this.options.sshTarget,
        `upload ${handoffId} ${projectId}`
      ], { stdinFile: bundlePath });
      return { handoffId, projectId, branch, commit, bytes: info.size };
    } finally {
      await rm(bundlePath, { force: true });
    }
  }
}

export interface InboxHandoff {
  handoffId: string;
  projectId: string;
  branch: string;
  commit: string;
  bytes: number;
  receivedAt: string;
}

export class HandoffInbox {
  constructor(private readonly inboxDir: string, private readonly workspaceRoot: string) {}

  private async describe(filename: string): Promise<InboxHandoff | undefined> {
    const match = HANDOFF_FILE.exec(filename);
    if (!match) return undefined;
    const handoffId = match[1];
    const projectId = match[2];
    if (!handoffId || !projectId) return undefined;
    const path = await resolveContained(this.inboxDir, filename);
    const heads = await command("git", ["bundle", "list-heads", path]);
    const line = heads.split("\n").find((value) => value.includes(" refs/heads/"));
    if (!line) throw new WorkspaceError("VALIDATION", `Handoff ${handoffId} has no branch head`);
    const [commit, ref] = line.split(/\s+/, 2);
    if (!commit || !ref?.startsWith("refs/heads/")) throw new WorkspaceError("VALIDATION", "Invalid handoff reference");
    const info = await stat(path);
    return { handoffId, projectId, branch: ref.slice("refs/heads/".length), commit, bytes: info.size, receivedAt: info.mtime.toISOString() };
  }

  async list(): Promise<InboxHandoff[]> {
    await mkdir(this.inboxDir, { recursive: true, mode: 0o750 });
    const items: InboxHandoff[] = [];
    for (const filename of await readdir(this.inboxDir)) {
      const described = await this.describe(filename);
      if (described) items.push(described);
    }
    return items.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  }

  async import(handoffId: string): Promise<InboxHandoff & { registeredProjectId: string; path: string }> {
    const handoff = (await this.list()).find((item) => item.handoffId === handoffId);
    if (!handoff) throw new WorkspaceError("NOT_FOUND", "Handoff not found");
    const filename = `${handoff.handoffId}--${handoff.projectId}.bundle`;
    const bundlePath = await resolveContained(this.inboxDir, filename);
    const registeredProjectId = `${handoff.projectId.slice(0, 54)}-${handoff.handoffId.slice(0, 8)}`;
    const importsRoot = resolve(this.workspaceRoot, "handoffs");
    await mkdir(importsRoot, { recursive: true, mode: 0o750 });
    const destination = resolve(importsRoot, registeredProjectId);
    await resolveContained(this.workspaceRoot, "handoffs");
    try {
      await stat(destination);
      throw new WorkspaceError("CONFLICT", "Handoff was already imported");
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
    }
    await command("git", ["clone", "--branch", handoff.branch, "--single-branch", bundlePath, destination]);
    const importedReal = await realpath(destination);
    const archivePath = resolve(this.inboxDir, ".imported", filename);
    await mkdir(resolve(this.inboxDir, ".imported"), { recursive: true, mode: 0o750 });
    await rename(bundlePath, archivePath);
    return { ...handoff, registeredProjectId, path: importedReal };
  }
}
