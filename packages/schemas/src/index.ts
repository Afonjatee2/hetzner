import { z } from "zod/v4";

export const ProjectId = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/);
export const TaskId = z.string().uuid();
export const RelativePath = z.string().min(1).max(4096).refine((value) => !value.includes("\0"), "NUL bytes are forbidden");
export const NetworkMode = z.enum(["none", "registry", "restricted"]);
export const CommandExecutionMode = z.enum(["container", "host"]);
export const ExecutionMode = z.enum(["direct", "external_agent"]);
export const ExternalAgentProviderProfile = z.enum(["ccr", "claude_subscription"]);
export const WorkspaceKind = z.enum(["isolated", "attached"]);

export const ProjectRef = z.object({
  projectId: ProjectId,
  taskId: TaskId.optional()
});

export const RunCommandInput = ProjectRef.extend({
  executable: z.string().min(1).max(256),
  args: z.array(z.string().max(4096)).max(128).default([]),
  timeoutSeconds: z.number().int().min(5).max(86400).optional(),
  network: NetworkMode.default("none"),
  image: z.string().max(256).optional(),
  mode: CommandExecutionMode.default("container")
});

export const TaskStatus = z.enum([
  "queued",
  "preparing",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted"
]);

export type TaskStatus = z.infer<typeof TaskStatus>;
export type NetworkMode = z.infer<typeof NetworkMode>;
export type CommandExecutionMode = z.infer<typeof CommandExecutionMode>;
export type ExecutionMode = z.infer<typeof ExecutionMode>;
export type ExternalAgentProviderProfile = z.infer<typeof ExternalAgentProviderProfile>;
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;
export type RunCommandInput = z.infer<typeof RunCommandInput>;

export interface WorkspaceCapabilities {
  read: boolean;
  write: boolean;
  delete: boolean;
  runContainerCommands: boolean;
  runHostCommands: boolean;
  commit: boolean;
  push: boolean;
  publish: boolean;
  merge: boolean;
  rollback: boolean;
}

export const ATTACHED_CAPABILITIES: Readonly<WorkspaceCapabilities> = Object.freeze({
  read: true,
  write: true,
  delete: true,
  runContainerCommands: true,
  runHostCommands: false,
  commit: false,
  push: false,
  publish: false,
  merge: false,
  rollback: false
});

export const ISOLATED_CAPABILITIES: Readonly<WorkspaceCapabilities> = Object.freeze({
  read: true,
  write: true,
  delete: true,
  runContainerCommands: true,
  runHostCommands: true,
  commit: true,
  push: true,
  publish: true,
  merge: true,
  rollback: true
});

export type ToolErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "TIMEOUT"
  | "EXECUTION_FAILED"
  | "INTERNAL";

export interface ToolEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: ToolErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> };
  auditId: string;
  warnings?: string[];
}

export class WorkspaceError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}
