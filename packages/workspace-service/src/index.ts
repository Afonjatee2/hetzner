import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import {
  lstat, mkdir, readFile, readlink, realpath, rename, rm, writeFile
} from "node:fs/promises";
import { isAbsolute, dirname, relative, resolve, sep } from "node:path";
import type { WorkspaceDatabase } from "@gpt-dev/persistence";
import { isProtectedPath, resolveContained, type ProjectRecord } from "@gpt-dev/projects";
import {
  ATTACHED_CAPABILITIES, ISOLATED_CAPABILITIES, WorkspaceError,
  type ExecutionMode, type WorkspaceCapabilities, type WorkspaceKind
} from "@gpt-dev/schemas";

export const NEW_FILE_SHA256 = "NEW_FILE";
export const EXTERNAL_AGENT_DISABLED_MESSAGE = "External-agent execution is not enabled for this task. Continue using MCP tools directly unless the user explicitly requests delegation.";

export interface WorkspaceRecord {
  taskId: string;
  projectId: string;
  kind: WorkspaceKind;
  path: string;
  branch: string;
  originalHead?: string;
  originalBranch?: string;
  baselineManifestPath?: string;
  finalManifestPath?: string;
  executionMode: ExecutionMode;
  providerProfile?: string;
  selectedModel?: string;
  persistentOrchestratorSession: boolean;
  capabilities: WorkspaceCapabilities;
  siblingWorktrees: string[];
  activePath?: string;
  status: string;
  createdAt: string;
  closedAt?: string;
}

export interface BaselineLimits {
  perFileBytes: number;
  totalBytes: number;
  gitOutputBytes: number;
}

export interface ManifestEntry {
  path: string;
  status: string;
  type: "regular" | "symlink" | "directory" | "deleted";
  mode?: number;
  symlinkTarget?: string;
  sha256?: string;
  size?: number;
  contentBase64?: string;
}

export interface WorkspaceManifest {
  version: 1;
  capturedAt: string;
  head: string;
  branch: string;
  statusPorcelainV2Base64: string;
  stagedDiff: string;
  unstagedDiff: string;
  entries: ManifestEntry[];
  inventory: ManifestEntry[];
}

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function gitBuffer(cwd: string, args: string[], maxBytes: number): Promise<Buffer> {
  const result = await new Promise<GitResult>((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxBytes) overflow = true;
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > maxBytes) overflow = true;
      else stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const output = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (overflow) {
        reject(new WorkspaceError("VALIDATION", `Git output exceeded the safe ${String(maxBytes)} byte capture limit`));
      } else if (code === 0) {
        resolvePromise(output);
      } else {
        reject(new WorkspaceError("VALIDATION", output.stderr.toString("utf8").trim() || `git exited ${String(code)}`));
      }
    });
  });
  return result.stdout;
}

async function gitText(cwd: string, args: string[], maxBytes: number): Promise<string> {
  return (await gitBuffer(cwd, args, maxBytes)).toString("utf8").trimEnd();
}

function decodePath(bytes: Buffer): string {
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    throw new WorkspaceError("VALIDATION", "Dirty paths must be valid UTF-8 for safe manifest capture");
  }
  if (!decoded || decoded.includes("\0")) throw new WorkspaceError("VALIDATION", "Git returned an invalid dirty path");
  return decoded;
}

function parseDirtyPaths(status: Buffer): Array<{ path: string; status: string }> {
  const fields = status.toString("binary").split("\0");
  const paths: Array<{ path: string; status: string }> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const binary = fields[index];
    if (!binary) continue;
    const field = Buffer.from(binary, "binary");
    const prefix = field.subarray(0, 1).toString("ascii");
    const text = decodePath(field);
    const parts = text.split(" ");
    let path: string;
    let status: string;
    if (prefix === "?" || prefix === "!") {
      path = text.slice(2);
      status = prefix === "?" ? "untracked" : "ignored";
    } else if (prefix === "1") {
      path = parts.slice(8).join(" ");
      status = parts[1] ?? "unknown";
    } else if (prefix === "2") {
      path = parts.slice(9).join(" ");
      status = parts[1] ?? "unknown";
      const originalBinary = fields[index + 1];
      if (!originalBinary) throw new WorkspaceError("VALIDATION", "Git omitted the rename/copy source path");
      const originalPath = decodePath(Buffer.from(originalBinary, "binary"));
      paths.push({ path: originalPath, status: `${status}:source` });
      index += 1;
    } else if (prefix === "u") {
      path = parts.slice(10).join(" ");
      status = parts[1] ?? "unknown";
    } else throw new WorkspaceError("VALIDATION", "Unsupported porcelain-v2 status record");
    if (!path) throw new WorkspaceError("VALIDATION", "Git returned an empty dirty path");
    paths.push({ path, status });
  }
  return [...new Map(paths.map((entry) => [entry.path, entry])).values()];
}

function entryFingerprint(entry: ManifestEntry): string {
  return JSON.stringify({
    type: entry.type, mode: entry.mode, symlinkTarget: entry.symlinkTarget,
    sha256: entry.sha256, size: entry.size
  });
}

async function hashRegularFile(path: string): Promise<{ sha256: string; size: number; mode: number }> {
  const before = await lstat(path);
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    stream.once("error", reject);
    stream.once("end", resolvePromise);
  });
  const after = await lstat(path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) {
    throw new WorkspaceError("CONFLICT", `File changed during manifest inventory: ${path}`);
  }
  return { sha256: hash.digest("hex"), size: after.size, mode: after.mode & 0o7777 };
}

export class WorkspaceService {
  private readonly artifactRoot: string;

  constructor(
    private readonly database: WorkspaceDatabase,
    artifactRoot: string,
    private readonly limits: BaselineLimits,
    private readonly cancelExecutions?: (workspaceId: string) => Promise<void>
  ) {
    this.artifactRoot = resolve(artifactRoot);
  }

  get(projectId: string, taskId: string, requireActive = true): WorkspaceRecord {
    const row = this.database.db.prepare(`
      SELECT task_id AS taskId, project_id AS projectId, kind, path, branch,
        original_head AS originalHead, original_branch AS originalBranch,
        baseline_manifest_path AS baselineManifestPath, final_manifest_path AS finalManifestPath,
        execution_mode AS executionMode, provider_profile AS providerProfile,
        selected_model AS selectedModel, persistent_orchestrator AS persistentOrchestrator,
        capability_profile_json AS capabilityProfileJson,
        sibling_worktrees_json AS siblingWorktreesJson, active_path AS activePath,
        status, created_at AS createdAt, closed_at AS closedAt
      FROM task_workspaces WHERE task_id=? AND project_id=?
    `).get(taskId, projectId) as {
      taskId: string;
      projectId: string;
      kind: WorkspaceKind;
      path: string;
      branch: string;
      originalHead: string | null;
      originalBranch: string | null;
      baselineManifestPath: string | null;
      finalManifestPath: string | null;
      executionMode: ExecutionMode;
      providerProfile: string | null;
      selectedModel: string | null;
      persistentOrchestrator: number;
      capabilityProfileJson: string;
      siblingWorktreesJson: string;
      activePath: string | null;
      status: string;
      createdAt: string;
      closedAt: string | null;
    } | undefined;
    if (!row) throw new WorkspaceError("NOT_FOUND", "Task workspace not found for project");
    if (requireActive && row.status !== "active") throw new WorkspaceError("CONFLICT", `Workspace is ${row.status}`);
    return {
      taskId: row.taskId,
      projectId: row.projectId,
      kind: row.kind,
      path: row.path,
      branch: row.branch,
      ...(row.originalHead ? { originalHead: row.originalHead } : {}),
      ...(row.originalBranch ? { originalBranch: row.originalBranch } : {}),
      ...(row.baselineManifestPath ? { baselineManifestPath: row.baselineManifestPath } : {}),
      ...(row.finalManifestPath ? { finalManifestPath: row.finalManifestPath } : {}),
      executionMode: row.executionMode,
      ...(row.providerProfile ? { providerProfile: row.providerProfile } : {}),
      ...(row.selectedModel ? { selectedModel: row.selectedModel } : {}),
      persistentOrchestratorSession: row.persistentOrchestrator === 1,
      capabilities: JSON.parse(row.capabilityProfileJson) as WorkspaceCapabilities,
      siblingWorktrees: JSON.parse(row.siblingWorktreesJson) as string[],
      ...(row.activePath ? { activePath: row.activePath } : {}),
      status: row.status,
      createdAt: row.createdAt,
      ...(row.closedAt ? { closedAt: row.closedAt } : {})
    };
  }

  recordIsolated(input: {
    taskId: string; projectId: string; path: string; branch: string; originalHead: string; createdAt: string;
  }): WorkspaceRecord {
    const activePath = resolve(input.path);
    this.database.db.prepare(`
      INSERT INTO task_workspaces (
        task_id, project_id, kind, path, branch, original_head, original_branch,
        capability_profile_json, sibling_worktrees_json, active_path, execution_mode, status, created_at
      ) VALUES (@taskId,@projectId,'isolated',@path,@branch,@originalHead,@branch,@capabilities,'[]',@activePath,'direct','active',@createdAt)
    `).run({ ...input, activePath, capabilities: JSON.stringify(ISOLATED_CAPABILITIES) });
    return this.get(input.projectId, input.taskId);
  }

  async attach(input: {
    project: ProjectRecord;
    expectedBranch: string;
    preserveDirtyState: true;
    allowHostExecution?: boolean;
  }): Promise<WorkspaceRecord> {
    if (input.preserveDirtyState !== true) {
      throw new WorkspaceError("VALIDATION", "preserveDirtyState must be true for attached workspaces");
    }
    const root = await realpath(input.project.canonicalPath);
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    const artifactRootReal = await realpath(this.artifactRoot);
    if (isInside(root, artifactRootReal)) {
      throw new WorkspaceError("FORBIDDEN", "Attached baseline state must be stored outside the repository");
    }
    await gitText(root, ["check-ref-format", "--branch", input.expectedBranch], this.limits.gitOutputBytes);
    const topLevel = await realpath(await gitText(root, ["rev-parse", "--show-toplevel"], this.limits.gitOutputBytes));
    if (topLevel !== root) throw new WorkspaceError("VALIDATION", "Registered path must be the Git checkout root");
    const commonDir = await realpath(await gitText(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], this.limits.gitOutputBytes));
    const branch = await gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], this.limits.gitOutputBytes)
      .catch(() => { throw new WorkspaceError("CONFLICT", "Detached HEAD cannot be attached"); });
    if (branch !== input.expectedBranch) {
      throw new WorkspaceError("CONFLICT", `Checkout is on ${branch}, expected ${input.expectedBranch}`);
    }
    const worktreeOutput = await gitText(root, ["worktree", "list", "--porcelain"], this.limits.gitOutputBytes);
    const listedPaths = worktreeOutput.split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    const siblingWorktrees: string[] = [];
    let registeredIdentitySeen = false;
    for (const listed of listedPaths) {
      const listedReal = await realpath(listed).catch(() => {
        throw new WorkspaceError("VALIDATION", `Git listed an inaccessible sibling worktree: ${listed}`);
      });
      const listedCommon = await realpath(await gitText(listedReal, ["rev-parse", "--path-format=absolute", "--git-common-dir"], this.limits.gitOutputBytes));
      if (listedCommon !== commonDir) throw new WorkspaceError("VALIDATION", "Git worktree repository identity mismatch");
      if (listedReal === root) registeredIdentitySeen = true;
      else siblingWorktrees.push(listedReal);
    }
    if (!registeredIdentitySeen) throw new WorkspaceError("VALIDATION", "Registered checkout is absent from its repository worktree list");
    const existingOwner = this.database.db.prepare(`
      SELECT task_id AS taskId FROM task_workspaces
      WHERE kind='attached' AND active_path=? LIMIT 1
    `).get(root) as { taskId: string } | undefined;
    if (existingOwner) {
      throw new WorkspaceError("CONFLICT", "Another active attached workspace already owns this checkout");
    }

    const taskId = randomUUID();
    const baseline = await this.captureStableManifest(root);
    if (baseline.head !== await gitText(root, ["rev-parse", "HEAD"], this.limits.gitOutputBytes)
      || baseline.branch !== branch) {
      throw new WorkspaceError("CONFLICT", "Checkout HEAD or branch changed during baseline capture");
    }
    const baselineManifestPath = await this.writeManifest(taskId, "baseline", baseline);
    const capabilities: WorkspaceCapabilities = {
      ...ATTACHED_CAPABILITIES,
      runHostCommands: input.allowHostExecution === true
    };
    const createdAt = new Date().toISOString();
    try {
      this.database.db.prepare(`
        INSERT INTO task_workspaces (
          task_id, project_id, kind, path, branch, original_head, original_branch,
          baseline_manifest_path, capability_profile_json, sibling_worktrees_json,
          active_path, execution_mode, status, created_at
        ) VALUES (
          @taskId,@projectId,'attached',@path,@branch,@head,@branch,
          @baselineManifestPath,@capabilities,@siblings,@path,'direct','active',@createdAt
        )
      `).run({
        taskId, projectId: input.project.id, path: root, branch, head: baseline.head,
        baselineManifestPath, capabilities: JSON.stringify(capabilities),
        siblings: JSON.stringify(siblingWorktrees), createdAt
      });
    } catch (error) {
      await rm(resolve(this.artifactRoot, taskId), { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof Error && /UNIQUE constraint failed: task_workspaces\.active_path/.test(error.message)) {
        throw new WorkspaceError("CONFLICT", "Another active attached workspace already owns this checkout");
      }
      throw error;
    }
    const workspace = this.get(input.project.id, taskId);
    this.indexBaselineArtifact(workspace);
    return workspace;
  }

  setExecutionMode(input: {
    projectId: string;
    taskId: string;
    mode: ExecutionMode;
    providerProfile?: string;
    model?: string;
    persistentOrchestratorSession?: boolean;
  }): WorkspaceRecord {
    return this.transitionExecutionMode(input, "mcp-user", "explicit_user_request", true);
  }

  requireExternalAgentExecution(projectId: string, taskId: string): WorkspaceRecord {
    const workspace = this.get(projectId, taskId);
    if (workspace.executionMode !== "external_agent") {
      throw new WorkspaceError("FORBIDDEN", EXTERNAL_AGENT_DISABLED_MESSAGE);
    }
    if (!workspace.providerProfile) {
      throw new WorkspaceError("CONFLICT", "External-agent execution has no persisted provider profile");
    }
    return workspace;
  }

  resetExternalAgentExecution(projectId: string, taskId: string, reason: string): WorkspaceRecord {
    const current = this.get(projectId, taskId, false);
    if (current.executionMode !== "external_agent" || current.persistentOrchestratorSession) return current;
    return this.transitionExecutionMode(
      { projectId, taskId, mode: "direct" },
      "system:external-agent-lifecycle",
      reason,
      false
    );
  }

  private transitionExecutionMode(input: {
    projectId: string;
    taskId: string;
    mode: ExecutionMode;
    providerProfile?: string;
    model?: string;
    persistentOrchestratorSession?: boolean;
  }, actor: string, reason: string, requireActive: boolean): WorkspaceRecord {
    const previous = this.get(input.projectId, input.taskId, requireActive);
    const providerProfile = input.providerProfile?.trim();
    const selectedModel = input.model?.trim();
    const persistentOrchestratorSession = input.persistentOrchestratorSession === true;
    if (input.mode === "external_agent" && previous.kind === "attached") {
      throw new WorkspaceError("FORBIDDEN", "External-agent execution is forbidden for attached workspaces");
    }
    if (input.mode === "external_agent" && !providerProfile) {
      throw new WorkspaceError("VALIDATION", "providerProfile is required when enabling external-agent execution");
    }
    if (input.mode === "direct" && (providerProfile || selectedModel || persistentOrchestratorSession)) {
      throw new WorkspaceError("VALIDATION", "Direct execution mode cannot retain an external provider, model, or persistent orchestrator session");
    }
    const timestamp = new Date().toISOString();
    this.database.db.transaction(() => {
      this.database.db.prepare(`
        UPDATE task_workspaces
        SET execution_mode=?, provider_profile=?, selected_model=?, persistent_orchestrator=?
        WHERE task_id=? AND project_id=?
      `).run(
        input.mode,
        input.mode === "external_agent" ? providerProfile : null,
        input.mode === "external_agent" ? selectedModel ?? null : null,
        input.mode === "external_agent" && persistentOrchestratorSession ? 1 : 0,
        input.taskId,
        input.projectId
      );
      this.database.recordAudit({
        id: randomUUID(),
        timestamp,
        action: "task_execution_mode_transition",
        actor,
        projectId: input.projectId,
        taskId: input.taskId,
        destructive: false,
        networked: input.mode === "external_agent",
        detail: {
          taskId: input.taskId,
          previousMode: previous.executionMode,
          newMode: input.mode,
          previousProviderProfile: previous.providerProfile ?? null,
          newProviderProfile: input.mode === "external_agent" ? providerProfile : null,
          previousModel: previous.selectedModel ?? null,
          newModel: input.mode === "external_agent" ? selectedModel ?? null : null,
          persistentOrchestratorSession: input.mode === "external_agent" && persistentOrchestratorSession,
          timestamp,
          reason
        }
      });
    })();
    return this.get(input.projectId, input.taskId, requireActive);
  }

  requireCapability(
    projectId: string,
    taskId: string,
    capability: keyof WorkspaceCapabilities
  ): WorkspaceRecord {
    const workspace = this.get(projectId, taskId);
    if (!workspace.capabilities[capability]) {
      throw new WorkspaceError("FORBIDDEN", `${capability} is not permitted for ${workspace.kind} workspaces`);
    }
    return workspace;
  }

  requireIsolated(projectId: string, taskId: string, action: string, requireActive = true): WorkspaceRecord {
    const workspace = this.get(projectId, taskId, requireActive);
    if (workspace.kind === "attached") {
      throw new WorkspaceError("FORBIDDEN", `${action} is forbidden for attached workspaces`);
    }
    return workspace;
  }

  assertNoActiveAttachment(projectId: string, action: string): void {
    const row = this.database.db.prepare(`
      SELECT task_id AS taskId FROM task_workspaces
      WHERE project_id=? AND kind='attached' AND active_path IS NOT NULL LIMIT 1
    `).get(projectId) as { taskId: string } | undefined;
    if (row) throw new WorkspaceError("FORBIDDEN", `${action} is forbidden while the registered checkout is attached`);
  }

  async changesSinceAttachment(projectId: string, taskId: string): Promise<{
    preExistingUnchanged: ManifestEntry[];
    introducedAfterAttachment: ManifestEntry[];
    concurrentlyChanged: Array<{ baseline: ManifestEntry; live: ManifestEntry }>;
    newlyAdded: ManifestEntry[];
    deleted: ManifestEntry[];
    modeOrSymlinkChanged: Array<{ baseline?: ManifestEntry; live: ManifestEntry }>;
  }> {
    const workspace = this.requireCapability(projectId, taskId, "read");
    if (workspace.kind !== "attached" || !workspace.baselineManifestPath) {
      throw new WorkspaceError("VALIDATION", "Changes since attachment are only available for attached workspaces");
    }
    const baseline = JSON.parse(await readFile(workspace.baselineManifestPath, "utf8")) as WorkspaceManifest;
    const live = await this.captureStableManifest(workspace.path);
    const baselineDirtyByPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const liveDirtyByPath = new Map(live.entries.map((entry) => [entry.path, entry]));
    const baselineInventory = new Map(baseline.inventory.map((entry) => [entry.path, entry]));
    const liveInventory = new Map(live.inventory.map((entry) => [entry.path, entry]));
    const result = {
      preExistingUnchanged: [] as ManifestEntry[],
      introducedAfterAttachment: [] as ManifestEntry[],
      concurrentlyChanged: [] as Array<{ baseline: ManifestEntry; live: ManifestEntry }>,
      newlyAdded: [] as ManifestEntry[],
      deleted: [] as ManifestEntry[],
      modeOrSymlinkChanged: [] as Array<{ baseline?: ManifestEntry; live: ManifestEntry }>
    };
    for (const [path, baselineEntry] of baselineDirtyByPath) {
      const liveEntry = liveDirtyByPath.get(path) ?? liveInventory.get(path);
      if (!liveEntry || liveEntry.type === "deleted") {
        const deletedEntry = liveEntry ?? { path, status: "deleted", type: "deleted" as const };
        result.deleted.push(deletedEntry);
        result.concurrentlyChanged.push({ baseline: baselineEntry, live: deletedEntry });
      } else if (entryFingerprint(baselineEntry) === entryFingerprint(liveEntry)) {
        result.preExistingUnchanged.push(liveEntry);
      } else {
        result.concurrentlyChanged.push({ baseline: baselineEntry, live: liveEntry });
        if (baselineEntry.mode !== liveEntry.mode || baselineEntry.type === "symlink" || liveEntry.type === "symlink") {
          result.modeOrSymlinkChanged.push({ baseline: baselineEntry, live: liveEntry });
        }
      }
      liveDirtyByPath.delete(path);
    }
    for (const entry of liveDirtyByPath.values()) {
      const baselineEntry = baselineInventory.get(entry.path);
      if (entry.type === "deleted") result.deleted.push(entry);
      else if (entry.status === "untracked") result.newlyAdded.push(entry);
      else result.introducedAfterAttachment.push(entry);
      const liveEntry = liveInventory.get(entry.path) ?? entry;
      if (baselineEntry && (
        baselineEntry.mode !== liveEntry.mode
        || baselineEntry.type === "symlink"
        || liveEntry.type === "symlink"
      )) result.modeOrSymlinkChanged.push({ baseline: baselineEntry, live: liveEntry });
      else if (!baselineEntry && liveEntry.type === "symlink") result.modeOrSymlinkChanged.push({ live: liveEntry });
    }
    return result;
  }

  async patchFile(input: {
    projectId: string;
    taskId: string;
    path: string;
    expectedSha256: string;
    replacements: Array<{ oldText: string; newText: string }>;
  }): Promise<{ path: string; sha256: string; bytes: number }> {
    const workspace = this.requireCapability(input.projectId, input.taskId, "write");
    if (isProtectedPath(input.path)) throw new WorkspaceError("FORBIDDEN", "Protected credential paths cannot be edited");
    const existing = await this.fileState(workspace.path, input.path, false);
    if (existing.sha256 !== input.expectedSha256) {
      throw new WorkspaceError("CONFLICT", "File changed since it was read; expected SHA-256 is stale");
    }
    let content = existing.content ?? "";
    if (input.replacements.length === 0) throw new WorkspaceError("VALIDATION", "At least one replacement is required");
    if (existing.sha256 === NEW_FILE_SHA256) {
      if (input.replacements.length !== 1 || input.replacements[0]?.oldText !== "") {
        throw new WorkspaceError("VALIDATION", "New files require one empty-oldText replacement containing the complete new content");
      }
      content = input.replacements[0].newText;
    } else for (const replacement of input.replacements) {
      if (!replacement.oldText) throw new WorkspaceError("VALIDATION", "Replacement oldText must not be empty for existing files");
      const first = content.indexOf(replacement.oldText);
      if (first < 0 || content.indexOf(replacement.oldText, first + replacement.oldText.length) >= 0) {
        throw new WorkspaceError("CONFLICT", "Each replacement must match exactly once");
      }
      content = `${content.slice(0, first)}${replacement.newText}${content.slice(first + replacement.oldText.length)}`;
    }
    const path = await resolveContained(workspace.path, input.path, false);
    const temporary = `${path}.gptdev-patch-${process.pid}-${Date.now()}`;
    await writeFile(temporary, content, {
      encoding: "utf8", mode: existing.mode ?? 0o640, flag: "wx"
    });
    try {
      const latest = await this.fileState(workspace.path, input.path, false);
      if (latest.sha256 !== input.expectedSha256) {
        throw new WorkspaceError("CONFLICT", "File changed while the edit was being prepared");
      }
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return { path: input.path, sha256: sha256(content), bytes: Buffer.byteLength(content) };
  }

  async fileState(root: string, requested: string, mustExist = true, maxBytes = this.limits.perFileBytes): Promise<{
    content?: string; sha256: string; bytes: number; mode?: number;
  }> {
    if (isProtectedPath(requested)) throw new WorkspaceError("FORBIDDEN", "Protected credential paths cannot be read");
    let path: string;
    try {
      path = await resolveContained(root, requested, mustExist);
    } catch (error) {
      if (!mustExist && error instanceof WorkspaceError && error.code === "NOT_FOUND") throw error;
      throw error;
    }
    const info = await lstat(path).catch(() => undefined);
    if (!info) {
      return { sha256: NEW_FILE_SHA256, bytes: 0 };
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new WorkspaceError("VALIDATION", "Optimistic edits require a regular file");
    if (info.size > maxBytes) throw new WorkspaceError("VALIDATION", "File exceeds bounded read/edit size limit");
    const bytes = await readFile(path);
    if (bytes.includes(0)) throw new WorkspaceError("VALIDATION", "Binary files cannot be optimistically edited");
    return {
      content: bytes.toString("utf8"), sha256: sha256(bytes), bytes: bytes.byteLength,
      mode: info.mode & 0o7777
    };
  }

  async assertDeleteHash(projectId: string, taskId: string, requested: string, expectedSha256: string): Promise<WorkspaceRecord> {
    const workspace = this.requireCapability(projectId, taskId, "delete");
    if (workspace.kind === "attached") {
      const state = await this.fileState(workspace.path, requested);
      if (state.sha256 !== expectedSha256) throw new WorkspaceError("CONFLICT", "Path changed since it was read; expected SHA-256 is stale");
    }
    return workspace;
  }

  async close(projectId: string, taskId: string): Promise<WorkspaceRecord> {
    const workspace = this.get(projectId, taskId);
    if (workspace.kind !== "attached") throw new WorkspaceError("VALIDATION", "Only attached workspaces use close_attached_task");
    const claimed = this.database.db.prepare(`
      UPDATE task_workspaces SET status='closing'
      WHERE task_id=? AND project_id=? AND status='active'
    `).run(taskId, projectId);
    if (claimed.changes !== 1) throw new WorkspaceError("CONFLICT", "Attached workspace is not active");
    try {
      await this.cancelExecutions?.(taskId);
      const finalManifest = await this.captureStableManifest(workspace.path);
      const finalManifestPath = await this.writeManifest(taskId, "final", finalManifest);
      const closedAt = new Date().toISOString();
      this.database.db.prepare(`
        UPDATE task_workspaces
        SET status='closed', closed_at=?, final_manifest_path=?, active_path=NULL
        WHERE task_id=? AND project_id=? AND status='closing'
      `).run(closedAt, finalManifestPath, taskId, projectId);
      return this.get(projectId, taskId, false);
    } catch (error) {
      this.database.db.prepare(`
        UPDATE task_workspaces SET status='active'
        WHERE task_id=? AND project_id=? AND status='closing'
      `).run(taskId, projectId);
      throw error;
    }
  }

  private async captureStableManifest(root: string): Promise<WorkspaceManifest> {
    const first = await this.captureManifest(root);
    const second = await this.captureManifest(root);
    const stableFirst = JSON.stringify({ ...first, capturedAt: "" });
    const stableSecond = JSON.stringify({ ...second, capturedAt: "" });
    if (stableFirst !== stableSecond) {
      throw new WorkspaceError("CONFLICT", "Checkout changed during manifest capture; retry after concurrent writes stop");
    }
    return second;
  }

  private async captureManifest(root: string): Promise<WorkspaceManifest> {
    const [head, branch, statusBytes, stagedBytes, unstagedBytes, inventoryBytes] = await Promise.all([
      gitText(root, ["rev-parse", "HEAD"], this.limits.gitOutputBytes),
      gitText(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], this.limits.gitOutputBytes)
        .catch(() => { throw new WorkspaceError("CONFLICT", "Detached HEAD cannot be captured"); }),
      gitBuffer(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], this.limits.gitOutputBytes),
      gitBuffer(root, ["diff", "--cached", "--binary", "--no-ext-diff"], this.limits.gitOutputBytes),
      gitBuffer(root, ["diff", "--binary", "--no-ext-diff"], this.limits.gitOutputBytes),
      gitBuffer(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], this.limits.gitOutputBytes)
    ]);
    const rootReal = await realpath(root);
    const entries: ManifestEntry[] = [];
    let totalBytes = 0;
    for (const dirty of parseDirtyPaths(statusBytes)) {
      if (isProtectedPath(dirty.path)) {
        throw new WorkspaceError("FORBIDDEN", `Dirty protected path cannot be safely captured: ${dirty.path}`);
      }
      const lexical = resolve(rootReal, dirty.path);
      if (!isInside(rootReal, lexical)) throw new WorkspaceError("FORBIDDEN", `Dirty path escapes checkout: ${dirty.path}`);
      const before = await lstat(lexical).catch(() => undefined);
      if (!before) {
        entries.push({ path: dirty.path, status: dirty.status, type: "deleted" });
        continue;
      }
      const mode = before.mode & 0o7777;
      if (before.isSymbolicLink()) {
        const target = await readlink(lexical);
        const targetPath = resolve(dirname(lexical), target);
        if (isAbsolute(target) || !isInside(rootReal, targetPath)) {
          throw new WorkspaceError("FORBIDDEN", `Dirty symlink escapes checkout: ${dirty.path}`);
        }
        entries.push({
          path: dirty.path, status: dirty.status, type: "symlink", mode,
          symlinkTarget: target, sha256: sha256(target), size: Buffer.byteLength(target)
        });
      } else if (before.isFile()) {
        if (before.size > this.limits.perFileBytes) {
          throw new WorkspaceError("VALIDATION", `Dirty file exceeds per-file baseline limit: ${dirty.path}`);
        }
        totalBytes += before.size;
        if (totalBytes > this.limits.totalBytes) {
          throw new WorkspaceError("VALIDATION", "Dirty files exceed total baseline capture limit");
        }
        const bytes = await readFile(lexical);
        const after = await lstat(lexical);
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) {
          throw new WorkspaceError("CONFLICT", `Dirty file changed during capture: ${dirty.path}`);
        }
        entries.push({
          path: dirty.path, status: dirty.status, type: "regular", mode,
          sha256: sha256(bytes), size: bytes.byteLength, contentBase64: bytes.toString("base64")
        });
      } else if (before.isDirectory()) {
        entries.push({ path: dirty.path, status: dirty.status, type: "directory", mode });
      } else {
        throw new WorkspaceError("VALIDATION", `Unsupported dirty file type: ${dirty.path}`);
      }
    }
    const inventory: ManifestEntry[] = [];
    for (const binaryPath of inventoryBytes.toString("binary").split("\0")) {
      if (!binaryPath) continue;
      const path = decodePath(Buffer.from(binaryPath, "binary"));
      if (isProtectedPath(path)) continue;
      const absolute = resolve(rootReal, path);
      if (!isInside(rootReal, absolute)) throw new WorkspaceError("FORBIDDEN", `Inventory path escapes checkout: ${path}`);
      const info = await lstat(absolute).catch(() => undefined);
      if (!info) {
        inventory.push({ path, status: "clean", type: "deleted" });
      } else if (info.isSymbolicLink()) {
        const target = await readlink(absolute);
        const targetPath = resolve(dirname(absolute), target);
        if (isAbsolute(target) || !isInside(rootReal, targetPath)) {
          throw new WorkspaceError("FORBIDDEN", `Symlink escapes checkout: ${path}`);
        }
        inventory.push({
          path, status: "clean", type: "symlink", mode: info.mode & 0o7777,
          symlinkTarget: target, sha256: sha256(target), size: Buffer.byteLength(target)
        });
      } else if (info.isFile()) {
        const hashed = await hashRegularFile(absolute);
        inventory.push({ path, status: "clean", type: "regular", ...hashed });
      } else {
        throw new WorkspaceError("VALIDATION", `Unsupported repository file type: ${path}`);
      }
    }
    return {
      version: 1, capturedAt: new Date().toISOString(), head, branch,
      statusPorcelainV2Base64: statusBytes.toString("base64"),
      stagedDiff: stagedBytes.toString("utf8"),
      unstagedDiff: unstagedBytes.toString("utf8"),
      entries: entries.sort((left, right) => left.path.localeCompare(right.path)),
      inventory: inventory.sort((left, right) => left.path.localeCompare(right.path))
    };
  }

  private async writeManifest(taskId: string, name: "baseline" | "final", manifest: WorkspaceManifest): Promise<string> {
    const directory = resolve(this.artifactRoot, taskId, "workspace-state");
    if (!isInside(this.artifactRoot, directory)) throw new WorkspaceError("FORBIDDEN", "Workspace artifact path escaped configured root");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${name}-manifest.json`);
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    const record = {
      id: randomUUID(), taskId, relativePath: `workspace-state/${name}-manifest.json`,
      mediaType: "application/json", bytes: bytes.byteLength, sha256: sha256(bytes),
      createdAt: new Date().toISOString()
    };
    // Attached rows are inserted only after a complete baseline has been
    // captured. The baseline artifact is indexed immediately after insertion;
    // final manifests can be indexed here because the row already exists.
    if (name === "final") {
      this.database.db.prepare(`
        INSERT INTO workspace_artifacts
          (id, task_id, relative_path, media_type, bytes, sha256, created_at)
        VALUES (@id,@taskId,@relativePath,@mediaType,@bytes,@sha256,@createdAt)
        ON CONFLICT(task_id, relative_path) DO UPDATE SET
          media_type=excluded.media_type, bytes=excluded.bytes,
          sha256=excluded.sha256, created_at=excluded.created_at
      `).run(record);
    }
    return path;
  }

  indexBaselineArtifact(workspace: WorkspaceRecord): void {
    if (!workspace.baselineManifestPath) return;
    const content = readFileSync(workspace.baselineManifestPath);
    this.database.db.prepare(`
      INSERT INTO workspace_artifacts
        (id, task_id, relative_path, media_type, bytes, sha256, created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(task_id, relative_path) DO NOTHING
    `).run(
      randomUUID(), workspace.taskId, "workspace-state/baseline-manifest.json",
      "application/json", content.byteLength, sha256(content), new Date().toISOString()
    );
  }

  listArtifacts(taskId: string): Array<{
    id: string; taskId: string; relativePath: string; mediaType: string;
    bytes: number; sha256: string; createdAt: string;
  }> {
    return this.database.db.prepare(`
      SELECT id, task_id AS taskId, relative_path AS relativePath,
        media_type AS mediaType, bytes, sha256, created_at AS createdAt
      FROM workspace_artifacts WHERE task_id=?
      UNION ALL
      SELECT a.id, a.task_id AS taskId,
        'executions/' || a.task_id || '/' || a.relative_path AS relativePath,
        a.media_type AS mediaType, a.bytes, a.sha256, a.created_at AS createdAt
      FROM artifacts a
      INNER JOIN tasks t ON t.id=a.task_id
      WHERE t.worktree_id=?
      ORDER BY relativePath
    `).all(taskId, taskId) as Array<{
      id: string; taskId: string; relativePath: string; mediaType: string;
      bytes: number; sha256: string; createdAt: string;
    }>;
  }
}
