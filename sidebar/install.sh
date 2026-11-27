#!/usr/bin/env bash
# Installs the Vibe sidebar block and the Vibe model pricing table into OpenCode's
# config directory. Idempotent: re-run after editing anything here.
#
#   ./install.sh           install into ${OPENCODE_CONFIG:-~/.config/opencode}
#   ./install.sh --check   report whether the installed copies are in sync
#
# OpenCode reads both halves at load time, so restart it afterwards.

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cfg=${OPENCODE_CONFIG:-$HOME/.config/opencode}

pricing="$cfg/plugin/vibe-pricing.ts"
sidebar_dir="$cfg/plugins/vibe-sidebar"

mapfile -t sources <<EOF
$here/vibe-pricing.ts:$pricing
$here/vibe-sidebar/index.js:$sidebar_dir/index.js
$here/vibe-sidebar/tui.tsx:$sidebar_dir/tui.tsx
EOF

if [[ ${1:-} == "--check" ]]; then
  status=0
  for pair in "${sources[@]}"; do
    src=${pair%%:*}
    dst=${pair#*:}
    if cmp -s "$src" "$dst"; then
      echo "in sync: $dst"
    else
      echo "OUT OF SYNC: $dst"
      status=1
    fi
  done
  exit $status
fi

for pair in "${sources[@]}"; do
  src=${pair%%:*}
  dst=${pair#*:}
  install -Dm644 "$src" "$dst"
done

echo "installed into $cfg"
echo "restart OpenCode: the plugin halves are only read at load time"
