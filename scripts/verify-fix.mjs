/**
 * Live verification of the networkidle root-cause fix using the REAL compiled
 * PlaywrightXtmClient (dist/), not a hand-rolled diag. Proves the actual bot code
 * path (activeFrame → settleGrid → read) reads a POPULATED live grid correctly:
 *   - readClosedKeys() should return ~19 keys (Closed has 19 real rows).
 *   - fetchJobSnapshot() should run clean and classify Active (empty now → 0).
 * Run with the bot STOPPED (single-instance rule).
 */
import { loadConfig } from '../dist/config/index.js';
import { createLogger } from '../dist/monitoring/logger.js';
import { BrowserSession } from '../dist/portal/browser.js';
import { PlaywrightXtmClient } from '../dist/portal/xtmClient.js';
import { RateLimiter } from '../dist/runtime/rateLimiter.js';
import { systemClock } from '../dist/clock.js';

const cfg = loadConfig();
const logger = createLogger(cfg);
const browser = new BrowserSession(cfg.STATE_DIR, cfg.BROWSER_RECYCLE_HOURS, systemClock.nowMs);
const rate = new RateLimiter(cfg.REQUESTS_PER_HOUR_CAP);
const client = new PlaywrightXtmClient(browser, cfg, rate, systemClock, undefined, logger);

try {
  await client.ensureLoggedIn();

  const snap = await client.fetchJobSnapshot('verify-fix');
  console.log(
    `fetchJobSnapshot (Active): jobs=${snap.jobs.length} malformed=${snap.malformed.length} emptyConfirmed=${snap.emptyListConfirmed}`,
  );

  const closed = await client.readClosedKeys();
  console.log(`readClosedKeys (populated): keys=${closed.size}`);
  console.log(
    closed.size >= 15
      ? '✅ FIX VERIFIED — real client reads the populated grid (was 0 before the fix)'
      : `⚠️  only ${closed.size} keys — investigate (expected ~19)`,
  );
} catch (e) {
  console.error('verify-fix failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await client.dispose();
}
