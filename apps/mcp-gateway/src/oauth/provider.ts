import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { z } from "zod/v4";
import { createAuditEvent } from "@gpt-dev/audit-service";
import type { WorkspaceDatabase } from "@gpt-dev/persistence";
import type { Config } from "../config.js";
import { resolveClientIdMetadataDocument, type CimdDeps } from "./cimd.js";
import type { SigningKey } from "./keys.js";
import { isValidCodeChallenge, randomToken, sha256Hex, verifyCodeVerifier } from "./pkce.js";
import { isAllowedRedirectUri } from "./redirects.js";
import type { OAuthStore, RefreshTokenRecord } from "./store.js";

export const SUPPORTED_SCOPES = ["workspace.read", "workspace.write", "task.execute", "task.network"] as const;

// OAuth recommends authorization codes expire shortly after issuance, with a
// maximum lifetime of 10 minutes. ChatGPT's connector platform has been
// observed redeeming codes ~12 minutes after issuance (2026-07-11: redemption
// at 11m50s hit the previous 10-minute window and failed with invalid_grant),
// so this deliberately exceeds the RFC guidance. Codes remain single-use,
// PKCE-bound, and stored hashed, so the extra exposure is acceptable for a
// single-operator gateway.
const CODE_TTL_MS = 30 * 60_000;
const REFRESH_GRACE_MS = 60_000;

export interface ProviderDeps {
  config: Config;
  store: OAuthStore;
  signingKey: SigningKey;
  database: WorkspaceDatabase;
  cimdDeps?: CimdDeps;
  clock?: () => Date;
}

export interface ResolvedClient {
  id: string;
  redirectUris: string[];
}

export interface PreparedAuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state?: string;
  scope: string;
  resource?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  responseType: string;
}

export type AuthorizeOutcome =
  | { kind: "invalid_client"; status: number; html: string }
  | { kind: "redirect_error"; redirectUri: string; state?: string; error: string; description?: string }
  | { kind: "ok"; request: PreparedAuthorizeRequest };

export interface AuthorizeQuery {
  response_type?: string | undefined;
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  state?: string | undefined;
  scope?: string | undefined;
  resource?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
}

export interface TokenResult {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  /** Internal-only rejection reason for logs/audit; never sent to the client. */
  reason?: string;
}

const RegisterClientBody = z.object({
  client_name: z.string().max(200).optional(),
  redirect_uris: z.array(z.string()).min(1),
  token_endpoint_auth_method: z.string().optional(),
  scope: z.string().optional()
});

function errorPage(status: number, message: string): { kind: "invalid_client"; status: number; html: string } {
  return { kind: "invalid_client", status, html: `<!doctype html><html><body><h1>${message}</h1></body></html>` };
}

function normalizeResource(value: string): string {
  return value.replace(/\/+$/, "");
}

export class OAuthProvider {
  // In-memory cache of recently issued codes keyed by request fingerprint.
  // Prevents multiple codes from being issued for the same authorization
  // request when the browser double-clicks the sign-in button or resubmits
  // before the redirect completes.  Values expire after CODE_TTL_MS.
  private readonly recentCodes = new Map<string, { code: string; expiresAt: number }>();

  constructor(private readonly deps: ProviderDeps) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  private audit(action: string, detail: Record<string, unknown>): void {
    this.deps.database.recordAudit(createAuditEvent({ action, actor: "oauth-provider", destructive: false, networked: false, detail }));
  }

  private requestFingerprint(request: PreparedAuthorizeRequest): string {
    return [request.clientId, request.redirectUri, request.codeChallenge].join("|");
  }

  authorizationServerMetadata(): Record<string, unknown> {
    const issuer = this.deps.config.oauthIssuer ?? "";
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...SUPPORTED_SCOPES],
      // Advertised by the known-good dev-mcp gateway; ChatGPT falls back to
      // dynamic registration when this is absent, which changes the flow.
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true
    };
  }

  registerClient(body: unknown): TokenResult {
    const parsed = RegisterClientBody.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { error: "invalid_client_metadata", error_description: "Invalid registration request" } };
    }
    const { redirect_uris: redirectUris, client_name: clientName, token_endpoint_auth_method: authMethod, scope } = parsed.data;
    if (authMethod && authMethod !== "none") {
      return { status: 400, body: { error: "invalid_client_metadata", error_description: "Only token_endpoint_auth_method=none is supported" } };
    }
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri)) {
        return { status: 400, body: { error: "invalid_redirect_uri", error_description: `Redirect URI not allowed: ${uri}` } };
      }
    }
    const id = randomUUID();
    const createdAt = this.now().toISOString();
    this.deps.store.createClient({
      id,
      redirectUris,
      tokenEndpointAuthMethod: "none",
      createdAt,
      ...(clientName ? { clientName } : {}),
      ...(scope ? { scope } : {})
    });
    this.audit("oauth.client.registered", { clientId: id });
    return {
      status: 201,
      body: {
        client_id: id,
        client_name: clientName ?? null,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: scope ?? SUPPORTED_SCOPES.join(" ")
      }
    };
  }

  async resolveClient(clientId: string): Promise<ResolvedClient | undefined> {
    if (/^https:\/\//i.test(clientId)) {
      try {
        const doc = await resolveClientIdMetadataDocument(clientId, this.deps.cimdDeps);
        const redirectUris = Array.isArray(doc.redirect_uris)
          ? doc.redirect_uris.filter((value): value is string => typeof value === "string")
          : [];
        const allowed = redirectUris.filter(isAllowedRedirectUri);
        if (allowed.length === 0) return undefined;
        return { id: clientId, redirectUris: allowed };
      } catch {
        return undefined;
      }
    }
    const row = this.deps.store.getClient(clientId);
    if (!row) return undefined;
    return { id: row.id, redirectUris: row.redirectUris };
  }

  async prepareAuthorize(query: AuthorizeQuery): Promise<AuthorizeOutcome> {
    if (!query.client_id) return errorPage(400, "Missing client_id");
    const client = await this.resolveClient(query.client_id);
    if (!client) return errorPage(400, "Unknown client");
    if (!query.redirect_uri || !isAllowedRedirectUri(query.redirect_uri) || !client.redirectUris.includes(query.redirect_uri)) {
      return errorPage(400, "Invalid redirect_uri");
    }

    const redirectUri = query.redirect_uri;
    const state = query.state;

    if (query.response_type !== "code") {
      return { kind: "redirect_error", redirectUri, ...(state !== undefined ? { state } : {}), error: "unsupported_response_type" };
    }
    if (!isValidCodeChallenge(query.code_challenge, query.code_challenge_method)) {
      return {
        kind: "redirect_error",
        redirectUri,
        ...(state !== undefined ? { state } : {}),
        error: "invalid_request",
        description: "A valid S256 code_challenge is required"
      };
    }

    let scope: string;
    if (query.scope) {
      const requested = query.scope.split(/\s+/).filter(Boolean);
      const supported: readonly string[] = SUPPORTED_SCOPES;
      if (requested.length === 0 || !requested.every((value) => supported.includes(value))) {
        return { kind: "redirect_error", redirectUri, ...(state !== undefined ? { state } : {}), error: "invalid_scope" };
      }
      scope = requested.join(" ");
    } else {
      scope = SUPPORTED_SCOPES.join(" ");
    }

    let resource: string | undefined;
    if (query.resource) {
      const audience = this.deps.config.oauthAudience;
      if (!audience || normalizeResource(query.resource) !== normalizeResource(audience)) {
        return { kind: "redirect_error", redirectUri, ...(state !== undefined ? { state } : {}), error: "invalid_target" };
      }
      resource = query.resource;
    }

    return {
      kind: "ok",
      request: {
        clientId: client.id,
        redirectUri,
        ...(state !== undefined ? { state } : {}),
        scope,
        ...(resource !== undefined ? { resource } : {}),
        codeChallenge: query.code_challenge as string,
        codeChallengeMethod: query.code_challenge_method as string,
        responseType: "code"
      }
    };
  }

  issueCode(request: PreparedAuthorizeRequest): string {
    const fingerprint = this.requestFingerprint(request);
    const nowMs = this.now().getTime();

    // Reuse a code issued for the same request within the last 30 seconds.
    // This prevents the browser sending multiple authorization codes when the
    // user double-clicks Sign in or when a redirected page reloads the form
    // before the server redirect is followed.  The idempotency window is short
    // enough that a legitimate re-request (new state/code_challenge) always
    // creates a fresh code, but long enough to absorb form resubmission races.
    const recent = this.recentCodes.get(fingerprint);
    if (recent && recent.expiresAt > nowMs) {
      return recent.code;
    }

    const code = randomToken();
    const now = this.now();
    this.deps.store.insertCode({
      codeHash: sha256Hex(code),
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scope: request.scope,
      ...(request.resource !== undefined ? { resource: request.resource } : {}),
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
      createdAt: now.toISOString()
    });
    this.audit("oauth.code.issued", { clientId: request.clientId });

    // Cache for 30 s idempotency window; evict expired entries when we reach a
    // reasonable size to prevent unbounded growth.
    this.recentCodes.set(fingerprint, { code, expiresAt: nowMs + 30_000 });
    if (this.recentCodes.size > 200) {
      for (const [key, value] of this.recentCodes) {
        if (value.expiresAt <= nowMs) this.recentCodes.delete(key);
      }
    }

    return code;
  }

  private async signAccessToken(clientId: string, scope: string): Promise<string> {
    const jti = randomUUID();
    const issuedAtSeconds = Math.floor(this.now().getTime() / 1000);
    return new SignJWT({ scope, client_id: clientId })
      .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: this.deps.signingKey.kid })
      .setIssuer(this.deps.config.oauthIssuer ?? "")
      .setAudience(this.deps.config.oauthAudience ?? "")
      .setSubject("operator")
      .setJti(jti)
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + this.deps.config.OAUTH_ACCESS_TOKEN_TTL_SECONDS)
      .sign(this.deps.signingKey.privateKey);
  }

  private tokenError(status: number, error: string, reason?: string, description?: string): TokenResult {
    if (reason) this.audit("oauth.token.rejected", { error, reason });
    return {
      status,
      headers: { "Cache-Control": "no-store" },
      body: { error, ...(description ? { error_description: description } : {}) },
      ...(reason ? { reason } : {})
    };
  }

  async handleTokenRequest(body: Record<string, string | undefined>): Promise<TokenResult> {
    this.deps.store.purgeExpired();
    if (body.grant_type === "authorization_code") return this.handleAuthorizationCodeGrant(body);
    if (body.grant_type === "refresh_token") return this.handleRefreshTokenGrant(body);
    return this.tokenError(400, "unsupported_grant_type", "unsupported_grant_type");
  }

  private revokeFamilyFromCachedResponse(tokenResponseJson: string, clientId: string): void {
    try {
      const cached = JSON.parse(tokenResponseJson) as { refresh_token?: string };
      if (!cached.refresh_token) return;
      const refreshRow = this.deps.store.getRefreshToken(sha256Hex(cached.refresh_token));
      if (refreshRow) {
        this.deps.store.revokeFamily(refreshRow.familyId);
        this.audit("oauth.token.reuse_detected", { familyId: refreshRow.familyId, clientId });
      }
    } catch {
      // malformed cached response - nothing to revoke
    }
  }

  private async handleAuthorizationCodeGrant(body: Record<string, string | undefined>): Promise<TokenResult> {
    const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier } = body;
    if (!code || !redirectUri || !clientId || !codeVerifier) return this.tokenError(400, "invalid_request", "missing_code_params");

    const codeHash = sha256Hex(code);
    const row = this.deps.store.getCode(codeHash);
    if (!row) return this.tokenError(400, "invalid_grant", "code_not_found");

    const nowMs = this.now().getTime();
    const expiresMs = Date.parse(row.expiresAt);

    if (row.consumedAt) {
      if (
        nowMs <= expiresMs && row.clientId === clientId && row.redirectUri === redirectUri &&
        verifyCodeVerifier(codeVerifier, row.codeChallenge) && row.tokenResponseJson
      ) {
        return { status: 200, headers: { "Cache-Control": "no-store" }, body: JSON.parse(row.tokenResponseJson) as unknown };
      }
      if (row.tokenResponseJson) this.revokeFamilyFromCachedResponse(row.tokenResponseJson, clientId);
      return this.tokenError(400, "invalid_grant", "code_already_consumed_replay_mismatch");
    }

    if (nowMs > expiresMs) return this.tokenError(400, "invalid_grant", "code_expired");
    if (row.clientId !== clientId || row.redirectUri !== redirectUri) return this.tokenError(400, "invalid_grant", row.clientId !== clientId ? "client_id_mismatch" : "redirect_uri_mismatch");
    if (row.codeChallengeMethod !== "S256" || !verifyCodeVerifier(codeVerifier, row.codeChallenge)) return this.tokenError(400, "invalid_grant", "pkce_mismatch");

    const scope = row.scope;
    const familyId = randomUUID();
    const accessToken = await this.signAccessToken(clientId, scope);
    const refreshToken = randomToken();
    const responseBody = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.deps.config.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope
    };
    const responseJson = JSON.stringify(responseBody);
    const consumedAt = new Date(nowMs).toISOString();
    const refreshExpiresAt = new Date(nowMs + this.deps.config.OAUTH_REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString();

    const refreshRecord: RefreshTokenRecord = {
      tokenHash: sha256Hex(refreshToken),
      familyId,
      clientId,
      scope,
      expiresAt: refreshExpiresAt,
      createdAt: consumedAt,
      ...(row.resource !== undefined ? { resource: row.resource } : {})
    };
    const won = this.deps.store.consumeCodeAndIssueRefresh({ codeHash, consumedAt, tokenResponseJson: responseJson, refreshToken: refreshRecord });

    if (!won) {
      const fresh = this.deps.store.getCode(codeHash);
      if (
        fresh?.consumedAt && fresh.tokenResponseJson && fresh.clientId === clientId && fresh.redirectUri === redirectUri &&
        verifyCodeVerifier(codeVerifier, fresh.codeChallenge)
      ) {
        return { status: 200, headers: { "Cache-Control": "no-store" }, body: JSON.parse(fresh.tokenResponseJson) as unknown };
      }
      return this.tokenError(400, "invalid_grant", "code_consume_race_lost");
    }

    this.audit("oauth.token.issued", { clientId, familyId });
    return { status: 200, headers: { "Cache-Control": "no-store" }, body: responseBody };
  }

  private async handleRefreshTokenGrant(body: Record<string, string | undefined>): Promise<TokenResult> {
    const { refresh_token: refreshToken, client_id: clientId } = body;
    if (!refreshToken || !clientId) return this.tokenError(400, "invalid_request", "missing_refresh_params");

    const tokenHash = sha256Hex(refreshToken);
    const row = this.deps.store.getRefreshToken(tokenHash);
    if (!row || row.clientId !== clientId) return this.tokenError(400, "invalid_grant", !row ? "refresh_token_not_found" : "refresh_client_id_mismatch");

    const nowMs = this.now().getTime();
    if (row.revokedAt) return this.tokenError(400, "invalid_grant", "refresh_token_revoked");
    if (Date.parse(row.expiresAt) < nowMs) return this.tokenError(400, "invalid_grant", "refresh_token_expired");

    if (row.rotatedAt) {
      const rotatedMs = Date.parse(row.rotatedAt);
      if (nowMs - rotatedMs <= REFRESH_GRACE_MS && row.rotationResponseJson) {
        return { status: 200, headers: { "Cache-Control": "no-store" }, body: JSON.parse(row.rotationResponseJson) as unknown };
      }
      this.deps.store.revokeFamily(row.familyId);
      this.audit("oauth.token.reuse_detected", { familyId: row.familyId, clientId });
      return this.tokenError(400, "invalid_grant", "refresh_reuse_outside_grace");
    }

    const scope = row.scope;
    const newAccessToken = await this.signAccessToken(clientId, scope);
    const newRefreshToken = randomToken();
    const responseBody = {
      access_token: newAccessToken,
      token_type: "Bearer",
      expires_in: this.deps.config.OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: newRefreshToken,
      scope
    };
    const responseJson = JSON.stringify(responseBody);
    const rotatedAt = new Date(nowMs).toISOString();
    const newExpiresAt = new Date(nowMs + this.deps.config.OAUTH_REFRESH_TOKEN_TTL_DAYS * 86_400_000).toISOString();

    const nextRecord: RefreshTokenRecord = {
      tokenHash: sha256Hex(newRefreshToken),
      familyId: row.familyId,
      clientId,
      scope,
      expiresAt: newExpiresAt,
      createdAt: rotatedAt,
      ...(row.resource !== undefined ? { resource: row.resource } : {})
    };
    const won = this.deps.store.rotateRefreshToken({ tokenHash, rotatedAt, rotationResponseJson: responseJson, next: nextRecord });

    if (!won) {
      const fresh = this.deps.store.getRefreshToken(tokenHash);
      if (fresh?.rotatedAt) {
        const rotatedMs = Date.parse(fresh.rotatedAt);
        if (nowMs - rotatedMs <= REFRESH_GRACE_MS && fresh.rotationResponseJson) {
          return { status: 200, headers: { "Cache-Control": "no-store" }, body: JSON.parse(fresh.rotationResponseJson) as unknown };
        }
      }
      this.deps.store.revokeFamily(row.familyId);
      this.audit("oauth.token.reuse_detected", { familyId: row.familyId, clientId });
      return this.tokenError(400, "invalid_grant", "refresh_rotation_race_outside_grace");
    }

    this.audit("oauth.token.refreshed", { clientId, familyId: row.familyId });
    return { status: 200, headers: { "Cache-Control": "no-store" }, body: responseBody };
  }
}
