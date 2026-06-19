/**
 * Diagnostic: capture the REAL rendered XTM login form (the .login-view template
 * loads via XHR after the shell). Navigates only — never types or submits, so it
 * adds zero login attempts (no shared-account lockout risk). Dumps every VISIBLE
 * input/button so the username/password field mapping can be confirmed.
 */
import { config as loadDotenv } from 'dotenv';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

loadDotenv();

async function main(): Promise<void> {
  const url = process.env.XTM_ACOLAD_PORTAL_URL;
  if (!url) throw new Error('XTM_ACOLAD_PORTAL_URL not set');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  // Give the AngularJS ui-view XHR template time to render the real form.
  await page
    .locator('.login-view input[type="password"]:visible, input[type="password"]:visible')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);

  // Extract visible field metadata only (no values — fields are empty).
  const fields = await page.evaluate(() => {
    const vis = (el: Element): boolean => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el as HTMLElement);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const pick = (el: Element) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.getAttribute('id'),
      ngModel: el.getAttribute('ng-model'),
      placeholder: el.getAttribute('placeholder'),
      ariaLabel: el.getAttribute('aria-label'),
      dataTest: el.getAttribute('data-test'),
      autocomplete: el.getAttribute('autocomplete'),
    });
    const els = Array.from(document.querySelectorAll('input, button, [type="submit"]'));
    return {
      visible: els.filter(vis).map(pick),
      hiddenInputCount: els.filter((e) => !vis(e)).length,
      bodyClass: document.body.className,
      loginViewHtmlLen: (document.querySelector('.login-view')?.innerHTML ?? '').length,
    };
  });

  const dir = join('state', 'evidence', 'login-dom-capture');
  mkdirSync(dir, { recursive: true });
  const html = await page.content();
  writeFileSync(join(dir, 'rendered-login.html'), html, 'utf8');
  await page.screenshot({ path: join(dir, 'login.png'), fullPage: true }).catch(() => undefined);

  console.log('=== VISIBLE form fields (no values) ===');
  console.log(JSON.stringify(fields, null, 2));
  console.log(`\nsaved rendered HTML + screenshot to ${dir}`);
  await browser.close();
}

main().catch((e) => {
  console.error('capture failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
