# Skills tools for the MCP gateway

Goal: expose read-only "skills" (markdown playbooks + support files, e.g. the Genesis
report-design-system) to any MCP client (ChatGPT web, Claude) via two lean tools.

Acceptance criteria
- `list_skills` returns every skill under SKILLS_ROOT (a skill = a folder containing SKILL.md
  with frontmatter name/description), discovered recursively to depth 4. Optional `query`
  filters on name/description.
- `load_skill { name }` returns the SKILL.md body + a bounded listing of the skill folder's files.
- `load_skill { name, file }` returns a support file (text types only), realpath-contained
  inside the skill folder, protected-path rules applied, size-capped.
- Tools registered only when SKILLS_ROOT is configured; audited via existing safely() wrapper.
- pnpm check + vitest pass.

Plan
- [x] Branch feat/skills-tools
- [x] packages/skills-service (SkillsService: discover/list/load; reuses resolveContained +
      isProtectedPath from @gpt-dev/projects; realpath-normalised root for macOS /var symlink)
- [x] config.ts: optional SKILLS_ROOT env → resolved skillsRoot
- [x] server.ts: instantiate SkillsService when configured; add to services
- [x] tools.ts: register list_skills + load_skill (conditional, read-only, audited)
- [x] Workspace wiring: root+gateway tsconfig references, gateway dep, pnpm install
- [x] Tests: 9 new cases (nested discovery, frontmatter, query filter, support files,
      binary refusal, protected paths, traversal, escape symlink, truncation)
- [x] pnpm check: lint + typecheck + 90/90 tests green
- [x] End-to-end MCP smoke test on dev instance (tools listed + list_skills returns real data)
- [x] Review pass on diff — 2 real findings, both fixed + regression-tested:
      (1) CRITICAL: symlink with allowed extension pointing at a protected/binary file INSIDE the
      root leaked content — protection + loadability now re-checked on the RESOLVED realpath;
      exploit re-run against dist and confirmed blocked (FORBIDDEN).
      (2) memory DoS: whole file was read before truncation — now bounded read (readBounded) with
      NUL-byte binary guard, and list() head-reads manifests (8KB) instead of full files.
      pnpm check green after fixes: 93/93 tests. Gateway restarted on fixed build.
- [x] Mac deployment: SKILLS_ROOT added to gateway.env, LaunchAgent kickstarted, gateway
      running on :8082 (401 for unauthenticated probe = auth intact)
- [ ] Hetzner deployment: same env var + rsync of ~/Downloads/report-design-system content

## Review
(fill on completion)
