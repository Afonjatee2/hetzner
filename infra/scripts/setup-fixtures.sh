#!/usr/bin/env bash
set -euo pipefail

root="${1:-fixtures/workspaces}"
mkdir -p "$root"

for fixture in broken-node-app broken-python-app; do
  destination="$root/$fixture"
  rm -rf "$destination"
  cp -R "fixtures/$fixture" "$destination"
  git -C "$destination" init -b main
  git -C "$destination" add --all
  git -C "$destination" -c user.name='Fixture Builder' -c user.email='fixture@example.invalid' commit -m 'Add deliberately broken fixture'
done

