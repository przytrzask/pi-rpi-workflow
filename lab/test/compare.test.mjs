// compare.mjs verdicts on fixture sides: the rules a workflow stops on, without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const compare = join(dirname(fileURLToPath(import.meta.url)), '..', 'compare.mjs');

const result = (id, status, { tags = [], error = null, appLog = [], artifacts = [], repeat = 0 } = {}) => ({
  kind: 'test', titlePath: [`${id}: a check`], tags, repeat, status,
  attempts: [{ status, appLog, artifacts, ...(error ? { error } : {}) }],
});
const vitalsLine = (runId, metrics) => ({ runId, id: 'AB2', label: 'page', metrics: { cls: 0, failedRequests: 0, errors: 0, lcp: 900, inp: null, ttfb: 100, loadToIdle: 1500, ...metrics }, details: { clsSelectors: [] } });

function side(dir, name, { flags, sha = 'abc123', target = 'staging', results = [], vitals = [], orgId = 7, seen = [] }) {
  const base = join(dir, name);
  mkdirSync(join(base, 'vitals'), { recursive: true });
  const runId = `run-${name}`;
  writeFileSync(join(base, 'side.json'), JSON.stringify({ side: name, flags, sha, repeat: vitals.length || 1, runId, target, mr: target === 'env' ? '42' : null, url: 'https://x.test', orgId }));
  writeFileSync(join(base, 'report.json'), JSON.stringify({ schemaVersion: 'report-1', run: { results } }));
  if (seen.length) writeFileSync(join(base, 'flags.jsonl'), seen.map((variant) => JSON.stringify({ runId, key: 'lab-flag', variant })).join('\n') + '\n');
  if (vitals.length) writeFileSync(join(base, 'vitals', 'AB2-page.runs.jsonl'), vitals.map((m) => JSON.stringify(vitalsLine(runId, m))).join('\n') + '\n');
}

function run(setup, ...args) {
  const dir = mkdtempSync(join(tmpdir(), 'lab-compare-'));
  setup(dir);
  execFileSync(process.execPath, [compare, '--dir', dir, ...args], { stdio: 'ignore' });
  return JSON.parse(readFileSync(join(dir, 'compare.json'), 'utf8'));
}

const OFF = { 'lab-flag': 'OFF' }, ON = { 'lab-flag': 'ON' };
const mismatch = { code: 'ASSERTION_FAILED', message: 'toHaveScreenshot: 4123 pixels differ' };

test('a cls drop with nothing else changed is IMPROVED', () => {
  const c = run((d) => {
    side(d, 'before', { flags: OFF, results: [result('AB1', 'passed', { tags: ['visual'] }), result('AB2', 'passed')], vitals: [{ cls: 0.2 }, { cls: 0.2 }] });
    side(d, 'after', { flags: ON, results: [result('AB1', 'passed', { tags: ['visual'] }), result('AB2', 'passed')], vitals: [{ cls: 0.01 }, { cls: 0.01 }] });
  }, '--expect-improved', 'cls');
  assert.equal(c.overall, 'IMPROVED');
  assert.deepEqual(c.expectations, [{ metric: 'cls', measured: true, met: true }]);
});

test('sides that differ in more than the flag are INCOMPLETE', () => {
  const shaDiffers = run((d) => { side(d, 'before', { flags: OFF }); side(d, 'after', { flags: ON, sha: 'def456' }); });
  assert.equal(shaDiffers.overall, 'INCOMPLETE');
  assert.match(shaDiffers.problems.join(), /served sha differs/);
  const sameFlags = run((d) => { side(d, 'before', { flags: OFF }); side(d, 'after', { flags: OFF }); });
  assert.match(sameFlags.problems.join(), /flags are the same/);
  const otherOrg = run((d) => { side(d, 'before', { flags: OFF }); side(d, 'after', { flags: ON, orgId: 8 }); });
  assert.match(otherOrg.problems.join(), /orgId differs/);
  const noAfter = run((d) => side(d, 'before', { flags: OFF }));
  assert.match(noAfter.problems.join(), /no after run/);
});

test('a before run that failed blocks its check, so the run is INCOMPLETE', () => {
  const c = run((d) => {
    side(d, 'before', { flags: OFF, results: [result('AB1', 'failed', { error: { code: 'LOCATOR_NOT_FOUND', message: 'no heading' } })] });
    side(d, 'after', { flags: ON, results: [result('AB1', 'passed')] });
  });
  assert.equal(c.overall, 'INCOMPLETE');
  assert.equal(c.checks[0].verdict, 'BLOCKED');
});

test('an after run that fails other than on the screenshot is BROKEN: REGRESSED', () => {
  const c = run((d) => {
    side(d, 'before', { flags: OFF, results: [result('AB1', 'passed', { tags: ['visual'] })] });
    side(d, 'after', { flags: ON, results: [result('AB1', 'failed', { tags: ['visual'], error: { code: 'LOCATOR_NOT_FOUND', message: 'no heading' } })] });
  });
  assert.equal(c.checks[0].verdict, 'BROKEN');
  assert.equal(c.overall, 'REGRESSED');
});

test('a screenshot that differs is CHANGED, unless the check is --intended', () => {
  const setup = (d) => {
    side(d, 'before', { flags: OFF, results: [result('AB1', 'passed', { tags: ['visual'] })] });
    side(d, 'check', { flags: OFF, results: [result('AB1', 'passed', { tags: ['visual'] })] });
    side(d, 'after', { flags: ON, results: [result('AB1', 'failed', { tags: ['visual'], error: mismatch, artifacts: [{ kind: 'screenshot', path: 'ab1/attempt-1/screenshots/AB1-settled-diff.png' }] })] });
  };
  const c = run(setup);
  assert.equal(c.checks[0].verdict, 'DIFFERENT');
  assert.equal(c.overall, 'CHANGED');
  assert.match(c.checks[0].diff[0], /AB1-settled-diff\.png$/);
  assert.equal(run(setup, '--intended', 'AB1').overall, 'SAME');
});

test('a screenshot that also differs in the noise check is UNSTABLE and never gates', () => {
  const c = run((d) => {
    side(d, 'before', { flags: OFF, results: [result('AB1', 'passed', { tags: ['visual'] })] });
    side(d, 'check', { flags: OFF, results: [result('AB1', 'failed', { tags: ['visual'], error: mismatch })] });
    side(d, 'after', { flags: ON, results: [result('AB1', 'failed', { tags: ['visual'], error: mismatch })] });
  });
  assert.equal(c.checks[0].verdict, 'UNSTABLE');
  assert.equal(c.overall, 'SAME');
});

test('a new app-log error is REGRESSED; a 401 or an error already there before is not', () => {
  const log = (text, source = 'network') => ({ source, level: 'error', text, at: '2026-10-25T00:00:00Z' });
  const c = run((d) => {
    side(d, 'before', { flags: OFF, results: [result('AB1', 'passed', { appLog: [log('GET /api/a 500 Internal Server Error')] })] });
    side(d, 'after', { flags: ON, results: [result('AB1', 'passed', { appLog: [log('GET /api/a 500 Internal Server Error'), log('GET /api/me 401 Unauthorized'), log('TypeError: x is undefined', 'error')] })] });
  });
  assert.deepEqual(c.newAppLogErrors, ['AB1 error: TypeError: x is undefined']);
  assert.equal(c.overall, 'REGRESSED');
});

test('failedRequests up is REGRESSED; a metric whose before runs disagree never gates', () => {
  const up = run((d) => {
    side(d, 'before', { flags: OFF, results: [result('AB2', 'passed')], vitals: [{ failedRequests: 0 }, { failedRequests: 0 }] });
    side(d, 'after', { flags: ON, results: [result('AB2', 'passed')], vitals: [{ failedRequests: 2 }, { failedRequests: 2 }] });
  });
  assert.equal(up.overall, 'REGRESSED');
  const noisy = run((d) => {
    side(d, 'before', { flags: OFF, results: [result('AB2', 'passed')], vitals: [{ cls: 0.0 }, { cls: 0.3 }] });
    side(d, 'after', { flags: ON, results: [result('AB2', 'passed')], vitals: [{ cls: 0.4 }, { cls: 0.4 }] });
  });
  const cls = noisy.metrics.find((m) => m.metric === 'cls');
  assert.equal(cls.stable, false);
  assert.equal(noisy.overall, 'SAME');
});

test('a metric expected to improve that stayed the same is NOT_IMPROVED', () => {
  const c = run((d) => {
    side(d, 'before', { flags: OFF, results: [result('AB2', 'passed')], vitals: [{ cls: 0.2 }] });
    side(d, 'after', { flags: ON, results: [result('AB2', 'passed')], vitals: [{ cls: 0.2 }] });
  }, '--expect-improved', 'cls');
  assert.equal(c.overall, 'NOT_IMPROVED');
});

test('timings are indicative on staging and n/a on a dev env', () => {
  const staging = run((d) => {
    side(d, 'before', { flags: OFF, results: [result('AB2', 'passed')], vitals: [{ loadToIdle: 2000 }] });
    side(d, 'after', { flags: ON, results: [result('AB2', 'passed')], vitals: [{ loadToIdle: 1000 }] });
  });
  const lt = staging.metrics.find((m) => m.metric === 'loadToIdle');
  assert.equal(lt.verdict, 'INDICATIVE');
  assert.equal(lt.deltaPct, -50);
  assert.equal(staging.overall, 'SAME');
  const env = run((d) => {
    side(d, 'before', { flags: OFF, target: 'env', results: [result('AB2', 'passed')], vitals: [{ loadToIdle: 2000 }] });
    side(d, 'after', { flags: ON, target: 'env', results: [result('AB2', 'passed')], vitals: [{ loadToIdle: 1000 }] });
  });
  assert.equal(env.metrics.find((m) => m.metric === 'loadToIdle').verdict, 'n/a');
});

test('a flag that did not flip, or was already on before, makes the run INCOMPLETE', () => {
  const pass = [result('AB1', 'passed')];
  const notFlipped = run((d) => { side(d, 'before', { flags: OFF, results: pass, seen: ['not-using-lab-flag'] }); side(d, 'after', { flags: ON, results: pass, seen: ['not-using-lab-flag'] }); });
  assert.equal(notFlipped.overall, 'INCOMPLETE');
  assert.match(notFlipped.problems.join(), /did not flip/);
  const alreadyOn = run((d) => { side(d, 'before', { flags: OFF, results: pass, seen: ['using-lab-flag'] }); side(d, 'after', { flags: ON, results: pass, seen: ['using-lab-flag'] }); });
  assert.match(alreadyOn.problems.join(), /already saw using-lab-flag/);
  const flipped = run((d) => { side(d, 'before', { flags: OFF, results: pass, seen: ['not-using-lab-flag'] }); side(d, 'after', { flags: ON, results: pass, seen: ['using-lab-flag'] }); });
  assert.equal(flipped.overall, 'SAME');
  assert.equal(flipped.flagProof['lab-flag'].proven, true);
  const backendOnly = run((d) => { side(d, 'before', { flags: OFF, results: pass, seen: [null] }); side(d, 'after', { flags: ON, results: pass, seen: [null] }); });
  assert.equal(backendOnly.overall, 'SAME');
  assert.equal(backendOnly.flagProof['lab-flag'].proven, false);
});
