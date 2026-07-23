import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceDatabase } from "@gpt-dev/persistence";
import { loadConfig } from "../config.js";
import { buildJwks, loadOrCreateSigningKey } from "./keys.js";
import { randomToken } from "./pkce.js";
import { OAuthProvider, type AuthorizeQuery, type PreparedAuthorizeRequest, type TokenResult } from "./provider.js";
import { OAuthStore } from "./store.js";

const ALLOWED_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const QWEN_REDIRECT = "http://localhost:7777/oauth/callback";

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function body(result: TokenResult): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "gptdev-oauth-provider-"));
  const config = loadConfig({
    PUBLIC_BASE_URL: "https://dev-mcp.example.com",
    MCP_PATH: "/mcp",
    AUTH_MODE: "first-party",
    OAUTH_OPERATOR_PASSWORD_HASH: "scrypt:N=16384,r=8,p=1:a:b",
    DATABASE_URL: join(dir, "app.db")
  });
  const database = new WorkspaceDatabase(config.databasePath);
  cleanups.push(() => database.close());
  const store = new OAuthStore(database.db);
  const signingKey = await loadOrCreateSigningKey(join(dir, "key.pem"));
  let currentTime = new Date();
  const clock = () => currentTime;
  const advance = (ms: number): void => {
    currentTime = new Date(currentTime.getTime() + ms);
  };
  const provider = new OAuthProvider({ config, store, signingKey, database, clock });
  return { config, database, store, signingKey, provider, advance };
}

function registerClient(provider: OAuthProvider): string {
  const result = provider.registerClient({ redirect_uris: [ALLOWED_REDIRECT] });
  expect(result.status).toBe(201);
  return body(result).client_id as string;
}

async function fullAuthorize(provider: OAuthProvider, clientId: string, overrides: Partial<AuthorizeQuery> = {}) {
  const { verifier, challenge } = pkcePair();
  const query: AuthorizeQuery = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: ALLOWED_REDIRECT,
    state: "xyz",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...overrides
  };
  const outcome = await provider.prepareAuthorize(query);
  if (outcome.kind !== "ok") throw new Error(`expected ok outcome, got ${outcome.kind}`);
  const code = provider.issueCode(outcome.request);
  return { code, verifier, request: outcome.request };
}

function tokenBody(request: PreparedAuthorizeRequest, code: string, verifier: string, clientId: string): Record<string, string> {
  return { grant_type: "authorization_code", code, redirect_uri: request.redirectUri, client_id: clientId, code_verifier: verifier };
}

describe("registerClient", () => {
  it("registers a client with allowed redirect URIs", async () => {
    const { provider } = await setup();
    const result = provider.registerClient({ redirect_uris: [ALLOWED_REDIRECT] });
    expect(result.status).toBe(201);
    expect(typeof body(result).client_id).toBe("string");
    expect(body(result).token_endpoint_auth_method).toBe("none");
  });

  it("registers Qwen Code with its exact loopback redirect", async () => {
    const { provider } = await setup();
    const result = provider.registerClient({
      client_name: "Qwen Code",
      redirect_uris: [QWEN_REDIRECT],
      token_endpoint_auth_method: "none"
    });
    expect(result.status).toBe(201);
    expect(body(result).redirect_uris).toEqual([QWEN_REDIRECT]);
    expect(typeof body(result).client_id).toBe("string");
  });

  it("rejects a disallowed redirect_uri", async () => {
    const { provider } = await setup();
    const result = provider.registerClient({ redirect_uris: ["https://evil.example.com/callback"] });
    expect(result.status).toBe(400);
    expect(body(result).error).toBe("invalid_redirect_uri");
  });

  it("rejects non-none token endpoint auth methods", async () => {
    const { provider } = await setup();
    const result = provider.registerClient({ redirect_uris: [ALLOWED_REDIRECT], token_endpoint_auth_method: "client_secret_basic" });
    expect(result.status).toBe(400);
  });

  it("rejects malformed registration bodies", async () => {
    const { provider } = await setup();
    expect(provider.registerClient({ redirect_uris: [] }).status).toBe(400);
    expect(provider.registerClient({}).status).toBe(400);
  });
});

describe("prepareAuthorize", () => {
  it("returns a direct error for an unknown client", async () => {
    const { provider } = await setup();
    const outcome = await provider.prepareAuthorize({ client_id: "does-not-exist", redirect_uri: ALLOWED_REDIRECT });
    expect(outcome.kind).toBe("invalid_client");
  });

  it("returns a direct error for a redirect_uri not registered to the client", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const outcome = await provider.prepareAuthorize({ client_id: clientId, redirect_uri: "https://chatgpt.com/connector/oauth/other" });
    expect(outcome.kind).toBe("invalid_client");
  });

  it("redirects with an error for an unsupported response_type", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const { challenge } = pkcePair();
    const outcome = await provider.prepareAuthorize({
      client_id: clientId, redirect_uri: ALLOWED_REDIRECT, response_type: "token", code_challenge: challenge, code_challenge_method: "S256"
    });
    expect(outcome.kind).toBe("redirect_error");
    if (outcome.kind === "redirect_error") expect(outcome.error).toBe("unsupported_response_type");
  });

  it("redirects with an error when PKCE is missing or uses plain", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const missing = await provider.prepareAuthorize({ client_id: clientId, redirect_uri: ALLOWED_REDIRECT, response_type: "code" });
    expect(missing.kind).toBe("redirect_error");
    if (missing.kind === "redirect_error") expect(missing.error).toBe("invalid_request");

    const { challenge } = pkcePair();
    const plain = await provider.prepareAuthorize({
      client_id: clientId, redirect_uri: ALLOWED_REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "plain"
    });
    expect(plain.kind).toBe("redirect_error");
    if (plain.kind === "redirect_error") expect(plain.error).toBe("invalid_request");
  });

  it("redirects with an error for an unsupported scope", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const { challenge } = pkcePair();
    const outcome = await provider.prepareAuthorize({
      client_id: clientId, redirect_uri: ALLOWED_REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
      scope: "admin.everything"
    });
    expect(outcome.kind).toBe("redirect_error");
    if (outcome.kind === "redirect_error") expect(outcome.error).toBe("invalid_scope");
  });

  it("redirects with invalid_target when resource does not match the audience", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const { challenge } = pkcePair();
    const outcome = await provider.prepareAuthorize({
      client_id: clientId, redirect_uri: ALLOWED_REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
      resource: "https://someone-else.example.com/mcp"
    });
    expect(outcome.kind).toBe("redirect_error");
    if (outcome.kind === "redirect_error") expect(outcome.error).toBe("invalid_target");
  });

  it("accepts a fully valid request", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const { challenge } = pkcePair();
    const outcome = await provider.prepareAuthorize({
      client_id: clientId, redirect_uri: ALLOWED_REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
      resource: "https://dev-mcp.example.com/mcp"
    });
    expect(outcome.kind).toBe("ok");
  });
});

describe("authorization_code grant", () => {
  it("allows ChatGPT-style delayed redemption within thirty minutes", async () => {
    const { provider, advance } = await setup();
    const clientId = registerClient(provider);
    const { code, verifier, request } = await fullAuthorize(provider, clientId);
    advance(12 * 60_000);
    const result = await provider.handleTokenRequest(tokenBody(request, code, verifier, clientId));
    expect(result.status).toBe(200);
  });

  it("rejects redemption after thirty minutes", async () => {
    const { provider, advance } = await setup();
    const clientId = registerClient(provider);
    const { code, verifier, request } = await fullAuthorize(provider, clientId);
    advance(30 * 60_000 + 1);
    const result = await provider.handleTokenRequest(tokenBody(request, code, verifier, clientId));
    expect(result.status).toBe(400);
    expect(body(result).error).toBe("invalid_grant");
  });

  it("issues a verifiable access token with the expected claims", async () => {
    const { provider, signingKey, config } = await setup();
    const clientId = registerClient(provider);
    const { code, verifier, request } = await fullAuthorize(provider, clientId);
    const result = await provider.handleTokenRequest(tokenBody(request, code, verifier, clientId));
    expect(result.status).toBe(200);
    const accessToken = body(result).access_token as string;
    const jwks = createLocalJWKSet(buildJwks([signingKey]));
    const { payload } = await jwtVerify(accessToken, jwks, { issuer: config.oauthIssuer ?? "", audience: config.oauthAudience ?? "", algorithms: ["ES256"] });
    expect(payload.sub).toBe("operator");
    expect(payload.scope).toBe(request.scope);
    expect(typeof payload.jti).toBe("string");
  });

  it("returns a byte-identical response on a double redeem of the same code", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const { code, verifier, request } = await fullAuthorize(provider, clientId);
    const first = await provider.handleTokenRequest(tokenBody(request, code, verifier, clientId));
    const second = await provider.handleTokenRequest(tokenBody(request, code, verifier, clientId));
    expect(first.status).toBe(200);
    expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body));
  });

  it("fails a replay that presents the wrong verifier and revokes the issued refresh family", async () => {
    const { provider, store } = await setup();
    const clientId = registerClient(provider);
    const { code, verifier, request } = await fullAuthorize(provider, clientId);
    const first = await provider.handleTokenRequest(tokenBody(request, code, verifier, clientId));
    expect(first.status).toBe(200);
    const refreshToken = body(first).refresh_token as string;

    const secondBad = await provider.handleTokenRequest({ ...tokenBody(request, code, verifier, clientId), code_verifier: randomToken() });
    expect(secondBad.status).toBe(400);
    expect(body(secondBad).error).toBe("invalid_grant");

    const refreshAttempt = await provider.handleTokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    expect(refreshAttempt.status).toBe(400);
    expect(store.getRefreshToken(createHash("sha256").update(refreshToken).digest("hex"))?.revokedAt).toBeDefined();
  });

  it("fails for an unregistered client_id", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const { code, verifier, request } = await fullAuthorize(provider, clientId);
    const result = await provider.handleTokenRequest(tokenBody(request, code, verifier, "some-other-client"));
    expect(result.status).toBe(400);
    expect(body(result).error).toBe("invalid_grant");
  });
});

describe("refresh_token grant", () => {
  it("rotates the refresh token and replays the cached response within the grace window", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const { code, verifier, request } = await fullAuthorize(provider, clientId);
    const issued = await provider.handleTokenRequest(tokenBody(request, code, verifier, clientId));
    const refreshToken = body(issued).refresh_token as string;

    const first = await provider.handleTokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    expect(first.status).toBe(200);
    const second = await provider.handleTokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    expect(second.status).toBe(200);
    expect(JSON.stringify(first.body)).toBe(JSON.stringify(second.body));
  });

  it("revokes the token family on reuse past the grace window", async () => {
    const { provider, advance } = await setup();
    const clientId = registerClient(provider);
    const { code, verifier, request } = await fullAuthorize(provider, clientId);
    const issued = await provider.handleTokenRequest(tokenBody(request, code, verifier, clientId));
    const refreshToken = body(issued).refresh_token as string;

    const rotated = await provider.handleTokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    expect(rotated.status).toBe(200);
    const newRefreshToken = body(rotated).refresh_token as string;

    advance(61_000);
    const reuse = await provider.handleTokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect(body(reuse).error).toBe("invalid_grant");

    const afterRevocation = await provider.handleTokenRequest({ grant_type: "refresh_token", refresh_token: newRefreshToken, client_id: clientId });
    expect(afterRevocation.status).toBe(400);
  });

  it("fails for a wrong client_id", async () => {
    const { provider } = await setup();
    const clientId = registerClient(provider);
    const { code, verifier, request } = await fullAuthorize(provider, clientId);
    const issued = await provider.handleTokenRequest(tokenBody(request, code, verifier, clientId));
    const refreshToken = body(issued).refresh_token as string;

    const result = await provider.handleTokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: "wrong-client" });
    expect(result.status).toBe(400);
    expect(body(result).error).toBe("invalid_grant");
  });
});
