import { randomBytes, randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ArtifactService } from "@gpt-dev/artifact-service";
import { BrowserService, DevServerService } from "@gpt-dev/browser-service";
import { GitService } from "@gpt-dev/git-service";
import { HandoffInbox, HandoffSender } from "@gpt-dev/handoff-service";
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
const projects = new ProjectService(database, config.workspaceRoot);
const git = new GitService(config.worktreeRoot);
const runner = new DockerSandboxRunner();
const artifacts = new ArtifactService(database, config.artifactDir);
const tasks = new TaskService(database, runner, artifacts);
const browser = new BrowserService();
const devServers = new DevServerService(database);
const handoffSender = config.handoffOutboxDir && config.HANDOFF_SSH_TARGET && config.handoffSshKeyPath && config.handoffKnownHostsPath
  ? new HandoffSender({
      outboxDir: config.handoffOutboxDir,
      sshTarget: config.HANDOFF_SSH_TARGET,
      sshKeyPath: config.handoffSshKeyPath,
      knownHostsPath: config.handoffKnownHostsPath,
      maxBytes: config.HANDOFF_MAX_BYTES
    })
  : undefined;
const handoffInbox = config.handoffInboxDir ? new HandoffInbox(config.handoffInboxDir, config.workspaceRoot) : undefined;
const interrupted = tasks.reconcileInterrupted();
const services = { config, database, projects, git, runner, tasks, artifacts, browser, devServers, handoffSender, handoffInbox };
const firstPartySigningKey = config.AUTH_MODE === "first-party" ? await loadOrCreateSigningKey(config.signingKeyPath) : undefined;
const auth = new AuthService(config, firstPartySigningKey ? [firstPartySigningKey] : undefined);
// Only trust X-Forwarded-For from loopback: cloudflared (or any local reverse
// proxy) always connects over 127.0.0.1/::1, so this is the only hop allowed to
// set the client IP. `trustProxy: true` would let a remote client spoof
// request.ip via an arbitrary X-Forwarded-For header, defeating both the
// development loopback check and the OAuth login rate limiter.
const app = Fastify({
  logger: {
    level: config.NODE_ENV === "production" ? "info" : "debug",
    redact: ["req.headers.authorization"],
    serializers: {
      // Authorization query strings contain state and PKCE challenges. Keep the
      // route visible for operations while ensuring those values never reach
      // request logs.
      req(request) {
        const url = request.url.split("?", 1)[0] ?? request.url;
        return {
          method: request.method,
          url,
          host: request.headers.host ?? "",
          remoteAddress: request.ip
        };
      }
    }
  },
  trustProxy: ["127.0.0.1", "::1"],
  bodyLimit: 2_000_000
});

// Fallback body parser for any Content-Type Fastify has no registered parser
// for. MCP clients (e.g. the ChatGPT connector) POST the JSON-RPC body with a
// Content-Type that is not application/json; without this, Fastify rejects the
// request with 415 before it reaches the /mcp handler, so the client never
// receives the 401 auth challenge or a valid MCP response and cannot establish
// a session. Specific parsers (application/json, x-www-form-urlencoded) still
// take precedence; this only catches otherwise-unhandled types.
app.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
  const text = body as string;
  if (!text) { done(null, undefined); return; }
  try { done(null, JSON.parse(text)); }
  catch { done(null, text); }
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

const handleMcpRequest = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
  try {
    await auth.authenticate(request, ["workspace.read"]);
  } catch (error) {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 401;
    const resourceMetadata = `${config.PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`;
    const wwwAuthenticate = statusCode === 403
      ? `Bearer resource_metadata="${resourceMetadata}", error="insufficient_scope", scope="workspace.read"`
      : `Bearer resource_metadata="${resourceMetadata}", scope="workspace.read"`;
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
  return undefined;
};

app.all(config.MCP_PATH, handleMcpRequest);
// ChatGPT connectors are frequently configured with the bare origin instead of
// the /mcp path; every MCP call then 404s at "/" and the connector shows
// "Error refreshing actions". Serve MCP at the root as well so both work.
if (config.MCP_PATH !== "/") app.all("/", handleMcpRequest);

app.setErrorHandler((error: unknown, _request, reply) => {
  // Preserve client-error status codes (e.g. 415 from an unparseable body, 400
  // from a malformed request) instead of masking everything as 500 — a 500 on
  // the /mcp handshake makes strict clients abort the connection.
  const rawStatus = typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: unknown }).statusCode) : NaN;
  const statusCode = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  if (statusCode >= 500) app.log.error(error);
  if (!reply.sent) {
    const message = statusCode >= 500 ? "Internal server error" : (error instanceof Error ? error.message : "Request error");
    void reply.code(statusCode).send({ error: message });
  }
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
