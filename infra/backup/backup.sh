#!/usr/bin/env bash
set -euo pipefail
umask 077

state_dir="${STATE_DIR:-/var/lib/gpt-dev}"
backup_dir="${BACKUP_DIR:-/var/backups/gpt-dev}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"

sqlite3 "$state_dir/app.db" ".backup '$backup_dir/app-$timestamp.db'"
tar --create --gzip --file "$backup_dir/metadata-$timestamp.tar.gz" \
  --directory "$state_dir" tasks --exclude='*.zip' --exclude='*.png' 2>/dev/null || true
find "$backup_dir" -type f -mtime +30 -delete

