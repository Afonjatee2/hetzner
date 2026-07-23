import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceDatabase } from "@gpt-dev/persistence";
import { ProjectService } from "@gpt-dev/projects";
import { NEW_FILE_SHA256, WorkspaceService, type WorkspaceManifest } from "./index.js";

const temporaryDirectories: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
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

interface Fixture {
  root: string;
  repo: string;
  sibling: string;
  artifacts: string;
  databasePath: string;
  database: WorkspaceDatabase;
  projects: ProjectService;
  workspaces: WorkspaceService;
}

async function fixture(limits = { perFileBytes: 1_000_000, totalBytes: 5_000_000, gitOutputBytes: 5_000_000 }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "gptdev-attached-fixture-"));
  temporaryDirectories.push(root);
  const repo = join(root, "project");
  const sibling = join(root, "sibling");
  const artifacts = join(root, "artifacts");
  const databasePath = join(root, "state", "app.db");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Fixture User"]);
  await git(repo, ["config", "user.email", "fixture@example.com"]);
  await writeFile(join(repo, "tracked.txt"), "base tracked\n");
  await writeFile(join(repo, "clean.txt"), "base clean\n");
  await writeFile(join(repo, "delete-me.txt"), "delete later\n");
  await writeFile(join(repo, "script.sh"), "#!/bin/sh\necho ok\n");
  await writeFile(join(repo, "package.json"), JSON.stringify({
    scripts: { lint: "echo lint", typecheck: "echo types", test: "echo tests" },
    gptdev: { electronAcceptance: ["node", "acceptance.mjs"] }
  }));
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["worktree", "add", "-b", "sibling", sibling]);
  await writeFile(join(repo, "tracked.txt"), "dirty before attach\n");
  await writeFile(join(repo, "untracked.txt"), "local untracked\n");
  await writeFile(join(repo, "staged.txt"), "staged before attach\n");
  await git(repo, ["add", "staged.txt"]);

  const database = new WorkspaceDatabase(databasePath);
  const projects = new ProjectService(database, root);
  projects.register({ id: "fixture", canonicalPath: repo, defaultBranch: "main", runtime: "node" });
  const workspaces = new WorkspaceService(database, artifacts, limits);
  return { root, repo, sibling, artifacts, databasePath, database, projects, workspaces };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WorkspaceService attached checkout lifecycle", () => {
  it("captures complete dirty state, sibling identity, capabilities, and survives restart", async () => {
    const value = await fixture();
    await git(value.repo, ["mv", "clean.txt", "renamed-clean.txt"]);
    const statusBefore = await git(value.repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    const attached = await value.workspaces.attach({
      project: value.projects.get("fixture"),
      expectedBranch: "main",
      preserveDirtyState: true
    });

    expect(attached.kind).toBe("attached");
    expect(attached.path).toBe(await realpath(value.repo));
    expect(attached.originalBranch).toBe("main");
    expect(attached.originalHead).toBe(await git(value.repo, ["rev-parse", "HEAD"]));
    expect(attached.siblingWorktrees).toEqual([await realpath(value.sibling)]);
    expect(attached.capabilities).toMatchObject({
      read: true, write: true, delete: true,
      runContainerCommands: true, runHostCommands: false,
      commit: false, push: false, publish: false, merge: false, rollback: false
    });
    const manifest = JSON.parse(await readFile(attached.baselineManifestPath!, "utf8")) as WorkspaceManifest;
    expect(Buffer.from(manifest.statusPorcelainV2Base64, "base64").toString("utf8")).toBe(statusBefore);
    expect(manifest.stagedDiff).toContain("staged.txt");
    expect(manifest.unstagedDiff).toContain("dirty before attach");
    const dirtyTracked = manifest.entries.find((entry) => entry.path === "tracked.txt");
    expect(Buffer.from(dirtyTracked?.contentBase64 ?? "", "base64").toString("utf8")).toBe("dirty before attach\n");
    expect(manifest.entries.find((entry) => entry.path === "tracked.txt")?.status).toBe(".M");
    expect(manifest.entries.find((entry) => entry.path === "staged.txt")?.status).toBe("A.");
    expect(manifest.entries.find((entry) => entry.path === "untracked.txt")?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.entries.find((entry) => entry.path === "clean.txt")?.type).toBe("deleted");
    expect(manifest.entries.find((entry) => entry.path === "renamed-clean.txt")?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.inventory.find((entry) => entry.path === "renamed-clean.txt")?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => value.workspaces.requireCapability("fixture", attached.taskId, "runHostCommands"))
      .toThrow(/not permitted/);
    expect(await git(value.repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(statusBefore);

    value.database.close();
    const restartedDatabase = new WorkspaceDatabase(value.databasePath);
    const restarted = new WorkspaceService(restartedDatabase, value.artifacts, {
      perFileBytes: 1_000_000, totalBytes: 5_000_000, gitOutputBytes: 5_000_000
    });
    expect(restarted.get("fixture", attached.taskId)).toMatchObject({
      kind: "attached", originalBranch: "main", status: "active"
    });
    restartedDatabase.close();
  }, 20_000);

  it("rejects wrong branch, detached HEAD, duplicate ownership, oversized dirt, and escaping symlinks", async () => {
    const value = await fixture();
    await expect(value.workspaces.attach({
      project: value.projects.get("fixture"), expectedBranch: "wrong",
      preserveDirtyState: true
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const first = await value.workspaces.attach({
      project: value.projects.get("fixture"), expectedBranch: "main",
      preserveDirtyState: true
    });
    const artifactDirectoriesBeforeDuplicate = await readdir(value.artifacts);
    await expect(value.workspaces.attach({
      project: value.projects.get("fixture"), expectedBranch: "main",
      preserveDirtyState: true
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readdir(value.artifacts)).toEqual(artifactDirectoriesBeforeDuplicate);
    await value.workspaces.close("fixture", first.taskId);

    await git(value.repo, ["checkout", "--detach"]);
    await expect(value.workspaces.attach({
      project: value.projects.get("fixture"), expectedBranch: "main",
      preserveDirtyState: true
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await git(value.repo, ["switch", "main"]);
    await symlink("../outside.txt", join(value.repo, "escape-link"));
    await expect(value.workspaces.attach({
      project: value.projects.get("fixture"), expectedBranch: "main",
      preserveDirtyState: true
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await rm(join(value.repo, "escape-link"));
    value.database.close();

    const limited = await fixture({ perFileBytes: 4, totalBytes: 8, gitOutputBytes: 5_000_000 });
    await expect(limited.workspaces.attach({
      project: limited.projects.get("fixture"), expectedBranch: "main",
      preserveDirtyState: true
    })).rejects.toMatchObject({ code: "VALIDATION" });
    limited.database.close();
  }, 20_000);

  it("requires optimistic hashes, classifies baseline/new/concurrent/delete/mode/symlink changes, and closes without restoring", async () => {
    const value = await fixture();
    const originalHead = await git(value.repo, ["rev-parse", "HEAD"]);
    const siblingHead = await git(value.sibling, ["rev-parse", "HEAD"]);
    const siblingStatus = await git(value.sibling, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    const attached = await value.workspaces.attach({
      project: value.projects.get("fixture"), expectedBranch: "main",
      preserveDirtyState: true, allowHostExecution: true
    });
    expect(value.workspaces.requireCapability("fixture", attached.taskId, "runHostCommands").capabilities.runHostCommands).toBe(true);
    const observed = await value.workspaces.fileState(value.repo, "tracked.txt");
    await expect(value.workspaces.patchFile({
      projectId: "fixture", taskId: attached.taskId, path: "../outside.txt",
      expectedSha256: NEW_FILE_SHA256,
      replacements: [{ oldText: "", newText: "escape" }]
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await value.workspaces.patchFile({
      projectId: "fixture", taskId: attached.taskId, path: "tracked.txt",
      expectedSha256: observed.sha256,
      replacements: [{ oldText: "dirty before attach", newText: "task edit" }]
    });
    await expect(value.workspaces.patchFile({
      projectId: "fixture", taskId: attached.taskId, path: "tracked.txt",
      expectedSha256: observed.sha256,
      replacements: [{ oldText: "task edit", newText: "stale edit" }]
    })).rejects.toMatchObject({ code: "CONFLICT" });
    await value.workspaces.patchFile({
      projectId: "fixture", taskId: attached.taskId, path: "created.txt",
      expectedSha256: NEW_FILE_SHA256,
      replacements: [{ oldText: "", newText: "created optimistically\n" }]
    });
    await writeFile(join(value.repo, "new-untracked.txt"), "new\n");
    await writeFile(join(value.repo, "clean.txt"), "changed clean\n");
    await rm(join(value.repo, "delete-me.txt"));
    await chmod(join(value.repo, "script.sh"), 0o755);
    await symlink("clean.txt", join(value.repo, "safe-link"));

    const changes = await value.workspaces.changesSinceAttachment("fixture", attached.taskId);
    expect(changes.preExistingUnchanged.map((entry) => entry.path)).toContain("untracked.txt");
    expect(changes.concurrentlyChanged.map((entry) => entry.baseline.path)).toContain("tracked.txt");
    expect(changes.introducedAfterAttachment.map((entry) => entry.path)).toContain("clean.txt");
    expect(changes.newlyAdded.map((entry) => entry.path)).toEqual(expect.arrayContaining(["created.txt", "new-untracked.txt", "safe-link"]));
    expect(changes.deleted.map((entry) => entry.path)).toContain("delete-me.txt");
    expect(changes.modeOrSymlinkChanged.map((entry) => entry.live.path)).toEqual(expect.arrayContaining(["script.sh", "safe-link"]));

    const statusBeforeClose = await git(value.repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    const closed = await value.workspaces.close("fixture", attached.taskId);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeTruthy();
    expect(closed.activePath).toBeUndefined();
    expect(await git(value.repo, ["rev-parse", "HEAD"])).toBe(originalHead);
    expect(await git(value.repo, ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    expect(await git(value.repo, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(statusBeforeClose);
    expect(await git(value.sibling, ["rev-parse", "HEAD"])).toBe(siblingHead);
    expect(await git(value.sibling, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).toBe(siblingStatus);
    expect(value.workspaces.listArtifacts(attached.taskId).map((entry) => entry.relativePath))
      .toEqual(["workspace-state/baseline-manifest.json", "workspace-state/final-manifest.json"]);

    const reattached = await value.workspaces.attach({
      project: value.projects.get("fixture"), expectedBranch: "main",
      preserveDirtyState: true
    });
    expect(reattached.taskId).not.toBe(attached.taskId);
    expect(await lstat(value.sibling)).toBeTruthy();
    value.database.close();
  });

  it("hard-rejects attached branch/history capabilities while retaining isolated capabilities", async () => {
    const value = await fixture();
    const attached = await value.workspaces.attach({
      project: value.projects.get("fixture"), expectedBranch: "main", preserveDirtyState: true
    });
    for (const capability of ["commit", "push", "publish", "merge", "rollback"] as const) {
      expect(() => value.workspaces.requireCapability("fixture", attached.taskId, capability))
        .toThrow(/not permitted/);
    }
    for (const action of ["commit_task", "publish_task", "rollback_task", "create_pull_request", "handoff", "execute_plan"]) {
      expect(() => value.workspaces.requireIsolated("fixture", attached.taskId, action)).toThrow(/forbidden/);
    }
    expect(() => value.workspaces.assertNoActiveAttachment("fixture", "merge_pull_request")).toThrow(/forbidden/);
    value.database.close();
  });
});
