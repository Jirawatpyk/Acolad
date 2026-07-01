/**
 * Confirm the post-accept false-negative diagnosis. captions.json was accepted live
 * (user-confirmed) but the bot reported "still acceptable". On a FRESH page load the
 * accepted row's menu should show "Finish task" (NOT "Accept task"), so
 * readAcceptAvailability must return FALSE for it. If it does, the bug was the re-read
 * reading a STALE (non-reloaded) frame — the reload fix is correct.
 * Run with the bot STOPPED.
 */
import { chromium } from 'playwright';
import { config as loadDotenv } from 'dotenv';
import { readAcceptAvailability } from '../dist/portal/xtmAccept.js';
import { computeXtmJobKey } from '../dist/detection/jobKey.js';

loadDotenv();

// projectName is now part of the key (collision fix 2026-06-30). Fail loud if it is missing:
// `?? ''` would compute a wrong empty-project key that never matches the live DOM, and the script
// would blame "row matching" for what is really a missing env var.
if (!process.env.VERIFY_PROJECT) {
  console.error(
    'VERIFY_PROJECT is required — set it to the exact project name in the XTM Project column ' +
      'for this job (projectName is part of the key since the 2026-06-30 collision fix).',
  );
  process.exit(1);
}
const KEY = computeXtmJobKey({
  projectName: process.env.VERIFY_PROJECT,
  fileName: '4716302-1-19 (ID-b2cf8d0d04bd)_captions.json',
  step: 'Post-Editing (PE) 1',
  role: 'Corrector',
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(process.env.XTM_ACOLAD_PORTAL_URL, { waitUntil: 'networkidle' });
  await page.locator('#password').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#client').first().fill(process.env.XTM_ACOLAD_Company);
  await page.locator('#username').first().fill(process.env.XTM_ACOLAD_Username);
  await page.locator('#password').first().fill(process.env.XTM_ACOLAD_Password);
  await page.waitForTimeout(400);
  await page.locator('.login-view button[type="submit"]').first().click();
  await page
    .waitForURL((u) => !/login\.jsp/i.test(u.toString()), { timeout: 25_000 })
    .catch(() => undefined);

  await page.goto(process.env.XTM_ACOLAD_OFFERS_URL, { waitUntil: 'networkidle' });
  const handle = await page.waitForSelector('#myInboxIframe', { timeout: 25_000 });
  const frame = await handle.contentFrame();
  await frame
    .locator('table#TaskListingTable thead')
    .first()
    .waitFor({ state: 'attached', timeout: 20_000 })
    .catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);

  // Dump each Active data row's menu item ids (Accept vs Finish) on this FRESH load.
  const rows = frame.locator('table#TaskListingTable tbody tr');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const kebab = row.locator('button[data-testid="context-menu-button"]').first();
    if ((await kebab.count()) === 0) continue;
    const file = (await row.locator('td:nth-child(5)').first().textContent())?.trim() ?? '';
    await kebab.click({ timeout: 10_000 }).catch(() => undefined);
    await frame
      .locator('[data-dropdown-menu="true"]')
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 })
      .catch(() => undefined);
    const ids = await frame
      .locator('li[id^="TASK_LISTING_"]')
      .evaluateAll((els) => els.map((e) => e.id.replace(/_\d+$/, '')))
      .catch(() => []);
    const hasAccept = ids.some((x) => x.startsWith('TASK_LISTING_ACCEPT_GROUP_TASK'));
    const hasFinish = ids.some((x) => /FINISH/i.test(x));
    console.log(`row "${file.slice(0, 45)}" → Accept=${hasAccept} Finish=${hasFinish}`);
    console.log(`   ids: ${ids.join(', ')}`);
    await page.keyboard.press('Escape').catch(() => undefined);
  }

  // Forward drift observers: if the target row has an empty project cell (the very drift the
  // collision fix guards), surface the structured WARN + evidence signal here too — otherwise this
  // diagnostic would silently omit the one signal that matters most when a row fails to match.
  const avail = await readAcceptAvailability(frame, page, new Set([KEY]), {
    logger: { warn: (obj, msg) => console.warn('[drift]', msg ?? '', obj) },
    captureEvidence: async (reason) => {
      console.warn('[evidence needed]', reason);
      return undefined;
    },
  });
  const v = avail.get(KEY);
  console.log(`\nreadAcceptAvailability(captions accepted job) = ${v}`);
  console.log(
    v === false
      ? '✅ CONFIRMED: fresh read returns false (accepted) → the bug was the STALE re-read; reload fix is correct'
      : v === undefined
        ? '⚠️ row not matched on fresh load — investigate row matching'
        : '⚠️ fresh read STILL true — readAcceptAvailability/selector issue, not staleness',
  );
} finally {
  await browser.close();
}
