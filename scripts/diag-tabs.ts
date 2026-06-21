/**
 * One-off diagnostic: log in as the bot and report the row + footer count for
 * EACH inbox tab (Planned / Active / Closed) so we can see WHERE jobs actually
 * are. Read-only — clicks tabs only, never accepts. Run with the bot stopped.
 */
import { config as loadDotenv } from 'dotenv';
import { chromium, type Frame, type Page } from 'playwright';

loadDotenv();

async function tabInfo(frame: Frame, label: string, tabSel: string): Promise<void> {
  try {
    await frame
      .locator(tabSel)
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await frame.waitForTimeout(2500);
    const state = await frame
      .locator('#tasksState')
      .first()
      .getAttribute('value')
      .catch(() => '?');
    const dataRows = await frame
      .locator('table#TaskListingTable tbody tr')
      .evaluateAll(
        (rows) =>
          rows.filter((r) => r.querySelector('button[data-testid="context-menu-button"]') !== null)
            .length,
      )
      .catch(() => -1);
    const footer =
      (await frame
        .locator('.itemsCount__itemCount--1BMuy, [class*="itemCount"]')
        .first()
        .textContent()
        .catch(() => null)) ?? '(no footer)';
    console.log(
      `  ${label.padEnd(8)} → tasksState=${state} | data-rows(with kebab)=${dataRows} | footer="${footer.trim()}"`,
    );
  } catch (e) {
    console.log(`  ${label.padEnd(8)} → ERROR ${e instanceof Error ? e.message : e}`);
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page: Page = await browser.newPage();
  await page.goto(process.env.XTM_ACOLAD_PORTAL_URL!, { waitUntil: 'networkidle' });
  await page.locator('#password').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#client').first().fill(process.env.XTM_ACOLAD_Company!);
  await page.locator('#username').first().fill(process.env.XTM_ACOLAD_Username!);
  await page.locator('#password').first().fill(process.env.XTM_ACOLAD_Password!);
  await page.waitForTimeout(400);
  await page.locator('.login-view button[type="submit"]').first().click();
  await page
    .waitForURL((u) => !/login\.jsp/i.test(u.toString()), { timeout: 25_000 })
    .catch(() => undefined);

  console.log(
    'logged in as:',
    process.env.XTM_ACOLAD_Username,
    '@',
    process.env.XTM_ACOLAD_Company,
  );
  await page
    .goto(process.env.XTM_ACOLAD_OFFERS_URL!, { waitUntil: 'networkidle' })
    .catch(() => undefined);
  const handle = await page.waitForSelector('#myInboxIframe', { timeout: 25_000 });
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('no inbox iframe');
  await page.waitForTimeout(3000);

  console.log('=== inbox tab counts (data rows = rows carrying the per-row kebab) ===');
  await tabInfo(frame, 'Planned', 'a[aria-controls="NEW_TASKS"]');
  await tabInfo(frame, 'Active', 'a[aria-controls="IN_PROGRESS"]');
  await tabInfo(frame, 'Closed', 'a[aria-controls="CLOSED_TASKS"]');

  // Dump the Closed rows' target language + due (col 7 + 8) to gauge recency/language.
  await frame
    .locator('a[aria-controls="CLOSED_TASKS"]')
    .first()
    .click({ timeout: 10_000 })
    .catch(() => undefined);
  await frame.waitForTimeout(2500);
  const closed = await frame.locator('table#TaskListingTable tbody tr').evaluateAll((rows) =>
    rows
      .filter((r) => r.querySelector('button[data-testid="context-menu-button"]') !== null)
      .map((r) => {
        const td = r.querySelectorAll('td');
        const t = (i: number): string => (td[i]?.textContent ?? '').trim().slice(0, 30);
        return { file: t(4), target: t(6), due: t(7), step: t(8) };
      }),
  );
  console.log('=== Closed rows (target | due | file) ===');
  for (const c of closed) console.log(`  ${c.target.padEnd(20)} | ${c.due.padEnd(20)} | ${c.file}`);
  const malay = closed.filter((c) => /malay/i.test(c.target)).length;
  console.log(`>> Malay in Closed: ${malay} / ${closed.length}`);

  await browser.close();
}

main().catch((e) => {
  console.error('diag failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
