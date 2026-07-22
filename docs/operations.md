# Operations

## Routine checks

```bash
systemctl status gpt-dev-gateway gpt-dev-registry-rules cloudflared gpt-dev-backup.timer
journalctl -u gpt-dev-gateway --since today
docker network inspect gptdev-registry >/dev/null
docker ps --filter name=gptdev-
docker system df
df -h /srv/gpt-hosted /var/lib/gpt-dev
```

## Update with rollback

Fetch the reviewed private Git commit, run `pnpm install --frozen-lockfile`, `pnpm check`, build target runner images, stop the gateway, back up SQLite, deploy the new build and restart. Retain the previous Git commit and image digests. On failure, restore the prior commit/images and database backup, then restart.

## Emergency controls

- Disable execution while preserving reads by removing `task.execute` from issued scopes or stopping the engine-facing gateway and starting a read-only configuration.
- Disable the app completely with `systemctl stop gpt-dev-gateway cloudflared` and revoke the tunnel/OAuth credentials.
- Clean orphaned containers and worktrees only after matching them against persistent task state and preserving audit records.

## Retention

Keep audit/task metadata according to the approved policy. Remove expired large artifacts and discarded worktrees, but retain task outcomes, hashes and security events. Alert on disk pressure before cleanup becomes urgent.

## Dependency runner recovery

`system_health` must show both Docker and `registryNetwork` as healthy before dependency preparation. If the network is missing:

```bash
sudo systemctl restart gpt-dev-registry-rules.service
docker network inspect gptdev-registry
sudo systemctl restart gpt-dev-gateway.service
```

After updating `runner-images/node/Dockerfile`, rebuild the image before retrying tasks:

```bash
cd /opt/hetzner-dev-workspace
docker compose --profile images build runner-node
```

A Node worktree must complete `prepare_task` before package scripts such as lint, typecheck, test or build. The gateway rejects those commands when no `node_modules` or Yarn PnP marker exists, preventing prerequisite failures from being misreported as code failures.

## Agent execution boundary

Use `AGENT_EXECUTION=enabled` to allow the fixed `execute_plan` agent while leaving `HOST_EXECUTION=disabled`. The latter controls arbitrary `run_command` host processes and should remain off on the VPS unless there is a specific operational need.
