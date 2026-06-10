import { loadConfig, type AppConfig } from '../config/index.js';
import { createLogger, type Logger } from '../monitoring/logger.js';
import { openDatabase, type DB } from '../state/db.js';
import { Outbox, createOutbox } from '../state/outbox.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import { BrowserSession } from '../portal/browser.js';
import { PlaywrightPortalClient } from '../portal/portalClient.js';
import { PollLoop } from './pollLoop.js';
import { RateLimiter } from './rateLimiter.js';
import { systemClock } from '../clock.js';

/** Everything an entrypoint needs to run a poll cycle, wired consistently. */
export interface Bot {
  cfg: AppConfig;
  logger: Logger;
  db: DB;
  outbox: Outbox;
  browser: BrowserSession;
  rate: RateLimiter;
  client: PlaywrightPortalClient;
  loop: PollLoop;
}

/**
 * Shared bootstrap for the main loop and the one-shot runner: load config, open
 * (and recover) the state DB, alert on corruption, and wire the portal client +
 * poll loop. Keeps main.ts/once.ts from duplicating the same setup.
 */
export function createBot(): Bot {
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  const opened = openDatabase(cfg.STATE_DIR, systemClock.nowIso());
  const outbox = createOutbox(opened.db, cfg);

  if (opened.recoveredFromCorruption) {
    raiseAlert(
      opened.db,
      outbox,
      'db_corrupt',
      systemClock.nowIso(),
      `สำเนา: ${opened.corruptCopyPath ?? 'n/a'}`,
    );
  }

  const browser = new BrowserSession(cfg.STATE_DIR, cfg.BROWSER_RECYCLE_HOURS, systemClock.nowMs);
  const rate = new RateLimiter(cfg.REQUESTS_PER_HOUR_CAP);
  const client = new PlaywrightPortalClient(browser, cfg, rate, systemClock);
  const loop = new PollLoop(opened.db, client, cfg, logger);

  return { cfg, logger, db: opened.db, outbox, browser, rate, client, loop };
}
