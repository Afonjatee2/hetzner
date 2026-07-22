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

The iptables rules do not survive a reboot by themselves. Install `iptables-persistent` and run `netfilter-persistent save` after the rules are applied (and after any change to them).

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

After pulling commits that touch `runner-images/`, rebuild the local images with `docker compose --profile images build`; the gateway does not rebuild them itself. A stale `gptdev-runner-node:local` image typically surfaces as Corepack trying to download pnpm inside task containers, which fails because task containers have no network access.

The service is designed for a rootless Docker daemon owned by `gptdev`. In that
mode container UID 0 maps to the unprivileged host user; task containers still
run with all capabilities dropped, `no-new-privileges`, a read-only rootfs and
strict resource/mount/network limits. With a rootful development engine, the
runner instead maps the worktree's host UID/GID into the container.

## 4. Cloudflare

Create a new named tunnel and hostname such as `dev-mcp.remoteconnector.uk`. Use the provided configuration template, keep port 8081 closed publicly, and install cloudflared as a system service. Never copy the Windows tunnel credential.

## 5. Start and accept

```bash
sudo systemctl enable --now gpt-dev-gateway cloudflared gpt-dev-backup.timer
curl --fail http://127.0.0.1:8081/healthz
sudo journalctl -u gpt-dev-gateway -n 100 --no-pager
```

Connect a separate ChatGPT app named **Hetzner Dev Workspace** to the public `/mcp` endpoint. Test read tools, worktree creation, constrained execution, Playwright evidence, final diff, commit/rollback and reboot recovery before any approved project migration.
