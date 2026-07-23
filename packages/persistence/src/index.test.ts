import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceDatabase } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WorkspaceDatabase migrations", () => {
  it("migrates legacy worktrees and execution foreign keys without losing data", async () => {
    const root = await mkdtemp(join(tmpdir(), "gptdev-migration-"));
    roots.push(root);
    const path = join(root, "legacy.db");
    const legacy = new Database(path);
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE,
        default_branch TEXT NOT NULL, runtime TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE worktrees (
        task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
        worktree_path TEXT NOT NULL, status TEXT NOT NULL, image TEXT, command_json TEXT,
        container_id TEXT, exit_code INTEGER, started_at TEXT, finished_at TEXT,
        created_at TEXT NOT NULL, error TEXT
      );
      CREATE TABLE task_logs (
        task_id TEXT NOT NULL, sequence INTEGER NOT NULL, stream TEXT NOT NULL,
        content TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,sequence)
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, relative_path TEXT NOT NULL,
        media_type TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(task_id,relative_path)
      );
      CREATE TABLE dev_servers (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL,
        container_id TEXT NOT NULL, network_name TEXT NOT NULL, port INTEGER NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, stopped_at TEXT
      );
      INSERT INTO projects VALUES ('demo','/tmp/demo','main','node','2026-01-01');
      INSERT INTO worktrees VALUES ('11111111-1111-4111-8111-111111111111','demo','/tmp/task','task-branch','active','2026-01-01');
      INSERT INTO tasks (
        id,project_id,worktree_id,worktree_path,status,created_at
      ) VALUES (
        '22222222-2222-4222-8222-222222222222','demo',
        '11111111-1111-4111-8111-111111111111','/tmp/task','succeeded','2026-01-01'
      );
      INSERT INTO task_logs VALUES ('22222222-2222-4222-8222-222222222222',1,'stdout','ok','2026-01-01');
    `);
    legacy.close();

    const migrated = new WorkspaceDatabase(path);
    expect(migrated.db.pragma("user_version", { simple: true })).toBe(4);
    expect(migrated.db.prepare("SELECT kind,status,execution_mode AS executionMode,provider_profile AS providerProfile FROM task_workspaces").get())
      .toEqual({ kind: "isolated", status: "active", executionMode: "direct", providerProfile: null });
    expect(migrated.db.prepare("SELECT status,execution_mode AS executionMode FROM tasks").get()).toEqual({ status: "succeeded", executionMode: "direct" });
    expect(migrated.db.prepare("SELECT content FROM task_logs").get()).toEqual({ content: "ok" });
    expect(migrated.db.pragma("foreign_key_check")).toEqual([]);
    const tasksSql = (migrated.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { sql: string }).sql;
    expect(tasksSql).toContain("REFERENCES task_workspaces");
    migrated.close();
  });
});
