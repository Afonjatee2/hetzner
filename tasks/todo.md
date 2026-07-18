# execute_plan: planner/executor tool (2026-07-18, follow-up)

Goal: ChatGPT writes one complete plan; a local Claude Code CLI agent executes
it in the task worktree at native speed via ccr (DeepSeek/Kimi), collapsing the
slow per-edit MCP loop into a single tool call.

- [x] SandboxRequest/StartTaskInput: optional `env` (host runner only —
      carries ANTHROPIC_BASE_URL/API_KEY to the agent, never gateway secrets)
- [x] config: AGENT_CLI_PATH, AGENT_BACKEND_BASE_URL (ccr :3456),
      AGENT_BACKEND_API_KEY
- [x] tools.ts: execute_plan (plan → artifact plan.md → claude -p
      --output-format stream-json --dangerously-skip-permissions in worktree;
      backend ccr|subscription; gated by HOST_EXECUTION)
- [x] test: host-runner env passthrough; pnpm check 105/105 green
- [x] e2e (dev gateway + MCP client): execute_plan ran the real Claude Code
      CLI through ccr → 4 turns → AGENT_PROOF.txt created in worktree with
      exact content; git_status shows the change; final stream-json result
      event parsed cleanly
- [x] prod: AGENT_BACKEND_API_KEY added to gateway.env, LaunchAgent
      restarted, /healthz 200, tunnel MCP handshake 401-challenge in 240ms
- [x] docs + .env.mac.example updated

# Host execution mode for the Mac connector

Problem: run_command always executes in a disposable Linux Docker container
(network none, node image without Bun, no GUI). ChatGPT could not run
`bun install`, `bun run dev:desktop` (Electron) or build a DMG on the Mac.
Goal: make the connector behave like Codex/Claude Code — commands run directly
on macOS with the operator's toolchain — behind an explicit operator opt-in.

Acceptance criteria
- `run_command { mode: "host" }` runs the executable directly on macOS in the
  task worktree, with the operator PATH (bun/node/pnpm/homebrew), full network,
  GUI-capable (Aqua session via LaunchAgent).
- Gated: only when `HOST_EXECUTION=enabled` in gateway.env; otherwise FORBIDDEN
  with an actionable message. Default stays container mode — nothing changes
  for existing callers.
- Same task model as containers: async task record, redacted cursor logs,
  output byte cap, timeout kill (SIGTERM → SIGKILL of the whole process
  group), cancel_task works, artifacts dir exposed via GPTDEV_ARTIFACTS_DIR.
- pnpm check green; end-to-end proof: MCP client call runs `bun --version`
  in host mode through a dev-mode gateway instance.
- Production LaunchAgent restarted with host execution enabled; /healthz ok.

Plan
- [x] schemas: ExecutionMode enum; RunCommandInput.mode (default "container");
      raise timeoutSeconds max to 86400 for long-lived host dev servers
- [x] sandbox-runner: TaskRunner interface + HostProcessRunner (host.ts):
      direct spawn, detached process group, minimal env + PATH prepend,
      timeout/output-cap/cancel parity with the Docker runner
- [x] task-service: optional host runner, dispatch on mode, image="host"
      marker so cancel picks the right runner
- [x] gateway config: HOST_EXECUTION (disabled|enabled), HOST_PATH_PREPEND
- [x] tools.ts: gate host mode, wire through, update run_command +
      system_health descriptions/output
- [x] server.ts: construct HostProcessRunner when enabled
- [x] tests: HostProcessRunner unit tests (success, exit code, timeout,
      truncation, secret-leak check, cancel, ENOENT) — 8 new, colocated
- [x] pnpm check (lint + typecheck + 104/104 tests green)
- [x] e2e: dev-mode gateway + real MCP client: register_project →
      create_task_worktree → run_command mode:host `bun --version` →
      succeeded, exit 0, output "1.3.14" (host Bun); container mode still
      returns v22.23.1 from the image; FORBIDDEN gate verified when
      HOST_EXECUTION is unset
- [x] gateway.env: HOST_EXECUTION=enabled + HOST_PATH_PREPEND; pnpm build;
      LaunchAgent kickstarted; /healthz 200 in ~60ms (5/5), process env
      confirmed to carry the new flags
- [x] docs: host-execution section in docs/mac-project-files.md +
      .env.mac.example
- [x] commit (only host-execution files; oauth WIP left unstaged)

## Review

run_command now accepts mode:"host" and executes directly on macOS in the
task worktree with the operator toolchain (bun 1.3.14, node, pnpm, git), full
network and GUI capability — this is what ChatGPT needed for `bun install`,
`bun run dev:desktop` (Electron) and DMG packaging. Container mode is
unchanged and remains the default. The gate is operator-controlled config,
not tool input, so a remote model cannot enable it. Host children get a
from-scratch environment, so gateway OAuth/handoff secrets cannot leak into
task logs. Long-running dev servers fit the async task model (timeout raised
to a day, cancel_task kills the process group). Production connector is live
with the feature; ChatGPT may need the connector refreshed to pick up the new
run_command schema.
