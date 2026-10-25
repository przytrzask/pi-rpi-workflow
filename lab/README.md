# Lab A/B

Before/after comparison of one flagged change on a deployed environment: the same build, the same throwaway org, the flag **OFF** (before) and **ON** (after). It answers "did the flag change anything it shouldn't, and did the targeted signal move?"

It runs [tester-army e2e](https://e2e.tester.army) **0.21.3** directly (pinned here, independent of verify-change), so visual checks use e2e's own `toHaveScreenshot`. It reuses only verify-change's **seeding**: `scaffold-run.sh`, `seed-org.sh` and `login-cookies.mjs` give a throwaway org and its session cookies. Its network allowlist (`network-policy.mjs`) keeps every run away from production and third parties.

Used by the Golden Signals Gardener's G7.5 stage (`../gardener/agents/lab-ab.md`). It's generic, so `/rpi` stage 7 could call it for flagged changes too; that isn't wired yet.

## Flow

```bash
lab.sh seed --dir <dir> --target env --mr <IID> --checkout <worktree>   # or --target staging
# write <dir>/project/tests/AB<n>-*.e2e.ts from templates/ (visual + vitals)
lab.sh run --dir <dir> --side before --flags "<key>=OFF" --sha <sha>    # stores screenshots, + noise check
#   ... the caller turns the flag ON for the seeded org ...
lab.sh run --dir <dir> --side after  --flags "<key>=ON"  --sha <sha>    # compares with them
#   ... the caller restores the flag ...
lab.sh compare --dir <dir> --expect-improved cls [--intended AB3]
```

`lab.sh` never touches a flag, a deploy or an MR. The caller owns those.

## What it checks

| Check | How | Gates? |
|---|---|---|
| Visual | `expect(screen).toHaveScreenshot(name, { mask })`. The before run writes the stored screenshot; a noise check reruns the `visual` tests with the flag still OFF; the after run compares | **DIFFERENT** → `CHANGED`, unless `--intended`. **UNSTABLE** (the noise check differed too) never gates |
| Flow | Any after-run failure other than the screenshot (a locator gone, an assertion) | **BROKEN** → `REGRESSED` |
| CLS, failed requests, page errors | `startVitals` / `vitals` in `lab.ts`: buffered `PerformanceObserver`s, Resource Timing `responseStatus` (fetch/XHR 4xx/5xx other than 401), uncaught errors. Median of `--repeat` runs | Deterministic: CLS ±0.005, counts exact. `stable: false` when the before runs disagree, and then it never gates |
| App log | e2e's `appLog`: uncaught errors and 4xx/5xx other than 401, new on the after side | → `REGRESSED` |
| LCP, INP, TTFB, loadToIdle | Same observers | Indicative only; `n/a` on a dev env (Rails in development mode) |
| Flag flip | `recordFlag(browser, key)` reads the client's Amplitude variant cache | Before saw ON, or after never saw ON → `INCOMPLETE`. A backend-only flag is `proven: false` |

The sides must match in everything but the flag: target, MR, URL, org, and served sha (`--sha`). Otherwise the result is `INCOMPLETE`.

`overall` is one of `INCOMPLETE` · `REGRESSED` · `NOT_IMPROVED` · `CHANGED` · `IMPROVED` · `SAME`, and the first one that applies wins. Rules: `compare.mjs`.

## Files

| File | What |
|---|---|
| `lab.sh` | `seed`, `project`, `run`, `compare` |
| `lab.ts` | `test` with the network guard, `startVitals`, `vitals`, `recordFlag` (copied into each project) |
| `e2e.config.ts` | One target, `lab`, so the stored screenshots match across sides |
| `setup/00-login.setup.e2e.ts` | Restores the seeded pro's cookies as session `pro` |
| `templates/` | `AB1-visual`, `AB2-vitals` to copy and adapt |
| `compare.mjs` | The verdict: `compare.json` + `compare.md` |
| `test/compare.test.mjs` | Verdict rules on fixtures (`npm test`) |
| `test/smoke.sh` | Real-browser self-test on a local page: same page → SAME, late banner → REGRESSED with a diff image, flag not flipped → INCOMPLETE |

## Requirements

- Node ≥ 24.8. `lab.sh` runs `npm ci` and installs Chromium on first use.
- verify-change at `$VERIFY_CHANGE_DIR`, else `~/.pi/agent/skills/verify-change`. `--target env` needs a verify-change with dev-env support (`payrollaiharness` main); the copy installed with `npx skills add` before that merge doesn't have it: `npx skills update verify-change -g`.
- Dev env: membership of `teams/hcw-dev-env-beta` and Twingate. Staging: Twingate.
