import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { redactSecrets } from "@gpt-dev/audit-service";
import { WorkspaceError } from "@gpt-dev/schemas";
import type { SandboxCallbacks, SandboxRequest, SandboxResult, TaskRunner } from "./index.js";

export interface HostRunnerOptions {
  /** Colon-separated directories prepended to the child PATH (e.g. bun/homebrew bins). */
  pathPrepend?: string;
}

const BASE_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

function childEnvironment(pathPrepend: string | undefined, artifactPath: string): NodeJS.ProcessEnv {
  // Deliberately NOT process.env: the gateway environment carries OAuth and
  // handoff secrets that must never leak into task processes or their logs.
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"]) {
    if (process.env[key]) inherited[key] = process.env[key];
  }
  inherited.LANG ??= "en_US.UTF-8";
  return {
    ...inherited,
    PATH: [pathPrepend, BASE_PATH].filter(Boolean).join(":"),
    GPTDEV_ARTIFACTS_DIR: artifactPath
  };
}

export class HostProcessRunner implements TaskRunner {
  private readonly active = new Map<string, number>();

  constructor(private readonly options: HostRunnerOptions = {}) {}

  async run(request: SandboxRequest, callbacks: SandboxCallbacks): Promise<SandboxResult> {
    await stat(request.worktreePath);
    let totalBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      const child = spawn(request.executable, request.args, {
        cwd: request.worktreePath,
        env: childEnvironment(this.options.pathPrepend, request.artifactPath),
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group so timeout/cancel can kill the whole tree
        // (package managers and dev servers fork aggressively).
        detached: true
      });
      const consume = (stream: "stdout" | "stderr") => (chunk: Buffer): void => {
        if (totalBytes >= request.limits.maxOutputBytes) { outputTruncated = true; return; }
        const remaining = request.limits.maxOutputBytes - totalBytes;
        const sliced = chunk.subarray(0, remaining);
        totalBytes += sliced.byteLength;
        callbacks.onLog(stream, redactSecrets(sliced.toString("utf8")));
        if (sliced.byteLength < chunk.byteLength) outputTruncated = true;
      };
      child.stdout?.on("data", consume("stdout"));
      child.stderr?.on("data", consume("stderr"));
      child.once("error", (error) => {
        this.active.delete(request.taskId);
        reject(new WorkspaceError("EXECUTION_FAILED", redactSecrets(error.message)));
      });
      child.once("spawn", () => {
        if (typeof child.pid === "number") {
          this.active.set(request.taskId, child.pid);
          callbacks.onContainer(`host-pid-${String(child.pid)}`);
        }
      });
      const timer = setTimeout(() => {
        timedOut = true;
        this.terminate(request.taskId);
      }, request.limits.timeoutSeconds * 1000);
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        this.active.delete(request.taskId);
        resolvePromise(code ?? (signal ? 128 + 9 : 1));
      });
    });
    return { containerId: "host", exitCode, timedOut, outputTruncated };
  }

  async cancel(taskId: string): Promise<void> {
    if (!this.active.has(taskId)) throw new WorkspaceError("CONFLICT", "Task has no active host process");
    this.terminate(taskId);
    await Promise.resolve();
  }

  private terminate(taskId: string): void {
    const pid = this.active.get(taskId);
    if (typeof pid !== "number") return;
    const signalGroup = (signal: NodeJS.Signals): void => {
      try { process.kill(-pid, signal); } catch { /* group already gone */ }
    };
    signalGroup("SIGTERM");
    const escalation = setTimeout(() => signalGroup("SIGKILL"), 2000);
    escalation.unref();
  }
}
