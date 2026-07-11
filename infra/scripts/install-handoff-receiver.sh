#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: $0 /path/to/mac-handoff-key.pub" >&2
  exit 64
fi

id gptsync >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin gptsync
install -d -o gptsync -g gptdev -m 2770 /var/lib/gpt-dev/handoffs /var/lib/gpt-dev/handoffs/incoming
install -d -o root -g root -m 0755 /opt/hetzner-dev-workspace/infra/scripts
install -o root -g root -m 0755 infra/scripts/receive-handoff.sh /opt/hetzner-dev-workspace/infra/scripts/receive-handoff.sh
install -d -o gptsync -g gptsync -m 0700 /home/gptsync/.ssh
key=$(<"$1")
restriction='restrict,command="/opt/hetzner-dev-workspace/infra/scripts/receive-handoff.sh"'
authorized=/home/gptsync/.ssh/authorized_keys
touch "$authorized"
chown gptsync:gptsync "$authorized"
chmod 0600 "$authorized"
if ! grep -Fq -- "$key" "$authorized"; then
  printf '%s %s\n' "$restriction" "$key" >>"$authorized"
fi
