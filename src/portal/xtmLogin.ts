import type { Page } from 'playwright';
import { XTM } from './selectors.js';
import { CaptchaDetectedError, LoginFailedError } from './errors.js';

export interface XtmCredentials {
  loginUrl: string;
  company: string;
  username: string;
  password: string;
}

/**
 * True when the outer page shows the XTM login shell — used to detect both an
 * initial logged-out state and a mid-run session expiry. After a successful
 * login the body is `#root.xtm-app` (no `loginPage` class / `xtm.login` app),
 * so this never false-positives on the inbox.
 */
export async function isXtmLoggedOut(page: Page): Promise<boolean> {
  return (await page.locator(XTM.session.loggedOutShell).count()) > 0;
}

/** True when XTM demands human verification (CAPTCHA/2FA) — never auto-bypassed. */
export async function hasXtmChallenge(page: Page): Promise<boolean> {
  return (await page.locator(XTM.challenge).count()) > 0;
}

/**
 * Perform the XTM login flow (AngularJS SPA, contracts/xtm-portal-adapter.md).
 * The rendered form has THREE visible fields — company (client), username,
 * password — all empty; all three are typed (the client field is NOT pre-filled).
 * A successful login client-side routes away from login.jsp to the inbox; staying
 * on the login page means the credentials were rejected (LoginFailedError). A
 * challenge at any point stops the flow.
 *
 * Idempotent: if called when already authenticated it returns immediately.
 */
export async function performXtmLogin(page: Page, creds: XtmCredentials): Promise<void> {
  await page.goto(creds.loginUrl, { waitUntil: 'domcontentloaded' });
  // Let the SPA render the login form (the ui-view template loads via XHR).
  await page
    .locator(XTM.login.password)
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => undefined);

  if (await hasXtmChallenge(page)) {
    throw new CaptchaDetectedError('CAPTCHA/2FA challenge present on the XTM login page');
  }

  // Already authenticated (no login shell) — nothing to do.
  if (!(await isXtmLoggedOut(page))) return;

  await page.locator(XTM.login.client).first().fill(creds.company);
  await page.locator(XTM.login.username).first().fill(creds.username);
  await page.locator(XTM.login.password).first().fill(creds.password);
  // AngularJS controlled inputs need a tick to commit before the submit handler
  // reads form state (same SPA quirk as the partner portal).
  await page.waitForTimeout(400);
  await page.locator(XTM.login.submit).first().click();

  // Success client-side routes off login.jsp; a timeout here means we never left.
  await page
    .waitForURL((u) => !/login\.jsp/i.test(u.toString()), { timeout: 20_000 })
    .catch(() => undefined);
  await page
    .locator(XTM.login.password)
    .first()
    .waitFor({ state: 'detached', timeout: 5_000 })
    .catch(() => undefined);

  if (await hasXtmChallenge(page)) {
    throw new CaptchaDetectedError('CAPTCHA/2FA challenge after submitting XTM credentials');
  }
  if (await isXtmLoggedOut(page)) {
    throw new LoginFailedError('still on the XTM login page after submitting credentials');
  }
}
