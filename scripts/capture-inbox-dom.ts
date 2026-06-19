/**
 * Diagnostic: log in and dump the INSIDE of the inbox iframe (#myInboxIframe),
 * where the task grid lives. The bot's evidence capture only serializes the outer
 * page, so the grid markers (table / state input / tabs) never appear there. This
 * fills the three real login fields by id and dumps the frame's structure so the
 * Active-grid selectors can be confirmed. Never logs credentials.
 */
import { config as loadDotenv } from 'dotenv';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

loadDotenv();

async function main(): Promise<void> {
  const loginUrl = process.env.XTM_ACOLAD_PORTAL_URL!;
  const inboxUrl = process.env.XTM_ACOLAD_OFFERS_URL!;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.goto(loginUrl, { waitUntil: 'networkidle' });
  await page.locator('#password').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#client').first().fill(process.env.XTM_ACOLAD_Company!);
  await page.locator('#username').first().fill(process.env.XTM_ACOLAD_Username!);
  await page.locator('#password').first().fill(process.env.XTM_ACOLAD_Password!);
  await page.waitForTimeout(400);
  await page.locator('.login-view button[type="submit"]').first().click();
  await page
    .waitForURL((u) => !/login\.jsp/i.test(u.toString()), { timeout: 25_000 })
    .catch(() => undefined);

  await page.goto(inboxUrl, { waitUntil: 'networkidle' }).catch(() => undefined);
  const handle = await page.waitForSelector('#myInboxIframe', { timeout: 25_000 });
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('#myInboxIframe has no content frame');
  // Let the grid inside the iframe render.
  await page.waitForTimeout(4000);

  const info = await frame.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table')).map((t) => ({
      id: t.id || null,
      cls: t.className || null,
      rows: t.querySelectorAll('tr').length,
    }));
    const stateInputs = Array.from(
      document.querySelectorAll('input[id*="tate" i], input[id*="task" i], input[type="hidden"]'),
    )
      .slice(0, 20)
      .map((i) => ({
        id: i.getAttribute('id'),
        name: i.getAttribute('name'),
        value: i.getAttribute('value'),
      }));
    const tabs = Array.from(
      document.querySelectorAll('[aria-controls], [role="tab"], .tab, a[ng-click*="ab" i]'),
    )
      .slice(0, 15)
      .map((e) => ({
        tag: e.tagName.toLowerCase(),
        ariaControls: e.getAttribute('aria-controls'),
        text: (e.textContent || '').trim().slice(0, 30),
      }));
    return {
      tables,
      stateInputs,
      tabs,
      kebabCount: document.querySelectorAll('[data-testid="context-menu-button"]').length,
      bodyLen: document.body.innerHTML.length,
    };
  });

  const dir = join('state', 'evidence', 'inbox-dom-capture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'inbox-frame.html'), await frame.content(), 'utf8');
  console.log('=== INBOX IFRAME structure ===');
  console.log(JSON.stringify(info, null, 2));
  console.log(`\nsaved iframe HTML to ${dir}/inbox-frame.html`);
  await browser.close();
}

main().catch((e) => {
  console.error('capture failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
