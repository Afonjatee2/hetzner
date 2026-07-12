import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isProtectedPath, resolveContained } from "@gpt-dev/projects";
import { WorkspaceError } from "@gpt-dev/schemas";

export interface SkillSummary {
  name: string;
  description: string;
  /** Skill folder, relative to the skills root ("." for a skill at the root itself). */
  dir: string;
}

export interface SkillFileEntry {
  path: string;
  bytes: number;
  loadable: boolean;
}

export interface LoadedSkill {
  name: string;
  file: string;
  content: string;
  files?: SkillFileEntry[];
  truncated?: boolean;
}

const MANIFEST = "SKILL.md";
const MAX_DISCOVERY_DEPTH = 4;
const MAX_FILE_LIST = 200;
const DEFAULT_MAX_BYTES = 262_144;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".state", ".artifacts", "__MACOSX"]);
const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "js", "mjs", "cjs", "ts", "csv", "tsv", "yaml", "yml", "xml", "html", "css", "svg"]);

function isLoadable(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

/** Read at most `maxBytes` from a file without buffering the rest (large files must not OOM the gateway). */
async function readBounded(path: string, maxBytes: number, size: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (size <= maxBytes) return { buffer: await readFile(path), truncated: false };
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return { buffer: buffer.subarray(0, bytesRead), truncated: true };
  } finally {
    await handle.close();
  }
}

function parseFrontmatter(markdown: string): { name?: string; description?: string } {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const keyValue = line.match(/^(name|description):\s*(.+)$/);
    if (keyValue?.[1] && keyValue[2]) out[keyValue[1] as "name" | "description"] = keyValue[2].trim();
  }
  return out;
}

export class SkillsService {
  constructor(private readonly root: string, private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  /** Real (symlink-resolved) root, so relative paths stay consistent on macOS /var → /private/var. */
  private async realRoot(): Promise<string> {
    return resolveContained(this.root, ".");
  }

  /** Recursively discover skills (folders holding SKILL.md) below the root. */
  async list(query?: string): Promise<SkillSummary[]> {
    const skills: SkillSummary[] = [];
    const rootReal = await this.realRoot();
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((entry) => entry.isFile() && entry.name === MANIFEST)) {
        // Frontmatter lives at the top; a bounded head-read keeps giant manifests from being buffered.
        const manifest = join(dir, MANIFEST);
        const head = await stat(manifest)
          .then((info) => readBounded(manifest, 8192, info.size))
          .then(({ buffer }) => buffer.toString("utf8"))
          .catch(() => "");
        const meta = parseFrontmatter(head);
        const rel = relative(rootReal, dir) || ".";
        skills.push({
          name: meta.name ?? rel.split(sep).at(-1) ?? rel,
          description: meta.description ?? "",
          dir: rel.replaceAll(sep, "/")
        });
      }
      if (depth >= MAX_DISCOVERY_DEPTH) return;
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) {
          await walk(join(dir, entry.name), depth + 1);
        }
      }
    };
    await walk(rootReal, 0);
    skills.sort((a, b) => a.name.localeCompare(b.name));
    if (!query) return skills;
    const needle = query.toLowerCase();
    return skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(needle));
  }

  /** Load a skill's SKILL.md (default) or a named support file inside the skill folder. */
  async load(name: string, file?: string): Promise<LoadedSkill> {
    const skill = (await this.list()).find((candidate) => candidate.name === name);
    if (!skill) throw new WorkspaceError("NOT_FOUND", `Unknown skill: ${name}`);
    const requested = file ?? MANIFEST;
    if (isProtectedPath(requested) || !isLoadable(requested)) {
      throw this.rejectionFor(requested);
    }
    const rootReal = await this.realRoot();
    const skillDir = await resolveContained(rootReal, skill.dir);
    const resolved = await resolveContained(skillDir, requested);
    // Re-check on the RESOLVED path: a symlink named notes.md may point at .env or a
    // binary elsewhere inside the root, so the requested-string checks are not enough.
    const resolvedRel = relative(rootReal, resolved).replaceAll(sep, "/");
    if (isProtectedPath(resolvedRel) || !isLoadable(resolvedRel)) {
      throw this.rejectionFor(resolvedRel);
    }
    const info = await stat(resolved);
    if (!info.isFile()) throw new WorkspaceError("NOT_FOUND", `Not a file: ${requested}`);
    const { buffer, truncated } = await readBounded(resolved, this.maxBytes, info.size);
    if (buffer.includes(0)) {
      throw new WorkspaceError("VALIDATION", `File contains binary data: ${requested}`);
    }
    return {
      name: skill.name,
      file: requested,
      content: buffer.toString("utf8"),
      ...(truncated ? { truncated } : {}),
      ...(file ? {} : { files: await this.filesOf(skillDir) })
    };
  }

  private rejectionFor(path: string): WorkspaceError {
    if (isProtectedPath(path)) {
      return new WorkspaceError("FORBIDDEN", "Protected credential paths are not available through this connector");
    }
    return new WorkspaceError("VALIDATION", `Not a loadable text file: ${path}. Binary assets (pptx, pdf, images) are listed but not readable through this tool.`);
  }

  private async filesOf(skillDir: string): Promise<SkillFileEntry[]> {
    const files: SkillFileEntry[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (files.length >= MAX_FILE_LIST || depth > MAX_DISCOVERY_DEPTH) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILE_LIST) return;
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        const absolute = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(absolute, depth + 1);
        } else if (entry.isFile()) {
          const rel = relative(skillDir, absolute).replaceAll(sep, "/");
          if (isProtectedPath(rel)) continue;
          const info = await stat(absolute).catch(() => undefined);
          files.push({ path: rel, bytes: info?.size ?? 0, loadable: isLoadable(rel) });
        }
      }
    };
    await walk(skillDir, 0);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return files;
  }
}
