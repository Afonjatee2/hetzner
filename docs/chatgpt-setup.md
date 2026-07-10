# ChatGPT setup

1. Keep the existing app connected and rename it **Windows Local Workspace**.
2. Create a separate app named **Hetzner Dev Workspace**.
3. In ChatGPT's developer mode, add a custom connector pointing at `https://<new-hostname>/mcp`.
4. ChatGPT auto-discovers the first-party authorization server from `/.well-known/oauth-authorization-server` and registers itself via client ID metadata documents (no manual client registration required). It opens `/oauth/authorize`, which renders a minimal password login page for the workspace operator.
5. Sign in with the operator password (the one used to generate `OAUTH_OPERATOR_PASSWORD_HASH`). ChatGPT then completes the authorization-code + PKCE exchange and stores the access/refresh token pair.
6. Verify tool names, descriptions, read-only/destructive annotations and requested scopes.
7. Call `system_health` and `list_projects` first.
8. Test a fixture worktree, sandboxed command, logs, artifacts and rollback.
9. Migrate only explicitly approved repositories after full acceptance.

Never place tunnel credentials, OAuth secrets, private keys or `.env` content into ChatGPT messages.

