import { loadConfig } from '../config/index.js';
import { createLogger } from '../monitoring/logger.js';
import { openDatabase } from '../state/db.js';
import { Outbox } from '../state/outbox.js';
import { MetaStore } from '../state/meta.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import { BrowserSession } from '../portal/browser.js';
import { ColdStartHistory } from './coldStartHistory.js';
import { PollLoop, systemClock } from './pollLoop.js';
import { computeNextDelay, jitter } from './scheduler.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Long-running 24/7 entrypoint under PM2 (npm start). */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg);
  const opened = openDatabase(cfg.STATE_DIR, systemClock.nowIso());
  const outbox = new Outbox(opened.db, cfg.OUTBOX_RETRY_CAP, cfg.OUTBOX_DEAD_AFTER_HOURS);

  if (opened.recoveredFromCorruption) {
    raiseAlert(
      opened.db,
      outbox,
      'db_corrupt',
      systemClock.nowIso(),
      `สำเนา: ${opened.corruptCopyPath ?? 'n/a'}`,
    );
  }

  // Cold-start-repeat detection (FR-015): only counts when there is no baseline yet.
  const history = new ColdStartHistory(cfg.LOG_DIR);
  if (!new MetaStore(opened.db).baselineDone) {
    if (history.record(systemClock.nowIso())) {
      raiseAlert(
        opened.db,
        outbox,
        'cold_start_repeat',
        systemClock.nowIso(),
        'เริ่มแบบไม่มีฐานสถานะซ้ำใน 7 วัน',
      );
    }
  }

  const browser = new BrowserSession(cfg.STATE_DIR, cfg.BROWSER_RECYCLE_HOURS, systemClock.nowMs);
  const loop = new PollLoop(opened.db, browser, cfg, logger);

  let running = true;
  const shutdown = (signal: string): void => {
    logger.info({ module: 'main', action: 'shutdown', signal }, 'graceful shutdown requested');
    running = false;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info({ module: 'main', action: 'startup', outcome: 'ok' }, 'acolad-bot started');

  while (running) {
    const cycleStart = systemClock.nowMs();
    await loop.runOnce();

    if (browser.shouldRecycle()) {
      await browser.recycle();
      logger.info({ module: 'main', action: 'browser_recycle', outcome: 'ok' }, 'browser recycled');
    }

    const cycleDurationMs = systemClock.nowMs() - cycleStart;
    // Pseudo-random jitter; varies by cycle. Math.random is unavailable in
    // workflow scripts but fine in the running app.
    const j = jitter(5_000, Math.random());
    let delay = computeNextDelay({
      intervalMs: cfg.POLL_INTERVAL_MS,
      cycleDurationMs,
      jitterMs: j,
    });

    // Respect the hourly request cap (FR-011): wait out the window if at cap.
    const rate = loop.rateLimiter();
    const waitForSlot = rate.msUntilSlot(systemClock.nowMs());
    if (waitForSlot > delay) {
      logger.warn(
        { module: 'main', action: 'rate_limit', outcome: 'deferred', waitMs: waitForSlot },
        'request cap reached — extending interval',
      );
      delay = waitForSlot;
    }
    await sleep(delay);
  }

  await browser.dispose();
  opened.db.close();
  logger.info({ module: 'main', action: 'shutdown', outcome: 'ok' }, 'acolad-bot stopped');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
