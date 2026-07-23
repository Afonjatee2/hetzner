import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { request } from "undici";
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
import { NEW_FILE_SHA256, type WorkspaceRecord, type WorkspaceService } from "@gpt-dev/workspace-service";
import type { Config } from "./config.js";
import {
  createElectronEnvironment, hasPreparedNodeDependencies, requiresPreparedNodeDependencies, resolveTaskCheckPreset,
  type TaskCheckPreset
} from "./execution-policy.js";

export interface Services {
  config: Config;
  database: WorkspaceDatabase;
  projects: ProjectService;
  git: GitService;
  runner: DockerSandboxRunner;
  tasks: TaskService;
  workspaces: WorkspaceService;
  artifacts: ArtifactService;
  browser: BrowserService;
  devServers: DevServerService;
  handoffSender: HandoffSender | undefined;
  handoffInbox: HandoffInbox | undefined;
  skills: SkillsService | undefined;
}

function workspace(services: Services, projectId: string, taskId: string): WorkspaceRecord {
  return services.workspaces.get(projectId, taskId);
}

function updateWorkspaceStatus(services: Services, taskId: string, status: string): void {
  services.database.db.prepare("UPDATE task_workspaces SET status=?, active_path=CASE WHEN ?='active' THEN active_path ELSE NULL END WHERE task_id=?")
    .run(status, status, taskId);
  services.database.db.prepare("UPDATE worktrees SET status=? WHERE task_id=?").run(status, taskId);
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
  return taskId ? workspace(services, projectId, taskId).path : services.projects.get(projectId).canonicalPath;
}

export function createMcpServer(services: Services): McpServer {
  const server = new McpServer({ name: services.config.GATEWAY_NAME, version: "0.1.0" }, { capabilities: { logging: {} } });

  server.registerTool("system_health", {
    description: "Read gateway, SQLite, workspace and Docker runner health. Makes no changes.",
    inputSchema: {}, annotations: { title: "System health", readOnlyHint: true, openWorldHint: false }
  }, async () => safely(services, "system_health", {}, async () => ({
    gateway: "ok", database: services.database.db.prepare("SELECT 1 AS ok").get(), docker: await services.runner.health(),
    registryNetwork: await services.runner.registryNetworkHealth(),
    hostExecution: services.config.HOST_EXECUTION, agentExecution: services.config.AGENT_EXECUTION,
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
  }, async (input) => safely(services, "project_tree", { projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}) }, () => {
    if (input.taskId) services.workspaces.requireCapability(input.projectId, input.taskId, "read");
    return services.projects.tree(rootFor(services, input.projectId, input.taskId), input.path, input.maxEntries, input.maxDepth);
  }));

  server.registerTool("read_file", {
    description: "Read a bounded UTF-8 text file from an approved project or active task worktree. Rejects binaries and path escapes.",
    inputSchema: { projectId: ProjectId, taskId: TaskId.optional(), path: RelativePath, maxBytes: z.number().int().min(1).max(2_000_000).default(1_000_000) },
    annotations: { title: "Read file", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "read_file", { projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}) }, async () => {
    const root = rootFor(services, input.projectId, input.taskId);
    if (!input.taskId) return services.projects.readText(root, input.path, input.maxBytes);
    const target = services.workspaces.requireCapability(input.projectId, input.taskId, "read");
    if (target.kind === "isolated") return services.projects.readText(root, input.path, input.maxBytes);
    const state = await services.workspaces.fileState(root, input.path, true, input.maxBytes);
    return { content: state.content, sha256: state.sha256, bytes: state.bytes };
  }));

  server.registerTool("search_code", {
    description: "Search text with ripgrep inside an approved project or active task worktree. Results are bounded.",
    inputSchema: { projectId: ProjectId, taskId: TaskId.optional(), pattern: z.string().min(1).max(512), maxResults: z.number().int().min(1).max(1000).default(200) },
    annotations: { title: "Search code", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "search_code", { projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}) }, () => {
    if (input.taskId) services.workspaces.requireCapability(input.projectId, input.taskId, "read");
    return services.projects.search(rootFor(services, input.projectId, input.taskId), input.pattern, input.maxResults);
  }));

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
    const originalHead = await services.git.head(created.path);
    const record = { taskId, projectId: project.id, path: created.path, branch: created.branch, originalHead, status: "active", createdAt: new Date().toISOString() };
    services.database.db.transaction(() => {
      services.database.db.prepare(`INSERT INTO worktrees (task_id, project_id, path, branch, status, created_at) VALUES (@taskId,@projectId,@path,@branch,@status,@createdAt)`).run(record);
      services.workspaces.recordIsolated(record);
    })();
    return services.workspaces.get(project.id, taskId);
  }));

  server.registerTool("attach_existing_checkout", {
    description: "Attach a task to the exact registered checkout without creating a branch or worktree. Captures a complete dirty baseline outside the repository first.",
    inputSchema: {
      projectId: ProjectId,
      expectedBranch: z.string().min(1).max(256).refine((value) => !value.includes("\0")),
      preserveDirtyState: z.literal(true),
      allowHostExecution: z.boolean().optional()
    },
    annotations: { title: "Attach existing checkout", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "attach_existing_checkout", { projectId: input.projectId }, async () => {
    if (input.allowHostExecution === true && services.config.HOST_EXECUTION !== "enabled") {
      throw new WorkspaceError("FORBIDDEN", "Host execution requires HOST_EXECUTION=enabled on the gateway");
    }
    return services.workspaces.attach({
      project: services.projects.get(input.projectId),
      expectedBranch: input.expectedBranch,
      preserveDirtyState: input.preserveDirtyState,
      ...(input.allowHostExecution === undefined ? {} : { allowHostExecution: input.allowHostExecution })
    });
  }));

  server.registerTool("write_file", {
    description: "Create or replace a UTF-8 file atomically inside an active task worktree. Never writes to a canonical checkout.",
    inputSchema: { projectId: ProjectId, taskId: TaskId, path: RelativePath, content: z.string().max(2_000_000) },
    annotations: { title: "Write file", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "write_file", { projectId: input.projectId, taskId: input.taskId }, async () => {
    services.workspaces.requireCapability(input.projectId, input.taskId, "write");
    services.workspaces.requireIsolated(input.projectId, input.taskId, "write_file");
    await services.projects.writeText(rootFor(services, input.projectId, input.taskId), input.path, input.content);
    return { path: input.path, bytes: Buffer.byteLength(input.content) };
  }));

  server.registerTool("patch_file", {
    description: `Optimistically edit one UTF-8 file using bounded exact replacements. expectedSha256 must come from read_file; use ${NEW_FILE_SHA256} only for a new file.`,
    inputSchema: {
      projectId: ProjectId, taskId: TaskId, path: RelativePath,
      expectedSha256: z.union([z.string().regex(/^[a-f0-9]{64}$/), z.literal(NEW_FILE_SHA256)]),
      replacements: z.array(z.object({
        oldText: z.string().max(1_000_000),
        newText: z.string().max(1_000_000)
      })).min(1).max(100)
    },
    annotations: { title: "Patch file", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "patch_file", { projectId: input.projectId, taskId: input.taskId }, () =>
    services.workspaces.patchFile(input)));

  server.registerTool("delete_path", {
    description: "Delete a file or directory only inside an active task worktree. This is destructive and cannot target the worktree root.",
    inputSchema: {
      projectId: ProjectId, taskId: TaskId, path: RelativePath,
      expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional()
    },
    annotations: { title: "Delete path", readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async (input) => safely(services, "delete_path", { projectId: input.projectId, taskId: input.taskId, destructive: true }, async () => {
    const target = workspace(services, input.projectId, input.taskId);
    if (target.kind === "attached" && !input.expectedSha256) {
      throw new WorkspaceError("VALIDATION", "expectedSha256 from read_file is required when deleting from an attached workspace");
    }
    await services.workspaces.assertDeleteHash(
      input.projectId, input.taskId, input.path, input.expectedSha256 ?? NEW_FILE_SHA256
    );
    await services.projects.remove(rootFor(services, input.projectId, input.taskId), input.path); return { deleted: input.path };
  }));

  server.registerTool("git_status", {
    description: "Read Git status for an active task worktree.", inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Git status", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "git_status", { projectId: input.projectId, taskId: input.taskId }, () => {
    services.workspaces.requireCapability(input.projectId, input.taskId, "read");
    return services.git.status(rootFor(services, input.projectId, input.taskId));
  }));

  server.registerTool("git_diff", {
    description: "Read the bounded Git diff for an active task worktree.", inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Git diff", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "git_diff", { projectId: input.projectId, taskId: input.taskId }, () => {
    services.workspaces.requireCapability(input.projectId, input.taskId, "read");
    return services.git.diff(rootFor(services, input.projectId, input.taskId));
  }));

  server.registerTool("changes_since_attachment", {
    description: "Classify live filesystem changes against the captured attachment baseline, including pre-existing, concurrent, new, deleted, mode and symlink changes.",
    inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Changes since attachment", readOnlyHint: true, openWorldHint: false }
  }, async (input) => safely(services, "changes_since_attachment", { projectId: input.projectId, taskId: input.taskId }, () =>
    services.workspaces.changesSinceAttachment(input.projectId, input.taskId)));

  server.registerTool("close_attached_task", {
    description: "Cancel active child executions, capture/index a final manifest, release checkout ownership, and close an attached task without changing repository files or Git state.",
    inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Close attached task", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "close_attached_task", { projectId: input.projectId, taskId: input.taskId }, () =>
    services.workspaces.close(input.projectId, input.taskId)));

  if (services.handoffSender) {
    server.registerTool("send_handoff_to_hetzner", {
      description: "Stream a clean committed task branch to the fixed Hetzner handoff inbox over a restricted SSH identity. The destination cannot be changed by tool input.",
      inputSchema: { projectId: ProjectId, taskId: TaskId },
      annotations: { title: "Send handoff to Hetzner", readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    }, async (input) => safely(services, "send_handoff_to_hetzner", { projectId: input.projectId, taskId: input.taskId, networked: true }, async () => {
      const tree = services.workspaces.requireIsolated(input.projectId, input.taskId, "handoff publishing", false);
      if (!new Set(["active", "committed"]).has(tree.status)) throw new WorkspaceError("NOT_FOUND", "Handoff task worktree not found");
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

  server.registerTool("prepare_task", {
    description: "Install project dependencies inside the task worktree container using the registry-only network and a persistent pnpm store volume. Run this before run_command checks (lint, typecheck, test) so node_modules exists. Requires PNPM_STORE_DIR to be configured.",
    inputSchema: { projectId: ProjectId, taskId: TaskId, timeoutSeconds: z.number().int().min(30).max(3600).default(600) },
    annotations: { title: "Prepare task dependencies", readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async (input) => safely(services, "prepare_task", { projectId: input.projectId, taskId: input.taskId, networked: true }, async () => {
    services.workspaces.requireIsolated(input.projectId, input.taskId, "prepare_task");
    if (!services.config.PNPM_STORE_DIR) throw new WorkspaceError("FORBIDDEN", "PNPM_STORE_DIR is not configured in the gateway environment");
    const registryNetwork = await services.runner.registryNetworkHealth();
    if (!registryNetwork.ok) {
      throw new WorkspaceError(
        "EXECUTION_FAILED",
        `Dependency preparation is unavailable because Docker network ${registryNetwork.name} is missing or inaccessible. Restart gpt-dev-registry-rules.service before retrying.`,
        true,
        { network: registryNetwork.name, cause: registryNetwork.error }
      );
    }
    const tree = workspace(services, input.projectId, input.taskId);
    const project = services.projects.get(input.projectId);
    const image = project.runtime === "python" ? "gptdev-runner-python:local" : "gptdev-runner-node:local";
    const executable = project.runtime === "python" ? "pip" : "pnpm";
    const args = project.runtime === "python"
      ? ["install", "-r", "requirements.txt", "--quiet"]
      : ["install", "--frozen-lockfile", "--store-dir", "/pnpm-store"];
    const timeoutSeconds = Math.min(input.timeoutSeconds, services.config.TASK_MAX_TIMEOUT_SECONDS);
    return services.tasks.start({
      worktreeId: input.taskId, projectId: input.projectId, worktreePath: tree.path,
      image, executable, args, network: "registry",
      extraMounts: [{ source: services.config.PNPM_STORE_DIR, target: "/pnpm-store" }],
      limits: { memory: services.config.TASK_DEFAULT_MEMORY, cpus: services.config.TASK_DEFAULT_CPUS, pids: services.config.TASK_DEFAULT_PIDS, timeoutSeconds, maxOutputBytes: services.config.TASK_MAX_OUTPUT_BYTES }
    });
  }));

  server.registerTool("run_command", {
    description: "Start an asynchronous command in the task worktree. mode:'container' (default) runs inside a constrained disposable container with network disabled. mode:'host' (requires the operator to enable HOST_EXECUTION) runs directly on the host with the operator's toolchain (node, bun, pnpm, git), full network access and GUI capability — use it for dependency installs, dev servers, native/Electron builds and anything a normal terminal could do. Poll get_task and read_task_logs for progress.",
    inputSchema: RunCommandInput,
    annotations: { title: "Run command", readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async (input) => safely(services, "run_command", { projectId: input.projectId, ...(input.taskId ? { taskId: input.taskId } : {}), networked: input.mode === "host" || input.network !== "none", detail: { mode: input.mode } }, async () => {
    if (!input.taskId) throw new WorkspaceError("VALIDATION", "taskId is required for execution");
    services.workspaces.requireIsolated(input.projectId, input.taskId, "Unrestricted run_command");
    if (input.mode === "host" && services.config.HOST_EXECUTION !== "enabled") {
      throw new WorkspaceError("FORBIDDEN", "Host execution is disabled. The operator must set HOST_EXECUTION=enabled in the gateway environment.");
    }
    const project = services.projects.get(input.projectId);
    const tree = workspace(services, input.projectId, input.taskId);
    if (requiresPreparedNodeDependencies(project.runtime, input.mode, input.executable, input.args)
      && !await hasPreparedNodeDependencies(tree.path)) {
      throw new WorkspaceError(
        "CONFLICT",
        "Node dependencies are not prepared for this worktree. Run prepare_task successfully before lint, typecheck, test or build commands."
      );
    }
    const timeoutSeconds = Math.min(input.timeoutSeconds ?? services.config.TASK_DEFAULT_TIMEOUT_SECONDS, services.config.TASK_MAX_TIMEOUT_SECONDS);
    const defaultImage = project.runtime === "python" ? "gptdev-runner-python:local" : "gptdev-runner-node:local";
    return services.tasks.start({ worktreeId: input.taskId, projectId: input.projectId, worktreePath: tree.path,
      image: input.mode === "host" ? "host" : input.image ?? defaultImage, mode: input.mode,
      executable: input.executable, args: input.args, network: input.network,
      limits: { memory: services.config.TASK_DEFAULT_MEMORY, cpus: services.config.TASK_DEFAULT_CPUS, pids: services.config.TASK_DEFAULT_PIDS, timeoutSeconds, maxOutputBytes: services.config.TASK_MAX_OUTPUT_BYTES }
    });
  }));

  const CheckPreset = z.enum([
    "node-version", "pnpm-version", "git-diff-check", "typecheck", "lint", "tests", "electron-acceptance"
  ]);
  server.registerTool("run_task_check", {
    description: "Run one server-approved check preset for an active workspace. Attached workspaces cannot supply executable or argv.",
    inputSchema: {
      projectId: ProjectId, taskId: TaskId, preset: CheckPreset,
      mode: z.enum(["container", "host"]).default("container"),
      timeoutSeconds: z.number().int().min(5).max(3600).optional()
    },
    annotations: { title: "Run task check", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "run_task_check", {
    projectId: input.projectId, taskId: input.taskId,
    networked: input.mode === "host", detail: { preset: input.preset, mode: input.mode }
  }, async () => {
    const tree = workspace(services, input.projectId, input.taskId);
    const project = services.projects.get(input.projectId);
    const preset = input.preset as TaskCheckPreset;
    const mode = preset === "electron-acceptance" ? "host" : input.mode;
    services.workspaces.requireCapability(
      input.projectId, input.taskId, mode === "host" ? "runHostCommands" : "runContainerCommands"
    );
    if (mode === "host" && services.config.HOST_EXECUTION !== "enabled") {
      throw new WorkspaceError("FORBIDDEN", "Host checks require both workspace permission and HOST_EXECUTION=enabled");
    }
    if (preset === "electron-acceptance") {
      if (tree.kind !== "attached") throw new WorkspaceError("FORBIDDEN", "Native Electron acceptance is only available for attached workspaces");
      if (process.platform !== "darwin") throw new WorkspaceError("FORBIDDEN", "Native Electron acceptance requires macOS");
    }
    const command = await resolveTaskCheckPreset(tree.path, preset);
    const executionId = randomUUID();
    let env: Record<string, string> | undefined;
    if (preset === "electron-acceptance") {
      const root = await services.artifacts.taskDirectory(executionId);
      env = await createElectronEnvironment(root);
    }
    const defaultImage = project.runtime === "python" ? "gptdev-runner-python:local" : "gptdev-runner-node:local";
    return services.tasks.start({
      executionId, worktreeId: input.taskId, projectId: input.projectId, worktreePath: tree.path,
      image: mode === "host" ? "host" : defaultImage, mode,
      executable: command.executable, args: command.args, network: "none",
      ...(env ? { env } : {}),
      limits: {
        memory: services.config.TASK_DEFAULT_MEMORY, cpus: services.config.TASK_DEFAULT_CPUS,
        pids: services.config.TASK_DEFAULT_PIDS,
        timeoutSeconds: Math.min(input.timeoutSeconds ?? services.config.TASK_DEFAULT_TIMEOUT_SECONDS, services.config.TASK_MAX_TIMEOUT_SECONDS),
        maxOutputBytes: services.config.TASK_MAX_OUTPUT_BYTES
      }
    });
  }));

  server.registerTool("execute_plan", {
    description: "Hand a complete implementation plan to a local coding agent (Claude Code CLI) that executes it autonomously inside the task worktree: it reads the repo, edits files, runs commands and iterates on failures at native speed. One call replaces the per-edit tool loop — write a precise plan (exact files, exact changes, acceptance checks), then poll get_task and read_task_logs (stream-json events) for progress, and review with git_diff before commit_task. backend 'ccr' (default) routes the agent through the local claude-code-router models; 'subscription' uses the operator's own Claude account. Requires the operator to enable AGENT_EXECUTION.",
    inputSchema: {
      projectId: ProjectId, taskId: TaskId,
      plan: z.string().min(20).max(200_000),
      backend: z.enum(["ccr", "subscription"]).default("ccr"),
      model: z.string().max(128).optional(),
      timeoutSeconds: z.number().int().min(60).max(86400).default(3600)
    },
    annotations: { title: "Execute plan with local agent", readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async (input) => safely(services, "execute_plan", { projectId: input.projectId, taskId: input.taskId, networked: true, detail: { backend: input.backend, planBytes: Buffer.byteLength(input.plan) } }, async () => {
    services.workspaces.requireIsolated(
      input.projectId, input.taskId,
      "Unrestricted agent execution is only available in isolated worktrees"
    );
    if (services.config.AGENT_EXECUTION !== "enabled") {
      throw new WorkspaceError("FORBIDDEN", "Agent execution is disabled. The operator must set AGENT_EXECUTION=enabled in the gateway environment.");
    }
    const tree = workspace(services, input.projectId, input.taskId);
    const executionId = randomUUID();
    const artifactDirectory = await services.artifacts.taskDirectory(executionId);
    const planPath = join(artifactDirectory, "plan.md");
    await writeFile(planPath, input.plan, "utf8");
    const prompt = [
      `Execute the implementation plan stored at ${planPath}. Read it fully before changing anything.`,
      "Work only inside the current directory, which is an isolated git worktree for this task.",
      "Implement the plan exactly, run the acceptance checks it defines, and fix failures until they pass.",
      "If dependency preparation or another prerequisite fails, stop dependent checks and report the infrastructure failure clearly instead of treating them as code failures.",
      "Never run git push, never publish, and never modify files outside the worktree.",
      "Finish with a concise summary of the changes made and the final check results."
    ].join(" ");
    const env: Record<string, string> = input.backend === "ccr"
      ? { ANTHROPIC_BASE_URL: services.config.AGENT_BACKEND_BASE_URL, ANTHROPIC_API_KEY: services.config.AGENT_BACKEND_API_KEY ?? "local" }
      : {};
    return services.tasks.start({
      executionId, worktreeId: input.taskId, projectId: input.projectId, worktreePath: tree.path,
      image: "host", mode: "host",
      executable: services.config.AGENT_CLI_PATH,
      args: ["--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", ...(input.model ? ["--model", input.model] : []), "-p", prompt],
      network: "none", env,
      limits: { memory: services.config.TASK_DEFAULT_MEMORY, cpus: services.config.TASK_DEFAULT_CPUS, pids: services.config.TASK_DEFAULT_PIDS,
        timeoutSeconds: Math.min(input.timeoutSeconds, services.config.TASK_MAX_TIMEOUT_SECONDS), maxOutputBytes: services.config.TASK_MAX_OUTPUT_BYTES }
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
  }, async (input) => safely(services, "list_artifacts", { taskId: input.taskId }, () => {
    const workspaceExists = services.database.db.prepare("SELECT 1 FROM task_workspaces WHERE task_id=?").get(input.taskId);
    return workspaceExists ? services.workspaces.listArtifacts(input.taskId) : services.artifacts.list(input.taskId);
  }));

  server.registerTool("start_dev_server", {
    description: "Start a managed development server inside a constrained container on an internal task-specific network. No host or public port is exposed.",
    inputSchema: {
      projectId: ProjectId, taskId: TaskId, executable: z.string().min(1).max(256),
      args: z.array(z.string().max(4096)).max(64).default([]), port: z.number().int().min(1024).max(65535).default(3000),
      image: z.string().max(256).optional()
    },
    annotations: { title: "Start dev server", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async (input) => safely(services, "start_dev_server", { projectId: input.projectId, taskId: input.taskId }, async () => {
    services.workspaces.requireIsolated(input.projectId, input.taskId, "start_dev_server");
    const tree = workspace(services, input.projectId, input.taskId);
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
    services.workspaces.requireIsolated(input.projectId, input.taskId, "run_browser_check");
    const tree = workspace(services, input.projectId, input.taskId);
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
    inputSchema: { projectId: ProjectId, taskId: TaskId.optional() },
    annotations: { title: "Sync project", readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async (input) => safely(services, "sync_project", { projectId: input.projectId, destructive: true, networked: true }, async () => {
    if (input.taskId) services.workspaces.requireIsolated(input.projectId, input.taskId, "project synchronisation");
    services.workspaces.assertNoActiveAttachment(input.projectId, "Project synchronisation");
    const project = services.projects.get(input.projectId);
    return services.git.sync(project.canonicalPath, project.defaultBranch);
  }));

  server.registerTool("publish_task", {
    description: "After explicit approval, publish an already committed and tested task by pushing its unique branch, fast-forwarding the fixed origin/default branch, and updating the canonical checkout. Never force-pushes.",
    inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Publish task", readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async (input) => safely(services, "publish_task", { projectId: input.projectId, taskId: input.taskId, destructive: true, networked: true }, async () => {
    const tree = services.workspaces.requireIsolated(input.projectId, input.taskId, "publish_task", false);
    if (tree.status !== "committed") throw new WorkspaceError("CONFLICT", "Only an already committed and tested task can be published");
    const project = services.projects.get(input.projectId);
    const commit = await services.git.head(tree.path);
    const published = await services.git.promote(project.canonicalPath, tree.path, tree.branch, project.defaultBranch);
    updateWorkspaceStatus(services, input.taskId, "published");
    return { commit, ...published };
  }));

  server.registerTool("create_pull_request", {
    description: "Push the committed task branch and open a GitHub pull request against the project's default branch. Creates a draft PR by default. Requires GITHUB_TOKEN in the gateway environment.",
    inputSchema: {
      projectId: ProjectId, taskId: TaskId,
      title: z.string().min(1).max(256),
      body: z.string().max(65_536).default(""),
      draft: z.boolean().default(true),
      base: z.string().max(128).optional()
    },
    annotations: { title: "Create pull request", readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async (input) => safely(services, "create_pull_request", { projectId: input.projectId, taskId: input.taskId, networked: true }, async () => {
    const tree = services.workspaces.requireIsolated(input.projectId, input.taskId, "create_pull_request", false);
    if (!services.config.GITHUB_TOKEN) throw new WorkspaceError("FORBIDDEN", "GITHUB_TOKEN is not configured in the gateway environment");
    if (tree.status !== "committed") throw new WorkspaceError("CONFLICT", "Only an already committed task can open a pull request");
    const project = services.projects.get(input.projectId);
    const base = input.base ?? project.defaultBranch;

    await services.git.pushBranch(tree.path, tree.branch);

    const remoteUrl = await services.git.remoteUrl(tree.path);
    const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) throw new WorkspaceError("VALIDATION", `Cannot parse GitHub owner/repo from remote: ${remoteUrl}`);
    const [, owner, repo] = match;

    const response = await request(`${services.config.GITHUB_API_BASE}/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${services.config.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ title: input.title, body: input.body, head: tree.branch, base, draft: input.draft })
    });
    const result = await response.body.json() as Record<string, unknown>;
    if (response.statusCode >= 400) {
      throw new WorkspaceError("EXECUTION_FAILED", `GitHub API ${String(response.statusCode)}: ${JSON.stringify(result)}`);
    }
    updateWorkspaceStatus(services, input.taskId, "published");
    return { number: result.number, url: result.html_url, state: result.state, draft: result.draft, branch: tree.branch, base };
  }));

  server.registerTool("merge_pull_request", {
    description: "Merge an open GitHub pull request for the project via the GitHub API using GITHUB_TOKEN. Defaults to a squash merge; the head branch is not deleted. Merge permission and required-check failures come back as errors. Requires GITHUB_TOKEN in the gateway environment.",
    inputSchema: {
      projectId: ProjectId,
      taskId: TaskId.optional(),
      pullNumber: z.number().int().min(1),
      method: z.enum(["merge", "squash", "rebase"]).default("squash"),
      commitTitle: z.string().min(1).max(256).optional()
    },
    annotations: { title: "Merge pull request", readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async (input) => safely(services, "merge_pull_request", { projectId: input.projectId, destructive: true, networked: true, detail: { pullNumber: input.pullNumber, method: input.method } }, async () => {
    if (input.taskId) services.workspaces.requireIsolated(input.projectId, input.taskId, "merge_pull_request", false);
    services.workspaces.assertNoActiveAttachment(input.projectId, "Pull-request merging");
    if (!services.config.GITHUB_TOKEN) throw new WorkspaceError("FORBIDDEN", "GITHUB_TOKEN is not configured in the gateway environment");
    const project = services.projects.get(input.projectId);

    const remoteUrl = await services.git.remoteUrl(project.canonicalPath);
    const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) throw new WorkspaceError("VALIDATION", `Cannot parse GitHub owner/repo from remote: ${remoteUrl}`);
    const [, owner, repo] = match;

    const response = await request(`${services.config.GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${input.pullNumber}/merge`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${services.config.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ merge_method: input.method, ...(input.commitTitle ? { commit_title: input.commitTitle } : {}) })
    });
    const result = await response.body.json() as Record<string, unknown>;
    if (response.statusCode >= 400) {
      throw new WorkspaceError("EXECUTION_FAILED", `GitHub API ${String(response.statusCode)}: ${JSON.stringify(result)}`);
    }
    return { merged: true, sha: result.sha, message: result.message };
  }));

  server.registerTool("commit_task", {
    description: "Stage and commit all task-worktree changes after explicit user approval. Does not push or merge.",
    inputSchema: { projectId: ProjectId, taskId: TaskId, message: z.string().min(1).max(500) },
    annotations: { title: "Commit task", readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async (input) => safely(services, "commit_task", { projectId: input.projectId, taskId: input.taskId, destructive: true }, async () => {
    const tree = services.workspaces.requireIsolated(input.projectId, input.taskId, "commit_task");
    const commit = await services.git.commit(tree.path, input.message);
    updateWorkspaceStatus(services, input.taskId, "committed");
    return { commit, branch: tree.branch };
  }));

  server.registerTool("rollback_task", {
    description: "Permanently discard an uncommitted task worktree and delete its task branch. Audit logs and artifacts remain.",
    inputSchema: { projectId: ProjectId, taskId: TaskId },
    annotations: { title: "Roll back task", readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async (input) => safely(services, "rollback_task", { projectId: input.projectId, taskId: input.taskId, destructive: true }, async () => {
    const tree = services.workspaces.requireIsolated(input.projectId, input.taskId, "rollback_task");
    const task = services.database.db.prepare("SELECT status FROM tasks WHERE worktree_id=? AND status IN ('queued','preparing','running') LIMIT 1").get(input.taskId) as { status: string } | undefined;
    if (task) throw new WorkspaceError("CONFLICT", "Stop active worktree tasks before rollback");
    await services.git.discard(services.projects.get(input.projectId).canonicalPath, tree.path, tree.branch);
    updateWorkspaceStatus(services, input.taskId, "discarded");
    return { discarded: true, branch: tree.branch };
  }));

  return server;
}
