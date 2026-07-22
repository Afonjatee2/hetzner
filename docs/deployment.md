# Hetzner deployment

Do not alter the existing Windows connector or its Cloudflare tunnel.

## 1. Discovery

Run `infra/scripts/preflight.sh` and save output to `docs/evidence/00-discovery.md`. Confirm distribution, `uname -m`, CPU, RAM, disk, open ports, Docker/Podman, Git, cloudflared and firewall state. Take a Hetzner snapshot before invasive changes.

## 2. Install

Clone the private repository to `/opt/hetzner-dev-workspace`, run `pnpm install --frozen-lockfile && pnpm build`, then run `sudo infra/scripts/install-hetzner.sh`. Put secrets only in `/etc/gpt-dev/gateway.env` with owner `root:gptdev` and mode `0640` or stricter.

The installer also runs `infra/scripts/setup-registry-network.sh`, which creates the `gptdev-registry` Docker network and the `GPTDEV_REGISTRY` iptables chain used by `prepare_task`: containers on this network get DNS and HTTPS to registry.npmjs.org (and its tarball CDNs) only; everything else is dropped. The script is idempotent and safe to re-run. On deployments that predate this step, run it manually once:

```bash
sudo bash infra/scripts/setup-registry-network.sh
```

The `gpt-dev-registry-rules` systemd service now owns both network creation and rule application. It is bound to Docker and ordered before the gateway, so a Docker restart recreates `gptdev-registry` before new tasks are accepted. `system_health` reports the network separately, and `prepare_task` fails immediately with a repair instruction when it is unavailable. On older systems, also install `iptables-persistent` and run `netfilter-persistent save` after any rule change.

Required production values include `NODE_ENV=production`, `AUTH_MODE=oauth`, `PUBLIC_BASE_URL`, `OAUTH_ISSUER`, `OAUTH_AUDIENCE` and `OAUTH_JWKS_URI` when using an external authorization server.

### First-party authorization server

To let ChatGPT connect without standing up a separate OAuth provider, set `AUTH_MODE=first-party` instead. Required production values:

```
NODE_ENV=production
AUTH_MODE=first-party
PUBLIC_BASE_URL=https://dev-mcp.remoteconnector.uk
OAUTH_OPERATOR_PASSWORD_HASH=scrypt:N=16384,r=8,p=1:<salt>:<hash>
OAUTH_SIGNING_KEY_PATH=/var/lib/gpt-dev/oauth-signing-key.pem
```

Issuer, audience and the JWKS document are derived automatically from `PUBLIC_BASE_URL` and `MCP_PATH`; do not set `OAUTH_ISSUER`, `OAUTH_AUDIENCE` or `OAUTH_JWKS_URI` in this mode.

Generate the operator password hash with the bundled CLI, which reads the password from stdin (never from argv or shell history):

```bash
printf '%s' 'your-strong-password' | pnpm exec tsx apps/mcp-gateway/src/oauth/hash-password.ts
```

Paste the resulting `scrypt:...` string into `OAUTH_OPERATOR_PASSWORD_HASH` in `/etc/gpt-dev/gateway.env`. The ES256 signing key is generated automatically on first boot at `OAUTH_SIGNING_KEY_PATH`; ensure the parent directory is owned by `gptdev` and the key file is mode `0600` (the gateway creates it this way itself, but confirm after the first start and after any manual copy between hosts).

## 3. Images

Build runner images for the server architecture:

```bash
docker compose --profile images build
```

For multi-platform publication:

```bash
docker buildx build --platform linux/amd64,linux/arm64 --push -t REGISTRY/gptdev-runner-node:VERSION runner-images/node
```

Pin production image digests after verification.

After pulling commits that touch `runner-images/`, rebuild the local images with `docker compose --profile images build`; the gateway does not rebuild them itself. The Node image pins pnpm and disables pnpm's automatic package-manager-version download, so offline lint/test commands use the binary already baked into the image instead of hanging while resolving a repository `packageManager` version.

The service is designed for a rootless Docker daemon owned by `gptdev`. In that
mode container UID 0 maps to the unprivileged host user; task containers still
run with all capabilities dropped, `no-new-privileges`, a read-only rootfs and
strict resource/mount/network limits. With a rootful development engine, the
runner instead maps the worktree's host UID/GID into the container.

## 4. Cloudflare

Create a new named tunnel and hostname such as `dev-mcp.remoteconnector.uk`. Use the provided configuration template, keep port 8081 closed publicly, and install cloudflared as a system service. Never copy the Windows tunnel credential.

## 5. Start and accept

```bash
sudo systemctl enable --now gpt-dev-registry-rules gpt-dev-gateway cloudflared gpt-dev-backup.timer
curl --fail http://127.0.0.1:8081/healthz
sudo systemctl is-active gpt-dev-registry-rules
docker network inspect gptdev-registry >/dev/null
sudo journalctl -u gpt-dev-gateway -n 100 --no-pager
```

Connect a separate ChatGPT app named **Hetzner Dev Workspace** to the public `/mcp` endpoint. Test read tools, worktree creation, dependency preparation, constrained execution, Playwright evidence, final diff, commit/rollback and reboot recovery before any approved project migration. Set `AGENT_EXECUTION=enabled` only when the fixed coding-agent CLI is installed and intended for remote use; keep `HOST_EXECUTION=disabled` unless arbitrary host commands are explicitly required.
