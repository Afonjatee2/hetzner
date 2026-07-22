#!/usr/bin/env python3
"""model-relay: send a task to an external model and print the reply.

Providers: deepseek (API key), openai (API key), codex (ChatGPT OAuth via the
Codex CLI, no key). Keys come from environment variables:
  DEEPSEEK_API_KEY, OPENAI_API_KEY

Usage:
  python3 relay.py --provider deepseek --prompt-file /tmp/task.txt
  python3 relay.py --provider codex --prompt-file /tmp/task.txt
  python3 relay.py --provider deepseek --system-file /tmp/sys.txt --prompt-file /tmp/task.txt --out /tmp/reply.txt
"""

import argparse
import contextlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

PROVIDERS = {
    "deepseek": {
        "url": "https://api.deepseek.com/v1/chat/completions",
        "key_env": "DEEPSEEK_API_KEY",
        "model_env": "MODEL_RELAY_DEEPSEEK_MODEL",
        "default_model": "deepseek-v4-pro",
    },
    "openai": {
        "url": "https://api.openai.com/v1/chat/completions",
        "key_env": "OPENAI_API_KEY",
        "model_env": "MODEL_RELAY_OPENAI_MODEL",
        "default_model": "gpt-5.6-sol",
    },
}

MAX_RETRIES = 3
RETRY_STATUSES = {429, 500, 502, 503, 504}


def read_text(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def deliver(reply, args):
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(reply)
        print(f"[model-relay] reply written to {args.out}", file=sys.stderr)
    else:
        print(reply)


AUTH_ERROR_RE = re.compile(r"login|auth|token|credential|401", re.IGNORECASE)


def codex_error_line(stderr_text, stdout_text):
    """Pick the most informative error line: last ERROR-prefixed line from stderr,
    else last non-empty line, else the raw tail. Falls back to stdout if stderr is empty."""
    text = (stderr_text or "").strip() or (stdout_text or "").strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    error_lines = [ln for ln in lines if re.match(r"^\s*ERROR[:\s]", ln, re.IGNORECASE)]
    if error_lines:
        return error_lines[-1]
    if lines:
        return lines[-1]
    return text[-200:]


def kill_process_group(proc):
    """SIGTERM the whole process group, give it 5s grace, then SIGKILL. Reap the child."""
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        proc.wait()


def relay_codex(args, prompt, system):
    """Second-opinion lane via the Codex CLI (ChatGPT OAuth). No API key involved.

    Isolation: --ignore-user-config prevents inheriting ANY user-level plugins or
    MCP servers from ~/.codex/config.toml (write-capable plugins would escape the
    read-only shell sandbox); -s read-only sandboxes model-generated shell commands.
    """
    codex_bin = shutil.which("codex") or os.path.expanduser("~/.npm-global/bin/codex")
    if system:
        prompt = f"{system}\n\n---\n\n{prompt}"

    fd, last_msg_path = tempfile.mkstemp(prefix="relay_codex_", suffix=".txt")
    os.close(fd)
    cmd = [
        codex_bin, "exec",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "-s", "read-only",
        "--color", "never",
        "--output-last-message", last_msg_path,
    ]
    if args.model:
        cmd += ["--model", args.model]
    cmd.append("-")  # read the prompt from stdin

    try:
        # start_new_session so a timeout can kill the whole group: the npm shim
        # does not forward SIGKILL, and killing only the shim orphans the real
        # codex binary, which keeps running and burning quota.
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
    except FileNotFoundError:
        with contextlib.suppress(OSError):
            os.unlink(last_msg_path)
        sys.exit("ERROR: codex CLI not found. Install it (npm i -g @openai/codex) and run: codex login")

    try:
        out, err = proc.communicate(input=prompt, timeout=args.timeout)
    except subprocess.TimeoutExpired:
        kill_process_group(proc)
        with contextlib.suppress(OSError):
            os.unlink(last_msg_path)
        sys.exit(
            f"ERROR: codex exec exceeded {args.timeout}s and was killed, including its process group. "
            "Do not simply retry; if the task genuinely needs longer, raise --timeout once."
        )

    if proc.returncode != 0:
        with contextlib.suppress(OSError):
            os.unlink(last_msg_path)
        detail = codex_error_line(err, out)
        hint = "\nHint: run: codex login" if AUTH_ERROR_RE.search(detail) else ""
        sys.exit(f"ERROR: codex exec failed (exit {proc.returncode}): {detail}{hint}")

    try:
        reply = read_text(last_msg_path)
    finally:
        with contextlib.suppress(OSError):
            os.unlink(last_msg_path)

    # Codex progress output stays out of our stdout; mine it for status info only.
    noise = out + "\n" + err
    model = args.model or "chatgpt-oauth"
    m = re.search(r"^\s*model:\s*(\S+)", noise, re.MULTILINE)
    if m:
        model = m.group(1)
    t = re.search(r"tokens used[:\s]+([\d,]+)", noise, re.IGNORECASE)
    tokens = t.group(1).replace(",", "") if t else "n/a"

    print(
        f"[model-relay] provider=codex model={model} tokens_used={tokens}",
        file=sys.stderr,
    )

    if not reply.strip():
        sys.exit("ERROR: codex returned no content. Inspect the task and codex output before retrying.")

    deliver(reply, args)


def key_from_zprofile(key_env):
    """Best-effort fallback: source ~/.zprofile and read the var.
    Never prints or logs the value; returns "" on any failure."""
    try:
        proc = subprocess.run(
            ["/bin/zsh", "-c", f'source ~/.zprofile >/dev/null 2>&1; printf "%s" "${key_env}"'],
            capture_output=True,
            text=True,
            timeout=10,
        )
        value = proc.stdout.strip()
        # A real key never contains whitespace; anything else is startup noise.
        if any(c.isspace() for c in value):
            return ""
        return value
    except Exception:
        return ""


def main():
    p = argparse.ArgumentParser(description="Relay a task to an external model.")
    p.add_argument("--provider", required=True, choices=sorted([*PROVIDERS, "codex"]))
    p.add_argument("--model", help="Override the model ID (else env var, else provider default)")
    p.add_argument("--prompt-file", help="File containing the user prompt (preferred for large payloads)")
    p.add_argument("--system", help="System prompt as a string")
    p.add_argument("--system-file", help="File containing the system prompt")
    p.add_argument("--max-tokens", type=int, default=8192)
    p.add_argument("--temperature", type=float, default=None)
    p.add_argument("--out", help="Write the reply to this file instead of stdout")
    p.add_argument("--timeout", type=int, default=300)
    args = p.parse_args()

    if args.prompt_file:
        prompt = read_text(args.prompt_file)
    else:
        prompt = sys.stdin.read()
    if not prompt.strip():
        sys.exit("ERROR: empty prompt. Pass --prompt-file or pipe text on stdin.")

    system = None
    if args.system_file:
        system = read_text(args.system_file)
    elif args.system:
        system = args.system

    if args.provider == "codex":
        relay_codex(args, prompt, system)
        return

    cfg = PROVIDERS[args.provider]

    api_key = os.environ.get(cfg["key_env"], "").strip()
    if not api_key:
        api_key = key_from_zprofile(cfg["key_env"])
    if not api_key:
        sys.exit(
            f"ERROR: {cfg['key_env']} is not set. Export it in ~/.zprofile, "
            f'or add it under "env" in the project\'s .claude/settings.json.'
        )

    model = args.model or os.environ.get(cfg["model_env"], "").strip() or cfg["default_model"]

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = {
        "model": model,
        "messages": messages,
    }
    if args.provider == "openai":
        payload["max_completion_tokens"] = args.max_tokens
        if args.temperature is not None:
            payload["temperature"] = args.temperature
    else:
        payload["max_tokens"] = args.max_tokens
        payload["temperature"] = args.temperature if args.temperature is not None else 0.2

    body = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        cfg["url"],
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )

    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=args.timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                sys.exit(f"ERROR: non-JSON response from {args.provider}: {raw[:200]}")
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:500]
            last_err = f"HTTP {e.code} from {args.provider}: {detail}"
            if e.code in RETRY_STATUSES and attempt < MAX_RETRIES:
                time.sleep(2 ** attempt)
                continue
            sys.exit(f"ERROR: {last_err}")
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = f"network error contacting {args.provider}: {e}"
            if attempt < MAX_RETRIES:
                time.sleep(2 ** attempt)
                continue
            sys.exit(f"ERROR: {last_err}")
    else:
        sys.exit(f"ERROR: {last_err}")

    try:
        choice = data["choices"][0]
        reply = choice["message"]["content"]
    except (KeyError, IndexError, TypeError):
        sys.exit(f"ERROR: unexpected response shape: {json.dumps(data)[:500]}")

    finish_reason = choice.get("finish_reason", "?")

    usage = data.get("usage", {})
    print(
        f"[model-relay] provider={args.provider} model={model} "
        f"prompt_tokens={usage.get('prompt_tokens', '?')} "
        f"completion_tokens={usage.get('completion_tokens', '?')} "
        f"finish_reason={finish_reason}",
        file=sys.stderr,
    )

    if reply is None or not reply.strip():
        sys.exit(
            f"ERROR: {args.provider} returned no content (finish_reason={finish_reason}). "
            "The completion budget may have been consumed by reasoning; retry with a higher --max-tokens."
        )

    deliver(reply, args)


if __name__ == "__main__":
    main()
