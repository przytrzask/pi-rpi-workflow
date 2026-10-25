#!/usr/bin/env node
/**
 * Compares the before and after sides of one Lab A/B run (lab.sh compare calls it).
 *   compare.mjs --dir <dir> [--expect-improved <metric>]... [--intended <ID>]...
 *
 * Reads <dir>/before, <dir>/after and, when the before side ran one, <dir>/check (the visual
 * tests rerun with the flag still OFF and nothing written: the noise check). Each side holds
 * side.json (lab.sh), report.json (e2e) and vitals/<ID>-<label>.runs.jsonl (lab.ts).
 * Writes <dir>/compare.json and <dir>/compare.md, prints the table, exits 0 (the verdict is data).
 *
 * Per check, by the ID that starts its test title (AB1, AB2, ...):
 *   visual   SAME | DIFFERENT (the after run's toHaveScreenshot failed: -diff images listed) |
 *            UNSTABLE (the noise check failed too: the screen isn't deterministic, never gating) |
 *            BROKEN (the after run failed some other way: the flow itself changed) |
 *            BLOCKED (the before run failed: nothing to compare with)
 *   metrics  per vitals label: the median of each side's runs.
 *            Deterministic (gating): cls (±0.005), failedRequests and errors (exact). IMPROVED, SAME,
 *            REGRESSED; `stable: false` when the before runs disagree beyond the tolerance, and then
 *            the metric never gates. Indicative: lcp, inp, ttfb, loadToIdle (delta %, never gating;
 *            `n/a` on a dev env, which runs Rails in development mode).
 *   app log  error lines (uncaught errors, 4xx/5xx other than 401) whose signature is new on the
 *            after side: gating.
 *   flag     what recordFlag() saw (flags.jsonl): the before side must never see `using-<key>`, the
 *            after side must see it; a side where every record is null (a backend-only flag) is
 *            `flagProven: false`, a warning, not a stop.
 *
 * Overall, first match wins:
 *   INCOMPLETE    a side is missing, the sides aren't comparable (target, MR, URL, org, served sha;
 *                 or the same flags on both sides), or a check is BLOCKED
 *   REGRESSED     a BROKEN check, a stable deterministic metric REGRESSED, or a new app-log error
 *   NOT_IMPROVED  an --expect-improved metric that is not IMPROVED (or not stable) anywhere it was measured
 *   CHANGED       a visual DIFFERENT that is not --intended (the caller decides if that's intended)
 *   IMPROVED      at least one stable deterministic metric IMPROVED
 *   SAME          otherwise
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const many = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const di = args.indexOf('--dir');
if (di === -1 || !args[di + 1]) {
  console.error('usage: compare.mjs --dir <dir> [--expect-improved <metric>]... [--intended <ID>]...');
  process.exit(2);
}
const dir = resolve(args[di + 1]);
const expectImproved = many('--expect-improved');
const intended = new Set(many('--intended'));

export const DETERMINISTIC = { cls: 0.005, failedRequests: 0, errors: 0 };
export const INDICATIVE = ['lcp', 'inp', 'ttfb', 'loadToIdle'];

const readJson = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const idOf = (result) => result.titlePath?.at(-1)?.match(/^([A-Z]+\d+[a-z]?):/)?.[1] ?? null;

function loadSide(name) {
  const base = join(dir, name);
  const side = readJson(join(base, 'side.json'));
  const report = readJson(join(base, 'report.json'))?.run ?? null;
  const vitals = new Map();
  const vdir = join(base, 'vitals');
  if (side && existsSync(vdir)) {
    for (const f of readdirSync(vdir).filter((x) => x.endsWith('.runs.jsonl'))) {
      const lines = readFileSync(join(vdir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        .filter((l) => l.runId === side.runId);
      if (lines.length) vitals.set(f.replace(/\.runs\.jsonl$/, ''), lines);
    }
  }
  const flagsFile = join(base, 'flags.jsonl');
  const flags = side && existsSync(flagsFile)
    ? readFileSync(flagsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.runId === side.runId)
    : [];
  return side ? { name, base, side, report, vitals, flags } : null;
}

// Results by check ID, setup tests left out.
function byId(report) {
  const out = new Map();
  for (const r of report?.results ?? []) {
    if (r.kind === 'setup') continue;
    const id = idOf(r);
    if (!id) continue;
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(r);
  }
  return out;
}

const attemptsOf = (results) => results.flatMap((r) => r.attempts ?? []);
const lastError = (results) => {
  const a = attemptsOf(results).filter((x) => x.error).at(-1);
  return a ? `${a.error.code ?? ''} ${a.error.message ?? ''}`.trim().slice(0, 400) : null;
};
const isScreenshotMismatch = (results) => attemptsOf(results).some((a) => a.error
  && /toHaveScreenshot|screenshot/i.test(`${a.error.message ?? ''} ${a.error.matcher ?? ''} ${JSON.stringify(a.error.assertion ?? '')}`));
const diffImages = (side, results) => attemptsOf(results).flatMap((a) => (a.artifacts ?? []).filter((x) => x.kind === 'screenshot' && /-diff/.test(x.path ?? '')))
  .map((x) => relative(dir, join(side.base, 'results', x.path)));

// App-log error signatures: uncaught errors and 4xx/5xx other than 401, ids and numbers normalised.
export function errorSignatures(results) {
  const sigs = new Set();
  for (const a of attemptsOf(results)) {
    for (const l of a.appLog ?? []) {
      if (l.level !== 'error') continue;
      if (l.source === 'network') {
        const status = Number(l.text.match(/\b([45]\d\d)\b/)?.[1]);
        if (!status || status === 401) continue;
      } else if (l.source !== 'error') continue;
      sigs.add(`${l.source}: ${l.text.replace(/[0-9a-f]{8,}|\b\d{4,}\b/gi, ':id').slice(0, 200)}`);
    }
  }
  return sigs;
}

function compareMetrics(before, after, isEnv) {
  const out = [];
  for (const [key, bLines] of before.vitals) {
    const aLines = after.vitals.get(key) ?? [];
    const [id, ...label] = key.split('-');
    for (const [metric, tol] of Object.entries(DETERMINISTIC)) {
      const b = bLines.map((l) => l.metrics?.[metric]);
      const a = aLines.map((l) => l.metrics?.[metric]);
      const bm = median(b), am = median(a);
      const spread = b.length ? Math.max(...b) - Math.min(...b) : 0;
      const stable = spread <= tol + 1e-9;
      const verdict = bm === null || am === null ? 'MISSING' : am < bm - tol - 1e-9 ? 'IMPROVED' : am > bm + tol + 1e-9 ? 'REGRESSED' : 'SAME';
      out.push({ id, label: label.join('-'), metric, deterministic: true, stable, runs: { before: b, after: a }, before: bm, after: am,
        delta: bm === null || am === null ? null : Math.round((am - bm) * 10000) / 10000, verdict,
        ...(metric === 'cls' ? { selectors: { before: bLines.at(-1)?.details?.clsSelectors ?? [], after: aLines.at(-1)?.details?.clsSelectors ?? [] } } : {}) });
    }
    for (const metric of INDICATIVE) {
      const bm = median(bLines.map((l) => l.metrics?.[metric])), am = median(aLines.map((l) => l.metrics?.[metric]));
      out.push({ id, label: label.join('-'), metric, deterministic: false, before: isEnv ? null : bm, after: isEnv ? null : am,
        deltaPct: isEnv || !bm || am === null ? null : Math.round(((am - bm) / bm) * 1000) / 10,
        verdict: isEnv ? 'n/a' : 'INDICATIVE', ...(isEnv ? { reason: 'dev env: Rails in development mode, timings are not comparable with production' } : {}) });
    }
  }
  return out;
}

const before = loadSide('before');
const after = loadSide('after');
const check = loadSide('check');
const problems = [];
if (!before?.report) problems.push('no before run (lab.sh run --side before)');
if (!after?.report) problems.push('no after run (lab.sh run --side after)');
if (before && after) {
  for (const k of ['target', 'mr', 'url', 'orgId']) {
    if (JSON.stringify(before.side[k] ?? null) !== JSON.stringify(after.side[k] ?? null)) problems.push(`${k} differs: ${before.side[k]} vs ${after.side[k]}`);
  }
  if (!before.side.sha || !after.side.sha) problems.push('the served sha is unknown on a side (pass --sha to lab.sh run)');
  else if (before.side.sha !== after.side.sha) problems.push(`the served sha differs: ${before.side.sha} vs ${after.side.sha} (only the flag may change)`);
  if (JSON.stringify(before.side.flags) === JSON.stringify(after.side.flags)) problems.push('the flags are the same on both sides');
}
const flagProof = {};
for (const [key, state] of Object.entries(after?.side?.flags ?? {})) {
  const seen = (s) => (s?.flags ?? []).filter((f) => f.key === key).map((f) => f.variant);
  const b = seen(before), a = seen(after);
  const on = `using-${key}`;
  const proven = a.length > 0 && a.some((v) => v !== null);
  flagProof[key] = { before: [...new Set(b)], after: [...new Set(a)], proven };
  if (b.includes(on)) problems.push(`the before side already saw ${on}: the flag was not OFF for this org`);
  if (String(state).toUpperCase() === 'ON' && proven && a.some((v) => v !== on)) problems.push(`the after side saw ${[...new Set(a)].join(', ')} for ${key}, not ${on}: the flag did not flip (Amplitude caches about a minute)`);
}

const checks = [];
let metrics = [];
const newErrors = [];
if (before?.report && after?.report) {
  const bIds = byId(before.report), aIds = byId(after.report), cIds = byId(check?.report);
  for (const [id, bRes] of bIds) {
    const aRes = aIds.get(id) ?? [];
    const visual = bRes.some((r) => (r.tags ?? []).includes('visual'));
    const bPassed = bRes.every((r) => r.status === 'passed');
    const aPassed = aRes.length > 0 && aRes.every((r) => r.status === 'passed');
    const c = { id, title: bRes[0].titlePath.at(-1), kind: visual ? 'visual' : 'flow', repeats: { before: bRes.length, after: aRes.length } };
    if (!bPassed) Object.assign(c, { verdict: 'BLOCKED', reason: `the before run failed: ${lastError(bRes)}` });
    else if (!aRes.length) Object.assign(c, { verdict: 'BLOCKED', reason: 'the after run did not run it' });
    else if (aPassed) c.verdict = 'SAME';
    else if (visual && isScreenshotMismatch(aRes)) {
      const noisy = (cIds.get(id) ?? []).some((r) => r.status !== 'passed');
      Object.assign(c, { verdict: noisy ? 'UNSTABLE' : 'DIFFERENT', diff: diffImages(after, aRes), failedRepeats: aRes.filter((r) => r.status !== 'passed').length,
        ...(noisy ? { reason: 'the noise check (flag still OFF) differed too' } : {}), intended: intended.has(id) });
    } else Object.assign(c, { verdict: 'BROKEN', reason: lastError(aRes) });
    const bSigs = errorSignatures(bRes), aSigs = errorSignatures(aRes);
    const fresh = [...aSigs].filter((s) => !bSigs.has(s));
    if (fresh.length) { c.newAppLogErrors = fresh; newErrors.push(...fresh.map((s) => `${id} ${s}`)); }
    checks.push(c);
  }
  metrics = compareMetrics(before, after, before.side.target === 'env');
}

const det = metrics.filter((m) => m.deterministic);
const expectations = expectImproved.map((metric) => {
  const rows = det.filter((m) => m.metric === metric);
  const ok = rows.length > 0 && rows.every((m) => m.stable && m.verdict === 'IMPROVED');
  return { metric, measured: rows.length > 0, met: ok };
});
let overall;
if (problems.length || checks.some((c) => c.verdict === 'BLOCKED') || det.some((m) => m.verdict === 'MISSING')) overall = 'INCOMPLETE';
else if (checks.some((c) => c.verdict === 'BROKEN') || det.some((m) => m.stable && m.verdict === 'REGRESSED') || newErrors.length) overall = 'REGRESSED';
else if (expectations.some((e) => !e.met)) overall = 'NOT_IMPROVED';
else if (checks.some((c) => c.verdict === 'DIFFERENT' && !c.intended)) overall = 'CHANGED';
else if (det.some((m) => m.stable && m.verdict === 'IMPROVED')) overall = 'IMPROVED';
else overall = 'SAME';

const result = {
  schema: 'lab-ab-compare-1',
  overall,
  comparable: problems.length === 0,
  problems,
  flagProof,
  sides: { before: before?.side ?? null, after: after?.side ?? null, check: check?.side ?? null },
  expectations,
  checks,
  metrics,
  newAppLogErrors: newErrors,
};
writeFileSync(join(dir, 'compare.json'), `${JSON.stringify(result, null, 2)}\n`);

const fmt = (v) => (v === null || v === undefined ? '–' : String(v));
const md = [
  `# Lab A/B: ${overall}`,
  '',
  `Flags: before ${JSON.stringify(before?.side?.flags ?? {})} · after ${JSON.stringify(after?.side?.flags ?? {})} · target ${before?.side?.target ?? '?'}${before?.side?.mr ? ` !${before.side.mr}` : ''} · sha ${before?.side?.sha?.slice(0, 12) ?? '?'}`,
  ...(problems.length ? ['', `**Not comparable:** ${problems.join('; ')}`] : []),
  ...(expectations.length ? ['', `Expected to improve: ${expectations.map((e) => `${e.metric} ${e.met ? '✅' : '❌'}`).join(', ')}`] : []),
  '',
  '| Check | Kind | Verdict | Detail |',
  '|---|---|---|---|',
  ...checks.map((c) => `| ${c.id} | ${c.kind} | ${c.verdict}${c.intended ? ' (intended)' : ''} | ${[c.reason, ...(c.diff ?? []).slice(0, 2), ...(c.newAppLogErrors ?? []).slice(0, 2)].filter(Boolean).join('<br>') || ''} |`),
  '',
  '| Check | Metric | Before | After | Delta | Verdict |',
  '|---|---|---|---|---|---|',
  ...metrics.map((m) => `| ${m.id}${m.label !== 'page' ? ` ${m.label}` : ''} | ${m.metric}${m.deterministic ? '' : ' (indicative)'} | ${fmt(m.before)} | ${fmt(m.after)} | ${m.deterministic ? fmt(m.delta) : m.deltaPct === null ? '–' : `${m.deltaPct} %`} | ${m.verdict}${m.deterministic && !m.stable ? ' (unstable)' : ''} |`),
  '',
].join('\n');
writeFileSync(join(dir, 'compare.md'), md);
console.log(md);
