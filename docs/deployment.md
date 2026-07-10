# Hetzner deployment

Do not alter the existing Windows connector or its Cloudflare tunnel.

## 1. Discovery

Run `infra/scripts/preflight.sh` and save output to `docs/evidence/00-discovery.md`. Confirm distribution, `uname -m`, CPU, RAM, disk, open ports, Docker/Podman, Git, cloudflared and firewall state. Take a Hetzner snapshot before invasive changes.

## 2. Install

Clone the private repository to `/opt/hetzner-dev-workspace`, run `pnpm install --frozen-lockfile && pnpm build`, then run `sudo infra/scripts/install-hetzner.sh`. Put secrets only in `/etc/gpt-dev/gateway.env` with owner `root:gptdev` and mode `0640` or stricter.

Required production values include `NODE_ENV=production`, `AUTH_MODE=oauth`, `PUBLIC_BASE_URL`, `OAUTH_ISSUER`, `OAUTH_AUDIENCE` and `OAUTH_JWKS_URI`.

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

## 4. Cloudflare

Create a new named tunnel and hostname such as `dev-mcp.remoteconnector.uk`. Use the provided configuration template, keep port 8081 closed publicly, and install cloudflared as a system service. Never copy the Windows tunnel credential.

## 5. Start and accept

```bash
sudo systemctl enable --now gpt-dev-gateway cloudflared gpt-dev-backup.timer
curl --fail http://127.0.0.1:8081/healthz
sudo journalctl -u gpt-dev-gateway -n 100 --no-pager
```

Connect a separate ChatGPT app named **Hetzner Dev Workspace** to the public `/mcp` endpoint. Test read tools, worktree creation, constrained execution, Playwright evidence, final diff, commit/rollback and reboot recovery before any approved project migration.

