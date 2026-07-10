# Acceptance checklist

Status as of 2026-07-10. Public-edge and ChatGPT checks remain open until the new Cloudflare tunnel and production OAuth client are configured.

- [x] Mac/OrbStack unit, integration and end-to-end acceptance pass
- [x] Native Streamable HTTP MCP negotiation succeeds
- [x] 22 MCP tools are advertised
- [x] Approved project registration and bounded file operations work
- [x] Traversal outside an approved project is rejected
- [x] Git worktree creation, diff and rollback work
- [x] Deliberately failing Node test is captured with logs
- [x] File patch and passing retest succeed
- [x] Disposable execution container is isolated and resource limited
- [x] Network is disabled by default and verified from a task container
- [x] Cancellation works
- [x] Internal development server has no host-published port
- [x] Playwright succeeds through the internal task-only network
- [x] Screenshot, trace and browser event artifacts are registered
- [x] Same complete workflow passes on the Hetzner amd64 host
- [x] Gateway runs as a systemd-managed unprivileged account
- [x] Gateway talks to rootless Docker, not the rootful daemon
- [ ] New Cloudflare tunnel and hostname created without changing the Windows connector
- [ ] OAuth metadata and production JWT validation verified publicly
- [ ] Separate ChatGPT app connected and read/edit/test loop verified
- [ ] Reboot and recovery drill completed
- [ ] Optional billable Hetzner automated backups approved or declined
