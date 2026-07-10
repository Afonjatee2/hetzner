import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { WorkspaceError } from "@gpt-dev/schemas";

async function git(cwd: string, args: string[], maxBytes = 2_000_000): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < maxBytes) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < maxBytes) stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trimEnd());
      else reject(new WorkspaceError("EXECUTION_FAILED", stderr.trim() || `git exited ${String(code)}`));
    });
  });
}

export class GitService {
  constructor(private readonly worktreeRoot: string) {}

  async createWorktree(projectPath: string, projectId: string, taskId: string, slug = "task"): Promise<{ path: string; branch: string }> {
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const safeSlug = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "task";
    const branch = `chatgpt/${date}/${taskId.slice(0, 8)}-${safeSlug}`;
    const path = resolve(this.worktreeRoot, projectId, taskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o750 });
    await git(projectPath, ["worktree", "add", "-b", branch, path, "HEAD"]);
    return { path, branch };
  }

  status(worktreePath: string): Promise<string> {
    return git(worktreePath, ["status", "--short", "--branch"]);
  }

  diff(worktreePath: string): Promise<string> {
    return git(worktreePath, ["diff", "--no-ext-diff", "--binary"]);
  }

  async commit(worktreePath: string, message: string): Promise<string> {
    await git(worktreePath, ["add", "--all"]);
    await git(worktreePath, ["commit", "-m", message]);
    return git(worktreePath, ["rev-parse", "HEAD"]);
  }

  async discard(projectPath: string, worktreePath: string, branch: string): Promise<void> {
    await git(projectPath, ["worktree", "remove", "--force", worktreePath]);
    await git(projectPath, ["branch", "-D", branch]);
    await rm(worktreePath, { recursive: true, force: true });
  }
}
