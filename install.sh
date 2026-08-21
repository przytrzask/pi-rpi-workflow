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
