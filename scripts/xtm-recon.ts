/**
 * XTM recon tool (T005, contracts/xtm-portal-adapter.md).
 *
 * Captures real evidence from XTM Cloud so selectors.ts (T012) and the D1–D8
 * discovery items in research.md can be confirmed against production HTML —
 * BEFORE any auto-accept logic is finalized (evidence-first).
 *
 * SAFETY:
 *   - Gated behind LIVE_PORTAL=1 — refuses to run otherwise (never in CI).
 *   - Opens the Accept menu but NEVER clicks the confirm/accept action.
 *   - Evidence is sanitized: no credential values, no cookies/tokens, request
 *     URLs are logged path-only (query string stripped).
 *
 * Self-contained on purpose (only playwright + dotenv + node) so it compiles
 * with a one-file `tsc` invocation (see package.json "xtm:recon"); it does not
 * pull in the src/ module graph.
 *
 * Run:  $env:LIVE_PORTAL='1'; npm run xtm:recon     (supervised, on the bot host)
 *       set RECON_HEADLESS=1 to run headless.
 */
import { config as loadDotenv } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type Frame, type Browser } from 'playwright';

type Scope = Page | Frame;

loadDotenv();

interface NetEntry {
  phase: 'request' | 'response';
  method: string;
  url: string; // query stripped
  status?: number;
  resourceType?: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`[recon] missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

/** Strip the query string so session tokens are never written to evidence. */
function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?[stripped]`;
}

/** Try each selector; fill the first one that is present+visible. Returns ok. */
async function fillFirst(scope: Scope, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    const loc = scope.locator(sel).first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.fill(value, { timeout: 5_000 });
        return true;
      }
    } catch {
      // try next candidate
    }
  }
  return false;
}

async function clickFirst(scope: Scope, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const loc = scope.locator(sel).first();
    try {
      if ((await loc.count()) > 0 && (await loc.isVisible())) {
        await loc.click({ timeout: 5_000 });
        return true;
      }
    } catch {
      // try next candidate
    }
  }
  return false;
}

/** Dump a frame's rendered HTML (the task grid lives in #myInboxIframe). */
async function dumpFrameHtml(frame: Frame | null, dir: string, name: string): Promise<void> {
  if (!frame) {
    console.log(`[recon] ${name}: iframe not available`);
    return;
  }
  try {
    await frame.waitForLoadState('networkidle').catch(() => undefined);
    writeFileSync(join(dir, `${name}.html`), await frame.content(), 'utf8');
    console.log(`[recon] captured ${name} (iframe content)`);
  } catch (err) {
    console.warn(`[recon] dump ${name} failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Resolve the My-inbox iframe (the legacy .action task list), if present. */
async function inboxFrame(page: Page): Promise<Frame | null> {
  try {
    const handle = await page.waitForSelector('#myInboxIframe', { timeout: 15_000 });
    return await handle.contentFrame();
  } catch {
    return null;
  }
}

/**
 * D4 capture: open a real row's kebab menu, then HOVER "Accept task" to expand
 * its submenu, capturing the DOM at each step. SAFETY: clicks ONLY the kebab
 * (opens the menu, no action) and HOVERS the "Accept task" parent (expands the
 * submenu, no action). It NEVER clicks an "Accept this/all ..." option — so no
 * task is ever accepted on the shared account.
 */
async function captureAcceptMenu(page: Page, dir: string): Promise<void> {
  const frame = await inboxFrame(page);
  if (!frame) {
    console.log('[recon] accept-menu: no inbox frame');
    return;
  }
  try {
    const kebab = frame.locator('button[data-testid="context-menu-button"]').first();
    if ((await kebab.count()) === 0) {
      console.log('[recon] accept-menu: no kebab button (Active empty?)');
      return;
    }
    await kebab.click({ timeout: 5_000 }); // opens the row menu — safe, no action
    await page.waitForTimeout(700);
    // The menu may render in the iframe document or a top-document portal — dump both.
    await dumpFrameHtml(frame, dir, '07-accept-menu-iframe');
    writeFileSync(join(dir, '07-accept-menu-page.html'), await page.content(), 'utf8');
    await snapshot(page, dir, '07-accept-menu-fullpage');

    // Expand the "Accept task" submenu by HOVER only (exact text → never an action item).
    let hovered = false;
    for (const scope of [frame, page] as Scope[]) {
      const item = scope.getByText('Accept task', { exact: true }).first();
      try {
        if ((await item.count()) > 0) {
          await item.hover({ timeout: 5_000 });
          hovered = true;
          break;
        }
      } catch {
        // try next scope
      }
    }
    if (hovered) {
      await page.waitForTimeout(800);
      await dumpFrameHtml(frame, dir, '07b-accept-submenu-iframe');
      writeFileSync(join(dir, '07b-accept-submenu-page.html'), await page.content(), 'utf8');
      await snapshot(page, dir, '07b-accept-submenu-fullpage');
      console.log('[recon] captured Accept submenu (hover only — NO accept performed)');
    } else {
      console.log(
        '[recon] accept-menu: "Accept task" not found by exact text — captured top menu only',
      );
    }
  } catch (err) {
    console.warn(`[recon] accept-menu failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    await page.keyboard.press('Escape').catch(() => undefined); // close menu, no action
  }
}

async function snapshot(page: Page, dir: string, name: string): Promise<void> {
  try {
    writeFileSync(join(dir, `${name}.html`), await page.content(), 'utf8');
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
    console.log(`[recon] captured ${name}`);
  } catch (err) {
    console.warn(`[recon] capture ${name} failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function main(): Promise<void> {
  if (process.env.LIVE_PORTAL !== '1') {
    console.error('[recon] refused: set LIVE_PORTAL=1 to run against the real portal.');
    process.exit(2);
  }

  const portalUrl = requireEnv('XTM_ACOLAD_PORTAL_URL');
  const offersUrl = requireEnv('XTM_ACOLAD_OFFERS_URL');
  const company = requireEnv('XTM_ACOLAD_Company');
  const username = requireEnv('XTM_ACOLAD_Username');
  const password = requireEnv('XTM_ACOLAD_Password');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(process.env.STATE_DIR ?? 'state', 'evidence', `xtm-recon-${stamp}`);
  mkdirSync(dir, { recursive: true });
  console.log(`[recon] evidence dir: ${dir}`);

  const net: NetEntry[] = [];
  const headless = process.env.RECON_HEADLESS === '1';
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless, channel: 'chromium' });
    const context = await browser.newContext();
    context.setDefaultNavigationTimeout(30_000);
    context.setDefaultTimeout(10_000);
    const page = await context.newPage();

    page.on('request', (r) =>
      net.push({
        phase: 'request',
        method: r.method(),
        url: stripQuery(r.url()),
        resourceType: r.resourceType(),
      }),
    );
    page.on('response', (r) =>
      net.push({
        phase: 'response',
        method: r.request().method(),
        url: stripQuery(r.url()),
        status: r.status(),
      }),
    );

    // 1) Login page (D3 — login field selectors)
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded' });
    await snapshot(page, dir, '01-login');

    // 2) Best-effort login (selectors unconfirmed — candidates only)
    const filledCompany = await fillFirst(
      page,
      [
        '#j_company',
        'input[name="companyName"]',
        'input[name="j_company"]',
        'input[name="company"]',
        '#company',
      ],
      company,
    );
    const filledUser = await fillFirst(
      page,
      [
        '#j_username',
        'input[name="userId"]',
        'input[name="userName"]',
        'input[name="j_username"]',
        'input[name="username"]',
        '#username',
      ],
      username,
    );
    const filledPass = await fillFirst(
      page,
      [
        '#j_password',
        'input[type="password"]',
        'input[name="password"]',
        'input[name="j_password"]',
      ],
      password,
    );
    console.log(
      `[recon] login fields filled — company:${filledCompany} user:${filledUser} pass:${filledPass}`,
    );
    await clickFirst(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      '#loginButton',
      'button:has-text("Log in")',
      'button:has-text("Login")',
    ]);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await snapshot(page, dir, '02-after-login');

    // 3) Tasks page (D1) — the inbox is iframe#myInboxIframe (my-inbox-start.action),
    //    which exposes three tabs: NEW_TASKS (accept target), IN_PROGRESS, CLOSED_TASKS.
    await page.goto(offersUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await snapshot(page, dir, '03-tasks-outer');
    await page.waitForTimeout(2_000);
    await dumpFrameHtml(await inboxFrame(page), dir, '03b-inbox-default');

    // 4) Capture each tab grid (D1 columns + D6 accept-available marker + D8 Closed).
    const tabs: { name: string; href: string }[] = [
      { name: '04-new', href: 'my-inbox-new-tasks-page.action' },
      { name: '05-in-progress', href: 'my-inbox-in-progress-tasks-page.action' },
      { name: '06-closed', href: 'my-inbox-closed-tasks-page.action' },
    ];
    for (const tab of tabs) {
      const frame = await inboxFrame(page);
      if (!frame) {
        console.log(`[recon] ${tab.name}: no inbox frame`);
        continue;
      }
      const clicked = await clickFirst(frame, [
        `a[href="${tab.href}"]`,
        `a[aria-controls="${tab.name.includes('new') ? 'NEW_TASKS' : tab.name.includes('closed') ? 'CLOSED_TASKS' : 'IN_PROGRESS'}"]`,
      ]);
      if (!clicked) {
        console.log(`[recon] ${tab.name}: tab link not found`);
        continue;
      }
      await page.waitForTimeout(2_500);
      await dumpFrameHtml(await inboxFrame(page), dir, `${tab.name}-iframe`);
      await snapshot(page, dir, `${tab.name}-fullpage`);

      // On the ACTIVE (in-progress) tab, capture the Accept menu DOM from a real
      // row — kebab click + "Accept task" hover only (D4). No accept is performed.
      if (tab.name.includes('in-progress')) {
        await captureAcceptMenu(page, dir);
      }
    }

    writeFileSync(join(dir, 'network.json'), JSON.stringify(net, null, 2), 'utf8');
    writeFileSync(
      join(dir, 'README.txt'),
      [
        'XTM recon evidence — confirm these against research.md D1–D8:',
        ' D1  Active list URL + the row/column selectors (project/file/source/target/due/words/step/role)',
        ' D2  Stable file identity for the job_key composite (fileId|step|role)',
        ' D3  Login field selectors (company/username/password) + submit',
        ' D4  "Accept all for language in this group" path + the readable success signal',
        ' D5  Exact target-language string for Malay (e.g. "Malay (Malaysia)")',
        ' D6  acceptAvailable marker (free vs already-taken)',
        ' D7  Sheets tab/gid mapping (separate — Google side)',
        ' D8  Closed list URL (Closed vs Removed)',
        '',
        'Files: 01-login, 02-after-login, 03-active, 04-accept-menu, 05-closed (.html + .png), network.json',
        'NOTE: query strings stripped from network.json; no cookies/credentials captured.',
      ].join('\n'),
      'utf8',
    );
    console.log(`[recon] done. Review evidence in ${dir}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[recon] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
