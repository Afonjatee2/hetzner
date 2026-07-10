import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

export interface Principal {
  subject: string;
  scopes: string[];
}

export class AuthService {
  private readonly jwks;

  constructor(private readonly config: Config) {
    this.jwks = config.OAUTH_JWKS_URI ? createRemoteJWKSet(new URL(config.OAUTH_JWKS_URI)) : undefined;
  }

  async authenticate(request: FastifyRequest, requiredScopes: string[] = []): Promise<Principal> {
    if (this.config.AUTH_MODE === "development") {
      const host = request.ip;
      if (!new Set(["127.0.0.1", "::1"]).has(host)) throw Object.assign(new Error("Development auth is loopback-only"), { statusCode: 403 });
      return { subject: "local-development", scopes: ["workspace.read", "workspace.write", "task.execute", "task.network"] };
    }
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw Object.assign(new Error("Bearer token required"), { statusCode: 401 });
    if (!this.jwks || !this.config.OAUTH_ISSUER || !this.config.OAUTH_AUDIENCE) throw new Error("OAuth verifier is not configured");
    const token = header.slice("Bearer ".length);
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.config.OAUTH_ISSUER,
      audience: this.config.OAUTH_AUDIENCE,
      algorithms: ["RS256", "ES256", "EdDSA"]
    });
    const scopes = typeof payload.scope === "string"
      ? payload.scope.split(/\s+/).filter(Boolean)
      : Array.isArray(payload.scp) ? payload.scp.filter((scope): scope is string => typeof scope === "string") : [];
    if (!requiredScopes.every((scope) => scopes.includes(scope))) {
      throw Object.assign(new Error("Insufficient scope"), { statusCode: 403 });
    }
    return { subject: payload.sub ?? "unknown", scopes };
  }

  protectedResourceMetadata() {
    return {
      resource: `${this.config.PUBLIC_BASE_URL}${this.config.MCP_PATH}`,
      authorization_servers: this.config.OAUTH_ISSUER ? [this.config.OAUTH_ISSUER] : [],
      bearer_methods_supported: ["header"],
      scopes_supported: ["workspace.read", "workspace.write", "task.execute", "task.network"],
      resource_documentation: `${this.config.PUBLIC_BASE_URL}/docs/authentication`
    };
  }
}

