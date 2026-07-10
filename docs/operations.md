# Operations

## Routine checks

```bash
systemctl status gpt-dev-gateway cloudflared gpt-dev-backup.timer
journalctl -u gpt-dev-gateway --since today
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

