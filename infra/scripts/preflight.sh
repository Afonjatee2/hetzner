#!/usr/bin/env bash
set -euo pipefail

echo "timestamp=$(date -u +%FT%TZ)"
echo "kernel=$(uname -srmo)"
echo "architecture=$(uname -m)"
echo "os_release="
cat /etc/os-release
echo "cpu_count=$(nproc)"
free -h
df -hT /
command -v docker >/dev/null && docker version || true
command -v podman >/dev/null && podman version || true
command -v cloudflared >/dev/null && cloudflared --version || true
command -v git >/dev/null && git --version || true
command -v rg >/dev/null && rg --version | head -n 1 || true
ss -lntup

