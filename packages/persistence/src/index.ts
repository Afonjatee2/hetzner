import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { AuditEvent } from "@gpt-dev/audit-service";

export class WorkspaceDatabase {
  readonly db: Database.Database;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o750 });
    this.db = new Database(absolute);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        canonical_path TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL,
        runtime TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        status TEXT NOT NULL,
        image TEXT,
        command_json TEXT,
        container_id TEXT,
        exit_code INTEGER,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        error TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(worktree_id) REFERENCES worktrees(task_id)
      );
      CREATE TABLE IF NOT EXISTS worktrees (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS task_logs (
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        stream TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_id, sequence),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        media_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, relative_path),
        FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        destructive INTEGER NOT NULL,
        networked INTEGER NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_task_logs_task_sequence ON task_logs(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
    `);
  }

  recordAudit(event: AuditEvent): void {
    this.db.prepare(`
      INSERT INTO audit_events
      (id, timestamp, action, actor, project_id, task_id, destructive, networked, detail_json)
      VALUES (@id, @timestamp, @action, @actor, @projectId, @taskId, @destructive, @networked, @detail)
    `).run({
      ...event,
      projectId: event.projectId ?? null,
      taskId: event.taskId ?? null,
      destructive: event.destructive ? 1 : 0,
      networked: event.networked ? 1 : 0,
      detail: JSON.stringify(event.detail)
    });
  }

  close(): void {
    this.db.close();
  }
}
