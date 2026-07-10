# Recovery

Source code is recovered from the private Git repository. SQLite state is recovered from the newest verified backup; secrets are restored from the approved secret manager or rotated, never from Git.

## Database restore

1. Stop the gateway.
2. Preserve the damaged database and WAL/SHM files for diagnosis.
3. Verify the selected backup with `sqlite3 BACKUP.db 'PRAGMA integrity_check;'`.
4. Restore it to `/var/lib/gpt-dev/app.db` with owner `gptdev:gptdev` and mode `0640`.
5. Start the gateway and inspect reconciliation results.

## Disk exhaustion

Stop new execution, preserve state, remove stopped disposable containers and unreferenced images, then apply the documented artifact/worktree retention policy. Do not delete active worktrees or the only database backup.

## Compromised token or tunnel

Stop the gateway and tunnel, revoke credentials, inspect audit/authentication failures, rotate secrets, rebuild from a trusted commit, and repeat the security acceptance suite before reconnecting ChatGPT.

Perform and record a restore rehearsal before production acceptance.

