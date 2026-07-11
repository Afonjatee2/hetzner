#!/usr/bin/env bash
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
config_dir="$HOME/.config/mac-project-files"
config="$config_dir/gateway.env"
state="$HOME/Library/Application Support/MacProjectFiles"
plist="$HOME/Library/LaunchAgents/uk.remoteconnector.mac-project-files.plist"
template="$repo/infra/launchd/uk.remoteconnector.mac-project-files.plist.example"

if [[ ! -r "$config" ]]; then
  echo "Create $config from .env.mac.example first" >&2
  exit 78
fi

mkdir -p "$config_dir" "$state" "$HOME/Library/LaunchAgents"
chmod 0700 "$config_dir" "$state"
chmod 0600 "$config"
cd "$repo"
pnpm install --frozen-lockfile
pnpm build
chmod 0755 infra/scripts/run-mac-gateway.sh

escaped_repo=${repo//&/\\&}
escaped_state=${state//&/\\&}
sed -e "s|__REPOSITORY__|$escaped_repo|g" -e "s|__STATE__|$escaped_state|g" "$template" >"$plist"
chmod 0600 "$plist"
launchctl bootout "gui/$(id -u)/uk.remoteconnector.mac-project-files" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
launchctl kickstart -k "gui/$(id -u)/uk.remoteconnector.mac-project-files"
