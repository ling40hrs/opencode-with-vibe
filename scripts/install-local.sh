#!/usr/bin/env bash
# Install this checkout as OpenCode's `vibe/*` provider, replacing the npm package entry.
#
#   scripts/install-local.sh --check   report what is installed now, change nothing
#   scripts/install-local.sh           switch to this checkout (backup, verify, roll back on failure)
#
# Why this exists: OpenCode loads the published npm package out of its cache
# (~/.cache/opencode/npm/opencode-with-vibe@latest/<stamp>/dist/plugin.js), so a fork's changes
# never reach a running session until the plugin resolves to the checkout instead. Route 1 of
# PATCH.md does the same thing by hand: symlink the built bundle into `plugin/` and drop the npm
# entry, because both provide `vibe/*` and two providers with one id is not a state to leave behind.
#
# The verification step boots a private OpenCode (`--standalone`) against the edited config and
# counts the `vibe/*` models it reports. A broken bundle fails there, not on the next restart.

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cfg_dir=${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}
cfg=$cfg_dir/opencode.json
link=$cfg_dir/plugin/opencode-with-vibe.js
bundle=$here/dist/plugin.js
expected=${OPENCODE_VIBE_MODELS:-12}

if [[ ! -f $bundle ]]; then
  echo "no bundle at $bundle — run 'bun run build' in $here first" >&2
  exit 1
fi
if [[ ! -f $cfg ]]; then
  echo "no config at $cfg" >&2
  exit 1
fi

count_models() {
  # A private server, so a running OpenCode is neither disturbed nor consulted.
  OPENCODE_CONFIG=$cfg timeout 180 opencode --standalone models 2>/dev/null | grep -c '^vibe/' || true
}

if [[ ${1:-} == "--check" ]]; then
  echo "bundle:  $bundle ($(wc -c <"$bundle") bytes)"
  if [[ -L $link ]]; then
    echo "link:    $link -> $(readlink "$link")"
    [[ $(readlink -f "$link") == "$(readlink -f "$bundle")" ]] || echo "         (points somewhere else)"
  elif [[ -e $link ]]; then
    echo "link:    $link exists and is not a symlink"
  else
    echo "link:    absent"
  fi
  if grep -q '"opencode-with-vibe"' "$cfg"; then
    echo "config:  still lists the npm package in plugins"
  else
    echo "config:  no npm package entry"
  fi
  echo "models:  $(count_models) vibe/* reported by a private server"
  exit 0
fi

backup=$cfg.bak-planmode
cp -p "$cfg" "$backup"

# The entry is an object, not a string, so JSON is edited rather than pattern-matched, and the file is
# rewritten in its existing two-space layout. `plugins` keeps every other entry in the order it had.
python3 - "$cfg" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    config = json.load(f)

plugins = config.get("plugins") or []
kept = [p for p in plugins if not (isinstance(p, dict) and p.get("package") == "opencode-with-vibe")]
config["plugins"] = kept

with open(path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
print(f"plugins: {len(plugins)} -> {len(kept)}")
PY

ln -sfn "$bundle" "$link"

models=$(count_models)
if [[ $models -lt $expected ]]; then
  echo "verification failed: $models vibe/* models, expected $expected — rolling back" >&2
  cp -p "$backup" "$cfg"
  rm -f "$link"
  echo "restored $cfg; removed $link" >&2
  exit 1
fi

echo "installed: $link -> $bundle"
echo "config:    $cfg (backup at $backup)"
echo "verified:  $models vibe/* models from a private server"
echo
echo "Restart OpenCode: the plugin bundle is read once, at load time."
