#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates git ripgrep
rm -rf /var/lib/apt/lists/*

id gptdev >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin gptdev
install -d -o gptdev -g gptdev -m 0750 /opt/hetzner-dev-workspace
install -d -o gptdev -g gptdev -m 0750 /srv/gpt-hosted /srv/gpt-hosted/.worktrees /var/lib/gpt-dev /var/lib/gpt-dev/tasks /var/lib/gpt-dev/docker-config /var/lib/gpt-dev/handoffs /var/lib/gpt-dev/pnpm-store
install -d -o gptsync -g gptdev -m 2770 /var/lib/gpt-dev/handoffs/incoming 2>/dev/null || install -d -o gptdev -g gptdev -m 0750 /var/lib/gpt-dev/handoffs/incoming
install -d -o root -g gptdev -m 0750 /etc/gpt-dev
install -d -o gptdev -g gptdev -m 0700 /var/backups/gpt-dev

echo "==> Setting up the gptdev-registry Docker network (registry-only egress for prepare_task)"
bash "$SCRIPT_DIR/setup-registry-network.sh"
echo "    Reminder: install iptables-persistent and run 'netfilter-persistent save' so the rules survive reboots."

install -o root -g root -m 0644 infra/systemd/gpt-dev-gateway.service /etc/systemd/system/
install -o root -g root -m 0644 infra/systemd/gpt-dev-backup.service infra/systemd/gpt-dev-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable gpt-dev-gateway.service gpt-dev-backup.timer
