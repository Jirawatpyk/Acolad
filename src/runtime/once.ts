import { loadConfig } from '../config/index.js';
import { createLogger } from '../monitoring/logger.js';
import { openDatabase } from '../state/db.js';
import { Outbox } from '../state/outbox.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import { BrowserSession } from '../portal/browser.js';
import { ColdStartHistory } from './coldStartHistory.js';
import { PollLoop, systemClock } from './pollLoop.js';

/** Run a single poll cycle then exit (smoke test — npm run poll:once). */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  const opened = openDatabase(cfg.STATE_DIR, systemClock.nowIso());

  if (opened.recoveredFromCorruption) {
    const outbox = new Outbox(opened.db, cfg.OUTBOX_RETRY_CAP, cfg.OUTBOX_DEAD_AFTER_HOURS);
    raiseAlert(
      opened.db,
      outbox,
      'db_corrupt',
      systemClock.nowIso(),
      `สำเนา: ${opened.corruptCopyPath ?? 'n/a'}`,
    );
  }
  const history = new ColdStartHistory(cfg.LOG_DIR);

  const browser = new BrowserSession(cfg.STATE_DIR, cfg.BROWSER_RECYCLE_HOURS, systemClock.nowMs);
  const loop = new PollLoop(opened.db, browser, cfg, logger);
  try {
    const ok = await loop.runOnce();
    console.log(ok ? 'poll:once OK' : 'poll:once completed with errors (see logs/alerts)');
    if (ok) history.record(systemClock.nowIso());
  } finally {
    await browser.dispose();
    opened.db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
