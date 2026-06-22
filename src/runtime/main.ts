import { MetaStore } from '../state/meta.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import { ColdStartHistory } from './coldStartHistory.js';
import { createXtmBot } from './bootstrap.js';
import { computeNextDelay, jitter } from './scheduler.js';
import { systemClock } from '../clock.js';
import { loadConfig } from '../config/index.js';
import { acquireSingleInstanceLock } from './singleInstance.js';
import { withTimeout } from '../withTimeout.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const stamp = (): string => new Date().toLocaleTimeString('en-GB');

const LOCK_RETRY_MS = 45_000; // >= PM2 kill_timeout (35s) so a new instance waits out the old's shutdown
const SHUTDOWN_BUDGET_MS = 25_000; // force shutdown if the loop hasn't exited by now
const DISPOSE_TIMEOUT_MS = 8_000; // cap on the final browser dispose

/** Long-running 24/7 entrypoint under PM2 (npm start). */
async function main(): Promise<void> {
  const cfg0 = loadConfig();

  // Single-instance guard (port-bind). A refusal pings the Healthchecks dead-man switch
  // BEFORE exit — nobody watches `pm2 status`, and this runs before the bot's heartbeat exists.
  let release: () => Promise<void>;
  try {
    release = await acquireSingleInstanceLock({
      port: cfg0.SINGLE_INSTANCE_PORT,
      retryMs: LOCK_RETRY_MS,
      onRefused: () =>
        fetch(`${cfg0.HEALTHCHECKS_PING_URL}/fail`)
          .then(() => undefined)
          .catch(() => undefined),
    });
  } catch {
    console.error(
      `[${stamp()}] acolad-bot: another instance owns port ${cfg0.SINGLE_INSTANCE_PORT} — refusing to start (single-instance).`,
    );
    process.exit(1);
    return; // unreachable; satisfies the type checker
  }

  const { cfg, logger, db, outbox, rate, client, loop } = createXtmBot();

  // Cold-start-repeat detection (FR-015): only counts when there is no baseline yet.
  if (!new MetaStore(db).baselineDone) {
    if (new ColdStartHistory(cfg.LOG_DIR).record(systemClock.nowIso())) {
      raiseAlert(
        db,
        outbox,
        'cold_start_repeat',
        systemClock.nowIso(),
        'เริ่มแบบไม่มีฐานสถานะซ้ำใน 7 วัน',
      );
    }
  }

  let running = true;
  let forcing = false;
  // Bounded shutdown: dispose the browser (capped) + release the lock + exit — never wait
  // for an in-flight cycle (disposing mid-cycle just errors the caught Playwright calls).
  const forceShutdown = async (): Promise<void> => {
    if (forcing) return;
    forcing = true;
    await withTimeout(client.dispose(), DISPOSE_TIMEOUT_MS);
    db.close();
    await release().catch(() => undefined);
    logger.info(
      { module: 'main', action: 'shutdown', outcome: 'forced' },
      'acolad-bot stopped (bounded)',
    );
    process.exit(0);
  };
  const shutdown = (signal: string): void => {
    logger.info({ module: 'main', action: 'shutdown', signal }, 'graceful shutdown requested');
    console.log(`[${stamp()}] ได้รับสัญญาณ ${signal} — กำลังปิดอย่างนุ่มนวล...`);
    if (!running) {
      void forceShutdown(); // second signal → force now
      return;
    }
    running = false;
    setTimeout(() => void forceShutdown(), SHUTDOWN_BUDGET_MS).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  logger.info({ module: 'main', action: 'startup', outcome: 'ok' }, 'acolad-xtm-bot started');
  console.log(
    `[${stamp()}] acolad-bot (XTM) เริ่มทำงาน — เฝ้า ${cfg.XTM_ACOLAD_OFFERS_URL} | accept=${cfg.ACCEPT_ENABLED ? 'ON' : 'OFF'}`,
  );
  console.log(`[${stamp()}] log ละเอียดอยู่ที่ ${cfg.LOG_DIR}/  (Ctrl+C เพื่อหยุด)`);

  while (running) {
    const cycleStart = systemClock.nowMs();
    const ok = await loop.runOnce();
    console.log(`[${stamp()}] รอบตรวจ: ${ok ? 'OK' : 'มีปัญหา (ดู log/Google Chat)'}`);

    const cycleDurationMs = systemClock.nowMs() - cycleStart;
    const j = jitter(5_000, Math.random());
    let delay = computeNextDelay({
      intervalMs: cfg.POLL_INTERVAL_MS,
      cycleDurationMs,
      jitterMs: j,
    });
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

  // Normal exit (loop ended cooperatively before the watchdog fired).
  await withTimeout(client.dispose(), DISPOSE_TIMEOUT_MS);
  db.close();
  await release().catch(() => undefined);
  logger.info({ module: 'main', action: 'shutdown', outcome: 'ok' }, 'acolad-bot stopped');
  console.log(`[${stamp()}] acolad-bot หยุดแล้ว`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
