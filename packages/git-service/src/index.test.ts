import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitService } from "./index.js";

async function run(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(stderr.trim() || `git exited ${String(code)}`)));
  });
}

async function fixture(): Promise<{ root: string; project: string; remote: string; service: GitService }> {
  const root = await mkdtemp(join(tmpdir(), "gptdev-git-"));
  const remote = join(root, "remote.git");
  const project = join(root, "project");
  await mkdir(project);
  await run(root, ["init", "--bare", remote]);
  await run(project, ["init", "-b", "main"]);
  await run(project, ["config", "user.name", "Test User"]);
  await run(project, ["config", "user.email", "test@example.com"]);
  await writeFile(join(project, "README.md"), "base\n");
  await run(project, ["add", "."]);
  await run(project, ["commit", "-m", "base"]);
  await run(project, ["remote", "add", "origin", remote]);
  await run(project, ["push", "-u", "origin", "main"]);
  return { root, project, remote, service: new GitService(join(root, "worktrees")) };
}

describe("GitService promotion and sync", () => {
  it("publishes a clean task by fast-forwarding origin/main and the canonical checkout", async () => {
    const { project, remote, service } = await fixture();
    const created = await service.createWorktree(project, "demo", "11111111-1111-4111-8111-111111111111", "publish");
    await run(created.path, ["config", "user.name", "Test User"]);
    await run(created.path, ["config", "user.email", "test@example.com"]);
    await writeFile(join(created.path, "feature.txt"), "published\n");
    const commit = await service.commit(created.path, "add feature");

    const result = await service.promote(project, created.path, created.branch, "main");

    expect(result.after).toBe(commit);
    expect(await run(remote, ["rev-parse", "refs/heads/main"])).toBe(commit);
    expect(await readFile(join(project, "feature.txt"), "utf8")).toBe("published\n");
  });

  it("syncs a clean canonical checkout using a fast-forward only", async () => {
    const { root, project, remote, service } = await fixture();
    const writer = join(root, "writer");
    await run(root, ["clone", remote, writer]);
    await run(writer, ["switch", "main"]);
    await run(writer, ["config", "user.name", "Test User"]);
    await run(writer, ["config", "user.email", "test@example.com"]);
    await writeFile(join(writer, "remote.txt"), "new\n");
    await run(writer, ["add", "."]);
    await run(writer, ["commit", "-m", "remote update"]);
    await run(writer, ["push", "origin", "main"]);

    const result = await service.sync(project, "main");

    expect(result.changed).toBe(true);
    expect(await readFile(join(project, "remote.txt"), "utf8")).toBe("new\n");
  });

  it("allows harmless untracked files in the canonical checkout", async () => {
    const { project, service } = await fixture();
    await writeFile(join(project, "local-notes.txt"), "keep local\n");
    const result = await service.sync(project, "main");
    expect(result.changed).toBe(false);
    expect(await readFile(join(project, "local-notes.txt"), "utf8")).toBe("keep local\n");
  });

  it("refuses to sync a dirty canonical checkout", async () => {
    const { project, service } = await fixture();
    await writeFile(join(project, "README.md"), "dirty\n");
    await expect(service.sync(project, "main")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
