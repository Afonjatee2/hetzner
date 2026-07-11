#!/usr/bin/env bash
set -euo pipefail

config=${MAC_PROJECT_FILES_ENV:-"$HOME/.config/mac-project-files/gateway.env"}
if [[ ! -r "$config" ]]; then
  echo "Missing Mac Project Files configuration: $config" >&2
  exit 78
fi
set -a
# shellcheck disable=SC1090
source "$config"
set +a
exec "${NODE_BINARY:-$(command -v node)}" apps/mcp-gateway/dist/server.js
