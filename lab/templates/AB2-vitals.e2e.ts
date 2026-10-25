import { expect } from 'e2e';
import { recordFlag, sleep, startVitals, test, vitals } from '../lab.ts';

/**
 * Template: the signals the diagnosis targets, measured the same way on both sides. Copy it to
 * <dir>/project/tests/AB<n>-vitals.e2e.ts and change the ID, route, the ready condition and, for INP,
 * the interaction.
 *
 * - startVitals before app.open, so the page is observed from its first paint.
 * - Wait for the same "loaded" state on both sides before reading, then read once.
 * - lab.sh runs every test --repeat times per side; compare.mjs compares the medians.
 * - recordFlag proves which variant the page got; compare.mjs refuses a run whose flag didn't flip.
 * - Assert nothing about the numbers here: the comparison is compare.mjs's job, and a test that
 *   fails on a number hides the run line it should have written.
 */
const ID = 'AB2';
const ROUTE = '/app/payroll';
const FLAG = 'payroll-example-kill-switch'; // the gardener's flag for this change

test(`${ID}: ${ROUTE} vitals`, { session: 'pro' }, async ({ app, browser, screen }) => {
  await startVitals(browser);
  await app.open(ROUTE);
  await expect(screen.getByRole('heading', { name: /payroll/i })).toBeVisible();
  await sleep(3_000); // the same settle window on both sides
  // For INP: one scripted interaction, the one the diagnosis names, e.g.
  // await screen.getByRole('button', { name: 'Run payroll' }).tap(); await sleep(1_000);
  await vitals(browser, ID);
  await recordFlag(browser, FLAG); // proves the side got the variant it claims
});
