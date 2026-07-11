# Hetzner Dev Workspace

An authenticated Streamable HTTP MCP gateway for a persistent, container-isolated coding workspace on Hetzner. It exposes bounded project/file operations, Git task worktrees, asynchronous task execution, logs, cancellation, artifacts, and commit-or-rollback controls.

## Local development (OrbStack)

Requirements: Node.js 22+, pnpm 10+, OrbStack, Git, and ripgrep.

```bash
./infra/scripts/setup-fixtures.sh
pnpm install
pnpm check
docker compose --profile images build
docker compose up -d gateway
docker compose logs -f gateway
```

On macOS, set the OrbStack socket explicitly if `/var/run/docker.sock` is not available:

```bash
DOCKER_SOCKET_PATH="$HOME/.orbstack/run/docker.sock" \
HOST_UID="$(id -u)" HOST_GID="$(id -g)" \
docker compose up -d gateway
```

OrbStack is a local engine only. Production uses Docker Engine or Podman on Hetzner and must stay available when personal computers are offline.

## Security defaults

- Production refuses to start without OAuth/JWKS configuration.
- Development authentication is accepted only from loopback.
- Canonical Git checkouts are read-only to MCP mutation tools.
- Every mutation targets an isolated task worktree.
- Task containers have no network by default, a read-only root filesystem, all capabilities dropped, `no-new-privileges`, PID/CPU/memory/time/output limits, and only worktree/artifact mounts.
- Task containers never receive the Docker/Podman socket, home directories, SSH agents, secrets, or host configuration.
- Logs are redacted and stored with cursor-based access.

See [architecture](docs/architecture.md), [deployment](docs/deployment.md), [operations](docs/operations.md), [recovery](docs/recovery.md), and the [threat model](docs/threat-model.md).

For continuation from ChatGPT Web against selected projects on the Mac, see the separate [Mac Project Files connector](docs/mac-project-files.md). It uses Git bundles and a restricted SSH receiver to hand committed task branches to the Hetzner sandbox without exposing the rest of the Mac filesystem.
