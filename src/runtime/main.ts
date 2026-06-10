import { loadConfig } from '../config/index.js';
import { createLogger } from '../monitoring/logger.js';
import { openDatabase } from '../state/db.js';
import { Outbox } from '../state/outbox.js';
import { MetaStore } from '../state/meta.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import { BrowserSession } from '../portal/browser.js';
import { PlaywrightPortalClient } from '../portal/portalClient.js';
import { ColdStartHistory } from './coldStartHistory.js';
import { PollLoop } from './pollLoop.js';
import { RateLimiter } from './rateLimiter.js';
import { computeNextDelay, jitter } from './scheduler.js';
import { systemClock } from '../clock.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stamp = (): string => new Date().toLocaleTimeString('en-GB');

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
  const rate = new RateLimiter(cfg.REQUESTS_PER_HOUR_CAP);
  const client = new PlaywrightPortalClient(browser, cfg, rate, systemClock);
  const loop = new PollLoop(opened.db, client, cfg, logger);

  let running = true;
  const shutdown = (signal: string): void => {
    logger.info({ module: 'main', action: 'shutdown', signal }, 'graceful shutdown requested');
    console.log(`[${stamp()}] ได้รับสัญญาณ ${signal} — กำลังปิดอย่างนุ่มนวล...`);
    running = false;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info({ module: 'main', action: 'startup', outcome: 'ok' }, 'acolad-bot started');
  console.log(`[${stamp()}] acolad-bot เริ่มทำงาน — เฝ้า ${cfg.ACOLAD_OFFERS_URL}`);
  console.log(`[${stamp()}] log ละเอียดอยู่ที่ ${cfg.LOG_DIR}/  (Ctrl+C เพื่อหยุด)`);

  while (running) {
    const cycleStart = systemClock.nowMs();
    const ok = await loop.runOnce();
    console.log(`[${stamp()}] รอบตรวจ: ${ok ? 'OK' : 'มีปัญหา (ดู log/Google Chat)'}`);

    await client.maybeRecycle();

    const cycleDurationMs = systemClock.nowMs() - cycleStart;
    // Pseudo-random jitter; varies by cycle. Math.random is fine in the running app.
    const j = jitter(5_000, Math.random());
    let delay = computeNextDelay({
      intervalMs: cfg.POLL_INTERVAL_MS,
      cycleDurationMs,
      jitterMs: j,
    });

    // Respect the hourly request cap (FR-011): wait out the window if at cap.
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

  await client.dispose();
  opened.db.close();
  logger.info({ module: 'main', action: 'shutdown', outcome: 'ok' }, 'acolad-bot stopped');
  console.log(`[${stamp()}] acolad-bot หยุดแล้ว`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
