#!/usr/bin/env bash
# Lab A/B self-test in a real browser, on a local page whose "flag" is which file is served.
#   test/smoke.sh        needs python3, a verify-change checkout (VERIFY_CHANGE_DIR) and Chromium
# Case 1: the same page on both sides            -> SAME
# Case 2: the after page inserts a late banner   -> REGRESSED (cls up), AB1 DIFFERENT
# Case 3: case 2 run with --expect-improved cls  -> REGRESSED still wins over NOT_IMPROVED
# Case 4: the flag cache stays OFF on the after side -> INCOMPLETE (the flag did not flip)
# Each page writes an Amplitude-style variant cache (OFF before, ON after unless FLIP=0), so recordFlag sees the side's variant.
set -euo pipefail
lab="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
site="$tmp/site"; mkdir -p "$site"
port=$((20000 + RANDOM % 20000))
(cd "$site" && exec python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) &
server=$!
trap 'kill $server 2>/dev/null || true; wait $server 2>/dev/null || true; rm -rf "$tmp"' EXIT

page() { # <file> <banner: 0|1> <flag on: 0|1>
  cat > "$1" <<EOF
<!doctype html><html><head><meta charset="utf-8"><title>lab</title>
<style>body{font:16px sans-serif;margin:0}main{padding:24px}.card{height:200px;background:#eef;margin:12px 0}</style></head>
<body><main><h1>Payroll</h1><div class="card">one</div><div class="card">two</div><p id="clock">$(date +%s%N)</p></main>
<script>
localStorage.setItem('amp-exp-\$default_instance-smoke', JSON.stringify({ 'lab-flag': { key: $3 ? 'using-lab-flag' : 'not-using-lab-flag' } }));
if ($2) setTimeout(() => { const b = document.createElement('div'); b.id = 'banner'; b.style.height = '120px'; b.style.background = '#fcc';
  b.textContent = 'late banner'; document.body.prepend(b); }, 300);
</script></body></html>
EOF
}

tests() { # <project dir>
  mkdir -p "$1/tests"
  cat > "$1/tests/AB1-visual.e2e.ts" <<'EOF'
import { expect } from 'e2e';
import { sleep, test } from '../lab.ts';
test('AB1: the page looks the same once settled', { tags: ['visual'] }, async ({ app, browser, screen }) => {
  await app.open('/index.html');
  await expect(screen.getByRole('heading', { name: 'Payroll' })).toBeVisible();
  await sleep(1_000);
  await expect(screen).toHaveScreenshot('AB1-settled', { mask: [browser.locator('#clock')] });
});
EOF
  cat > "$1/tests/AB2-vitals.e2e.ts" <<'EOF'
import { expect } from 'e2e';
import { recordFlag, sleep, startVitals, test, vitals } from '../lab.ts';
test('AB2: page vitals', async ({ app, browser, screen }) => {
  await startVitals(browser);
  await app.open('/index.html');
  await expect(screen.getByRole('heading', { name: 'Payroll' })).toBeVisible();
  await sleep(1_000);
  await vitals(browser, 'AB2');
  await recordFlag(browser, 'lab-flag');
});
EOF
}

fail=0
expect() { # <case> <dir> <overall> [jq-like node check]
  local got; got="$(node -p 'require(process.argv[1]).overall' "$2/compare.json")"
  if [ "$got" = "$3" ]; then echo "ok   $1: $got"; else echo "FAIL $1: expected $3, got $got"; fail=1; fi
}

run_case() { # <name> <after banner> [compare args...]; FLIP=0 keeps the after page's flag cache OFF
  local name="$1" banner="$2"; shift 2
  local d="$tmp/$name"
  "$lab/lab.sh" project --dir "$d" --url "http://127.0.0.1:$port" >/dev/null
  tests "$d/project"
  page "$site/index.html" 0 0
  "$lab/lab.sh" run --dir "$d" --side before --flags "lab-flag=OFF" --sha smoke --repeat 2 >"$tmp/$name-before.log" 2>&1 || { cat "$tmp/$name-before.log"; exit 1; }
  page "$site/index.html" "$banner" "${FLIP:-1}"
  "$lab/lab.sh" run --dir "$d" --side after --flags "lab-flag=ON" --sha smoke --repeat 2 >"$tmp/$name-after.log" 2>&1 || { cat "$tmp/$name-after.log"; exit 1; }
  "$lab/lab.sh" compare --dir "$d" "$@" >"$tmp/$name-compare.log" 2>&1
  echo "$d"
}

d1="$(run_case same 0)"
expect "same page" "$d1" SAME
node -e '
  const c = require(process.argv[1]);
  const ab1 = c.checks.find((x) => x.id === "AB1"), cls = c.metrics.find((m) => m.metric === "cls");
  const ok = ab1?.verdict === "SAME" && cls?.verdict === "SAME" && cls.stable && c.sides.check?.e2eExit === 0;
  console.log(`${ok ? "ok  " : "FAIL"} same page: AB1 SAME, cls SAME and stable, noise check passed`);
  process.exit(ok ? 0 : 1);' "$d1/compare.json" || fail=1

d2="$(run_case banner 1)"
expect "late banner" "$d2" REGRESSED
node -e '
  const c = require(process.argv[1]);
  const ab1 = c.checks.find((x) => x.id === "AB1"), cls = c.metrics.find((m) => m.metric === "cls");
  const ok = ab1?.verdict === "DIFFERENT" && ab1.diff.length > 0 && ab1.diff.every((f) => require("node:fs").existsSync(require("node:path").join(process.argv[2], f))) && cls?.verdict === "REGRESSED" && cls.after > cls.before
    && cls.selectors.after.some((s) => /MAIN|BODY/.test(s.selector));
  console.log(`${ok ? "ok  " : "FAIL"} late banner: AB1 DIFFERENT with a diff image, cls REGRESSED, shifted selector named`);
  if (!ok) console.log(JSON.stringify({ ab1, dir: process.argv[2] }, null, 2), require("node:child_process").execSync(`find ${process.argv[2]}/after/results -name "*.png"`).toString());
  process.exit(ok ? 0 : 1);' "$d2/compare.json" "$d2" || fail=1

"$lab/lab.sh" compare --dir "$d2" --expect-improved cls >/dev/null
expect "late banner, cls expected to improve" "$d2" REGRESSED

node -e 'const c = require(process.argv[1]); const ok = c.flagProof["lab-flag"]?.proven === true;
  console.log(`${ok ? "ok  " : "FAIL"} late banner: the flag flip is proven in the browser`); process.exit(ok ? 0 : 1);' "$d2/compare.json" || fail=1

d4="$(FLIP=0 run_case noflip 0)"
expect "flag cache stayed OFF" "$d4" INCOMPLETE

exit $fail
