import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactService } from "@gpt-dev/artifact-service";
import { WorkspaceDatabase } from "@gpt-dev/persistence";
import { ProjectService } from "@gpt-dev/projects";
import { HostProcessRunner } from "@gpt-dev/sandbox-runner";
import { TaskService } from "@gpt-dev/task-service";
import { WorkspaceService } from "@gpt-dev/workspace-service";
import { createElectronEnvironment, resolveTaskCheckPreset } from "./execution-policy.js";

const roots: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolvePromise(stdout.trimEnd())
      : reject(new Error(stderr.trim() || `git exited ${String(code)}`)));
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("disposable attached native acceptance", () => {
  it("isolates host state, indexes screenshot/trace/log artifacts, and closes without changing Git history or original dirt", async () => {
    const root = await mkdtemp(join(tmpdir(), "gptdev-native-acceptance-"));
    roots.push(root);
    const repo = join(root, "project");
    const sibling = join(root, "sibling");
    const artifactRoot = join(root, "artifacts");
    await mkdir(repo);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Fixture User"]);
    await git(repo, ["config", "user.email", "fixture@example.com"]);
    await writeFile(join(repo, "tracked.txt"), "base\n");
    await writeFile(join(repo, "acceptance.mjs"), `
      import { mkdirSync, writeFileSync } from "node:fs";
      for (const key of ["GPTDEV_SCREENSHOTS_DIR","GPTDEV_TRACES_DIR","GPTDEV_LOGS_DIR"]) mkdirSync(process.env[key], { recursive: true });
      writeFileSync(process.env.GPTDEV_SCREENSHOTS_DIR + "/window.png", "png");
      writeFileSync(process.env.GPTDEV_TRACES_DIR + "/native-trace.zip", "trace");
      writeFileSync(process.env.GPTDEV_LOGS_DIR + "/acceptance.log", JSON.stringify({
        home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, cache: process.env.XDG_CACHE_HOME,
        data: process.env.XDG_DATA_HOME, temp: process.env.TMPDIR, userData: process.env.ELECTRON_USER_DATA_DIR
      }));
    `);
    await writeFile(join(repo, "package.json"), JSON.stringify({
      gptdev: { electronAcceptance: ["node", "acceptance.mjs"] }
    }));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    await git(repo, ["worktree", "add", "-b", "sibling", sibling]);
    await writeFile(join(repo, "tracked.txt"), "dirty before attach\n");
    await writeFile(join(repo, "untracked.txt"), "keep me\n");

    const database = new WorkspaceDatabase(join(root, "state", "app.db"));
    const projects = new ProjectService(database, root);
    const project = projects.register({
      id: "native-fixture", canonicalPath: repo, defaultBranch: "main", runtime: "node"
    });
    const artifacts = new ArtifactService(database, artifactRoot);
    const host = new HostProcessRunner();
    const tasks = new TaskService(database, host, artifacts, host);
    const workspaces = new WorkspaceService(database, artifactRoot, {
      perFileBytes: 1_000_000, totalBytes: 5_000_000, gitOutputBytes: 5_000_000
    }, (workspaceId) => tasks.cancelWorkspace(workspaceId));
    const attached = await workspaces.attach({
      project, expectedBranch: "main", preserveDirtyState: true, allowHostExecution: true
    });
    const headBefore = await git(repo, ["rev-parse", "HEAD"]);
    const command = await resolveTaskCheckPreset(repo, "electron-acceptance");
    const executionId = crypto.randomUUID();
    const executionArtifacts = await artifacts.taskDirectory(executionId);
    const env = await createElectronEnvironment(executionArtifacts);
    const execution = await tasks.start({
      executionId, worktreeId: attached.taskId, projectId: project.id, worktreePath: repo,
      image: "host", mode: "host", executable: command.executable, args: command.args,
      network: "none", env,
      limits: { memory: "1g", cpus: 1, pids: 64, timeoutSeconds: 30, maxOutputBytes: 65_536 }
    });
    for (let index = 0; index < 200 && !new Set(["succeeded", "failed", "cancelled", "timed_out"]).has(tasks.get(execution.id).status); index += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(tasks.get(execution.id).status).toBe("succeeded");
    expect(artifacts.list(execution.id).map((entry) => entry.relativePath)).toEqual(expect.arrayContaining([
      "screenshots/window.png", "traces/native-trace.zip", "logs/acceptance.log"
    ]));
    expect(workspaces.listArtifacts(attached.taskId).map((entry) => entry.relativePath)).toEqual(expect.arrayContaining([
      `executions/${execution.id}/screenshots/window.png`,
      `executions/${execution.id}/traces/native-trace.zip`,
      `executions/${execution.id}/logs/acceptance.log`
    ]));
    const environment = JSON.parse(await readFile(join(executionArtifacts, "logs", "acceptance.log"), "utf8")) as Record<string, string>;
    for (const path of Object.values(environment)) expect(path.startsWith(`${executionArtifacts}/`)).toBe(true);

    await writeFile(join(repo, "task-edit.txt"), "task output\n");
    const statusBeforeClose = await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    await workspaces.close(project.id, attached.taskId);
    expect(await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(statusBeforeClose);
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await git(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    database.close();
  }, 30_000);
});
