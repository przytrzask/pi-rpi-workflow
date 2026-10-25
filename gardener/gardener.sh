#!/bin/zsh
# Golden Signals Gardener launcher. launchd runs it on a schedule (com.hcp.golden-signals-gardener.plist).
# Opens a herdr tab, starts an interactive pi, and submits "/gardener [args]".
# The session is visible in herdr and mirrored to HumanLayer, so you can watch or steer it.
# Usage: gardener.sh [PRR-xxxx | dry-run]      manual run, any time
#        gardener.sh --scheduled               used by launchd (at most once per day)
set -euo pipefail
SCHEDULED=0
if [[ "${1:-}" == "--scheduled" ]]; then SCHEDULED=1; shift; fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.asdf/shims:$HOME/.asdf/installs/nodejs/24.16.0/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="$HOME/projects/housecall-web"
HOME_DIR="$HOME/.pi/agent/gardener"
LOG="$HOME_DIR/logs/$(date +%F).log"
mkdir -p "$HOME_DIR/logs" "$HOME_DIR/runs"
exec >>"$LOG" 2>&1
echo "=== $(date -Iseconds) gardener launch args='$*'"

notify() { osascript -e "display notification \"$1\" with title \"🌱 Golden Signals Gardener\"" >/dev/null 2>&1 || true; }

# Scheduled runs: at most once per day (launchd may fire again on wake). Manual runs always go.
STAMP="$HOME_DIR/logs/.started-$(date +%F)"
if (( SCHEDULED )) && [[ -e "$STAMP" ]]; then echo "scheduled run already done today, skipping"; exit 0; fi

if ! herdr status server 2>/dev/null | grep -q "status: running"; then
  echo "herdr server not running - cannot start unattended session"
  notify "Skipped: herdr is not running. Open herdr once and leave it running."
  exit 1
fi

# Keep the Mac awake for up to 3h while the run works
caffeinate -i -t 10800 &

# Fetch only master, here and without a time limit (a full fetch of this repo can take minutes)
echo "fetching origin/master..."
git -C "$REPO" fetch origin master --quiet && echo "fetch ok" || echo "WARN: fetch failed, the run uses the existing origin/master"

# HUMANLAYER_TASK=new: each run gets its own HumanLayer task instead of joining a random worktree task
TAB_JSON=$(herdr tab create --cwd "$REPO" --label "🌱 gardener $(date +%m-%d)" --no-focus --env HUMANLAYER_TASK=new --env GARDENER_FETCHED=1)
PANE=$(echo "$TAB_JSON" | jq -r '.result.root_pane.pane_id')
echo "tab pane=$PANE"
sleep 2
herdr agent start "gardener-$(date +%m%d)" --kind pi --pane "$PANE" --timeout 120000
herdr agent prompt "$PANE" "/gardener ${*:-}"
(( SCHEDULED )) && touch "$STAMP"
notify "Started today's run (pane $PANE)."
echo "prompt submitted"
