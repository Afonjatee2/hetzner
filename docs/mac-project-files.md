# Mac Project Files connector

This is a separate ChatGPT MCP connector for projects physically stored on the Mac. It is available only while the Mac is awake and online. The Hetzner connector remains the 24/7 execution environment.

## Boundary

Set `WORKSPACE_ROOT` to the narrowest useful parent, normally the user's `Downloads` directory. A folder is not readable merely because it is below that root: it must also be an explicitly registered Git checkout. Registration outside the root is rejected by canonical realpath comparison.

File tools exclude `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.env` variants, package-manager authentication files and private-key formats. Mutations occur only in task worktrees, never in the canonical checkout.

## Mac installation

1. Copy `.env.mac.example` to `~/.config/mac-project-files/gateway.env` and replace `your-user`.
2. Generate an operator password hash without putting the password in shell history:

   ```bash
   read -s PASSWORD
   printf '%s' "$PASSWORD" | node --import tsx apps/mcp-gateway/src/oauth/hash-password.ts
   unset PASSWORD
   ```

3. Put the resulting hash in `OAUTH_OPERATOR_PASSWORD_HASH`.
4. Generate the dedicated handoff key and known-hosts file:

   ```bash
   ssh-keygen -t ed25519 -f ~/.config/mac-project-files/handoff_ed25519 -N '' -C mac-project-files-handoff
   ssh-keyscan -H 167.233.75.192 > ~/.config/mac-project-files/known_hosts
   ```

5. Install the public key on Hetzner with `infra/scripts/install-handoff-receiver.sh`.
6. Run `infra/scripts/install-mac-gateway.sh` to install the `launchd` service.
7. Configure a separate Cloudflare Tunnel hostname, `mac-mcp.remoteconnector.uk`, to `http://127.0.0.1:8082`.
8. Add a ChatGPT connector named **Mac Project Files** pointing to `https://mac-mcp.remoteconnector.uk/mcp`.

## Handoff workflow

1. Register the local Git project and create a task worktree.
2. Read/edit the worktree through the Mac connector.
3. Inspect `git_diff`, then call `commit_task` only after explicit approval.
4. Call `send_handoff_to_hetzner`. It creates a Git bundle for the clean branch and streams it through a dedicated forced-command SSH identity. The identity cannot open a shell, forward ports, or choose another destination.
5. On the Hetzner connector, call `list_incoming_handoffs`, then `import_handoff`.
6. Create a Hetzner task worktree and run tests/Playwright in the existing rootless container sandbox.

The handoff carries Git objects only. Ignored local files, `.env` files, credentials, package caches and build output are not included.
