#!/usr/bin/env bash
# Lab A/B: one before/after comparison of a flagged change on a deployed environment, with e2e.
#
#   lab.sh seed    --dir <dir> --target env|staging --checkout <worktree> [--mr <IID>] [--recipe job] [--fresh]
#   lab.sh project --dir <dir> [--url <url>]
#   lab.sh run     --dir <dir> --side before|after --flags "<key>=OFF" --sha <sha> [--repeat 5]
#   lab.sh compare --dir <dir> [--expect-improved cls]... [--intended AB3]...
#
# seed     reuses verify-change's seeding as it is: scaffold-run.sh, seed-org.sh and login-cookies.mjs in
#          <dir>/seed/ give a throwaway org (.org.json) and its session cookies. Then runs `project`.
#          verify-change: $VERIFY_CHANGE_DIR, else ~/.pi/agent/skills/verify-change. --target env needs
#          a verify-change with dev env support (payrollaiharness main since the verify-change-env merge).
# project  (re)creates <dir>/project/: the e2e config, lab.ts, verify-change's network-policy.mjs,
#          the login setup test when the seed has cookies, node_modules linked to this folder's
#          pinned install, and lab.json (target URL, allowlist, viewport) from the seed's settings.
#          --url instead of a seed: an unauthenticated page (the self-test uses it). Keeps tests/.
#          The lab's own tests go in <dir>/project/tests/AB<n>-*.e2e.ts (templates/ has two).
# run      runs every test --repeat times (default 5) with the flag in the stated state, then copies the
#          report, results and vitals into <dir>/<side>/ with side.json (flags, sha, target, org).
#            before  writes the stored screenshots (--update-snapshots), then reruns the `visual`
#                    tests once more without writing, flag still OFF: the noise check, in <dir>/check/
#            after   compares with them
#          The caller flips the flag between the two runs; this script never touches a flag.
#          Exits 0 when a report was written (failed tests are data for compare), else e2e's code.
# compare  compare.mjs: <dir>/compare.json and compare.md.
set -euo pipefail

lab="$(cd "$(dirname "$0")" && pwd)"
cmd="${1:-}"; shift || true
dir="" target="" mr="" recipe="job" fresh="" checkout="" url="" side="" flags="" sha="" repeat=5 cmp=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) dir="$2"; shift 2 ;;
    --target) target="$2"; shift 2 ;;
    --mr) mr="${2#!}"; shift 2 ;;
    --recipe) recipe="$2"; shift 2 ;;
    --fresh) fresh=1; shift ;;
    --checkout) checkout="$2"; shift 2 ;;
    --url) url="$2"; shift 2 ;;
    --side) side="$2"; shift 2 ;;
    --flags) flags="$2"; shift 2 ;;
    --sha) sha="$2"; shift 2 ;;
    --repeat) repeat="$2"; shift 2 ;;
    --expect-improved|--intended) cmp+=("$1" "$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$dir" ] || { echo "--dir is required" >&2; exit 2; }
mkdir -p "$dir"
dir="$(cd "$dir" && pwd)"
vc="${VERIFY_CHANGE_DIR:-$HOME/.pi/agent/skills/verify-change}"

need_vc() {
  [ -x "$vc/scripts/seed-org.sh" ] && [ -f "$vc/runner/network-policy.mjs" ] \
    || { echo "BLOCKED: verify-change not found at $vc (set VERIFY_CHANGE_DIR)" >&2; exit 1; }
}

install_runner() {
  if [ ! -d "$lab/node_modules/e2e" ] || [ "$lab/package-lock.json" -nt "$lab/node_modules/.package-lock.json" ]; then
    echo "installing the pinned e2e runner (npm ci in $lab)" >&2
    (cd "$lab" && npm ci --package-lock=true --no-audit --no-fund --loglevel=error) >&2
  fi
  if ! (cd "$lab" && node -e 'process.exit(require("node:fs").existsSync(require("playwright-core").chromium.executablePath()) ? 0 : 1)' 2>/dev/null); then
    echo "installing Chromium for the pinned Playwright" >&2
    (cd "$lab" && ./node_modules/.bin/playwright-core install chromium) >&2
  fi
}

make_project() {
  need_vc
  install_runner
  local p="$dir/project"
  mkdir -p "$p/tests"
  cp "$lab/e2e.config.ts" "$lab/lab.ts" "$p/"
  cp "$vc/runner/network-policy.mjs" "$p/"
  ln -sfn "$lab/node_modules" "$p/node_modules"
  printf '{ "private": true, "type": "module" }\n' > "$p/package.json"
  if [ -n "$url" ]; then
    node -e '
      const [url] = process.argv.slice(1);
      const host = new URL(url).hostname;
      console.log(JSON.stringify({ url, target: "local", mr: null, viewport: { width: 1440, height: 1000 }, timeoutMs: 30000,
        network: { mode: "block" }, allowHosts: [host] }, null, 2));' "$url" > "$p/lab.json"
    rm -f "$p/tests/00-login.setup.e2e.ts" "$p/.session-cookies.json"
  else
    local cfg="$dir/seed/run/verify-change.effective.json"
    [ -f "$cfg" ] || { echo "no seed in $dir (lab.sh seed first, or --url)" >&2; exit 1; }
    node -e '
      const c = require(process.argv[1]); const t = c.targets[c.target];
      console.log(JSON.stringify({ url: t.url, target: c.target, mr: c.mr ?? null, viewport: c.viewport, timeoutMs: t.timeoutMs,
        network: c.network, allowHosts: t.allowHosts }, null, 2));' "$cfg" > "$p/lab.json"
    if [ -f "$dir/seed/run/.session-cookies.json" ]; then
      cp "$dir/seed/run/.session-cookies.json" "$p/.session-cookies.json"
      cp "$lab/setup/00-login.setup.e2e.ts" "$p/tests/00-login.setup.e2e.ts"
    fi
  fi
  printf '.session-cookies.json\nnode_modules\n.e2e/\n' > "$p/.gitignore"
  echo "project ready: $p ($(node -p 'const l=require(process.argv[1]); `${l.target} ${l.url}`' "$p/lab.json"))"
}

e2e_run() { # <side> [e2e args...]
  local s="$1"; shift
  (cd "$dir/project" && env -u CI E2E_TELEMETRY_DISABLED=1 LAB_DIR="$dir" LAB_SIDE="$s" LAB_RUN_ID="$run_id" \
    ./node_modules/.bin/e2e run --config e2e.config.ts --reporter list,markdown "$@")
}

keep_side() { # <side> <status>
  local s="$1" status="$2" out="$dir/$1"
  local e="$dir/project/.e2e"
  [ -f "$e/report.json" ] || return 1
  cp "$e/report.json" "$out/report.json"
  [ -f "$e/summary.md" ] && cp "$e/summary.md" "$out/summary.md"
  rm -rf "$out/results"; [ -d "$e/results" ] && cp -R "$e/results" "$out/results"
  node -e '
    const [file, side, flags, sha, repeat, runId, status, lab, org] = process.argv.slice(1);
    const fs = require("node:fs");
    const l = JSON.parse(fs.readFileSync(lab, "utf8"));
    const o = fs.existsSync(org) ? JSON.parse(fs.readFileSync(org, "utf8")) : {};
    const f = flags ? Object.fromEntries(flags.split(",").map((p) => p.split("=").map((x) => x.trim()))) : null;
    fs.writeFileSync(file, JSON.stringify({ side, flags: f, sha: sha || null, repeat: Number(repeat), runId,
      target: l.target, mr: l.mr, url: l.url, orgId: o.orgId ?? o.orgUuid ?? null, e2eExit: Number(status),
      finishedAt: new Date().toISOString() }, null, 2) + "\n");' \
    "$out/side.json" "$s" "$flags" "$sha" "$repeat" "$run_id" "$status" "$dir/project/lab.json" "$dir/seed/run/.org.json"
}

case "$cmd" in
  seed)
    need_vc
    case "$target" in env|staging) ;; *) echo "--target must be env or staging" >&2; exit 2 ;; esac
    [ "$target" != env ] || [ -n "$mr" ] || { echo "--target env needs --mr <IID>" >&2; exit 2; }
    [ "$target" != env ] || grep -q -- '--mr' "$vc/scripts/scaffold-run.sh" \
      || { echo "BLOCKED: $vc has no dev env support; update verify-change (npx skills update verify-change -g) or set VERIFY_CHANGE_DIR" >&2; exit 1; }
    [ -n "$checkout" ] || { echo "--checkout <worktree> is required (the served code)" >&2; exit 2; }
    scaffold=(--out "$dir/seed" --target "$target" --checkout "$checkout")
    [ -z "$mr" ] || scaffold+=(--mr "$mr")
    "$vc/scripts/scaffold-run.sh" "${scaffold[@]}"
    seed=(--target "$target" --out "$dir/seed" --recipe "$recipe" --checkout "$checkout")
    [ -z "$mr" ] || seed+=(--mr "$mr")
    [ -z "$fresh" ] || seed+=(--fresh)
    "$vc/scripts/seed-org.sh" "${seed[@]}"
    # shellcheck source=/dev/null
    . "$vc/scripts/node.sh"
    use_runner_node "$vc" || { echo "BLOCKED: $NODE_PROBLEM" >&2; exit 1; }
    node "$vc/scripts/login-cookies.mjs" --out "$dir/seed" || { echo "BLOCKED: could not log in as the seeded pro" >&2; exit 1; }
    make_project
    ;;
  project)
    make_project
    ;;
  run)
    case "$side" in before|after) ;; *) echo "--side must be before or after" >&2; exit 2 ;; esac
    [ -n "$flags" ] || { echo "--flags is required: the flag state of this side" >&2; exit 2; }
    [[ "$repeat" =~ ^[0-9]+$ ]] && [ "$repeat" -ge 1 ] && [ "$repeat" -le 20 ] || { echo "--repeat must be 1..20" >&2; exit 2; }
    [ -f "$dir/project/lab.json" ] || { echo "no project in $dir (lab.sh seed or lab.sh project first)" >&2; exit 1; }
    ls "$dir"/project/tests/AB*.e2e.ts >/dev/null 2>&1 || { echo "no lab tests in $dir/project/tests (copy templates/ and adapt them)" >&2; exit 1; }
    run_id="$(date +%Y%m%dT%H%M%S)-$side-$$"
    rm -rf "$dir/$side" "$dir/compare.json" "$dir/compare.md"; mkdir -p "$dir/$side"
    up=(); [ "$side" = before ] && up=(--update-snapshots)
    set +e
    e2e_run "$side" --repeat-each "$repeat" "${up[@]+"${up[@]}"}"
    status=$?
    set -e
    keep_side "$side" "$status" || { echo "e2e wrote no report (exit $status): see the output above" >&2; exit "$status"; }
    if [ "$side" = before ]; then
      rm -rf "$dir/check"; mkdir -p "$dir/check"
      set +e
      e2e_run check --tag visual --pass-with-no-tests
      cstatus=$?
      set -e
      keep_side check "$cstatus" || true
    fi
    echo "$side kept in $dir/$side (e2e exit $status)"
    ;;
  compare)
    node "$lab/compare.mjs" --dir "$dir" "${cmp[@]+"${cmp[@]}"}"
    ;;
  *)
    sed -n 2,27p "$0"; exit 2 ;;
esac
