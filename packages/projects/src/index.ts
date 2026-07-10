import { constants, realpathSync } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
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
  constructor(private readonly database: WorkspaceDatabase) {}

  register(input: Omit<ProjectRecord, "canonicalPath" | "createdAt"> & { canonicalPath: string }): ProjectRecord {
    const canonicalPath = realpathSync(input.canonicalPath);
    access(canonicalPath, constants.R_OK | constants.W_OK).catch(() => undefined);
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
    const start = await resolveContained(root, requested);
    const rootReal = await realpath(root);
    const entries: TreeEntry[] = [];
    const walk = async (current: string, depth: number): Promise<void> => {
      if (entries.length >= maxEntries || depth > maxDepth) return;
      for (const item of await readdir(current, { withFileTypes: true })) {
        if (DEFAULT_EXCLUDES.has(item.name)) continue;
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
    const path = await resolveContained(root, requested);
    const info = await stat(path);
    if (!info.isFile()) throw new WorkspaceError("VALIDATION", "Path is not a regular file");
    if (info.size > maxBytes) throw new WorkspaceError("VALIDATION", `File exceeds ${maxBytes} bytes`);
    const bytes = await readFile(path);
    if (bytes.includes(0)) throw new WorkspaceError("VALIDATION", "Binary files are not returned as text");
    return bytes.toString("utf8");
  }

  async writeText(root: string, requested: string, content: string): Promise<void> {
    const path = await resolveContained(root, requested, false);
    await mkdir(dirname(path), { recursive: true, mode: 0o750 });
    const temporary = `${path}.gptdev-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o640, flag: "wx" });
    await rename(temporary, path);
  }

  async remove(root: string, requested: string): Promise<void> {
    const path = await resolveContained(root, requested);
    if (path === await realpath(root)) throw new WorkspaceError("FORBIDDEN", "Cannot remove the project root");
    await rm(path, { recursive: true, force: false });
  }

  async search(root: string, pattern: string, maxResults = 200): Promise<string[]> {
    await resolveContained(root);
    return await new Promise((resolvePromise, reject) => {
      const child = spawn("rg", ["--line-number", "--color", "never", "--max-count", String(maxResults), "--", pattern, "."], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0 && code !== 1) reject(new WorkspaceError("EXECUTION_FAILED", stderr.trim() || "ripgrep failed"));
        else resolvePromise(stdout.split("\n").filter(Boolean).slice(0, maxResults));
      });
    });
  }
}
