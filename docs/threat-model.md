# Threat model

## Assets and trust boundaries

Assets include source code, Git history, OAuth/tunnel credentials, VPS integrity, task logs and artifacts. Trust boundaries are ChatGPT to Cloudflare, Cloudflare to the MCP gateway, gateway to container engine, task container to worktree/artifacts, and explicitly approved outbound network access.

## Threats and mitigations

- **Unauthenticated remote execution:** production startup requires OAuth; issuer, audience, signature, expiry and scopes are validated. The application port remains loopback-only behind a named tunnel.
- **Path traversal or symlink escape:** every project path uses `realpath` containment. Absolute escapes, `..` escapes and symlinks resolving outside the root are rejected.
- **Malicious repository:** task execution is disposable, non-root, capability-free, no-new-privileges, resource-bounded and networkless by default. Only the task worktree and artifact directory are mounted.
- **Credential theft:** task containers receive no engine socket, SSH agent, home directory, `/etc/gpt-dev`, environment secrets or host root. Common secret forms are redacted from logs.
- **Denial of service:** every task has CPU, memory, PID, timeout and output limits. Tree, search, file, diff and log operations are bounded.
- **Operator error:** all changes occur in a task branch/worktree; final diff is reviewable; rollback discards the worktree; commit and rollback are destructive MCP tools.
- **Container breakout:** rootless Docker is preferred. Kernel and engine patching remains necessary; container isolation is not equivalent to a VM boundary.
- **Prompt injection in repository files:** repository content is untrusted data. Tool permissions and hard containment rules do not change based on file instructions.

## Residual risks

The gateway can ask the container engine to create constrained containers; compromise of the gateway process is therefore high impact. Use a dedicated unprivileged service account, rootless engine where possible, minimal host access, patched dependencies, firewall controls and a separate VPS when handling hostile repositories. Registry-only egress is not considered proven until enforced and tested on the target VPS.

## Incident response

Stop `gpt-dev-gateway` and `cloudflared`, revoke OAuth/tunnel credentials, preserve `/var/lib/gpt-dev` and journal evidence, rotate affected secrets, snapshot before forensic changes, rebuild from a known-good Git commit and re-run security acceptance before restoring access.

