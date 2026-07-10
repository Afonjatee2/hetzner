# Hetzner Dev Workspace

## Working rules

- Use `pnpm` and Node.js 22 or later.
- Keep all Docker and Compose workflows compatible with standard Docker Engine; OrbStack is only the local engine.
- Never mount the container-engine socket into a task container.
- Mutating project operations must target a task worktree, not a canonical checkout.
- Use realpath containment for every filesystem operation.
- Network access is disabled for task containers by default.
- Run `pnpm check` and the relevant tests before committing.

