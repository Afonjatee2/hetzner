import { resolve } from "node:path";
import { z } from "zod/v4";

const Environment = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  MCP_PATH: z.string().startsWith("/").default("/mcp"),
  GATEWAY_NAME: z.string().min(1).max(100).default("hetzner-dev-workspace"),
  GATEWAY_PROFILE: z.enum(["full", "local-files"]).default("full"),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:8081"),
  WORKSPACE_ROOT: z.string().default("./fixtures/workspaces"),
  WORKTREE_ROOT: z.string().default("./.state/worktrees"),
  STATE_DIR: z.string().default("./.state"),
  ARTIFACT_DIR: z.string().default("./.artifacts"),
  DATABASE_URL: z.string().default("./.state/app.db"),
  TASK_DEFAULT_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(3600).default(900),
  TASK_MAX_TIMEOUT_SECONDS: z.coerce.number().int().min(5).max(86400).default(3600),
  TASK_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1024).default(10_485_760),
  TASK_DEFAULT_MEMORY: z.string().regex(/^\d+[kmg]$/i).default("2g"),
  TASK_DEFAULT_CPUS: z.coerce.number().positive().max(64).default(2),
  TASK_DEFAULT_PIDS: z.coerce.number().int().min(16).max(32768).default(256),
  HOST_EXECUTION: z.enum(["disabled", "enabled"]).default("disabled"),
  HOST_PATH_PREPEND: z.string().optional(),
  AGENT_CLI_PATH: z.string().default("claude"),
  AGENT_BACKEND_BASE_URL: z.string().url().default("http://127.0.0.1:3456"),
  AGENT_BACKEND_API_KEY: z.string().optional(),
  AUTH_MODE: z.enum(["development", "oauth", "first-party"]).default("development"),
  OAUTH_ISSUER: z.string().optional(),
  OAUTH_AUDIENCE: z.string().optional(),
  OAUTH_JWKS_URI: z.string().url().optional(),
  OAUTH_OPERATOR_PASSWORD_HASH: z.string().optional(),
  OAUTH_SIGNING_KEY_PATH: z.string().default("./.state/oauth-signing-key.pem"),
  OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(3600).default(3600),
  OAUTH_REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  SKILLS_ROOT: z.string().optional(),
  HANDOFF_OUTBOX_DIR: z.string().optional(),
  HANDOFF_INBOX_DIR: z.string().optional(),
  HANDOFF_SSH_TARGET: z.string().regex(/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9.-]+$/).optional(),
  HANDOFF_SSH_KEY_PATH: z.string().optional(),
  HANDOFF_SSH_KNOWN_HOSTS_PATH: z.string().optional(),
  HANDOFF_MAX_BYTES: z.coerce.number().int().min(1_048_576).max(524_288_000).default(104_857_600),
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_API_BASE: z.string().url().default("https://api.github.com"),
  PNPM_STORE_DIR: z.string().optional(),
  REGISTRY_NETWORK_NAME: z.string().default("gptdev-registry")
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = Environment.parse(env);
  if (parsed.NODE_ENV === "production" && parsed.AUTH_MODE === "development") {
    throw new Error("Production requires AUTH_MODE=oauth or AUTH_MODE=first-party");
  }
  if (parsed.AUTH_MODE === "oauth" && (!parsed.OAUTH_ISSUER || !parsed.OAUTH_AUDIENCE || !parsed.OAUTH_JWKS_URI)) {
    throw new Error("OAuth mode requires OAUTH_ISSUER, OAUTH_AUDIENCE and OAUTH_JWKS_URI");
  }
  if (parsed.AUTH_MODE === "first-party" && !parsed.OAUTH_OPERATOR_PASSWORD_HASH) {
    throw new Error("first-party mode requires OAUTH_OPERATOR_PASSWORD_HASH");
  }
  const senderFields = [parsed.HANDOFF_OUTBOX_DIR, parsed.HANDOFF_SSH_TARGET, parsed.HANDOFF_SSH_KEY_PATH, parsed.HANDOFF_SSH_KNOWN_HOSTS_PATH];
  if (senderFields.some(Boolean) && !senderFields.every(Boolean)) {
    throw new Error("Handoff sender requires OUTBOX_DIR, SSH_TARGET, SSH_KEY_PATH and SSH_KNOWN_HOSTS_PATH");
  }
  const trimmedBaseUrl = parsed.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const oauthIssuer = parsed.AUTH_MODE === "first-party" ? trimmedBaseUrl : parsed.OAUTH_ISSUER;
  const oauthAudience = parsed.AUTH_MODE === "first-party" ? `${trimmedBaseUrl}${parsed.MCP_PATH}` : parsed.OAUTH_AUDIENCE;
  return {
    ...parsed,
    workspaceRoot: resolve(parsed.WORKSPACE_ROOT),
    worktreeRoot: resolve(parsed.WORKTREE_ROOT),
    stateDir: resolve(parsed.STATE_DIR),
    artifactDir: resolve(parsed.ARTIFACT_DIR),
    databasePath: resolve(parsed.DATABASE_URL),
    signingKeyPath: resolve(parsed.OAUTH_SIGNING_KEY_PATH),
    skillsRoot: parsed.SKILLS_ROOT ? resolve(parsed.SKILLS_ROOT) : undefined,
    handoffOutboxDir: parsed.HANDOFF_OUTBOX_DIR ? resolve(parsed.HANDOFF_OUTBOX_DIR) : undefined,
    handoffInboxDir: parsed.HANDOFF_INBOX_DIR ? resolve(parsed.HANDOFF_INBOX_DIR) : undefined,
    handoffSshKeyPath: parsed.HANDOFF_SSH_KEY_PATH ? resolve(parsed.HANDOFF_SSH_KEY_PATH) : undefined,
    handoffKnownHostsPath: parsed.HANDOFF_SSH_KNOWN_HOSTS_PATH ? resolve(parsed.HANDOFF_SSH_KNOWN_HOSTS_PATH) : undefined,
    oauthIssuer,
    oauthAudience
  };
}
