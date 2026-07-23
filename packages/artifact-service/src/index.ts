import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { WorkspaceDatabase } from "@gpt-dev/persistence";
import { WorkspaceError } from "@gpt-dev/schemas";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".html": "text/html", ".json": "application/json", ".zip": "application/zip", ".txt": "text/plain"
};

export interface ArtifactRecord {
  id: string;
  taskId: string;
  relativePath: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export class ArtifactService {
  constructor(private readonly database: WorkspaceDatabase, private readonly root: string) {}

  async taskDirectory(taskId: string): Promise<string> {
    const path = resolve(this.root, taskId);
    await mkdir(path, { recursive: true, mode: 0o750 });
    return path;
  }

  async index(taskId: string, maxFiles = 200): Promise<ArtifactRecord[]> {
    const root = await realpath(await this.taskDirectory(taskId));
    const records: ArtifactRecord[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (records.length >= maxFiles) return;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) {
          const info = await stat(path);
          const bytes = await readFile(path);
          const record: ArtifactRecord = {
            id: randomUUID(), taskId, relativePath: relative(root, path),
            mediaType: MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
            bytes: info.size, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString()
          };
          this.database.db.prepare(`
            INSERT INTO artifacts (id, task_id, relative_path, media_type, bytes, sha256, created_at)
            VALUES (@id, @taskId, @relativePath, @mediaType, @bytes, @sha256, @createdAt)
            ON CONFLICT(task_id, relative_path) DO UPDATE SET media_type=excluded.media_type,
              bytes=excluded.bytes, sha256=excluded.sha256, created_at=excluded.created_at
          `).run(record);
          records.push(record);
        }
      }
    };
    await walk(root);
    return records;
  }

  list(taskId: string): ArtifactRecord[] {
    return this.database.db.prepare(`
      SELECT id, task_id AS taskId, relative_path AS relativePath, media_type AS mediaType,
             bytes, sha256, created_at AS createdAt FROM artifacts WHERE task_id=? ORDER BY relative_path
    `).all(taskId) as ArtifactRecord[];
  }

  async read(taskId: string, requested: string, maxBytes = 10_000_000): Promise<Buffer> {
    const root = await realpath(await this.taskDirectory(taskId));
    const path = await realpath(resolve(root, requested));
    if (!path.startsWith(`${root}/`)) throw new WorkspaceError("FORBIDDEN", "Artifact path escapes task directory");
    const info = await stat(path);
    if (info.size > maxBytes) throw new WorkspaceError("VALIDATION", "Artifact is too large");
    return readFile(path);
  }
}
