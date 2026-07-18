import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAuditEvent } from "@gpt-dev/audit-service";
import type { ArtifactService } from "@gpt-dev/artifact-service";
import { BrowserAction, type BrowserService, type DevServerService } from "@gpt-dev/browser-service";
import type { GitService } from "@gpt-dev/git-service";
import type { HandoffInbox, HandoffSender } from "@gpt-dev/handoff-service";
import type { WorkspaceDatabase } from "@gpt-dev/persistence";
import type { ProjectService } from "@gpt-dev/projects";
import type { DockerSandboxRunner } from "@gpt-dev/sandbox-runner";
import { ProjectId, RelativePath, RunCommandInput, TaskId, WorkspaceError } from "@gpt-dev/schemas";
import type { SkillsService } from "@gpt-dev/skills-service";
import type { TaskService } from "@gpt-dev/task-service";
import type { Config } from "./config.js";

export interface Services {
  config: Config;
  database: WorkspaceDatabase;
  projects: ProjectService;
  git: GitService;
  runner: DockerSandboxRunner;
  tasks: TaskService;
  artifacts: ArtifactService;
  browser: BrowserService;
  devServers: DevServerService;
  handoffSender: HandoffSender | undefined;
  handoffInbox: HandoffInbox | undefined;
  skills: SkillsService | undefined;
}

interface WorktreeRecord { taskId: string; projectId: string; path: string; branch: string; status: string; createdAt: string }

function worktreeRecord(database: WorkspaceDatabase, projectId: string, taskId: string): WorktreeRecord {
  const row = database.db.prepare(`
    SELECT task_id AS taskId, project_id AS projectId, path, branch, status, created_at AS createdAt
    FROM worktrees WHERE task_id=? AND project_id=?
  `).get(taskId, projectId) as WorktreeRecord | undefined;
  if (!row) throw new WorkspaceError("NOT_FOUND", "Task worktree not found for project");
  return row;
}

function worktree(database: WorkspaceDatabase, projectId: string, taskId: string): WorktreeRecord {
  const row = worktreeRecord(database, projectId, taskId);
  if (row.status !== "active") throw new WorkspaceError("CONFLICT", `Worktree is ${row.status}`);
  return row;
}

function content(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], isError };
}

function registerAudit(services: Services, action: string, options: { projectId?: string; taskId?: string; destructive?: boolean; networked?: boolean; detail?: Record<string, unknown> } = {}): string {
  const event = createAuditEvent({
    action, actor: "mcp-user", destructive: options.destructive ?? false, networked: options.networked ?? false,
    detail: options.detail ?? {},
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {})
  });
  services.database.recordAudit(event);
  return event.id;
}

async function safely<T>(services: Services, action: string, options: Parameters<typeof registerAudit>[2], callback: () => Promise<T> | T) {
  const auditId = registerAudit(services, action, options);
  try {
    return content({ ok: true, data: await callback(), auditId });
  } catch (error) {
    const known = error instanceof WorkspaceError ? error : new WorkspaceError("INTERNAL", error instanceof Error ? error.message : String(error));
    return content({ ok: false, error: { code: known.code, message: known.message, retryable: known.retryable, details: known.details }, auditId }, true);
  }
}

function rootFor(services: Services, projectId: string, taskId?: string): string {
  return taskId ? worktree(services.database, projectId, taskId).path : services.projects.get(projectId).canonicalPath;
}

export function createMcpServer(services: Services): McpServer {
  const server = new McpServer({ name: services.config.GATEWAY_NAME, version: "0.1.0" }, { capabilities: { logging: {} } });

  server.registerTool("system_health", {
    description: "Read gateway, SQLite, workspace and Docker runner health. Makes no changes.",
    inputSchema: {}, annotations: { title: "System health", readOnlyHint: true, openWorldHint: false }
  }, async () => safely(services, "system_health", {}, async () => ({
    gateway: "ok", database: services.database.db.prepare("SELECT 1 AS ok").get(), docker: await services.runner.health(),
    hostExecution: services.config.HOST_EXECUTION,
    workspaceRoot: services.config.workspaceRoot, architecture: process.arch, uptimeSeconds: Math.floor(process.uptime())
  })));

  server.registerTool("list_projects", {
    description: "List approved project IDs and metadata. Does not expose secrets or file contents.",
    inputSchema: {}, annotations: { title: "List projects", readOnlyHint: true, openWorldHint: false }
  }, async () => safely(services, "list_projects", {}, () => services.projects.list()));

  server.registerTool("register_project", {
    description: "Register an existing approved Git checkout below the workspace root. Requires explicit approval for company or client data.",
    inputSchema: { id: ProjectId, path: z.string().min(1), defaultBranch: z.string().min(1).default("main"), runtime: z.enum(["node", "python", "generic"]).default("generic") },
    annotations: { title: "Register project", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "register_project", { projectId: input.id }, () => services.projects.register({ id: input.id, canonicalPath: input.path, defaultBranch: input.defaultBranch, runtime: input.runtime })));

  server.registerTool("project_tree", {
    description: "Return a bounded tree for an approved project or active task worktree.",
    inputSchema: { projectId: ProjectId, taskId: TaskId.optional(), path: z.string().default("."), maxEntries: z.number().int().min(1).max(5000).default(1000), maxDepth: z.number().int().min(1).max(20).default(8) },
    annotations: { title: "Project tree", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "project_tree", { projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}) }, () => services.projects.tree(rootFor(services, input.projectId, input.taskId), input.path, input.maxEntries, input.maxDepth)));

  server.registerTool("read_file", {
    description: "Read a bounded UTF-8 text file from an approved project or active task worktree. Rejects binaries and path escapes.",
    inputSchema: { projectId: ProjectId, taskId: TaskId.optional(), path: RelativePath, maxBytes: z.number().int().min(1).max(2_000_000).default(1_000_000) },
    annotations: { title: "Read file", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "read_file", { projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}) }, () => services.projects.readText(rootFor(services, input.projectId, input.taskId), input.path, input.maxBytes)));

  server.registerTool("search_code", {
    description: "Search text with ripgrep inside an approved project or active task worktree. Results are bounded.",
    inputSchema: { projectId: ProjectId, taskId: TaskId.optional(), pattern: z.string().min(1).max(512), maxResults: z.number().int().min(1).max(1000).default(200) },
    annotations: { title: "Search code", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "search_code", { projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}) }, () => services.projects.search(rootFor(services, input.projectId, input.taskId), input.pattern, input.maxResults)));

  if (services.skills) {
    server.registerTool("list_skills", {
      description: "List available skills (markdown playbooks such as report frameworks and house-style guides). Load the relevant skill BEFORE starting a matching task; the optional query filters on name and description.",
      inputSchema: { query: z.string().min(1).max(200).optional() },
      annotations: { title: "List skills", readOnlyHint: true, openWorldHint: false }
    }, async (input) => safely(services, "list_skills", {}, () => services.skills!.list(input.query)));

    server.registerTool("load_skill", {
      description: "Load a skill's SKILL.md playbook (returns its support-file listing too), or pass `file` to read a specific text support file (specs, configs, themes) from the skill folder.",
      inputSchema: { name: z.string().min(1).max(200), file: RelativePath.optional() },
      annotations: { title: "Load skill", readOnlyHint: true, openWorldHint: false }
    }, async (input) => safely(services, "load_skill", { detail: { skill: input.name, ...(input.file ? { file: input.file } : {}) } }, () => services.skills!.load(input.name, input.file)));
  }

  server.registerTool("create_task_worktree", {
    description: "Create an isolated Git branch and worktree for a coding task. Canonical checkouts are not modified.",
    inputSchema: { projectId: ProjectId, slug: z.string().max(64).default("task") },
    annotations: { title: "Create task worktree", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "create_task_worktree", { projectId: input.projectId }, async () => {
    const project = services.projects.get(input.projectId);
    const taskId = randomUUID();
    const created = await services.git.createWorktree(project.canonicalPath, project.id, taskId, input.slug);
    const record = { taskId, projectId: project.id, path: created.path, branch: created.branch, status: "active", createdAt: new Date().toISOString() };
    services.database.db.prepare(`INSERT INTO worktrees (task_id, project_id, path, branch, status, created_at) VALUES (@taskId,@projectId,@path,@branch,@status,@createdAt)`).run(record);
    return record;
  }));

  server.registerTool("write_file", {
    description: "Create or replace a UTF-8 file atomically inside an active task worktree. Never writes to a canonical checkout.",
    inputSchema: { projectId: ProjectId, taskId: TaskId, path: RelativePath, content: z.string().max(2_000_000) },
    annotations: { title: "Write file", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "write_file", { projectId: input.projectId, taskId: input.taskId }, async () => {
    await services.projects.writeText(rootFor(services, input.projectId, input.taskId), input.path, input.content);
    return { path: input.path, bytes: Buffer.byteLength(input.content) };
  }));

  server.registerTool("delete_path", {
    description: "Delete a file or directory only inside an active task worktree. This is destructive and cannot target the worktree root.",
    inputSchema: { projectId: ProjectId, taskId: TaskId, path: RelativePath },
    annotations: { title: "Delete path", readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async (input) => safely(services, "delete_path", { projectId: input.projectId, taskId: input.taskId, destructive: true }, async () => {
    await services.projects.remove(rootFor(services, input.projectId, input.taskId), input.path); return { deleted: input.path };
  }));

  server.registerTool("git_status", {
    description: "Read Git status for an active task worktree.", inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Git status", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "git_status", { projectId: input.projectId, taskId: input.taskId }, () => services.git.status(rootFor(services, input.projectId, input.taskId))));

  server.registerTool("git_diff", {
    description: "Read the bounded Git diff for an active task worktree.", inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Git diff", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "git_diff", { projectId: input.projectId, taskId: input.taskId }, () => services.git.diff(rootFor(services, input.projectId, input.taskId))));

  if (services.handoffSender) {
    server.registerTool("send_handoff_to_hetzner", {
      description: "Stream a clean committed task branch to the fixed Hetzner handoff inbox over a restricted SSH identity. The destination cannot be changed by tool input.",
      inputSchema: { projectId: ProjectId, taskId: TaskId },
      annotations: { title: "Send handoff to Hetzner", readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    }, async (input) => safely(services, "send_handoff_to_hetzner", { projectId: input.projectId, taskId: input.taskId, networked: true }, async () => {
      const tree = services.database.db.prepare(`
        SELECT task_id AS taskId, project_id AS projectId, path, branch, status, created_at AS createdAt
        FROM worktrees WHERE task_id=? AND project_id=?
      `).get(input.taskId, input.projectId) as WorktreeRecord | undefined;
      if (!tree || !new Set(["active", "committed"]).has(tree.status)) throw new WorkspaceError("NOT_FOUND", "Handoff task worktree not found");
      return services.handoffSender!.send(input.projectId, tree.path);
    }));
  }

  if (services.handoffInbox) {
    server.registerTool("list_incoming_handoffs", {
      description: "List verified Git bundles received from the paired Mac Project Files connector.",
      inputSchema: {}, annotations: { title: "List incoming handoffs", readOnlyHint: true, openWorldHint: false }
    }, async () => safely(services, "list_incoming_handoffs", {}, () => services.handoffInbox!.list()));

    server.registerTool("import_handoff", {
      description: "Import a verified Mac handoff as a new approved project below the Hetzner workspace root. The original bundle is archived.",
      inputSchema: { handoffId: TaskId, runtime: z.enum(["node", "python", "generic"]).default("generic") },
      annotations: { title: "Import handoff", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    }, async (input) => safely(services, "import_handoff", {}, async () => {
      const imported = await services.handoffInbox!.import(input.handoffId);
      const project = services.projects.register({
        id: imported.registeredProjectId,
        canonicalPath: imported.path,
        defaultBranch: imported.branch,
        runtime: input.runtime
      });
      return { ...imported, project };
    }));
  }

  server.registerTool("run_command", {
    description: "Start an asynchronous command in the task worktree. mode:'container' (default) runs inside a constrained disposable container with network disabled. mode:'host' (requires the operator to enable HOST_EXECUTION) runs directly on the host with the operator's toolchain (node, bun, pnpm, git), full network access and GUI capability — use it for dependency installs, dev servers, native/Electron builds and anything a normal terminal could do. Poll get_task and read_task_logs for progress.",
    inputSchema: RunCommandInput,
    annotations: { title: "Run command", readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async (input) => safely(services, "run_command", { projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}), networked: input.mode === "host" || input.network !== "none", detail: { mode: input.mode } }, async () => {
    if (!input.taskId) throw new WorkspaceError("VALIDATION", "taskId is required for execution");
    if (input.mode === "host" && services.config.HOST_EXECUTION !== "enabled") {
      throw new WorkspaceError("FORBIDDEN", "Host execution is disabled. The operator must set HOST_EXECUTION=enabled in the gateway environment.");
    }
    const project = services.projects.get(input.projectId);
    const tree = worktree(services.database, input.projectId, input.taskId);
    const timeoutSeconds = Math.min(input.timeoutSeconds ?? services.config.TASK_DEFAULT_TIMEOUT_SECONDS, services.config.TASK_MAX_TIMEOUT_SECONDS);
    const defaultImage = project.runtime === "python" ? "gptdev-runner-python:local" : "gptdev-runner-node:local";
    return services.tasks.start({ worktreeId: input.taskId, projectId: input.projectId, worktreePath: tree.path,
      image: input.mode === "host" ? "host" : input.image ?? defaultImage, mode: input.mode,
      executable: input.executable, args: input.args, network: input.network,
      limits: { memory: services.config.TASK_DEFAULT_MEMORY, cpus: services.config.TASK_DEFAULT_CPUS, pids: services.config.TASK_DEFAULT_PIDS, timeoutSeconds, maxOutputBytes: services.config.TASK_MAX_OUTPUT_BYTES }
    });
  }));

  server.registerTool("get_task", {
    description: "Read persistent task state.", inputSchema: { taskId: TaskId },
    annotations: { title: "Get task", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "get_task", { taskId: input.taskId }, () => services.tasks.get(input.taskId)));

  server.registerTool("read_task_logs", {
    description: "Read cursor-based redacted logs for a task.", inputSchema: { taskId: TaskId, cursor: z.number().int().min(0).default(0), maxBytes: z.number().int().min(1024).max(262144).default(65536) },
    annotations: { title: "Read task logs", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "read_task_logs", { taskId: input.taskId }, () => services.tasks.logs(input.taskId, input.cursor, input.maxBytes)));

  server.registerTool("cancel_task", {
    description: "Cancel a running task and its complete container process tree.", inputSchema: { taskId: TaskId },
    annotations: { title: "Cancel task", readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async (input) => safely(services, "cancel_task", { taskId: input.taskId, destructive: true }, () => services.tasks.cancel(input.taskId)));

  server.registerTool("list_artifacts", {
    description: "List indexed task artifacts and hashes.", inputSchema: { taskId: TaskId },
    annotations: { title: "List artifacts", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "list_artifacts", { taskId: input.taskId }, () => services.artifacts.list(input.taskId)));

  server.registerTool("start_dev_server", {
    description: "Start a managed development server inside a constrained container on an internal task-specific network. No host or public port is exposed.",
    inputSchema: {
      projectId: ProjectId, taskId: TaskId, executable: z.string().min(1).max(256),
      args: z.array(z.string().max(4096)).max(64).default([]), port: z.number().int().min(1024).max(65535).default(3000),
      image: z.string().max(256).optional()
    },
    annotations: { title: "Start dev server", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "start_dev_server", { projectId: input.projectId, taskId: input.taskId }, async () => {
    const tree = worktree(services.database, input.projectId, input.taskId);
    const project = services.projects.get(input.projectId);
    const defaultImage = project.runtime === "python" ? "gptdev-runner-python:local" : "gptdev-runner-node:local";
    return services.devServers.start({
      projectId: input.projectId, worktreeId: input.taskId, worktreePath: tree.path,
      image: input.image ?? defaultImage, executable: input.executable, args: input.args, port: input.port
    });
  }));

  server.registerTool("get_dev_server", {
    description: "Read the state and internal address metadata for a managed development server.",
    inputSchema: { serverId: TaskId }, annotations: { title: "Get dev server", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "get_dev_server", {}, () => services.devServers.get(input.serverId)));

  server.registerTool("stop_dev_server", {
    description: "Stop and remove a managed development-server container and its task-specific network.",
    inputSchema: { serverId: TaskId }, annotations: { title: "Stop dev server", readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async (input) => safely(services, "stop_dev_server", { destructive: true }, () => services.devServers.stop(input.serverId)));

  server.registerTool("run_browser_check", {
    description: "Run a bounded Playwright action list against a managed internal development server. Captures screenshots, trace, console errors, page errors and failed requests as task artifacts.",
    inputSchema: { projectId: ProjectId, taskId: TaskId, serverId: TaskId, actions: z.array(BrowserAction).min(1).max(100) },
    annotations: { title: "Run browser check", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "run_browser_check", { projectId: input.projectId, taskId: input.taskId }, async () => {
    const tree = worktree(services.database, input.projectId, input.taskId);
    const devServer = services.devServers.get(input.serverId);
    if (devServer.projectId !== input.projectId || devServer.worktreeId !== input.taskId || devServer.status !== "ready") {
      throw new WorkspaceError("CONFLICT", "Dev server is not ready for this worktree");
    }
    const executionId = randomUUID();
    const artifactDirectory = await services.artifacts.taskDirectory(executionId);
    await services.browser.createScript(artifactDirectory, input.actions, ["workspace.test"]);
    return services.tasks.start({
      executionId, worktreeId: input.taskId, projectId: input.projectId, worktreePath: tree.path,
      image: "gptdev-runner-browser:local", executable: "node", args: ["/artifacts/browser-check.mjs"],
      network: "restricted", networkName: devServer.networkName,
      limits: { memory: "2g", cpus: 1, pids: 256, timeoutSeconds: 120, maxOutputBytes: services.config.TASK_MAX_OUTPUT_BYTES }
    });
  }));

  server.registerTool("sync_project", {
    description: "Fast-forward a clean canonical project checkout from its fixed origin/default branch. Rejects dirty folders, branch changes and non-fast-forward updates.",
    inputSchema: { projectId: ProjectId },
    annotations: { title: "Sync project", readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async (input) => safely(services, "sync_project", { projectId: input.projectId, destructive: true, networked: true }, async () => {
    const project = services.projects.get(input.projectId);
    return services.git.sync(project.canonicalPath, project.defaultBranch);
  }));

  server.registerTool("publish_task", {
    description: "After explicit approval, publish an already committed and tested task by pushing its unique branch, fast-forwarding the fixed origin/default branch, and updating the canonical checkout. Never force-pushes.",
    inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Publish task", readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async (input) => safely(services, "publish_task", { projectId: input.projectId, taskId: input.taskId, destructive: true, networked: true }, async () => {
    const tree = worktreeRecord(services.database, input.projectId, input.taskId);
    if (tree.status !== "committed") throw new WorkspaceError("CONFLICT", "Only an already committed and tested task can be published");
    const project = services.projects.get(input.projectId);
    const commit = await services.git.head(tree.path);
    const published = await services.git.promote(project.canonicalPath, tree.path, tree.branch, project.defaultBranch);
    services.database.db.prepare("UPDATE worktrees SET status='published' WHERE task_id=?").run(input.taskId);
    return { commit, ...published };
  }));

  server.registerTool("commit_task", {
    description: "Stage and commit all task-worktree changes after explicit user approval. Does not push or merge.",
    inputSchema: { projectId: ProjectId, taskId: TaskId, message: z.string().min(1).max(500) },
    annotations: { title: "Commit task", readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async (input) => safely(services, "commit_task", { projectId: input.projectId, taskId: input.taskId, destructive: true }, async () => {
    const tree = worktree(services.database, input.projectId, input.taskId);
    const commit = await services.git.commit(tree.path, input.message);
    services.database.db.prepare("UPDATE worktrees SET status='committed' WHERE task_id=?").run(input.taskId);
    return { commit, branch: tree.branch };
  }));

  server.registerTool("rollback_task", {
    description: "Permanently discard an uncommitted task worktree and delete its task branch. Audit logs and artifacts remain.",
    inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Roll back task", readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async (input) => safely(services, "rollback_task", { projectId: input.projectId, taskId: input.taskId, destructive: true }, async () => {
    const tree = worktree(services.database, input.projectId, input.taskId);
    const task = services.database.db.prepare("SELECT status FROM tasks WHERE worktree_id=? AND status IN ('queued','preparing','running') LIMIT 1").get(input.taskId) as { status: string } | undefined;
    if (task) throw new WorkspaceError("CONFLICT", "Stop active worktree tasks before rollback");
    await services.git.discard(services.projects.get(input.projectId).canonicalPath, tree.path, tree.branch);
    services.database.db.prepare("UPDATE worktrees SET status='discarded' WHERE task_id=?").run(input.taskId);
    return { discarded: true, branch: tree.branch };
  }));

  return server;
}
