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
- **First-party login brute force:** the operator password is stored only as a scrypt hash (`N=16384,r=8,p=1`) and compared with a constant-time check. Login attempts are rate-limited both per IP and globally (in-memory, 15-minute window) and blocked with `429` once exceeded.
- **Refresh token theft/replay:** refresh tokens are opaque, stored only as salted SHA-256 hashes, and rotate on every use. Presenting an already-rotated (superseded) refresh token outside a short idempotent-replay grace window revokes the entire token family, invalidating every descendant token.
- **CIMD SSRF and DNS rebinding:** client ID metadata document fetches are restricted to `https`, disallow redirects, enforce a 5s timeout and 64KiB cap, and reject IP-literal or DNS-resolved private/loopback/link-local addresses before connecting. A residual DNS-rebinding TOCTOU window exists between the resolution check and the actual `fetch` call; this is accepted because the fetched document only ever gates which redirect URIs are usable, and every redirect URI still has to pass the `chatgpt.com` allowlist regardless of CIMD outcome.
- **Plaintext token material at rest:** authorization-code and refresh-token idempotent-replay caches (120s / 60s windows respectively) hold a plaintext copy of the most recent token response so a legitimate duplicate POST can be answered without minting new tokens. These caches are purged shortly after their replay window closes, and the single-user SQLite database file is not world-readable (mode 0600 directory ownership on the host). This is an accepted trade-off for ChatGPT's known double-POST behavior on a single-tenant deployment.
- **Signing key at rest:** the ES256 access-token signing key is a PKCS8 PEM generated on first boot and stored at `OAUTH_SIGNING_KEY_PATH` with mode 0600. Compromise of that file allows forging access tokens for the workspace; treat it with the same sensitivity as the operator password hash and rotate it (delete the file to force regeneration, which invalidates all outstanding access tokens) if compromise is suspected.

## Residual risks

The gateway can ask the container engine to create constrained containers; compromise of the gateway process is therefore high impact. Use a dedicated unprivileged service account, rootless engine where possible, minimal host access, patched dependencies, firewall controls and a separate VPS when handling hostile repositories. Registry-only egress is not considered proven until enforced and tested on the target VPS.

## Incident response

Stop `gpt-dev-gateway` and `cloudflared`, revoke OAuth/tunnel credentials, preserve `/var/lib/gpt-dev` and journal evidence, rotate affected secrets, snapshot before forensic changes, rebuild from a known-good Git commit and re-run security acceptance before restoring access.

