import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { isXtmLoggedOut, hasXtmChallenge } from '../../src/portal/xtmLogin.js';
import { xtmLoginPage, xtmLoggedInPage, xtmChallengePage } from '../fixtures/xtmPages.js';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  page = await browser.newPage();
});
afterEach(async () => {
  await page.close();
});

describe('XTM login detection helpers', () => {
  it('detects the logged-out login shell (body.loginPage / xtm.login app)', async () => {
    await page.setContent(xtmLoginPage());
    expect(await isXtmLoggedOut(page)).toBe(true);
  });

  it('reports logged-in on the authenticated inbox shell', async () => {
    await page.setContent(xtmLoggedInPage());
    expect(await isXtmLoggedOut(page)).toBe(false);
  });

  it('flags a CAPTCHA/2FA challenge (no auto-bypass)', async () => {
    await page.setContent(xtmChallengePage());
    expect(await hasXtmChallenge(page)).toBe(true);
  });

  it('does not flag a challenge on a normal login page', async () => {
    await page.setContent(xtmLoginPage());
    expect(await hasXtmChallenge(page)).toBe(false);
  });
});
