import { randomUUID } from "node:crypto";
import type { ArtifactService } from "@gpt-dev/artifact-service";
import { redactSecrets } from "@gpt-dev/audit-service";
import type { WorkspaceDatabase } from "@gpt-dev/persistence";
import type { DockerSandboxRunner, SandboxLimits } from "@gpt-dev/sandbox-runner";
import type { NetworkMode, TaskStatus } from "@gpt-dev/schemas";
import { WorkspaceError } from "@gpt-dev/schemas";

export interface TaskRecord {
  id: string;
  projectId: string;
  worktreeId: string;
  worktreePath: string;
  status: TaskStatus;
  image?: string;
  containerId?: string;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  error?: string;
}

export interface StartTaskInput {
  executionId?: string;
  worktreeId: string;
  projectId: string;
  worktreePath: string;
  image: string;
  executable: string;
  args: string[];
  network: NetworkMode;
  networkName?: string;
  limits: SandboxLimits;
}

export class TaskService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly cancellationRequested = new Set<string>();

  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly runner: DockerSandboxRunner,
    private readonly artifacts: ArtifactService
  ) {}

  reconcileInterrupted(): number {
    const result = this.database.db.prepare(`
      UPDATE tasks SET status='interrupted', finished_at=?, error='Gateway restarted while task was active'
      WHERE status IN ('queued','preparing','running')
    `).run(new Date().toISOString());
    return result.changes;
  }

  start(input: StartTaskInput): Promise<TaskRecord> {
    const id = input.executionId ?? randomUUID();
    const createdAt = new Date().toISOString();
    this.database.db.prepare(`
      INSERT INTO tasks (id, project_id, worktree_id, worktree_path, status, image, command_json, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(id, input.projectId, input.worktreeId, input.worktreePath, input.image, JSON.stringify([input.executable, ...input.args]), createdAt);
    const promise = this.execute(id, input).finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return Promise.resolve(this.get(id));
  }

  private async execute(taskId: string, input: StartTaskInput): Promise<void> {
    let sequence = 0;
    const update = (status: TaskStatus, extra: Record<string, unknown> = {}): void => {
      const assignments = ["status=@status", ...Object.keys(extra).map((key) => `${key}=@${key}`)];
      this.database.db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id=@id`).run({ id: taskId, status, ...extra });
    };
    try {
      update("preparing", { started_at: new Date().toISOString() });
      const artifactPath = await this.artifacts.taskDirectory(taskId);
      const result = await this.runner.run({ ...input, taskId, artifactPath }, {
        onContainer: (containerId) => update("running", { container_id: containerId }),
        onLog: (stream, content) => {
          sequence += 1;
          this.database.db.prepare(`
            INSERT INTO task_logs (task_id, sequence, stream, content, created_at) VALUES (?, ?, ?, ?, ?)
          `).run(taskId, sequence, stream, redactSecrets(content), new Date().toISOString());
        }
      });
      await this.artifacts.index(taskId);
      update(this.cancellationRequested.has(taskId) ? "cancelled" : result.timedOut ? "timed_out" : result.exitCode === 0 ? "succeeded" : "failed", {
        exit_code: result.exitCode,
        finished_at: new Date().toISOString(),
        error: result.outputTruncated ? "Task output was truncated at the configured byte limit" : null
      });
    } catch (error) {
      update(this.cancellationRequested.has(taskId) ? "cancelled" : "failed", {
        finished_at: new Date().toISOString(),
        error: redactSecrets(error instanceof Error ? error.message : String(error))
      });
    } finally {
      this.cancellationRequested.delete(taskId);
    }
  }

  get(id: string): TaskRecord {
    const row = this.database.db.prepare(`
      SELECT id, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, status, image,
        container_id AS containerId, exit_code AS exitCode, started_at AS startedAt,
        finished_at AS finishedAt, created_at AS createdAt, error FROM tasks WHERE id=?
    `).get(id) as TaskRecord | undefined;
    if (!row) throw new WorkspaceError("NOT_FOUND", `Unknown task: ${id}`);
    return row;
  }

  list(projectId?: string, limit = 100): TaskRecord[] {
    const sql = projectId
      ? `SELECT id, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, status, image,
          container_id AS containerId, exit_code AS exitCode, started_at AS startedAt,
          finished_at AS finishedAt, created_at AS createdAt, error
         FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT ?`
      : `SELECT id, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, status, image,
          container_id AS containerId, exit_code AS exitCode, started_at AS startedAt,
          finished_at AS finishedAt, created_at AS createdAt, error
         FROM tasks ORDER BY created_at DESC LIMIT ?`;
    return (projectId ? this.database.db.prepare(sql).all(projectId, limit) : this.database.db.prepare(sql).all(limit)) as TaskRecord[];
  }

  logs(taskId: string, cursor = 0, maxBytes = 65536): { entries: Array<{ sequence: number; stream: string; content: string; createdAt: string }>; nextCursor: number } {
    this.get(taskId);
    const rows = this.database.db.prepare(`
      SELECT sequence, stream, content, created_at AS createdAt FROM task_logs
      WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT 1000
    `).all(taskId, cursor) as Array<{ sequence: number; stream: string; content: string; createdAt: string }>;
    let bytes = 0;
    const entries = rows.filter((row) => {
      const size = Buffer.byteLength(row.content);
      if (bytes + size > maxBytes) return false;
      bytes += size;
      return true;
    });
    return { entries, nextCursor: entries.at(-1)?.sequence ?? cursor };
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    const task = this.get(taskId);
    if (task.status !== "running" && task.status !== "preparing") throw new WorkspaceError("CONFLICT", "Task is not cancellable");
    this.cancellationRequested.add(taskId);
    await this.runner.cancel(taskId);
    this.database.db.prepare("UPDATE tasks SET status='cancelled', finished_at=? WHERE id=?").run(new Date().toISOString(), taskId);
    return this.get(taskId);
  }
}
