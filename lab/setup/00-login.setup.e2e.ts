import { expect } from 'e2e';
import { readFileSync } from 'node:fs';
import { sleep, test } from '../lab.ts';

/**
 * Restores the seeded pro's login and saves it as session `pro`; lab tests use `{ session: 'pro' }`.
 * The cookies come from verify-change's login-cookies.mjs (lab.sh seed), so no test types a secret:
 * e2e withholds screenshots for the rest of a session once one has been typed. lab.sh copies this
 * file into the project only when the run has a seeded login.
 */
test.setup('restore the seeded pro login', { sessions: ['pro'] }, async ({ app, browser, screen, session }) => {
  const { cookies } = JSON.parse(readFileSync(new URL('../.session-cookies.json', import.meta.url), 'utf8'));
  await browser.setCookies(cookies);
  await app.open('/app');
  await expect(screen.getByTestId('main-nav-home')).toBeVisible({ timeout: 90_000 });
  await sleep(2_000);
  await session.save('pro');
});
