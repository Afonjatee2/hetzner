import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArtifactService } from "@gpt-dev/artifact-service";
import { BrowserService, DevServerService } from "@gpt-dev/browser-service";
import { GitService } from "@gpt-dev/git-service";
import { WorkspaceDatabase } from "@gpt-dev/persistence";
import { ProjectService } from "@gpt-dev/projects";
import { DockerSandboxRunner } from "@gpt-dev/sandbox-runner";
import { TaskService } from "@gpt-dev/task-service";
import { AuthService } from "./auth.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./tools.js";

const config = loadConfig();
const database = new WorkspaceDatabase(config.databasePath);
const projects = new ProjectService(database);
const git = new GitService(config.worktreeRoot);
const runner = new DockerSandboxRunner();
const artifacts = new ArtifactService(database, config.artifactDir);
const tasks = new TaskService(database, runner, artifacts);
const browser = new BrowserService();
const devServers = new DevServerService(database);
const interrupted = tasks.reconcileInterrupted();
const services = { config, database, projects, git, runner, tasks, artifacts, browser, devServers };
const auth = new AuthService(config);
const app = Fastify({ logger: { level: config.NODE_ENV === "production" ? "info" : "debug", redact: ["req.headers.authorization"] }, trustProxy: true, bodyLimit: 2_000_000 });

interface Session { server: McpServer; transport: StreamableHTTPServerTransport }
const sessions = new Map<string, Session>();

app.get("/healthz", async () => ({ status: "ok", docker: await runner.health(), interruptedTasksReconciled: interrupted }));
app.get("/.well-known/oauth-protected-resource", () => auth.protectedResourceMetadata());
app.get("/.well-known/oauth-protected-resource/mcp", () => auth.protectedResourceMetadata());

app.all(config.MCP_PATH, async (request, reply) => {
  try {
    await auth.authenticate(request, ["workspace.read"]);
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 401;
    reply.header("WWW-Authenticate", `Bearer resource_metadata="${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`);
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Unauthorized" });
  }

  const sessionIdHeader = request.headers["mcp-session-id"];
  const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (request.method === "POST" && !session && isInitializeRequest(request.body)) {
    const server = createMcpServer(services);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { server, transport }); },
      onsessionclosed: (id) => { sessions.delete(id); }
    });
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    session = { server, transport };
  }

  if (!session) {
    return reply.code(400).send({ jsonrpc: "2.0", error: { code: -32000, message: "Missing or invalid MCP session" }, id: null });
  }

  reply.hijack();
  await session.transport.handleRequest(request.raw, reply.raw, request.body);
});

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  if (!reply.sent) void reply.code(500).send({ error: "Internal server error" });
});

await app.listen({ host: config.HOST, port: config.PORT });

const shutdown = async (): Promise<void> => {
  await app.close();
  for (const { server, transport } of sessions.values()) {
    await transport.close();
    await server.close();
  }
  database.close();
};

process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.on("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
