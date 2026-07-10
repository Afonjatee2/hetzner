# Discovery record — 2026-07-10

## Local development host

- Apple MacBook, `arm64`
- macOS 26.5.1 (build 25F80)
- OrbStack Docker Engine 29.4.0
- Docker Compose 5.1.2
- Docker Buildx 0.33.0

## Hetzner production host

- Server `smarkets-bot`, Hetzner server ID `137985645`
- Public address `167.233.75.192`
- Ubuntu 26.04 LTS, `x86_64` (`linux/amd64`)
- CX23: 2 vCPU, 4 GB RAM, 40 GB disk
- Existing host services preserved: Caddy on 80/443 and the pre-existing application on `127.0.0.1:8000`
- UFW active: deny incoming by default; 22, 80 and 443 currently allowed
- Rootless Docker Engine 29.6.1, systemd cgroup v2, seccomp, user namespaces
- Docker Compose 5.3.1
- Gateway listener: `127.0.0.1:8081` only

## Recovery point

Hetzner snapshot `407070607`, `pre-hetzner-dev-workspace-2026-07-10`, was created and reached Available state before server changes. Snapshot billing was explicitly confirmed by the user.

## Architecture decision

The Mac and server architectures differ. Local development uses portable Docker/Compose commands through OrbStack. Production runner images were built natively on the amd64 Hetzner host; the deployment does not depend on the Mac remaining online.
