---
name: model-relay
description: Send token-heavy grunt work to cheap external models (DeepSeek) or get an independent second opinion (GPT) instead of burning Claude subscription tokens. Use this whenever a task involves summarising large files or logs, bulk extraction, generating boilerplate or repetitive transforms, drafting documentation from source material, first-pass triage of long test output, or when the orchestrator requests an independent GPT assessment. Any time the input or expected output exceeds roughly 200 lines, relay it rather than processing it in-context.
---

# Model Relay

Offload work to external models via `scripts/relay.py`. Only `DEEPSEEK_API_KEY` is required; if it isn't exported into Claude Code's environment, the script automatically falls back to sourcing it from `~/.zprofile`. Second opinions go through the Codex CLI (ChatGPT OAuth), which needs no key. The script is stdlib-only Python 3, no installs needed.

## Core pattern

Always write the payload to a temp file first. Never inline large content as a shell argument.

```bash
# 1. Build the task file (instructions + the material to process)
cat > /tmp/relay_task.txt << 'EOF'
Summarise the following test output. Return: failing tests, probable root cause per failure, and files implicated.

<paste or cat the material here>
EOF

# 2. Relay it
python3 .claude/skills/model-relay/scripts/relay.py --provider deepseek --prompt-file /tmp/relay_task.txt --out /tmp/relay_reply.txt

# 3. Read the reply and verify it before using it
cat /tmp/relay_reply.txt
```

Assembling the payload with shell (`cat file1 file2 >> /tmp/relay_task.txt`, `grep`, `head`) is free. Do the assembly mechanically; spend your own tokens only on verifying the reply.

## Providers

- `--provider deepseek`: default lane for all grunt work. Model defaults to `deepseek-v4-pro`; override with `--model` or the `MODEL_RELAY_DEEPSEEK_MODEL` env var. For high-volume grunt work, `deepseek-v4-flash` is roughly 3x cheaper — set it via `--model deepseek-v4-flash` or `MODEL_RELAY_DEEPSEEK_MODEL`.
- `--provider codex`: second-opinion lane. Runs via the Codex CLI with ChatGPT OAuth (`codex login`), no API key, rides the ChatGPT subscription. Runs `codex exec` with `--ignore-user-config` plus a read-only sandbox, so it inherits no user-level plugins or MCP servers and cannot write anything. `--model` passes through to `codex exec`; `--max-tokens`/`--temperature` are ignored.
- `--provider openai`: optional key-based alternative for second opinions (requires `OPENAI_API_KEY`). Model defaults to `gpt-5.6-sol`; override with `--model` or `MODEL_RELAY_OPENAI_MODEL`.

## Options

- `--system "..."` or `--system-file path`: role or constraints for the external model. For codex it is textually prepended to the prompt (codex exec has no separate system slot).
- `--max-tokens N` (default 8192): raise for long generations.
- `--temperature F`: default 0.2 for deepseek; omitted for openai unless explicitly passed (gpt-5.x rejects non-default temperature).
- `--out path`: write the reply to a file (preferred, keeps your context lean; read it selectively with `head`/`grep` when the reply is long).
- A status line is printed to stderr on every call; deepseek/openai include token counts, while codex reports `tokens_used=n/a` when the CLI does not expose them. Include the line in your final report so spend stays visible.

## Rules

- Verify relay output before passing it upward. Spot-check claims against the actual files. The external model's word is evidence, not truth.
- If the relay errors on a missing key, report that to the orchestrator; do not retry with a different provider silently.
- Never send secrets, credentials, or customer data in payloads.
- One large batched call beats many small calls: combine related grunt tasks into a single payload with numbered sections.
