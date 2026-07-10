# Architecture

```text
ChatGPT web
  -> HTTPS + OAuth
  -> Cloudflare named tunnel
  -> MCP gateway on 127.0.0.1:8081
     -> project/file service
     -> Git worktrees
     -> SQLite task/audit state
     -> constrained Docker runner
     -> task artifacts and Playwright evidence
```

The browser device is only the user interface. Canonical repositories, worktrees, state, execution and artifacts live on Hetzner.

The gateway uses native MCP Streamable HTTP at `/mcp`. Each client session receives an SDK transport and independently registered tool server. OAuth access tokens are verified against the configured JWKS, issuer and audience. The protected-resource metadata endpoints are exposed at both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`.

Canonical checkouts are registered in SQLite. Read tools may target a canonical checkout; write, delete, execute, commit and rollback operations require an active worktree. Paths are resolved through `realpath` after symlinks and must remain below the registered root.

Tasks are created in SQLite before execution and move through `queued -> preparing -> running -> terminal`. Non-terminal tasks found after a gateway restart become `interrupted`. Output is redacted and stored as ordered chunks. Container IDs, exit codes, timestamps and artifacts remain queryable.

## Architecture portability

The Mac is detected independently from Hetzner. Buildx can publish `linux/amd64` and `linux/arm64`, or local builds can target the detected Hetzner platform explicitly. Compose and Dockerfiles contain no required OrbStack commands.

## First-party authorization server

When `AUTH_MODE=first-party`, the gateway embeds its own OAuth 2.1 authorization server (`apps/mcp-gateway/src/oauth/`) instead of trusting an external issuer, so a single operator can connect ChatGPT as a custom connector without standing up separate infrastructure. Issuer, audience and JWKS are derived from `PUBLIC_BASE_URL`/`MCP_PATH`; there is no separate `OAUTH_ISSUER`/`OAUTH_JWKS_URI` to configure.

- **Discovery:** RFC 8414 metadata at `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` (identical documents), advertising authorization-code + PKCE (S256, mandatory), refresh-token rotation, `token_endpoint_auth_methods_supported: ["none"]` and `client_id_metadata_document_supported: true`.
- **Registration:** clients register via RFC 7591 dynamic client registration (`POST /oauth/register`) or client ID metadata documents (CIMD) fetched over HTTPS with SSRF guards (no redirects, 5s timeout, 64KiB cap, private-range/DNS-rebinding rejection). In both paths every redirect URI is checked against an allowlist restricted to `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/*` — this allowlist is the primary security boundary and is re-checked at registration, CIMD resolution, authorize time and token time.
- **Login:** `GET /oauth/authorize` renders a minimal server-rendered password form (HMAC-signed CSRF token, strict CSP, no-store) for the single workspace operator. The password is verified against a scrypt hash (`OAUTH_OPERATOR_PASSWORD_HASH`) with rate limiting per IP and globally.
- **Tokens:** access tokens are short-lived ES256 JWTs (`typ: at+jwt`) signed with a local key generated on first boot (`OAUTH_SIGNING_KEY_PATH`, mode 0600) and published at `/.well-known/jwks.json`. Refresh tokens are opaque, stored only as salted hashes, and rotate on every use with family-wide revocation if an already-rotated refresh token is presented again. Authorization codes and refresh-token rotations tolerate a short idempotent-replay window to accommodate ChatGPT's known double-POST behavior, after which stale plaintext response caches are purged.
- **Resource server:** `auth.ts` verifies first-party tokens against the locally-published JWKS (`createLocalJWKSet`, `ES256` only); the external-issuer `oauth` mode is unchanged and still uses a remote JWKS.

