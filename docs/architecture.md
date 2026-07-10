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

