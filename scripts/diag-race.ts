/**
 * Discriminator: does reading the grid the BOT's way (domcontentloaded + wait only
 * for the grid marker, then read immediately) miss rows compared to reading the
 * SETTLED way (networkidle + 3s, like diag-tabs)? Tests on the populated Closed tab
 * (19 rows) so NO fresh Malay job is needed.
 *
 *   fast == slow (both 19) → the bot's read is NOT racy → rule OUT the timing race,
 *                            the miss is structural (wrong tab / view / account).
 *   fast  < slow (0 vs 19) → the bot reads before XHR rows arrive → race CONFIRMED.
 *
 * Read-only (clicks tabs only, never accepts). Run with the bot STOPPED.
 */
import { config as loadDotenv } from 'dotenv';
import { chromium, type Frame, type Page } from 'playwright';

loadDotenv();

const KEBAB = 'button[data-testid="context-menu-button"]';

async function countRows(frame: Frame): Promise<number> {
  return frame
    .locator('table#TaskListingTable tbody tr')
    .evaluateAll((rows, sel) => rows.filter((r) => r.querySelector(sel) !== null).length, KEBAB)
    .catch(() => -1);
}

async function login(page: Page): Promise<void> {
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
}

async function getFrame(page: Page): Promise<Frame> {
  const handle = await page.waitForSelector('#myInboxIframe', { timeout: 25_000 });
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('no inbox iframe');
  return frame;
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await login(page);
  console.log(
    'logged in as:',
    process.env.XTM_ACOLAD_Username,
    '@',
    process.env.XTM_ACOLAD_Company,
  );

  for (let i = 1; i <= 3; i++) {
    // Fresh full navigation each round, exactly like the bot's fetchJobSnapshot.
    await page.goto(process.env.XTM_ACOLAD_OFFERS_URL!, { waitUntil: 'domcontentloaded' });
    const frame = await getFrame(page);

    // Switch to the populated Closed tab (XHR-loads its rows).
    await frame
      .locator('a[aria-controls="CLOSED_TASKS"]')
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);

    // BOT-STYLE FAST: wait only for the grid marker (thead) to be attached, then read
    // immediately — no networkidle, no fixed settle. This is what fetchJobSnapshot does.
    await frame
      .locator('table#TaskListingTable thead')
      .first()
      .waitFor({ state: 'attached', timeout: 20_000 })
      .catch(() => undefined);
    const fast = await countRows(frame);
    // What does the DOM look like at the racing (rows=0) moment? — to pick a safe
    // "data loaded" signal (footer present? "0 of 0"? any tr at all? spinner?).
    const fastState = await frame
      .evaluate(() => {
        const footerEl = document.querySelector('[class*="itemCount"]');
        const tbody = document.querySelector('table#TaskListingTable tbody');
        const spinner = document.querySelector(
          '[class*="spinner"],[class*="loading"],[class*="loader"],.mat-spinner',
        );
        return {
          footer: footerEl ? (footerEl.textContent ?? '').trim() : '(no footer el)',
          totalTr: tbody ? tbody.querySelectorAll('tr').length : -1,
          spinner: spinner ? spinner.className || spinner.tagName : '(none)',
        };
      })
      .catch(() => ({ footer: '?', totalTr: -1, spinner: '?' }));

    // CANDIDATE FIX SIGNAL: networkidle ONLY (no fixed settle) — is it enough?
    await page.waitForLoadState('networkidle').catch(() => undefined);
    const nidle = await countRows(frame);

    // SETTLED SLOW: networkidle + a fixed settle, like diag-tabs (belt & suspenders).
    await frame.waitForTimeout(3000);
    const slow = await countRows(frame);

    const footer =
      (await frame
        .locator('[class*="itemCount"]')
        .first()
        .textContent()
        .catch(() => null)) ?? '(none)';
    console.log(
      `round ${i}: Closed fast(thead)=${fast} | networkidle=${nidle} | slow(+3s)=${slow} | footer(settled)="${footer.trim()}"  ${
        nidle === slow && slow > 0 ? '→ networkidle SUFFICIENT' : '→ check'
      }`,
    );
    console.log(
      `         AT RACE MOMENT (rows=${fast}): footer="${fastState.footer}" | totalTr=${fastState.totalTr} | spinner=${fastState.spinner}`,
    );

    // Reset to Active for the next round's fresh goto.
    await page.waitForTimeout(500);
  }

  await browser.close();
}

main().catch((e) => {
  console.error('diag-race failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
