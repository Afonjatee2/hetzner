# ChatGPT setup

1. Keep the existing app connected and rename it **Windows Local Workspace**.
2. Create a separate app named **Hetzner Dev Workspace**.
3. Enter `https://<new-hostname>/mcp` and complete the configured OAuth flow.
4. Verify tool names, descriptions, read-only/destructive annotations and requested scopes.
5. Call `system_health` and `list_projects` first.
6. Test a fixture worktree, sandboxed command, logs, artifacts and rollback.
7. Migrate only explicitly approved repositories after full acceptance.

Never place tunnel credentials, OAuth secrets, private keys or `.env` content into ChatGPT messages.

