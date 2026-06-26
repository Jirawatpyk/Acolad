/**
 * XTM logout-rendering recon (auto-yield design spike).
 *
 * Answers the load-bearing question the auto-yield design rests on (see
 * docs/superpowers/specs/2026-06-26-xtm-auto-yield-design.md, review findings
 * Critical #2 / Playwright B+D): when a SECOND login on the shared account kicks
 * the first session, what does the kicked session SEE on its next navigation?
 *
 *   (a) TOP-LEVEL redirect  → body becomes the login shell, #myInboxIframe gone
 *       → isXtmLoggedOut() (reads the OUTER page) returns TRUE → the bot detects
 *         the kick → SessionYieldError path works as designed.
 *   (b) IN-IFRAME login     → outer page stays #root.xtm-app, the login form
 *       renders INSIDE #myInboxIframe → isXtmLoggedOut() returns FALSE → the read
 *         throws LayoutChangedError (classified) → the bot mis-pages instead of
 *         yielding → the design needs an extra logged-out guard.
 *
 * Also validates:
 *   - latest-login-wins (B's login kicks A) — the whole yield premise.
 *   - navigate-only does NOT kick (after A is kicked, navigating A does not in
 *     turn kick B) — assumption A in the review.
 *
 * SAFETY:
 *   - Gated behind LIVE_PORTAL=1 — refuses to run otherwise (never in CI).
 *   - Logs in TWICE on the SHARED account → it WILL kick a real human session.
 *     Run ONLY when no teammate is using XTM, and with the bot STOPPED
 *     (otherwise the bot's 20s poll re-login interferes).
 *   - NEVER accepts a task. Login + navigate + read-only DOM probes only.
 *   - Evidence is sanitized (credentials redacted, query strings stripped).
 *
 * Self-contained (only playwright + dotenv + node) so it compiles with the same
 * one-file tsc invocation as xtm-recon (see package.json "xtm:recon-logout").
 *
 * Run:  $env:LIVE_PORTAL='1'; npm run xtm:recon-logout      (bot stopped, supervised)
 *       set RECON_HEADLESS=1 to run headless.
 */
import { config as loadDotenv } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page, type Browser, type BrowserContext } from 'playwright';

loadDotenv();

const SECRETS = [
  process.env.XTM_ACOLAD_Password,
  process.env.XTM_ACOLAD_Username,
  process.env.XTM_ACOLAD_Company,
].filter((s): s is string => Boolean(s));

/** Redact credential values + token inputs before writing evidence HTML. */
function sanitize(html: string): string {
  let out = html.replace(/<input\b[^>]*>/gi, (tag) =>
    /type=["'](?:password|email)["']/i.test(tag) ||
    /(?:id|name|ng-model)=["'][^"']*(?:uust|xcbid|password|token|csrf|session|cookie)[^"']*["']/i.test(
      tag,
    )
      ? tag.replace(/(\bvalue=["'])[^"']*(["'])/i, '$1[REDACTED]$2')
      : tag,
  );
  for (const s of SECRETS) out = out.split(s).join('[REDACTED]');
  return out;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`[recon] missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

const env = {
  portalUrl: '',
  offersUrl: '',
  company: '',
  username: '',
  password: '',
};

/** The bot's exact login flow (selectors confirmed live in scripts/diag-race.ts). */
async function login(page: Page): Promise<void> {
  await page.goto(env.portalUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#password').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('#client').first().fill(env.company);
  await page.locator('#username').first().fill(env.username);
  await page.locator('#password').first().fill(env.password);
  await page.waitForTimeout(400);
  await page.locator('.login-view button[type="submit"]').first().click();
  await page
    .waitForURL((u) => !/login\.jsp/i.test(u.toString()), { timeout: 25_000 })
    .catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

interface SessionState {
  url: string;
  /** What isXtmLoggedOut() reads on the OUTER page — the bot's kick detector. */
  outerLoginShell: boolean;
  hasInboxIframe: boolean;
  /** A login form rendered INSIDE the iframe (the dangerous case b). */
  iframeHasLogin: boolean;
  /** The task grid present inside the iframe (i.e. genuinely logged in). */
  gridPresent: boolean;
  verdict: 'LOGGED_IN' | 'LOGGED_OUT_TOPLEVEL' | 'LOGGED_OUT_IN_IFRAME' | 'UNKNOWN';
}

/** Read-only: classify a page as logged-in / kicked-top-level / kicked-in-iframe. */
async function probeSessionState(page: Page): Promise<SessionState> {
  await page.goto(env.offersUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1_500);

  const url = page.url();
  const outerLoginShell = await page
    .locator('body.loginPage, [ng-app="xtm.login"]')
    .count()
    .then((n) => n > 0)
    .catch(() => false);

  let hasInboxIframe = false;
  let iframeHasLogin = false;
  let gridPresent = false;
  try {
    const handle = await page
      .waitForSelector('#myInboxIframe', { timeout: 5_000 })
      .catch(() => null);
    if (handle) {
      hasInboxIframe = true;
      const frame = await handle.contentFrame();
      if (frame) {
        await frame.waitForLoadState('networkidle').catch(() => undefined);
        gridPresent = await frame
          .locator('table#TaskListingTable')
          .count()
          .then((n) => n > 0)
          .catch(() => false);
        iframeHasLogin = await frame
          .locator(
            'input[type="password"], body.loginPage, [ng-app="xtm.login"], form[action*="login" i]',
          )
          .count()
          .then((n) => n > 0)
          .catch(() => false);
      }
    }
  } catch {
    // leave defaults
  }

  let verdict: SessionState['verdict'] = 'UNKNOWN';
  if (gridPresent && !outerLoginShell) verdict = 'LOGGED_IN';
  else if (outerLoginShell) verdict = 'LOGGED_OUT_TOPLEVEL';
  else if (iframeHasLogin) verdict = 'LOGGED_OUT_IN_IFRAME';

  return { url, outerLoginShell, hasInboxIframe, iframeHasLogin, gridPresent, verdict };
}

async function snapshot(page: Page, dir: string, name: string): Promise<void> {
  try {
    writeFileSync(join(dir, `${name}.html`), sanitize(await page.content()), 'utf8');
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
    const handle = await page.$('#myInboxIframe');
    const frame = handle ? await handle.contentFrame() : null;
    if (frame)
      writeFileSync(join(dir, `${name}-iframe.html`), sanitize(await frame.content()), 'utf8');
    console.log(`[recon] captured ${name}`);
  } catch (err) {
    console.warn(`[recon] capture ${name} failed: ${err instanceof Error ? err.message : err}`);
  }
}

function line(label: string, s: SessionState): string {
  return `${label}: verdict=${s.verdict} | outerLoginShell=${s.outerLoginShell} | hasIframe=${s.hasInboxIframe} | iframeHasLogin=${s.iframeHasLogin} | grid=${s.gridPresent} | url=${stripQuery(s.url)}`;
}
function stripQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : `${url.slice(0, q)}?[stripped]`;
}

async function main(): Promise<void> {
  if (process.env.LIVE_PORTAL !== '1') {
    console.error('[recon] refused: set LIVE_PORTAL=1 to run against the real portal.');
    process.exit(2);
  }
  env.portalUrl = requireEnv('XTM_ACOLAD_PORTAL_URL');
  env.offersUrl = requireEnv('XTM_ACOLAD_OFFERS_URL');
  env.company = requireEnv('XTM_ACOLAD_Company');
  env.username = requireEnv('XTM_ACOLAD_Username');
  env.password = requireEnv('XTM_ACOLAD_Password');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(process.env.STATE_DIR ?? 'state', 'evidence', `xtm-logout-recon-${stamp}`);
  mkdirSync(dir, { recursive: true });
  console.log(`[recon] evidence dir: ${dir}`);
  console.log(
    '[recon] WARNING: this logs into the shared account TWICE and WILL kick any live human session. Bot should be STOPPED.',
  );

  const headless = process.env.RECON_HEADLESS === '1';
  let browser: Browser | undefined;
  let ctxA: BrowserContext | undefined;
  let ctxB: BrowserContext | undefined;
  const results: Record<string, SessionState> = {};

  try {
    browser = await chromium.launch({ headless, channel: 'chromium' });

    // Context A = the BOT (its own cookie jar). Context B = a human teammate.
    ctxA = await browser.newContext();
    ctxA.setDefaultNavigationTimeout(30_000);
    ctxA.setDefaultTimeout(10_000);
    const pageA = await ctxA.newPage();

    // ── Phase 1: A logs in and confirms it is genuinely logged in ──────────────
    console.log('\n[recon] Phase 1: A (bot) logs in');
    await login(pageA);
    results['1-A-after-login'] = await probeSessionState(pageA);
    await snapshot(pageA, dir, '01-A-loggedin');
    console.log('  ' + line('A', results['1-A-after-login']));

    // ── Phase 2: B logs in on the SAME account → should kick A (latest-wins) ───
    console.log('\n[recon] Phase 2: B (human) logs in on the same account');
    ctxB = await browser.newContext();
    ctxB.setDefaultNavigationTimeout(30_000);
    ctxB.setDefaultTimeout(10_000);
    const pageB = await ctxB.newPage();
    await login(pageB);
    results['2-B-after-login'] = await probeSessionState(pageB);
    await snapshot(pageB, dir, '02-B-loggedin');
    console.log('  ' + line('B', results['2-B-after-login']));

    // ── Phase 3: THE KEY CAPTURE — A navigates with its now-(maybe)-dead cookie ─
    console.log('\n[recon] Phase 3: A navigates again (was it kicked? how does logout render?)');
    results['3-A-after-kick'] = await probeSessionState(pageA);
    await snapshot(pageA, dir, '03-A-afterkick');
    console.log('  ' + line('A', results['3-A-after-kick']));

    // ── Phase 4: did A's NAVIGATION (no login) kick B? (assumption: it must NOT) ─
    console.log(
      '\n[recon] Phase 4: B re-checked — did A navigating kick B? (should still be LOGGED_IN)',
    );
    results['4-B-after-A-nav'] = await probeSessionState(pageB);
    await snapshot(pageB, dir, '04-B-stillalive');
    console.log('  ' + line('B', results['4-B-after-A-nav']));

    // ── Phase 5: A performs a real LOGIN (the "probe") → should kick B ─────────
    console.log('\n[recon] Phase 5: A re-logs in (the probe) — should now kick B (latest-wins)');
    await login(pageA);
    results['5-A-after-relogin'] = await probeSessionState(pageA);
    await snapshot(pageA, dir, '05-A-relogged');
    console.log('  ' + line('A', results['5-A-after-relogin']));
    results['5-B-after-A-relogin'] = await probeSessionState(pageB);
    await snapshot(pageB, dir, '05-B-afterkick');
    console.log('  ' + line('B', results['5-B-after-A-relogin']));

    // ── Findings ──────────────────────────────────────────────────────────────
    const kicked = results['3-A-after-kick'];
    const botDetectsKick = kicked.outerLoginShell; // what isXtmLoggedOut() sees
    const findings = {
      stamp,
      latestLoginWins_BkicksA: kicked.verdict !== 'LOGGED_IN',
      logoutRendering: kicked.verdict, // LOGGED_OUT_TOPLEVEL (safe) | LOGGED_OUT_IN_IFRAME (needs guard)
      botExistingDetectorWorks: botDetectsKick,
      navigateOnlyDoesNotKick: results['4-B-after-A-nav'].verdict === 'LOGGED_IN',
      probeLoginKicksHuman: results['5-B-after-A-relogin'].verdict !== 'LOGGED_IN',
      states: results,
      interpretation: botDetectsKick
        ? 'SAFE: isXtmLoggedOut() (outer page) detects the kick — design works as written.'
        : kicked.verdict === 'LOGGED_OUT_IN_IFRAME'
          ? 'NEEDS GUARD: logout renders INSIDE the iframe; isXtmLoggedOut() misses it. Spec must add an in-iframe logged-out guard before the read throws LayoutChangedError.'
          : 'INCONCLUSIVE: A was not clearly kicked, or rendering is unrecognized — inspect screenshots/HTML manually.',
    };
    writeFileSync(join(dir, 'FINDINGS.json'), JSON.stringify(findings, null, 2), 'utf8');
    writeFileSync(
      join(dir, 'README.txt'),
      [
        'XTM logout-rendering recon — auto-yield design spike',
        '',
        'KEY QUESTION: after B kicks A, how does A see logout?',
        `  → logoutRendering = ${findings.logoutRendering}`,
        `  → botExistingDetectorWorks (isXtmLoggedOut on outer page) = ${findings.botExistingDetectorWorks}`,
        '',
        'Cross-checks:',
        `  latest-login-wins (B kicks A)      = ${findings.latestLoginWins_BkicksA}`,
        `  navigate-only does NOT kick (B ok) = ${findings.navigateOnlyDoesNotKick}`,
        `  probe login kicks human (A kicks B)= ${findings.probeLoginKicksHuman}`,
        '',
        `INTERPRETATION: ${findings.interpretation}`,
        '',
        'STILL TO MEASURE SEPARATELY: XTM idle/absolute session timeout (leave one',
        'session idle and poll until it dies) — sets the safe upper bound for',
        'XTM_YIELD_WINDOW_MS. Not covered here (needs a long idle observation).',
        '',
        'Files: 01-A-loggedin, 02-B-loggedin, 03-A-afterkick, 04-B-stillalive,',
        '       05-A-relogged, 05-B-afterkick (.html + .png + -iframe.html), FINDINGS.json',
        'NOTE: credentials redacted; no cookies/tokens captured.',
      ].join('\n'),
      'utf8',
    );

    console.log('\n[recon] ===== FINDINGS =====');
    console.log(`  logout rendering            : ${findings.logoutRendering}`);
    console.log(`  bot's isXtmLoggedOut works   : ${findings.botExistingDetectorWorks}`);
    console.log(`  latest-login-wins (B kicks A): ${findings.latestLoginWins_BkicksA}`);
    console.log(`  navigate-only doesn't kick   : ${findings.navigateOnlyDoesNotKick}`);
    console.log(`  probe login kicks human      : ${findings.probeLoginKicksHuman}`);
    console.log(`  → ${findings.interpretation}`);
    console.log(`\n[recon] done. Evidence in ${dir}`);
  } finally {
    await ctxA?.close().catch(() => undefined);
    await ctxB?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('[recon] fatal:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
