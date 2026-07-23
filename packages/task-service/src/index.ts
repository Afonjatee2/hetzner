import { randomUUID } from "node:crypto";
import type { ArtifactService } from "@gpt-dev/artifact-service";
import { redactSecrets } from "@gpt-dev/audit-service";
import type { WorkspaceDatabase } from "@gpt-dev/persistence";
import type { SandboxLimits, TaskRunner } from "@gpt-dev/sandbox-runner";
import type { CommandExecutionMode, ExecutionMode, NetworkMode, TaskStatus } from "@gpt-dev/schemas";
import { WorkspaceError } from "@gpt-dev/schemas";

export interface TaskRecord {
  id: string;
  projectId: string;
  worktreeId: string;
  worktreePath: string;
  status: TaskStatus;
  executionMode: ExecutionMode;
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
  mode?: CommandExecutionMode;
  executionMode?: ExecutionMode;
  env?: Record<string, string>;
  extraMounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
  limits: SandboxLimits;
}

export class TaskService {
  private readonly running = new Map<string, Promise<void>>();
  private readonly cancellationRequested = new Set<string>();
  private readonly terminalNotified = new Set<string>();

  constructor(
    private readonly database: WorkspaceDatabase,
    private readonly runner: TaskRunner,
    private readonly artifacts: ArtifactService,
    private readonly hostRunner?: TaskRunner,
    private readonly onExternalAgentTerminal?: (task: TaskRecord) => void
  ) {}

  private runnerFor(mode: CommandExecutionMode | undefined): TaskRunner {
    if (mode !== "host") return this.runner;
    if (!this.hostRunner) throw new WorkspaceError("FORBIDDEN", "Host execution is not enabled on this gateway");
    return this.hostRunner;
  }

  reconcileInterrupted(): number {
    const external = this.database.db.prepare(`
      SELECT id FROM tasks
      WHERE status IN ('queued','preparing','running') AND execution_mode='external_agent'
    `).all() as Array<{ id: string }>;
    const result = this.database.db.prepare(`
      UPDATE tasks SET status='interrupted', finished_at=?, error='Gateway restarted while task was active'
      WHERE status IN ('queued','preparing','running')
    `).run(new Date().toISOString());
    for (const { id } of external) {
      this.notifyExternalAgentTerminal(id);
      this.terminalNotified.delete(id);
    }
    return result.changes;
  }

  start(input: StartTaskInput): Promise<TaskRecord> {
    const id = input.executionId ?? randomUUID();
    const createdAt = new Date().toISOString();
    this.database.db.prepare(`
      INSERT INTO tasks (id, project_id, worktree_id, worktree_path, status, execution_mode, image, command_json, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(id, input.projectId, input.worktreeId, input.worktreePath, input.executionMode ?? 'direct', input.image, JSON.stringify([input.executable, ...input.args]), createdAt);
    const promise = this.execute(id, input).finally(() => {
      this.running.delete(id);
      this.terminalNotified.delete(id);
    });
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
      const result = await this.runnerFor(input.mode).run({ ...input, taskId, artifactPath }, {
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
      await this.artifacts.index(taskId).catch(() => []);
      update(this.cancellationRequested.has(taskId) ? "cancelled" : "failed", {
        finished_at: new Date().toISOString(),
        error: redactSecrets(error instanceof Error ? error.message : String(error))
      });
    } finally {
      this.cancellationRequested.delete(taskId);
      this.notifyExternalAgentTerminal(taskId);
    }
  }

  get(id: string): TaskRecord {
    const row = this.database.db.prepare(`
      SELECT id, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, status,
        execution_mode AS executionMode, image,
        container_id AS containerId, exit_code AS exitCode, started_at AS startedAt,
        finished_at AS finishedAt, created_at AS createdAt, error FROM tasks WHERE id=?
    `).get(id) as TaskRecord | undefined;
    if (!row) throw new WorkspaceError("NOT_FOUND", `Unknown task: ${id}`);
    return row;
  }

  list(projectId?: string, limit = 100): TaskRecord[] {
    const sql = projectId
      ? `SELECT id, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, status, execution_mode AS executionMode, image,
          container_id AS containerId, exit_code AS exitCode, started_at AS startedAt,
          finished_at AS finishedAt, created_at AS createdAt, error
         FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT ?`
      : `SELECT id, project_id AS projectId, worktree_id AS worktreeId, worktree_path AS worktreePath, status, execution_mode AS executionMode, image,
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

  async waitForCompletion(taskId: string): Promise<TaskRecord> {
    const running = this.running.get(taskId);
    if (running) await running;
    return this.get(taskId);
  }

  async cancel(taskId: string): Promise<TaskRecord> {
    const task = this.get(taskId);
    if (task.status !== "running" && task.status !== "preparing") throw new WorkspaceError("CONFLICT", "Task is not cancellable");
    this.cancellationRequested.add(taskId);
    // Host tasks are recorded with the sentinel image "host" (they have no container image).
    await this.runnerFor(task.image === "host" ? "host" : "container").cancel(taskId);
    this.database.db.prepare("UPDATE tasks SET status='cancelled', finished_at=? WHERE id=?").run(new Date().toISOString(), taskId);
    this.notifyExternalAgentTerminal(taskId);
    return this.waitForCompletion(taskId);
  }

  private notifyExternalAgentTerminal(taskId: string): void {
    if (this.terminalNotified.has(taskId)) return;
    const task = this.get(taskId);
    if (task.executionMode !== "external_agent" || new Set<TaskStatus>(["queued", "preparing", "running"]).has(task.status)) return;
    this.terminalNotified.add(taskId);
    this.onExternalAgentTerminal?.(task);
  }

  async cancelWorkspace(workspaceId: string): Promise<void> {
    const active = this.database.db.prepare(`
      SELECT id FROM tasks
      WHERE worktree_id=? AND status IN ('queued','preparing','running')
      ORDER BY created_at
    `).all(workspaceId) as Array<{ id: string }>;
    for (const { id } of active) {
      const current = this.get(id);
      if (current.status === "queued") {
        // execute() changes queued to preparing synchronously before its first
        // await, but retain a bounded turn for custom runners/test doubles.
        await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
      }
      const refreshed = this.get(id);
      if (!new Set<TaskStatus>(["preparing", "running"]).has(refreshed.status)) continue;
      try {
        await this.cancel(id);
      } catch (error) {
        const latest = this.get(id);
        if (new Set<TaskStatus>(["queued", "preparing", "running"]).has(latest.status)) throw error;
      }
      await this.running.get(id);
    }
  }
}
