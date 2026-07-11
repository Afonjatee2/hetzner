# Hetzner Dev Workspace

## Working rules

- Use `pnpm` and Node.js 22 or later.
- Keep all Docker and Compose workflows compatible with standard Docker Engine; OrbStack is only the local engine.
- Never mount the container-engine socket into a task container.
- Arbitrary file mutations must target a task worktree. Canonical checkouts may change only through explicit clean fast-forward `publish_task` or `sync_project` operations.
- Use realpath containment for every filesystem operation.
- Network access is disabled for task containers by default.
- Run `pnpm check` and the relevant tests before committing.

