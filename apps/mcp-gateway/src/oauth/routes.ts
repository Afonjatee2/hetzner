import type { FastifyInstance } from "fastify";
import { createAuditEvent } from "@gpt-dev/audit-service";
import type { WorkspaceDatabase } from "@gpt-dev/persistence";
import type { Config } from "../config.js";
import { buildJwks, type SigningKey } from "./keys.js";
import { createCsrfToken, LoginRateLimiter, renderLoginPage, verifyCsrfToken } from "./login.js";
import { verifyPassword } from "./password.js";
import type { OAuthProvider } from "./provider.js";

export interface OAuthRoutesDeps {
  config: Config;
  database: WorkspaceDatabase;
  provider: OAuthProvider;
  signingKey: SigningKey;
  csrfSecret: Buffer;
  rateLimiter: LoginRateLimiter;
}

function redirectWithError(redirectUri: string, error: string, description?: string, state?: string): URL {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (description) target.searchParams.set("error_description", description);
  if (state !== undefined) target.searchParams.set("state", state);
  return target;
}

export function registerOAuthRoutes(app: FastifyInstance, deps: OAuthRoutesDeps): void {
  const { config, database, provider, signingKey, csrfSecret, rateLimiter } = deps;

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body, done) => {
    try {
      const params = new URLSearchParams(body as string);
      const parsed: Record<string, string> = {};
      for (const [key, value] of params) parsed[key] = value;
      done(null, parsed);
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.get("/.well-known/oauth-authorization-server", () => provider.authorizationServerMetadata());
  app.get("/.well-known/openid-configuration", () => provider.authorizationServerMetadata());

  app.get("/.well-known/jwks.json", (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return buildJwks([signingKey]);
  });

  app.post("/oauth/register", (request, reply) => {
    const result = provider.registerClient(request.body);
    reply.header("Cache-Control", "no-store");
    return reply.code(result.status).send(result.body);
  });

  app.get("/oauth/authorize", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const outcome = await provider.prepareAuthorize(query);
    reply.header("Cache-Control", "no-store");
    if (outcome.kind === "invalid_client") {
      return reply.code(outcome.status).type("text/html").send(outcome.html);
    }
    if (outcome.kind === "redirect_error") {
      const target = redirectWithError(outcome.redirectUri, outcome.error, outcome.description, outcome.state);
      return reply.code(302).header("Location", target.toString()).send();
    }
    const csrfToken = createCsrfToken(csrfSecret);
    const html = renderLoginPage({ ...outcome.request }, csrfToken);
    reply.header("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'self'");
    return reply.type("text/html").send(html);
  });

  app.post("/oauth/authorize", async (request, reply) => {
    const body = request.body as Record<string, string | undefined>;
    reply.header("Cache-Control", "no-store");
    const ip = request.ip;

    const query = {
      response_type: body.response_type,
      client_id: body.client_id,
      redirect_uri: body.redirect_uri,
      state: body.state,
      scope: body.scope,
      resource: body.resource,
      code_challenge: body.code_challenge,
      code_challenge_method: body.code_challenge_method
    };
    const outcome = await provider.prepareAuthorize(query);
    if (outcome.kind === "invalid_client") {
      return reply.code(outcome.status).type("text/html").send(outcome.html);
    }
    if (outcome.kind === "redirect_error") {
      const target = redirectWithError(outcome.redirectUri, outcome.error, outcome.description, outcome.state);
      return reply.code(302).header("Location", target.toString()).send();
    }

    // isBlocked is a cheap, per-IP-only, read-only check consulted before the
    // comparatively expensive scrypt verification below. It never considers
    // any other IP's failures, so an attacker flooding wrong-password POSTs
    // (from this IP or any number of others) can never lock the operator's
    // own IP out of a correct login.
    if (rateLimiter.isBlocked(ip)) {
      database.recordAudit(createAuditEvent({ action: "oauth.login.rate_limited", actor: "oauth-provider", destructive: false, networked: false, detail: { clientId: outcome.request.clientId } }));
      return reply.code(429).send({ error: "too_many_requests" });
    }

    const csrfValid = verifyCsrfToken(csrfSecret, body.csrf_token);
    const password = body.password ?? "";
    const hash = config.OAUTH_OPERATOR_PASSWORD_HASH ?? "";
    const passwordValid = csrfValid && !!hash && verifyPassword(password, hash);

    if (!passwordValid) {
      rateLimiter.recordFailure(ip);
      if (rateLimiter.isGlobalSurgeDetected()) {
        database.recordAudit(createAuditEvent({ action: "oauth.login.global_failure_surge", actor: "oauth-provider", destructive: false, networked: false, detail: {} }));
      }
      const html = renderLoginPage({ ...outcome.request, error: csrfValid ? "Incorrect password" : "Session expired, please try again" }, createCsrfToken(csrfSecret));
      return reply.code(csrfValid ? 401 : 400).type("text/html").send(html);
    }

    const code = provider.issueCode(outcome.request);
    const target = new URL(outcome.request.redirectUri);
    target.searchParams.set("code", code);
    if (outcome.request.state !== undefined) target.searchParams.set("state", outcome.request.state);
    return reply.code(302).header("Location", target.toString()).send();
  });

  app.post("/oauth/token", async (request, reply) => {
    const body = request.body as Record<string, string | undefined>;
    const result = await provider.handleTokenRequest(body);
    reply.header("Cache-Control", "no-store");
    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) reply.header(key, value);
    }
    return reply.code(result.status).send(result.body);
  });
}
