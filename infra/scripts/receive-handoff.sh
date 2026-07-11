#!/usr/bin/env bash
set -euo pipefail

inbox=/var/lib/gpt-dev/handoffs/incoming
max_bytes=104857600
umask 007

read -r action handoff_id project_id extra <<<"${SSH_ORIGINAL_COMMAND:-}"
if [[ "$action" != upload || -n "${extra:-}" ]]; then
  echo "Only the upload command is permitted" >&2
  exit 64
fi
if [[ ! "$handoff_id" =~ ^[a-f0-9-]{36}$ || ! "$project_id" =~ ^[a-z0-9][a-z0-9._-]{1,63}$ ]]; then
  echo "Invalid handoff metadata" >&2
  exit 64
fi

install -d -m 2770 "$inbox"
temporary="$inbox/.${handoff_id}.upload"
destination="$inbox/${handoff_id}--${project_id}.bundle"
trap 'rm -f "$temporary"' EXIT
if [[ -e "$destination" ]]; then
  echo "Handoff already exists" >&2
  exit 65
fi

# Limit the forced-command process before accepting the untrusted stream.
ulimit -f 204800
cat >"$temporary"
bytes=$(wc -c <"$temporary")
if (( bytes < 1 || bytes > max_bytes )); then
  echo "Handoff size is invalid" >&2
  exit 65
fi
if ! git bundle list-heads "$temporary" | grep -q ' refs/heads/'; then
  echo "Handoff is not a valid branch bundle" >&2
  exit 65
fi
mv "$temporary" "$destination"
trap - EXIT
echo "received $handoff_id"
