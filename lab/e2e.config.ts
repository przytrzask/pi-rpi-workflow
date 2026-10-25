/**
 * Lab A/B e2e config. lab.sh copies this file into <dir>/project/ and writes lab.json beside it:
 *   { url, target, mr, viewport, timeoutMs, network: { mode }, allowHosts }
 * One target, named `lab`, on both sides, so the stored screenshots
 * (tests/<file>-snapshots/<name>-lab-<os>.png) written by the before run are the ones the after run
 * compares with. No model is configured: Lab A/B tests are deterministic.
 */
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { readFileSync } from 'node:fs';

const lab = JSON.parse(readFileSync(new URL('./lab.json', import.meta.url), 'utf8'));

export default {
  tests: 'tests/**/*.e2e.ts',
  targets: [{ name: 'lab', engine: web({ viewport: lab.viewport }), app: { url: lab.url } }],
  timeout: 240_000,
  assertionTimeout: lab.timeoutMs ?? 30_000,
} satisfies E2EConfig;
