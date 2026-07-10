import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { redactSecrets } from "@gpt-dev/audit-service";
import type { NetworkMode } from "@gpt-dev/schemas";
import { WorkspaceError } from "@gpt-dev/schemas";

export interface SandboxLimits {
  memory: string;
  cpus: number;
  pids: number;
  timeoutSeconds: number;
  maxOutputBytes: number;
}

export interface SandboxRequest {
  taskId: string;
  image: string;
  executable: string;
  args: string[];
  worktreePath: string;
  artifactPath: string;
  network: NetworkMode;
  networkName?: string;
  limits: SandboxLimits;
}

export interface SandboxResult {
  containerId: string;
  exitCode: number;
  timedOut: boolean;
  outputTruncated: boolean;
}

export interface SandboxCallbacks {
  onContainer(containerId: string): void;
  onLog(stream: "stdout" | "stderr", content: string): void;
}

async function docker(args: string[], allowFailure = false): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) resolvePromise(stdout.trim());
      else reject(new WorkspaceError("EXECUTION_FAILED", redactSecrets(stderr.trim() || `docker exited ${String(code)}`)));
    });
  });
}

let rootlessDocker: Promise<boolean> | undefined;

function isRootlessDocker(): Promise<boolean> {
  rootlessDocker ??= docker(["info", "--format", "{{json .SecurityOptions}}"])
    .then((options) => options.includes("name=rootless"));
  return rootlessDocker;
}

export class DockerSandboxRunner {
  private readonly active = new Map<string, string>();

  async health(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      return { ok: true, version: await docker(["version", "--format", "{{.Server.Version}}"] ) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async run(request: SandboxRequest, callbacks: SandboxCallbacks): Promise<SandboxResult> {
    if (request.network === "registry") {
      throw new WorkspaceError("FORBIDDEN", "Registry-only task networking is not configured");
    }
    if (request.network === "restricted" && !request.networkName?.match(/^gptdev-preview-[a-f0-9-]{36}$/)) {
      throw new WorkspaceError("FORBIDDEN", "Restricted networking requires a task-specific preview network");
    }
    const workspaceStat = await stat(request.worktreePath);
    // In rootless Docker, container UID 0 maps to the unprivileged daemon user
    // that owns the bind-mounted worktree. A host UID passed through literally
    // maps to a subordinate UID and cannot read mode-0640 workspace files.
    const rootless = await isRootlessDocker();
    const uid = rootless ? 0 : typeof workspaceStat.uid === "number" ? workspaceStat.uid : 1000;
    const gid = rootless ? 0 : typeof workspaceStat.gid === "number" ? workspaceStat.gid : 1000;
    const name = `gptdev-${request.taskId}`;
    const createArgs = [
      "create", "--name", name,
      "--network", request.network === "restricted" ? request.networkName! : "none",
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      "--memory", request.limits.memory,
      "--cpus", String(request.limits.cpus),
      "--pids-limit", String(request.limits.pids),
      "--user", `${uid}:${gid}`,
      "--env", "HOME=/tmp",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m",
      "--workdir", "/workspace",
      "--mount", `type=bind,source=${request.worktreePath},target=/workspace`,
      "--mount", `type=bind,source=${request.artifactPath},target=/artifacts`,
      request.image,
      request.executable,
      ...request.args
    ];
    await docker(["rm", "--force", name], true);
    const containerId = await docker(createArgs);
    this.active.set(request.taskId, containerId);
    callbacks.onContainer(containerId);
    let totalBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      const child = spawn("docker", ["start", "--attach", containerId], { stdio: ["ignore", "pipe", "pipe"] });
      const consume = (stream: "stdout" | "stderr") => (chunk: Buffer): void => {
        if (totalBytes >= request.limits.maxOutputBytes) { outputTruncated = true; return; }
        const remaining = request.limits.maxOutputBytes - totalBytes;
        const sliced = chunk.subarray(0, remaining);
        totalBytes += sliced.byteLength;
        callbacks.onLog(stream, redactSecrets(sliced.toString("utf8")));
        if (sliced.byteLength < chunk.byteLength) outputTruncated = true;
      };
      child.stdout.on("data", consume("stdout"));
      child.stderr.on("data", consume("stderr"));
      child.on("error", reject);
      const timer = setTimeout(() => {
        timedOut = true;
        void docker(["stop", "--time", "2", containerId], true);
      }, request.limits.timeoutSeconds * 1000);
      child.on("close", async () => {
        clearTimeout(timer);
        try {
          const inspected = await docker(["inspect", "--format", "{{.State.ExitCode}}", containerId]);
          resolvePromise(Number.parseInt(inspected, 10));
        } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    this.active.delete(request.taskId);
    await docker(["rm", "--force", containerId], true);
    return { containerId, exitCode, timedOut, outputTruncated };
  }

  async cancel(taskId: string): Promise<void> {
    const containerId = this.active.get(taskId);
    if (!containerId) throw new WorkspaceError("CONFLICT", "Task has no active container");
    await docker(["stop", "--time", "2", containerId], true);
  }
}
