#!/usr/bin/env bash
# Install the RPI workflow into ~/.pi/agent by symlinking agents + prompt.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

mkdir -p "$PI/agents" "$PI/prompts" "$PI/extensions/subagent"

echo "Symlinking stage agents -> $PI/agents/"
for f in "$SRC"/agents/*.md; do
  ln -sf "$f" "$PI/agents/$(basename "$f")"
done

echo "Symlinking /rpi prompt -> $PI/prompts/"
ln -sf "$SRC/prompts/rpi.md" "$PI/prompts/rpi.md"

# Stage 7 (verify) runs the /verify-change skill. Expose it to pi if it's installed for Claude Code.
VC="${VERIFY_CHANGE_DIR:-$HOME/.claude/skills/verify-change}"
if [ -f "$VC/SKILL.md" ]; then
  mkdir -p "$PI/skills"
  echo "Symlinking verify-change skill -> $PI/skills/"
  ln -sfn "$VC" "$PI/skills/verify-change"
else
  echo "WARNING: verify-change skill not found at $VC; stage 7 (verify) needs it (see its setup.md)."
fi

CFG="$PI/extensions/subagent/config.json"
if [ -f "$CFG" ]; then
  echo "Keeping existing subagent config: $CFG (see config/subagent-config.example.json to merge model routing)"
else
  echo "Installing example subagent config -> $CFG"
  cp "$SRC/config/subagent-config.example.json" "$CFG"
fi

echo
echo "Done. Restart pi inside a Herdr pane, then run:  /rpi <jira-key | issue text>"
echo "Requires the pi-herdr-subagents package: pi install npm:pi-herdr-subagents"
