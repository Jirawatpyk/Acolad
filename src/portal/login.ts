import type { Page } from 'playwright';
import { SELECTORS } from './selectors.js';
import { CaptchaDetectedError, LoginFailedError } from './errors.js';
import { hasChallenge, isLoggedOut } from './jobList.js';

export interface Credentials {
  portalUrl: string;
  email: string;
  password: string;
}

/**
 * Perform the portal login flow (FR-001). Detects CAPTCHA/2FA and refuses to
 * proceed (CaptchaDetectedError — no auto-bypass). Throws LoginFailedError when
 * the login form is still present after submitting (credentials rejected).
 */
export async function performLogin(page: Page, creds: Credentials): Promise<void> {
  await page.goto(creds.portalUrl, { waitUntil: 'domcontentloaded' });
  // Let the SPA render the login form (or restore an authenticated view).
  await page
    .locator(SELECTORS.login.password)
    .first()
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => undefined);

  if (await hasChallenge(page)) {
    throw new CaptchaDetectedError('CAPTCHA/2FA challenge present on login page');
  }

  // The presence of the password field is the reliable "on the login page"
  // marker (the portal is a React app with no stable <form> attributes). If it
  // is absent and we are not logged out, an existing session is already active.
  if (!(await isLoggedOut(page))) return;

  await page.locator(SELECTORS.login.email).first().fill(creds.email);
  await page.locator(SELECTORS.login.password).first().fill(creds.password);
  // Verified SPA quirk: the React controlled inputs need a tick to commit before
  // the submit handler reads the form state — clicking immediately submits empty
  // and we stay on the login page. A short settle makes the submit reliable.
  await page.waitForTimeout(500);
  await page.locator(SELECTORS.login.submit).first().click();

  // The portal is a SPA: a successful login client-side-routes away from the
  // login URL. Wait for the URL to leave login, then settle. A timeout means we
  // are still on the login page → failed login below.
  await page
    .waitForURL((u) => !/login/i.test(u.toString()), { timeout: 20_000 })
    .catch(() => undefined);
  await page
    .locator(SELECTORS.login.password)
    .first()
    .waitFor({ state: 'detached', timeout: 5_000 })
    .catch(() => undefined);

  if (await hasChallenge(page)) {
    throw new CaptchaDetectedError('CAPTCHA/2FA challenge presented after submitting credentials');
  }
  if (await isLoggedOut(page)) {
    throw new LoginFailedError('still on login page after submitting credentials');
  }
}
