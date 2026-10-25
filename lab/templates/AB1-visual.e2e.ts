import { expect } from 'e2e';
import { sleep, test } from '../lab.ts';

/**
 * Template: the view looks the same with the flag ON as with it OFF. Copy it to
 * <dir>/project/tests/AB<n>-visual.e2e.ts and change the ID, route, the state to reach and the masks.
 *
 * - The title starts with the ID; compare.mjs maps results to checks by that prefix.
 * - Keep the `visual` tag: lab.sh's noise check reruns only these tests with the flag still OFF.
 * - Mask what changes between runs on its own (dates, times, generated names). The org is the same
 *   throwaway org on both sides, so its own data stays put.
 * - One toHaveScreenshot per state that matters. It waits for two screenshots in a row that match.
 */
const ID = 'AB1';
const ROUTE = '/app/payroll';

test(`${ID}: ${ROUTE} looks the same once settled`, { session: 'pro', tags: ['visual'] }, async ({ app, screen }) => {
  await app.open(ROUTE);
  await expect(screen.getByRole('heading', { name: /payroll/i })).toBeVisible();
  await sleep(2_000); // let late requests land before comparing the settled state
  await expect(screen).toHaveScreenshot(`${ID}-settled`, {
    mask: [screen.getByTestId('current-date')],
    maxDiffPixelRatio: 0,
  });
});
