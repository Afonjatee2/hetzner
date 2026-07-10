#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root" >&2
  exit 1
fi

install -d -o root -g root -m 0755 /opt/hetzner-dev-workspace
id gptdev >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin gptdev
install -d -o gptdev -g gptdev -m 0750 /srv/gpt-hosted /srv/gpt-hosted/.worktrees /var/lib/gpt-dev /var/lib/gpt-dev/tasks
install -d -o root -g gptdev -m 0750 /etc/gpt-dev
install -d -o gptdev -g gptdev -m 0700 /var/backups/gpt-dev
install -o root -g root -m 0644 infra/systemd/gpt-dev-gateway.service /etc/systemd/system/
install -o root -g root -m 0644 infra/systemd/gpt-dev-backup.service infra/systemd/gpt-dev-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable gpt-dev-gateway.service gpt-dev-backup.timer

