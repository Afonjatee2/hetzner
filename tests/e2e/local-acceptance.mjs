import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.MCP_ENDPOINT ?? "http://127.0.0.1:18081/mcp";
const workspace = process.env.FIXTURE_ROOT ?? new URL("../../fixtures/workspaces/", import.meta.url).pathname;
const client = new Client({ name: "local-acceptance", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

function parsed(result) {
  const item = result.content.find((entry) => entry.type === "text");
  assert(item && item.type === "text");
  return JSON.parse(item.text);
}

async function call(name, args = {}) {
  return parsed(await client.callTool({ name, arguments: args }));
}

async function waitForTask(id) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await call("get_task", { taskId: id });
    if (["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(result.data.status)) return result.data;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Task ${id} did not finish`);
}

await client.connect(transport);
try {
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "system_health"));
  assert(tools.tools.some((tool) => tool.name === "rollback_task"));

  const health = await call("system_health");
  assert.equal(health.ok, true);
  assert.equal(health.data.docker.ok, true);

  const projectPath = `${workspace.replace(/\/$/, "")}/broken-node-app`;
  const registered = await call("register_project", { id: "fixture-node", path: projectPath, defaultBranch: "main", runtime: "node" });
  assert.equal(registered.ok, true);

  const traversal = await call("read_file", { projectId: "fixture-node", path: "../../etc/passwd" });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.code, "FORBIDDEN");

  const created = await call("create_task_worktree", { projectId: "fixture-node", slug: "acceptance" });
  assert.equal(created.ok, true);
  const worktreeId = created.data.taskId;

  const initial = await call("run_command", {
    projectId: "fixture-node", taskId: worktreeId, executable: "npm", args: ["test"], network: "none"
  });
  assert.equal(initial.ok, true);
  const initialTask = await waitForTask(initial.data.id);
  assert.equal(initialTask.status, "failed");
  const initialLogs = await call("read_task_logs", { taskId: initial.data.id });
  assert(initialLogs.data.entries.some((entry) => entry.content.includes("Expected values to be strictly equal")));

  const fixed = await call("write_file", {
    projectId: "fixture-node", taskId: worktreeId, path: "src/math.js",
    content: "export function add(left, right) {\n  return left + right;\n}\n"
  });
  assert.equal(fixed.ok, true);

  const retest = await call("run_command", {
    projectId: "fixture-node", taskId: worktreeId, executable: "npm", args: ["test"], network: "none"
  });
  const retestTask = await waitForTask(retest.data.id);
  assert.equal(retestTask.status, "succeeded");

  const diff = await call("git_diff", { projectId: "fixture-node", taskId: worktreeId });
  assert(diff.data.includes("return left + right"));

  const isolation = await call("run_command", {
    projectId: "fixture-node", taskId: worktreeId, executable: "sh",
    args: ["-c", "test ! -e /var/run/docker.sock && test ! -e /etc/gpt-dev && test ! -e /root/.ssh"], network: "none"
  });
  assert.equal((await waitForTask(isolation.data.id)).status, "succeeded");

  const deniedNetwork = await call("run_command", {
    projectId: "fixture-node", taskId: worktreeId, executable: "node",
    args: ["-e", "fetch('https://example.com').then(()=>process.exit(1)).catch(()=>process.exit(0))"], network: "none"
  });
  assert.equal((await waitForTask(deniedNetwork.data.id)).status, "succeeded");

  const redaction = await call("run_command", {
    projectId: "fixture-node", taskId: worktreeId, executable: "sh",
    args: ["-c", "printf 'token=super-secret-value\\n'"], network: "none"
  });
  assert.equal((await waitForTask(redaction.data.id)).status, "succeeded");
  const redactedLogs = await call("read_task_logs", { taskId: redaction.data.id });
  assert(redactedLogs.data.entries.some((entry) => entry.content.includes("[REDACTED]")));
  assert(!redactedLogs.data.entries.some((entry) => entry.content.includes("super-secret-value")));

  const cancellable = await call("run_command", {
    projectId: "fixture-node", taskId: worktreeId, executable: "sleep", args: ["30"], network: "none"
  });
  const cancelDeadline = Date.now() + 10_000;
  while (Date.now() < cancelDeadline) {
    const state = await call("get_task", { taskId: cancellable.data.id });
    if (state.data.status === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const cancelled = await call("cancel_task", { taskId: cancellable.data.id });
  assert.equal(cancelled.data.status, "cancelled");

  const rollback = await call("rollback_task", { projectId: "fixture-node", taskId: worktreeId });
  assert.equal(rollback.data.discarded, true);

  console.log(JSON.stringify({ ok: true, tools: tools.tools.length, failedTask: initial.data.id, passedTask: retest.data.id }, null, 2));
} finally {
  await transport.terminateSession().catch(() => undefined);
  await client.close();
}
