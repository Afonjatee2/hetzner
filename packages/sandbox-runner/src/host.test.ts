import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkspaceError } from "@gpt-dev/schemas";
import { HostProcessRunner } from "./host.js";
import type { SandboxRequest } from "./index.js";

let worktree: string;
let artifacts: string;

beforeAll(async () => {
  worktree = await mkdtemp(join(tmpdir(), "host-runner-worktree-"));
  artifacts = await mkdtemp(join(tmpdir(), "host-runner-artifacts-"));
});

afterAll(async () => {
  await rm(worktree, { recursive: true, force: true });
  await rm(artifacts, { recursive: true, force: true });
});

function request(overrides: Partial<SandboxRequest>): SandboxRequest {
  return {
    taskId: overrides.taskId ?? crypto.randomUUID(),
    image: "host",
    executable: "/bin/echo",
    args: [],
    worktreePath: worktree,
    artifactPath: artifacts,
    network: "none",
    limits: { memory: "2g", cpus: 2, pids: 256, timeoutSeconds: 10, maxOutputBytes: 65536 },
    ...overrides
  };
}

function collector() {
  const logs: Array<{ stream: string; content: string }> = [];
  let containerId = "";
  return {
    logs,
    id: () => containerId,
    callbacks: {
      onContainer: (id: string) => { containerId = id; },
      onLog: (stream: "stdout" | "stderr", content: string) => { logs.push({ stream, content }); }
    }
  };
}

describe("HostProcessRunner", () => {
  it("runs a command in the worktree and captures stdout", async () => {
    const runner = new HostProcessRunner();
    const output = collector();
    const result = await runner.run(request({ executable: "/bin/sh", args: ["-c", "echo hello from $PWD"] }), output.callbacks);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(output.id()).toMatch(/^host-pid-\d+$/);
    const stdout = output.logs.filter((entry) => entry.stream === "stdout").map((entry) => entry.content).join("");
    expect(stdout).toContain("hello from");
    expect(stdout).toContain(worktree.split("/").at(-1) as string);
  });

  it("propagates non-zero exit codes", async () => {
    const runner = new HostProcessRunner();
    const result = await runner.run(request({ executable: "/bin/sh", args: ["-c", "exit 3"] }), collector().callbacks);
    expect(result.exitCode).toBe(3);
  });

  it("prepends configured directories to PATH and exposes the artifacts directory", async () => {
    const runner = new HostProcessRunner({ pathPrepend: "/custom/tools/bin" });
    const output = collector();
    await runner.run(request({ executable: "/bin/sh", args: ["-c", "echo PATH=$PATH; echo ART=$GPTDEV_ARTIFACTS_DIR"] }), output.callbacks);
    const stdout = output.logs.map((entry) => entry.content).join("");
    expect(stdout).toContain("PATH=/custom/tools/bin:");
    expect(stdout).toContain(`ART=${artifacts}`);
  });

  it("does not leak the gateway environment into the child", async () => {
    process.env.GATEWAY_SUPER_SECRET_MARKER = "leak-check";
    try {
      const runner = new HostProcessRunner();
      const output = collector();
      await runner.run(request({ executable: "/usr/bin/env", args: [] }), output.callbacks);
      expect(output.logs.map((entry) => entry.content).join("")).not.toContain("GATEWAY_SUPER_SECRET_MARKER");
    } finally {
      delete process.env.GATEWAY_SUPER_SECRET_MARKER;
    }
  });

  it("kills the whole process group on timeout", async () => {
    const runner = new HostProcessRunner();
    const started = Date.now();
    const result = await runner.run(request({
      executable: "/bin/sh", args: ["-c", "sleep 30 & sleep 30"],
      limits: { memory: "2g", cpus: 2, pids: 256, timeoutSeconds: 1, maxOutputBytes: 65536 }
    }), collector().callbacks);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("truncates output at the configured byte limit", async () => {
    const runner = new HostProcessRunner();
    const output = collector();
    const result = await runner.run(request({
      executable: "/bin/sh", args: ["-c", "yes | head -c 100000"],
      limits: { memory: "2g", cpus: 2, pids: 256, timeoutSeconds: 10, maxOutputBytes: 1024 }
    }), output.callbacks);
    expect(result.outputTruncated).toBe(true);
    const bytes = output.logs.reduce((total, entry) => total + Buffer.byteLength(entry.content), 0);
    expect(bytes).toBeLessThanOrEqual(1024);
  });

  it("cancels a running task", async () => {
    const runner = new HostProcessRunner();
    const taskId = crypto.randomUUID();
    const pending = runner.run(request({ taskId, executable: "/bin/sleep", args: ["30"] }), collector().callbacks);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    await runner.cancel(taskId);
    const result = await pending;
    expect(result.exitCode).not.toBe(0);
    await expect(runner.cancel(taskId)).rejects.toThrow(WorkspaceError);
  });

  it("rejects a missing executable as EXECUTION_FAILED", async () => {
    const runner = new HostProcessRunner();
    await expect(runner.run(request({ executable: "/nonexistent/binary" }), collector().callbacks))
      .rejects.toMatchObject({ code: "EXECUTION_FAILED" });
  });
});
