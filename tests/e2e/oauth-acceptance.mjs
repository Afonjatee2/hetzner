import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const tsxEntry = join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const serverEntry = join(repoRoot, "apps/mcp-gateway/src/server.ts");

const PORT = 18082;
const BASE = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const OPERATOR_PASSWORD = "correct horse battery staple 42";

function hashPassword(password) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, { N, r, p }).toString("hex");
  return `scrypt:N=${N},r=${r},p=${p}:${salt}:${hash}`;
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function pkcePair() {
  const verifier = randomToken();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
}

async function registerClient(redirectUris) {
  const res = await fetch(`${BASE}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris })
  });
  return { status: res.status, body: await res.json() };
}

async function getAuthorizeForm(params) {
  const url = new URL(`${BASE}/oauth/authorize`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const res = await fetch(url, { redirect: "manual" });
  const text = await res.text();
  return { status: res.status, text };
}

function extractCsrfToken(html) {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  assert(match, "expected a csrf_token hidden field in the login form");
  return match[1];
}

async function postAuthorize(fields) {
  return fetch(`${BASE}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString()
  });
}

async function login(params, password) {
  const form = await getAuthorizeForm(params);
  assert.equal(form.status, 200);
  assert(form.text.includes("<form"));
  const csrfToken = extractCsrfToken(form.text);
  const res = await postAuthorize({ ...params, csrf_token: csrfToken, password });
  return res;
}

async function postToken(fields) {
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString()
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
}

async function fullAuthorizeAndExchange(clientId, scope) {
  const { verifier, challenge } = pkcePair();
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: `state-${randomToken(8)}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(scope ? { scope } : {})
  };
  const loginRes = await login(params, OPERATOR_PASSWORD);
  assert.equal(loginRes.status, 303);
  const location = new URL(loginRes.headers.get("location"));
  const code = location.searchParams.get("code");
  assert(code);
  assert.equal(location.searchParams.get("state"), params.state);
  // RFC 9207: the authorization response must carry iss = the AS issuer.
  assert.equal(location.searchParams.get("iss"), BASE);
  const tokenRes = await postToken({
    grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier
  });
  assert.equal(tokenRes.status, 200);
  return tokenRes.json;
}

async function waitForServer(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
      if (res.status === 200) return;
    } catch {
      // server not up yet
    }
    await sleep(200);
  }
  throw new Error("Server did not become ready in time");
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "gptdev-oauth-e2e-"));
  await Promise.all([
    mkdir(join(dir, "workspaces"), { recursive: true }),
    mkdir(join(dir, "worktrees"), { recursive: true }),
    mkdir(join(dir, "state"), { recursive: true }),
    mkdir(join(dir, "artifacts"), { recursive: true })
  ]);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    MCP_PATH: "/mcp",
    PUBLIC_BASE_URL: BASE,
    WORKSPACE_ROOT: join(dir, "workspaces"),
    WORKTREE_ROOT: join(dir, "worktrees"),
    STATE_DIR: join(dir, "state"),
    ARTIFACT_DIR: join(dir, "artifacts"),
    DATABASE_URL: join(dir, "state", "app.db"),
    AUTH_MODE: "first-party",
    OAUTH_OPERATOR_PASSWORD_HASH: hashPassword(OPERATOR_PASSWORD),
    OAUTH_SIGNING_KEY_PATH: join(dir, "state", "oauth-signing-key.pem")
  };

  const child = spawn(process.execPath, [tsxEntry, serverEntry], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  try {
    await waitForServer(15_000);

    const asMeta1 = await getJson("/.well-known/oauth-authorization-server");
    const asMeta2 = await getJson("/.well-known/openid-configuration");
    assert.equal(asMeta1.status, 200);
    assert.equal(asMeta2.status, 200);
    assert.deepEqual(asMeta1.body, asMeta2.body);
    assert(asMeta1.body.code_challenge_methods_supported.includes("S256"));
    assert.equal(asMeta1.body.client_id_metadata_document_supported, true);
    assert.equal(asMeta1.body.authorization_response_iss_parameter_supported, true);
    assert.equal(asMeta1.body.issuer, BASE);
    assert(asMeta1.body.token_endpoint_auth_methods_supported.includes("none"));
    assert(typeof asMeta1.body.authorization_endpoint === "string");
    assert(typeof asMeta1.body.token_endpoint === "string");

    const prm1 = await getJson("/.well-known/oauth-protected-resource");
    const prm2 = await getJson("/.well-known/oauth-protected-resource/mcp");
    assert.equal(prm1.status, 200);
    assert.equal(prm2.status, 200);
    assert(prm1.body.authorization_servers.length > 0);
    assert(prm2.body.authorization_servers.length > 0);

    const jwks = await getJson("/.well-known/jwks.json");
    assert.equal(jwks.status, 200);
    assert(Array.isArray(jwks.body.keys) && jwks.body.keys.length >= 1);
    assert(!("d" in jwks.body.keys[0]));

    const goodClient = await registerClient([REDIRECT_URI]);
    assert.equal(goodClient.status, 201);
    const clientId = goodClient.body.client_id;
    assert(typeof clientId === "string");

    const badClient = await registerClient(["https://evil.example.com/callback"]);
    assert.equal(badClient.status, 400);

    const { verifier, challenge } = pkcePair();
    const authParams = {
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT_URI, state: "abc123",
      code_challenge: challenge, code_challenge_method: "S256"
    };
    const form = await getAuthorizeForm(authParams);
    assert.equal(form.status, 200);
    assert(form.text.includes("<form"));
    const csrfToken = extractCsrfToken(form.text);

    const wrongPasswordRes = await postAuthorize({ ...authParams, csrf_token: csrfToken, password: "definitely-wrong" });
    assert.equal(wrongPasswordRes.status, 401);

    const loginRes = await postAuthorize({ ...authParams, csrf_token: csrfToken, password: OPERATOR_PASSWORD });
    assert.equal(loginRes.status, 303);
    const location = new URL(loginRes.headers.get("location"));
    const code = location.searchParams.get("code");
    assert(code);
    assert.equal(location.searchParams.get("state"), "abc123");

    const tokenFields = { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier };
    const tokenRes1 = await postToken(tokenFields);
    assert.equal(tokenRes1.status, 200);
    assert(typeof tokenRes1.json.access_token === "string");
    assert(typeof tokenRes1.json.refresh_token === "string");

    const tokenRes2 = await postToken(tokenFields);
    assert.equal(tokenRes2.status, 200);
    assert.equal(tokenRes1.text, tokenRes2.text);

    const unauthRes = await fetch(`${BASE}/mcp`, { headers: { Accept: "application/json, text/event-stream" } });
    assert.equal(unauthRes.status, 401);
    const unauthWwwAuth = unauthRes.headers.get("www-authenticate") ?? "";
    assert(unauthWwwAuth.includes('scope="workspace.read"'));
    assert(unauthWwwAuth.includes("resource_metadata="));

    // A POST with a Content-Type Fastify has no specific parser for must still
    // reach the handler and return the 401 challenge — never a 415/500 that
    // would make a strict MCP client (ChatGPT) abort before authenticating.
    const oddCtRes = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json-rpc", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    });
    assert.equal(oddCtRes.status, 401);
    assert((oddCtRes.headers.get("www-authenticate") ?? "").includes("resource_metadata="));

    const accessToken = tokenRes1.json.access_token;
    const mcpClient = new Client({ name: "oauth-acceptance", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
    });
    await mcpClient.connect(transport);
    const tools = await mcpClient.listTools();
    assert(tools.tools.some((tool) => tool.name === "system_health"));
    await transport.terminateSession().catch(() => undefined);
    await mcpClient.close();

    const refreshToken = tokenRes1.json.refresh_token;
    const rotated = await postToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    assert.equal(rotated.status, 200);
    assert(typeof rotated.json.access_token === "string");
    const newRefreshToken = rotated.json.refresh_token;
    assert.notEqual(newRefreshToken, refreshToken);

    // Wait past the 60s refresh-reuse grace window, then present the superseded token again.
    await sleep(61_000);
    const reuse = await postToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.json.error, "invalid_grant");
    const afterRevocation = await postToken({ grant_type: "refresh_token", refresh_token: newRefreshToken, client_id: clientId });
    assert.equal(afterRevocation.status, 400);

    const narrowTokens = await fullAuthorizeAndExchange(clientId, "task.execute");
    assert.equal(narrowTokens.scope, "task.execute");
    const narrowMcp = await fetch(`${BASE}/mcp`, {
      headers: { Authorization: `Bearer ${narrowTokens.access_token}`, Accept: "application/json, text/event-stream" }
    });
    assert.equal(narrowMcp.status, 403);
    const narrowWwwAuth = narrowMcp.headers.get("www-authenticate") ?? "";
    assert(narrowWwwAuth.includes('error="insufficient_scope"'));
    assert(narrowWwwAuth.includes('scope="workspace.read"'));

    const { challenge: rlChallenge } = pkcePair();
    const rlParams = {
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT_URI, state: "ratelimit",
      code_challenge: rlChallenge, code_challenge_method: "S256"
    };
    const rlForm = await getAuthorizeForm(rlParams);
    const rlCsrf = extractCsrfToken(rlForm.text);
    let sawRateLimit = false;
    for (let attempt = 0; attempt < 10 && !sawRateLimit; attempt += 1) {
      const res = await postAuthorize({ ...rlParams, csrf_token: rlCsrf, password: "still-wrong" });
      if (res.status === 429) sawRateLimit = true;
    }
    assert(sawRateLimit, "expected a 429 after repeated failed login attempts");

    assert(!output.includes(OPERATOR_PASSWORD), "operator password must not appear in logs");
    assert(!output.includes(accessToken), "access token must not appear in logs");
    assert(!output.includes(refreshToken), "refresh token must not appear in logs");
    assert(!output.includes(authParams.state), "OAuth state must not appear in logs");
    assert(!output.includes(authParams.code_challenge), "PKCE challenge must not appear in logs");

    console.log(JSON.stringify({ ok: true, clientId }, null, 2));
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
