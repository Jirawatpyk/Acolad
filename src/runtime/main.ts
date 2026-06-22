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
// Cap on the final browser dispose. Bounds BrowserSession.dispose()'s own 2× CLOSE_TIMEOUT_MS
// (browser.ts) to a single 8s ceiling — keep in step with ecosystem kill_timeout (25s+8s≈33s<35s).
const DISPOSE_TIMEOUT_MS = 8_000;

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
  let cleanedUp = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  // Single idempotent teardown: dispose the browser (capped — a hung close is process-tree
  // killed inside BrowserSession), close the DB, release the lock. Runs at most once whether
  // the loop exits cooperatively OR the watchdog forces it, so the two paths never race a
  // double db.close()/release(). Clears the watchdog so a normal exit cannot trigger a force.
  const cleanup = async (outcome: 'ok' | 'forced'): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (watchdog) clearTimeout(watchdog);
    await withTimeout(client.dispose(), DISPOSE_TIMEOUT_MS, () =>
      logger.error(
        { module: 'main', action: 'shutdown', outcome: 'dispose_timeout' },
        'browser dispose exceeded its cap — possible orphaned Chromium (reaped by next deploy sweep)',
      ),
    );
    db.close();
    await release().catch(() => undefined);
    logger.info({ module: 'main', action: 'shutdown', outcome }, 'acolad-bot stopped (bounded)');
    // Drain the worker-thread transport so this shutdown line actually reaches disk before
    // process.exit kills the worker — otherwise graceful shutdown is invisible in the logs.
    await logger.flush?.();
  };
  // Bounded shutdown: never wait for an in-flight cycle (disposing mid-cycle just errors the
  // caught Playwright calls). Force = tear down now and exit.
  const forceShutdown = async (): Promise<void> => {
    await cleanup('forced');
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
    watchdog = setTimeout(() => void forceShutdown(), SHUTDOWN_BUDGET_MS);
    watchdog.unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // PM2 on Windows cannot deliver POSIX signals to a daemon-spawned process; started with
  // `--shutdown-with-message` it sends an IPC 'shutdown' message instead. Handle it so
  // `pm2 stop`/deploy triggers the bounded teardown rather than waiting out kill_timeout
  // and SIGKILLing mid-cycle (which orphans Chromium). Harmless if the message never comes.
  process.on('message', (msg) => {
    if (msg === 'shutdown') shutdown('shutdown-message');
  });

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

  // Normal exit (loop ended cooperatively before the watchdog fired). Same guarded
  // teardown — clears the pending watchdog so it cannot fire a redundant force.
  await cleanup('ok');
  console.log(`[${stamp()}] acolad-bot หยุดแล้ว`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
