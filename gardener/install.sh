#!/usr/bin/env bash
# Install the Golden Signals Gardener (and its Lab A/B tool) into ~/.pi/agent by symlinking from this repo.
# Replaces the live copies, so the next scheduled run uses this repo's version. launchd keeps calling
# ~/.pi/agent/gardener/gardener.sh (now a link here); this script never loads or unloads the plist.
#   gardener/install.sh [--dry-run]
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SRC/.." && pwd)"
PI="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
DRY=""; [ "${1:-}" = "--dry-run" ] && DRY=1

link() { # <target in repo> <link path>
  if [ -n "$DRY" ]; then echo "would link $2 -> $1"; return; fi
  mkdir -p "$(dirname "$2")"
  if [ -e "$2" ] && [ ! -L "$2" ]; then mv "$2" "$2.pre-repo.bak"; echo "kept the old $2 as $2.pre-repo.bak"; fi
  ln -sfn "$1" "$2"; echo "linked $2 -> $1"
}

link "$SRC/gardener.md"             "$PI/prompts/gardener.md"
link "$SRC/agents/rum-diagnose.md"  "$PI/agents/rum-diagnose.md"
link "$SRC/agents/lab-ab.md"        "$PI/agents/lab-ab.md"
link "$SRC/score.js"                "$PI/gardener/score.js"
link "$SRC/gardener.sh"             "$PI/gardener/gardener.sh"
link "$REPO/lab"                    "$PI/lab"

# Lab A/B on a dev env needs a verify-change with `--target env` (payrollaiharness main since the verify-change-env merge).
VC="${VERIFY_CHANGE_DIR:-$PI/skills/verify-change}"
if grep -q -- '--mr' "$VC/scripts/scaffold-run.sh" 2>/dev/null; then
  echo "verify-change at $VC supports dev envs"
else
  echo "WARNING: verify-change at $VC has no dev env support, so Lab A/B can only use staging."
  echo "         Update it (npx skills update verify-change -g), or point $PI/skills/verify-change at a payrollaiharness checkout's skills/verify-change."
fi
echo "Run the lab's self-test once: VERIFY_CHANGE_DIR=$VC $REPO/lab/test/smoke.sh"
