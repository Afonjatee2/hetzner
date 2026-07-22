# Mac Project Files connector

This is a separate ChatGPT MCP connector for projects physically stored on the Mac. It is available only while the Mac is awake and online. The Hetzner connector remains the 24/7 execution environment.

## Boundary

Set `WORKSPACE_ROOT` to the narrowest useful parent, normally the user's `Downloads` directory. A folder is not readable merely because it is below that root: it must also be an explicitly registered Git checkout. Registration outside the root is rejected by canonical realpath comparison.

File tools exclude `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.env` variants, package-manager authentication files and private-key formats. Arbitrary file mutations occur only in task worktrees. The canonical checkout changes only through explicit clean fast-forward `publish_task` or `sync_project` operations.

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

## Host execution

By default `run_command` executes inside a disposable Linux container with networking disabled. That sandbox cannot run the Mac's own toolchain (Bun, Electron, DMG packaging, GUI apps). With `HOST_EXECUTION=enabled` in `gateway.env`, clients may pass `mode: "host"` to `run_command` and the command runs directly on macOS in the task worktree — like Codex or Claude Code would — with full network access and the operator PATH from `HOST_PATH_PREPEND` (Bun, Homebrew, npm globals).

Host tasks keep the same guardrails as container tasks: they only run in registered-project task worktrees, they are recorded as tasks with redacted cursor logs and byte-capped output, timeouts kill the whole process group, and `cancel_task` works. The child environment is built from scratch (HOME, USER, PATH, `GPTDEV_ARTIFACTS_DIR`) so gateway OAuth and handoff secrets are never inherited. Without the opt-in flag, `mode: "host"` returns FORBIDDEN. `system_health` reports both the arbitrary host-command gate and the separate agent-execution gate.

## Planner/executor: execute_plan

`execute_plan` inverts the slow chat-driven loop: the remote model (ChatGPT) writes one complete implementation plan, and a local coding agent (the Claude Code CLI, spawned as a host task in the worktree) executes it autonomously — reading files, editing, running checks and retrying at native speed. The chat client then reads back a single result via `read_task_logs` (stream-json events; the final `result` event carries the summary) and reviews with `git_diff` before `commit_task`.

`backend: "ccr"` (default) points the agent at the local claude-code-router (`AGENT_BACKEND_BASE_URL`, key in `AGENT_BACKEND_API_KEY`), so execution runs on cheap routed models (DeepSeek/Kimi) while the plan supplies the intelligence. `backend: "subscription"` uses the operator's own Claude login instead. The plan is archived as a task artifact (`plan.md`). Requires `AGENT_EXECUTION=enabled`; this separate gate allows the fixed coding-agent entry point without enabling arbitrary `run_command` host processes. The agent runs with permissions skipped, which is acceptable only because it is confined to an isolated worktree on the operator's own machine.

## Handoff workflow

The normal ChatGPT workflow is now deliberately short:

1. Edit the registered Mac project in an isolated task worktree.
2. Send the committed branch to Hetzner and run the required tests or Playwright checks there.
3. After explicit approval, call `publish_task` on the Mac connector. It publishes the exact committed branch that was tested, pushes the unique task branch, fast-forwards `origin/main`, and fast-forwards the real local project folder. It never force-pushes and stops if either checkout is dirty or has diverged.
4. Call `sync_project` whenever another trusted device has updated `origin/main`. It only fast-forwards a clean local checkout on its configured default branch.

This means the user does not need to copy commands, merge branches manually, or pull the finished code back into Downloads. GitHub remains the shared source of truth, while the Mac connector keeps the real local project current.

For recovery or review, the lower-level tools remain available: `commit_task`, `send_handoff_to_hetzner`, `list_incoming_handoffs`, and `import_handoff`. The handoff carries Git objects only. Ignored local files, `.env` files, credentials, package caches and build output are not included.
