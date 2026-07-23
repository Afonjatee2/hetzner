import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactService } from "@gpt-dev/artifact-service";
import { WorkspaceDatabase } from "@gpt-dev/persistence";
import { ProjectService } from "@gpt-dev/projects";
import type { SandboxCallbacks, SandboxRequest, SandboxResult, TaskRunner } from "@gpt-dev/sandbox-runner";
import { TaskService, type TaskRecord } from "@gpt-dev/task-service";
import {
  EXTERNAL_AGENT_DISABLED_MESSAGE,
  WorkspaceService
} from "@gpt-dev/workspace-service";
import { EXECUTE_PLAN_DESCRIPTION } from "./tools.js";

const roots: string[] = [];
const limits = { memory: "1g", cpus: 1, pids: 32, timeoutSeconds: 30, maxOutputBytes: 65_536 };

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolvePromise(stdout.trimEnd())
      : reject(new Error(stderr.trim() || `git exited ${String(code)}`)));
  });
}

class ControllableRunner implements TaskRunner {
  private readonly outcomes: Array<{ kind: "result"; exitCode: number } | { kind: "block" }> = [];
  private readonly blocked = new Map<string, (result: SandboxResult) => void>();

  enqueueResult(exitCode: number): void {
    this.outcomes.push({ kind: "result", exitCode });
  }

  enqueueBlock(): void {
    this.outcomes.push({ kind: "block" });
  }

  async run(request: SandboxRequest, callbacks: SandboxCallbacks): Promise<SandboxResult> {
    callbacks.onContainer(`fake-${request.taskId}`);
    const outcome = this.outcomes.shift() ?? { kind: "result" as const, exitCode: 0 };
    if (outcome.kind === "result") {
      return { containerId: `fake-${request.taskId}`, exitCode: outcome.exitCode, timedOut: false, outputTruncated: false };
    }
    return await new Promise<SandboxResult>((resolvePromise) => {
      this.blocked.set(request.taskId, resolvePromise);
    });
  }

  cancel(taskId: string): Promise<void> {
    const resolvePromise = this.blocked.get(taskId);
    if (!resolvePromise) return Promise.reject(new Error(`No blocked task: ${taskId}`));
    this.blocked.delete(taskId);
    resolvePromise({ containerId: `fake-${taskId}`, exitCode: 130, timedOut: false, outputTruncated: false });
    return Promise.resolve();
  }
}

interface Fixture {
  root: string;
  workspacePath: string;
  database: WorkspaceDatabase;
  workspaces: WorkspaceService;
  tasks: TaskService;
  runner: ControllableRunner;
  projectId: string;
  taskId: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "gptdev-execution-mode-"));
  roots.push(root);
  const workspacePath = join(root, "project");
  await mkdir(workspacePath);
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.name", "Fixture User"]);
  await git(workspacePath, ["config", "user.email", "fixture@example.com"]);
  await writeFile(join(workspacePath, "source.txt"), "small task\n");
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "base"]);
  const database = new WorkspaceDatabase(join(root, "state", "app.db"));
  const projects = new ProjectService(database, root);
  const project = projects.register({
    id: "execution-fixture",
    canonicalPath: workspacePath,
    defaultBranch: "main",
    runtime: "node"
  });
  const artifacts = new ArtifactService(database, join(root, "artifacts"));
  const runner = new ControllableRunner();
  const taskHolder: { service?: TaskService } = {};
  const workspaces = new WorkspaceService(database, join(root, "artifacts"), {
    perFileBytes: 1_000_000,
    totalBytes: 5_000_000,
    gitOutputBytes: 5_000_000
  }, (workspaceId) => {
    if (!taskHolder.service) throw new Error("Task service is not initialised");
    return taskHolder.service.cancelWorkspace(workspaceId);
  });
  const tasks = new TaskService(database, runner, artifacts, runner, (task) => {
    workspaces.resetExternalAgentExecution(task.projectId, task.worktreeId, `execution_${task.status}`);
  });
  taskHolder.service = tasks;
  const taskId = randomUUID();
  workspaces.recordIsolated({
    taskId,
    projectId: project.id,
    path: workspacePath,
    branch: `task-${taskId}`,
    originalHead: await git(workspacePath, ["rev-parse", "HEAD"]),
    createdAt: new Date().toISOString()
  });
  return { root, workspacePath, database, workspaces, tasks, runner, projectId: project.id, taskId };
}

async function waitForTerminal(tasks: TaskService, executionId: string): Promise<TaskRecord> {
  for (let index = 0; index < 200; index += 1) {
    const task = tasks.get(executionId);
    if (!new Set(["queued", "preparing", "running"]).has(task.status)) return tasks.waitForCompletion(executionId);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Execution did not finish: ${executionId}`);
}

async function startExecution(value: Fixture, executionMode: "direct" | "external_agent"): Promise<TaskRecord> {
  return value.tasks.start({
    worktreeId: value.taskId,
    projectId: value.projectId,
    worktreePath: value.workspacePath,
    executionMode,
    image: "fixture",
    executable: "node",
    args: ["--version"],
    network: "none",
    limits
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("explicit task execution modes", () => {
  it("defaults new isolated tasks to direct and keeps direct edit/command workflows unchanged", async () => {
    const value = await fixture();
    const initial = value.workspaces.get(value.projectId, value.taskId);
    expect(initial.executionMode).toBe("direct");
    expect(initial.providerProfile).toBeUndefined();

    const observed = await value.workspaces.fileState(value.workspacePath, "source.txt");
    await value.workspaces.patchFile({
      projectId: value.projectId,
      taskId: value.taskId,
      path: "source.txt",
      expectedSha256: observed.sha256,
      replacements: [{ oldText: "small task", newText: `complex task ${"x".repeat(50_000)}` }]
    });
    expect(value.workspaces.get(value.projectId, value.taskId).executionMode).toBe("direct");

    value.runner.enqueueResult(0);
    const started = await startExecution(value, "direct");
    const finished = await waitForTerminal(value.tasks, started.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.executionMode).toBe("direct");
    expect(value.workspaces.get(value.projectId, value.taskId).executionMode).toBe("direct");
    value.database.close();
  });

  it("rejects execute_plan in direct mode with the required message and never infers a provider", async () => {
    const value = await fixture();
    expect(() => value.workspaces.requireExternalAgentExecution(value.projectId, value.taskId))
      .toThrow(EXTERNAL_AGENT_DISABLED_MESSAGE);
    expect(() => value.workspaces.setExecutionMode({
      projectId: value.projectId,
      taskId: value.taskId,
      mode: "external_agent"
    })).toThrow(/providerProfile is required/);
    expect(value.workspaces.get(value.projectId, value.taskId)).toMatchObject({
      executionMode: "direct",
      persistentOrchestratorSession: false
    });
    expect(EXECUTE_PLAN_DESCRIPTION).toContain("explicitly delegates");
    expect(EXECUTE_PLAN_DESCRIPTION).toContain("never selected automatically");
    expect(EXECUTE_PLAN_DESCRIPTION).toContain("separately configured external coding model");
    value.database.close();
  });

  it("allows only the explicitly selected provider profile and audits mode, provider, model and timestamp", async () => {
    const value = await fixture();
    const enabled = value.workspaces.setExecutionMode({
      projectId: value.projectId,
      taskId: value.taskId,
      mode: "external_agent",
      providerProfile: "ccr",
      model: "qwen-explicit"
    });
    expect(enabled).toMatchObject({
      executionMode: "external_agent",
      providerProfile: "ccr",
      selectedModel: "qwen-explicit",
      persistentOrchestratorSession: false
    });
    expect(value.workspaces.requireExternalAgentExecution(value.projectId, value.taskId).providerProfile).toBe("ccr");

    const audit = value.database.db.prepare(`
      SELECT timestamp, detail_json AS detailJson
      FROM audit_events
      WHERE action='task_execution_mode_transition' AND task_id=?
      ORDER BY timestamp DESC LIMIT 1
    `).get(value.taskId) as { timestamp: string; detailJson: string };
    const detail = JSON.parse(audit.detailJson) as Record<string, unknown>;
    expect(detail).toMatchObject({
      taskId: value.taskId,
      previousMode: "direct",
      newMode: "external_agent",
      newProviderProfile: "ccr",
      newModel: "qwen-explicit",
      timestamp: audit.timestamp
    });
    value.database.close();
  });

  it("returns to direct after external-agent success, failure and cancellation", async () => {
    const value = await fixture();
    for (const [exitCode, expectedStatus] of [[0, "succeeded"], [2, "failed"]] as const) {
      value.workspaces.setExecutionMode({
        projectId: value.projectId,
        taskId: value.taskId,
        mode: "external_agent",
        providerProfile: "ccr",
        model: "explicit-model"
      });
      value.runner.enqueueResult(exitCode);
      const started = await startExecution(value, "external_agent");
      expect((await waitForTerminal(value.tasks, started.id)).status).toBe(expectedStatus);
      expect(value.workspaces.get(value.projectId, value.taskId).executionMode).toBe("direct");
    }

    value.workspaces.setExecutionMode({
      projectId: value.projectId,
      taskId: value.taskId,
      mode: "external_agent",
      providerProfile: "claude_subscription"
    });
    value.runner.enqueueBlock();
    const blocked = await startExecution(value, "external_agent");
    for (let index = 0; index < 100 && value.tasks.get(blocked.id).status !== "running"; index += 1) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    await value.tasks.cancel(blocked.id);
    expect((await waitForTerminal(value.tasks, blocked.id)).status).toBe("cancelled");
    expect(value.workspaces.get(value.projectId, value.taskId).executionMode).toBe("direct");

    const resetReasons = (value.database.db.prepare(`
      SELECT detail_json AS detailJson FROM audit_events
      WHERE action='task_execution_mode_transition' AND task_id=?
      ORDER BY timestamp
    `).all(value.taskId) as Array<{ detailJson: string }>)
      .map((row) => JSON.parse(row.detailJson) as { reason?: string })
      .map((detail) => detail.reason);
    expect(resetReasons).toEqual(expect.arrayContaining([
      "execution_succeeded",
      "execution_failed",
      "execution_cancelled"
    ]));
    value.database.close();
  });

  it("keeps external mode only for an explicitly persistent orchestrator session", async () => {
    const value = await fixture();
    value.workspaces.setExecutionMode({
      projectId: value.projectId,
      taskId: value.taskId,
      mode: "external_agent",
      providerProfile: "ccr",
      model: "persistent-model",
      persistentOrchestratorSession: true
    });
    value.runner.enqueueResult(0);
    const started = await startExecution(value, "external_agent");
    expect((await waitForTerminal(value.tasks, started.id)).status).toBe("succeeded");
    expect(value.workspaces.get(value.projectId, value.taskId)).toMatchObject({
      executionMode: "external_agent",
      providerProfile: "ccr",
      persistentOrchestratorSession: true
    });

    const direct = value.workspaces.setExecutionMode({
      projectId: value.projectId,
      taskId: value.taskId,
      mode: "direct"
    });
    expect(direct).toMatchObject({ executionMode: "direct", persistentOrchestratorSession: false });
    expect(direct.providerProfile).toBeUndefined();
    expect(direct.selectedModel).toBeUndefined();
    value.database.close();
  });
});
