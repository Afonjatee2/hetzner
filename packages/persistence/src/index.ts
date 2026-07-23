import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { AuditEvent } from "@gpt-dev/audit-service";

const LATEST_SCHEMA_VERSION = 3;

export class WorkspaceDatabase {
  readonly db: Database.Database;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o750 });
    this.db = new Database(absolute);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    // The database holds OAuth refresh-token hashes and short-lived plaintext
    // token-response replay caches; keep the main file and its WAL/SHM
    // sidecars owner-only regardless of the process umask.
    for (const file of [absolute, `${absolute}-wal`, `${absolute}-shm`]) {
      try {
        chmodSync(file, 0o600);
      } catch {
        // sidecar file may not exist yet on this platform/journal mode
      }
    }
  }

  private migrate(): void {
    const current = this.db.pragma("user_version", { simple: true }) as number;
    if (current > LATEST_SCHEMA_VERSION) {
      throw new Error(`Database schema version ${String(current)} is newer than supported version ${String(LATEST_SCHEMA_VERSION)}`);
    }
    if (current < 1) {
      this.db.transaction(() => {
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
      CREATE TABLE IF NOT EXISTS dev_servers (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        worktree_id TEXT NOT NULL,
        container_id TEXT NOT NULL,
        network_name TEXT NOT NULL,
        port INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        stopped_at TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id),
        FOREIGN KEY(worktree_id) REFERENCES worktrees(task_id)
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
      CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY,
        client_name TEXT,
        redirect_uris_json TEXT NOT NULL,
        token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
        scope TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code_hash TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT,
        code_challenge TEXT NOT NULL,
        code_challenge_method TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        consumed_at TEXT,
        token_response_json TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        family_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        rotation_response_json TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_task_logs_task_sequence ON task_logs(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id);
      CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_authorization_codes(expires_at);
        `);
        this.db.pragma("user_version = 1");
      })();
    }
    if (current < 2) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE task_workspaces (
            task_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK(kind IN ('isolated','attached')),
            path TEXT NOT NULL,
            branch TEXT NOT NULL,
            original_head TEXT,
            original_branch TEXT,
            baseline_manifest_path TEXT,
            final_manifest_path TEXT,
            capability_profile_json TEXT NOT NULL,
            sibling_worktrees_json TEXT NOT NULL DEFAULT '[]',
            active_path TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            closed_at TEXT,
            FOREIGN KEY(project_id) REFERENCES projects(id)
          );
          CREATE UNIQUE INDEX idx_task_workspaces_active_path
            ON task_workspaces(active_path) WHERE active_path IS NOT NULL;
          CREATE INDEX idx_task_workspaces_project_status
            ON task_workspaces(project_id, status);
          CREATE TABLE workspace_artifacts (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            media_type TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(task_id, relative_path),
            FOREIGN KEY(task_id) REFERENCES task_workspaces(task_id) ON DELETE CASCADE
          );
        `);
        const isolatedCapabilities = JSON.stringify({
          read: true, write: true, delete: true,
          runContainerCommands: true, runHostCommands: true,
          commit: true, push: true, publish: true, merge: true, rollback: true
        });
        this.db.prepare(`
          INSERT INTO task_workspaces (
            task_id, project_id, kind, path, branch, original_branch,
            capability_profile_json, sibling_worktrees_json, active_path,
            status, created_at
          )
          SELECT task_id, project_id, 'isolated', path, branch, branch,
                 ?, '[]',
                 CASE WHEN status='active' THEN path ELSE NULL END,
                 status, created_at
          FROM worktrees
        `).run(isolatedCapabilities);
        this.db.pragma("user_version = 2");
      })();
    }
    if (current < 3) {
      // Command executions and dev servers belong to a workspace, not
      // specifically to a Git worktree. Rebuild these two tables so attached
      // workspaces can use the existing execution lifecycle without creating
      // a dangerous compatibility row in `worktrees`.
      this.db.pragma("foreign_keys = OFF");
      try {
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE tasks_new (
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
              FOREIGN KEY(worktree_id) REFERENCES task_workspaces(task_id)
            );
            INSERT INTO tasks_new SELECT * FROM tasks;
            DROP TABLE tasks;
            ALTER TABLE tasks_new RENAME TO tasks;

            CREATE TABLE dev_servers_new (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              worktree_id TEXT NOT NULL,
              container_id TEXT NOT NULL,
              network_name TEXT NOT NULL,
              port INTEGER NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL,
              stopped_at TEXT,
              FOREIGN KEY(project_id) REFERENCES projects(id),
              FOREIGN KEY(worktree_id) REFERENCES task_workspaces(task_id)
            );
            INSERT INTO dev_servers_new SELECT * FROM dev_servers;
            DROP TABLE dev_servers;
            ALTER TABLE dev_servers_new RENAME TO dev_servers;
            CREATE INDEX idx_tasks_status ON tasks(status);
          `);
          this.db.pragma("user_version = 3");
        })();
      } finally {
        this.db.pragma("foreign_keys = ON");
      }
      const violations = this.db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) throw new Error("Database migration introduced foreign-key violations");
    }
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
