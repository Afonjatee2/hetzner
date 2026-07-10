import { randomBytes, randomUUID } from "node:crypto";
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
import { loadOrCreateSigningKey } from "./oauth/keys.js";
import { LoginRateLimiter } from "./oauth/login.js";
import { OAuthProvider } from "./oauth/provider.js";
import { registerOAuthRoutes } from "./oauth/routes.js";
import { OAuthStore } from "./oauth/store.js";
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
const firstPartySigningKey = config.AUTH_MODE === "first-party" ? await loadOrCreateSigningKey(config.signingKeyPath) : undefined;
const auth = new AuthService(config, firstPartySigningKey ? [firstPartySigningKey] : undefined);
// Only trust X-Forwarded-For from loopback: cloudflared (or any local reverse
// proxy) always connects over 127.0.0.1/::1, so this is the only hop allowed to
// set the client IP. `trustProxy: true` would let a remote client spoof
// request.ip via an arbitrary X-Forwarded-For header, defeating both the
// development loopback check and the OAuth login rate limiter.
const app = Fastify({
  logger: { level: config.NODE_ENV === "production" ? "info" : "debug", redact: ["req.headers.authorization"] },
  trustProxy: ["127.0.0.1", "::1"],
  bodyLimit: 2_000_000
});

if (config.AUTH_MODE === "first-party" && firstPartySigningKey) {
  const store = new OAuthStore(database.db);
  const provider = new OAuthProvider({ config, store, signingKey: firstPartySigningKey, database });
  registerOAuthRoutes(app, { config, database, provider, signingKey: firstPartySigningKey, csrfSecret: randomBytes(32), rateLimiter: new LoginRateLimiter() });
  const purgeInterval = setInterval(() => store.purgeExpired(), 5 * 60_000);
  purgeInterval.unref();
}

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
    const resourceMetadata = `${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`;
    const wwwAuthenticate = statusCode === 403
      ? `Bearer error="insufficient_scope", scope="workspace.read", resource_metadata="${resourceMetadata}"`
      : `Bearer scope="workspace.read", resource_metadata="${resourceMetadata}"`;
    reply.header("WWW-Authenticate", wwwAuthenticate);
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
