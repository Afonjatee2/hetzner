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

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(true);
      else if (code === 1) resolvePromise(false);
      else reject(new WorkspaceError("EXECUTION_FAILED", stderr.trim() || `git exited ${String(code)}`));
    });
  });
}

export interface GitPromotionResult {
  branch: string;
  defaultBranch: string;
  remote: string;
  before: string;
  after: string;
}

export interface GitSyncResult {
  defaultBranch: string;
  remote: string;
  before: string;
  after: string;
  changed: boolean;
}

export class GitService {
  private readonly worktreeRoot: string;

  constructor(worktreeRoot: string) {
    this.worktreeRoot = worktreeRoot;
  }

  private async assertClean(path: string, label: string, includeUntracked = true): Promise<void> {
    const args = ["status", "--porcelain", ...(includeUntracked ? [] : ["--untracked-files=no"])];
    const status = await git(path, args);
    if (status) throw new WorkspaceError("CONFLICT", `${label} has uncommitted tracked changes`);
  }

  private async currentBranch(path: string): Promise<string> {
    return git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  }

  head(path: string): Promise<string> {
    return git(path, ["rev-parse", "HEAD"]);
  }

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
    return this.head(worktreePath);
  }

  async promote(projectPath: string, worktreePath: string, branch: string, defaultBranch: string, remote = "origin"): Promise<GitPromotionResult> {
    await this.assertClean(worktreePath, "Task worktree");
    await this.assertClean(projectPath, "Canonical checkout", false);

    const actualTaskBranch = await this.currentBranch(worktreePath);
    if (actualTaskBranch !== branch) throw new WorkspaceError("CONFLICT", `Task worktree is on ${actualTaskBranch}, expected ${branch}`);
    const actualDefaultBranch = await this.currentBranch(projectPath);
    if (actualDefaultBranch !== defaultBranch) throw new WorkspaceError("CONFLICT", `Canonical checkout is on ${actualDefaultBranch}, expected ${defaultBranch}`);

    const before = await this.head(projectPath);
    await git(worktreePath, ["fetch", remote, `${defaultBranch}:refs/remotes/${remote}/${defaultBranch}`]);
    const remoteDefault = `${remote}/${defaultBranch}`;
    if (!await gitSucceeds(worktreePath, ["merge-base", "--is-ancestor", remoteDefault, branch])) {
      throw new WorkspaceError("CONFLICT", `${branch} cannot fast-forward ${remoteDefault}`);
    }

    await git(worktreePath, ["push", "--set-upstream", remote, branch]);
    await git(worktreePath, ["push", remote, `${branch}:refs/heads/${defaultBranch}`]);
    await git(projectPath, ["fetch", remote, `${defaultBranch}:refs/remotes/${remote}/${defaultBranch}`]);
    await git(projectPath, ["merge", "--ff-only", remoteDefault]);
    const after = await this.head(projectPath);
    return { branch, defaultBranch, remote, before, after };
  }

  async sync(projectPath: string, defaultBranch: string, remote = "origin"): Promise<GitSyncResult> {
    await this.assertClean(projectPath, "Canonical checkout", false);
    const actualBranch = await this.currentBranch(projectPath);
    if (actualBranch !== defaultBranch) throw new WorkspaceError("CONFLICT", `Canonical checkout is on ${actualBranch}, expected ${defaultBranch}`);

    const before = await this.head(projectPath);
    await git(projectPath, ["fetch", remote, `${defaultBranch}:refs/remotes/${remote}/${defaultBranch}`]);
    await git(projectPath, ["merge", "--ff-only", `${remote}/${defaultBranch}`]);
    const after = await this.head(projectPath);
    return { defaultBranch, remote, before, after, changed: before !== after };
  }

  async pushBranch(worktreePath: string, branch: string, remote = "origin"): Promise<{ branch: string; remote: string }> {
    await this.assertClean(worktreePath, "Task worktree");
    const actualBranch = await this.currentBranch(worktreePath);
    if (actualBranch !== branch) throw new WorkspaceError("CONFLICT", `Task worktree is on ${actualBranch}, expected ${branch}`);
    await git(worktreePath, ["push", "--set-upstream", remote, branch]);
    return { branch, remote };
  }

  async remoteUrl(worktreePath: string, remote = "origin"): Promise<string> {
    return git(worktreePath, ["remote", "get-url", remote]);
  }

  async discard(projectPath: string, worktreePath: string, branch: string): Promise<void> {
    await git(projectPath, ["worktree", "remove", "--force", worktreePath]);
    await git(projectPath, ["branch", "-D", branch]);
    await rm(worktreePath, { recursive: true, force: true });
  }
}
