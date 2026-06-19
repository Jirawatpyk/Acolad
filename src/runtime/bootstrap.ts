import { loadConfig, type AppConfig } from '../config/index.js';
import { createLogger, type Logger } from '../monitoring/logger.js';
import { openDatabase, type DB } from '../state/db.js';
import { Outbox, createOutbox } from '../state/outbox.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import { BrowserSession } from '../portal/browser.js';
import { PlaywrightPortalClient } from '../portal/portalClient.js';
import { PlaywrightXtmClient } from '../portal/xtmClient.js';
import { GoogleSheetsApi, SheetSink, GoogleSheetSender } from '../reporting/sheets.js';
import { PollLoop } from './pollLoop.js';
import { XtmPollLoop } from './xtmPollLoop.js';
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

/** Everything an XTM entrypoint needs (feature 002), wired consistently. */
export interface XtmBot {
  cfg: AppConfig;
  logger: Logger;
  db: DB;
  outbox: Outbox;
  browser: BrowserSession;
  rate: RateLimiter;
  client: PlaywrightXtmClient;
  loop: XtmPollLoop;
}

/**
 * Bootstrap the XTM bot (002): load config, open/recover the state DB, alert on
 * corruption, and wire the XTM client + Google Sheets sink + poll loop. The
 * Sheets sender flows through the same outbox/dispatcher as Chat (Constitution
 * IV — a Sheets outage never blocks acceptance).
 */
export function createXtmBot(): XtmBot {
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
  const client = new PlaywrightXtmClient(browser, cfg, rate, systemClock);
  const sheetSink = new SheetSink(
    new GoogleSheetsApi(
      cfg.GOOGLE_SHEETS_ID,
      cfg.SHEETS_TAB_NAME,
      cfg.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    ),
  );
  const sheetSender = new GoogleSheetSender(sheetSink);
  const loop = new XtmPollLoop(opened.db, client, cfg, logger, systemClock, { sheetSender });

  return { cfg, logger, db: opened.db, outbox, browser, rate, client, loop };
}
