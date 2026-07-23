import { accessSync, constants, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { WorkspaceDatabase } from "@gpt-dev/persistence";
import { WorkspaceError } from "@gpt-dev/schemas";

export interface ProjectRecord {
  id: string;
  canonicalPath: string;
  defaultBranch: string;
  runtime: "node" | "python" | "generic";
  createdAt: string;
}

export interface TreeEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  bytes?: number;
}

const DEFAULT_EXCLUDES = new Set([".git", "node_modules", "dist", "coverage", ".state", ".artifacts"]);
const PROTECTED_DIRECTORIES = new Set([".git", ".ssh", ".aws", ".gnupg", ".kube"]);
const PROTECTED_FILES = new Set([".npmrc", ".pypirc", ".netrc", "id_rsa", "id_ed25519", "credentials"]);

export function isProtectedPath(requested: string): boolean {
  const parts = requested.replaceAll("\\", "/").split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => PROTECTED_DIRECTORIES.has(part))) return true;
  const name = parts.at(-1)?.toLowerCase() ?? "";
  const safeEnvExample = /^\.env(?:\.[a-z0-9_-]+)*\.example$/i.test(name);
  if ((name === ".env" || name.startsWith(".env.")) && !safeEnvExample) return true;
  if (PROTECTED_FILES.has(name)) return true;
  return /\.(?:pem|key|p12|pfx)$/i.test(name);
}

function assertUnprotected(requested: string): void {
  if (isProtectedPath(requested)) throw new WorkspaceError("FORBIDDEN", "Protected credential paths are not available through this connector");
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function resolveContained(root: string, requested = ".", mustExist = true): Promise<string> {
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, requested);
  if (!isInside(realRoot, candidate)) {
    throw new WorkspaceError("FORBIDDEN", "Path escapes the approved project root");
  }
  let resolved: string;
  if (mustExist) {
    resolved = await realpath(candidate).catch(() => {
      throw new WorkspaceError("NOT_FOUND", `Path not found: ${requested}`);
    });
  } else {
    const parent = await realpath(dirname(candidate)).catch(() => {
      throw new WorkspaceError("NOT_FOUND", `Parent path not found: ${dirname(requested)}`);
    });
    resolved = resolve(parent, basename(candidate));
  }
  if (!isInside(realRoot, resolved)) {
    throw new WorkspaceError("FORBIDDEN", "Path escapes the approved project root");
  }
  return resolved;
}

export class ProjectService {
  private readonly allowedRootReal: string | undefined;

  constructor(private readonly database: WorkspaceDatabase, allowedRoot?: string) {
    this.allowedRootReal = allowedRoot ? realpathSync(allowedRoot) : undefined;
  }

  register(input: Omit<ProjectRecord, "canonicalPath" | "createdAt"> & { canonicalPath: string }): ProjectRecord {
    const canonicalPath = realpathSync(input.canonicalPath);
    if (this.allowedRootReal && !isInside(this.allowedRootReal, canonicalPath)) {
      throw new WorkspaceError("FORBIDDEN", "Project is outside the configured workspace root");
    }
    try {
      accessSync(canonicalPath, constants.R_OK | constants.W_OK);
    } catch {
      throw new WorkspaceError("FORBIDDEN", "Project must be readable and writable by the gateway user");
    }
    const gitPath = resolve(canonicalPath, ".git");
    try {
      realpathSync(gitPath);
    } catch {
      throw new WorkspaceError("VALIDATION", "Registered projects must be Git repositories");
    }
    const project: ProjectRecord = { ...input, canonicalPath, createdAt: new Date().toISOString() };
    this.database.db.prepare(`
      INSERT INTO projects (id, canonical_path, default_branch, runtime, created_at)
      VALUES (@id, @canonicalPath, @defaultBranch, @runtime, @createdAt)
      ON CONFLICT(id) DO UPDATE SET canonical_path=excluded.canonical_path,
        default_branch=excluded.default_branch, runtime=excluded.runtime
    `).run(project);
    return project;
  }

  list(): ProjectRecord[] {
    return this.database.db.prepare(`
      SELECT id, canonical_path AS canonicalPath, default_branch AS defaultBranch,
             runtime, created_at AS createdAt FROM projects ORDER BY id
    `).all() as ProjectRecord[];
  }

  get(id: string): ProjectRecord {
    const row = this.database.db.prepare(`
      SELECT id, canonical_path AS canonicalPath, default_branch AS defaultBranch,
             runtime, created_at AS createdAt FROM projects WHERE id=?
    `).get(id) as ProjectRecord | undefined;
    if (!row) throw new WorkspaceError("NOT_FOUND", `Unknown project: ${id}`);
    return row;
  }

  async tree(root: string, requested = ".", maxEntries = 1000, maxDepth = 8): Promise<TreeEntry[]> {
    assertUnprotected(requested);
    const start = await resolveContained(root, requested);
    const rootReal = await realpath(root);
    const entries: TreeEntry[] = [];
    const walk = async (current: string, depth: number): Promise<void> => {
      if (entries.length >= maxEntries || depth > maxDepth) return;
      for (const item of await readdir(current, { withFileTypes: true })) {
        if (DEFAULT_EXCLUDES.has(item.name) || isProtectedPath(relative(rootReal, resolve(current, item.name)))) continue;
        const absolute = resolve(current, item.name);
        const info = await lstat(absolute);
        const path = relative(rootReal, absolute) || ".";
        entries.push({
          path,
          type: item.isSymbolicLink() ? "symlink" : item.isDirectory() ? "directory" : "file",
          ...(item.isFile() ? { bytes: info.size } : {})
        });
        if (entries.length >= maxEntries) return;
        if (item.isDirectory()) await walk(absolute, depth + 1);
      }
    };
    const startStat = await stat(start);
    if (startStat.isDirectory()) await walk(start, 0);
    else entries.push({ path: relative(rootReal, start), type: "file", bytes: startStat.size });
    return entries;
  }

  async readText(root: string, requested: string, maxBytes = 1_000_000): Promise<string> {
    assertUnprotected(requested);
    const path = await resolveContained(root, requested);
    const info = await stat(path);
    if (!info.isFile()) throw new WorkspaceError("VALIDATION", "Path is not a regular file");
    if (info.size > maxBytes) throw new WorkspaceError("VALIDATION", `File exceeds ${maxBytes} bytes`);
    const bytes = await readFile(path);
    if (bytes.includes(0)) throw new WorkspaceError("VALIDATION", "Binary files are not returned as text");
    return bytes.toString("utf8");
  }

  async writeText(root: string, requested: string, content: string): Promise<void> {
    assertUnprotected(requested);
    const path = await resolveContained(root, requested, false);
    await mkdir(dirname(path), { recursive: true, mode: 0o750 });
    const temporary = `${path}.gptdev-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o640, flag: "wx" });
    await rename(temporary, path);
  }

  async remove(root: string, requested: string): Promise<void> {
    assertUnprotected(requested);
    const rootReal = await realpath(root);
    const candidate = resolve(rootReal, requested);
    if (!isInside(rootReal, candidate) || candidate === rootReal) {
      throw new WorkspaceError("FORBIDDEN", "Cannot remove a path outside the project root");
    }
    const parent = await realpath(dirname(candidate)).catch(() => {
      throw new WorkspaceError("NOT_FOUND", `Parent path not found: ${dirname(requested)}`);
    });
    if (!isInside(rootReal, parent)) throw new WorkspaceError("FORBIDDEN", "Path escapes the approved project root");
    const path = resolve(parent, basename(candidate));
    await lstat(path).catch(() => {
      throw new WorkspaceError("NOT_FOUND", `Path not found: ${requested}`);
    });
    await rm(path, { recursive: true, force: false });
  }

  async search(root: string, pattern: string, maxResults = 200): Promise<string[]> {
    await resolveContained(root);
    const commonExcludes = [
      "--glob", "!.git/**", "--glob", "!.ssh/**", "--glob", "!.aws/**", "--glob", "!.gnupg/**", "--glob", "!.kube/**",
      "--glob", "!.npmrc", "--glob", "!*.pem", "--glob", "!*.key", "--glob", "!*.p12", "--glob", "!*.pfx"
    ];
    const runSearch = async (globs: string[]): Promise<string[]> => await new Promise((resolvePromise, reject) => {
      const child = spawn("rg", [
        "--line-number", "--color", "never", "--max-count", String(maxResults),
        ...commonExcludes, ...globs, "--", pattern, "."
      ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0 && code !== 1) reject(new WorkspaceError("EXECUTION_FAILED", stderr.trim() || "ripgrep failed"));
        else resolvePromise(stdout.split("\n").filter(Boolean));
      });
    });

    const regularMatches = await runSearch(["--glob", "!.env", "--glob", "!.env.*"]);
    const exampleMatches = await runSearch(["--glob", ".env.example", "--glob", ".env.*.example"]);
    return [...new Set([...regularMatches, ...exampleMatches])].slice(0, maxResults);
  }
}
