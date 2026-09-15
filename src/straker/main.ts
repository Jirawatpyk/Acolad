/**
 * The Straker bot's entry point and composition root (T012, T014, T017).
 *
 * Deliberately shaped differently from `src/runtime/main.ts`: that one runs on import, so
 * nothing inside it can be tested. Here the startable unit is `startStrakerBot(deps)` with
 * its dependencies injected, and the module-level entry is guarded — which is what lets the
 * single-instance refusal and the liveness signal be proven by tests rather than by reading.
 *
 * `runOnce()` / `run()` mirror the XTM loop's shape on purpose (DC-3): one supervised cycle,
 * and a long-running loop that repeats it.
 */

import { config as loadDotenv } from 'dotenv';
import { Heartbeat, type HeartbeatPinger } from '../monitoring/heartbeat.js';
import type { Logger } from '../monitoring/logger.js';
import { acquireSingleInstanceLock } from '../runtime/singleInstance.js';
import { loadStrakerBotConfig, type StrakerBotConfig } from './config.js';
import {
  createHttpClient,
  type StrakerHttpClient,
  type StrakerTransportWarning,
} from './httpClient.js';
import { listOpenOffers } from './offersApi.js';
import {
  applySnapshot,
  emptyTrackerState,
  type SnapshotResult,
  type TrackerState,
} from './offerTracker.js';
import type { OfferSnapshot } from './offerTracker.js';
import { createStrakerLogger, STRAKER_LOG_NAME } from './logger.js';
import { StrakerLedger } from './ledger.js';
import { StrakerOutbox } from './outbox.js';
import { createOfferExtractor } from './offerParse.js';
import { createStrakerPollCycle } from './pollCycle.js';
import { openStrakerDatabase, StrakerStore } from './strakerStore.js';
import { openSession, type StrakerSession } from './session.js';
import type { RawOffer } from './probe.js';

/** Raised instead of a bare EADDRINUSE so a caller can tell "already running" from a fault. */
export class SingleInstanceRefused extends Error {
  constructor(readonly port: number) {
    super(`another ${STRAKER_LOG_NAME} instance owns port ${port} — refusing to start`);
    this.name = 'SingleInstanceRefused';
  }
}

/** One turn of the bot's work. Phase 3 (T037) supplies the real fetch -> diff -> gate ->
 *  act -> persist -> notify sequence; the shape is fixed here so it can be swapped in. */
export interface StrakerCycle {
  runOnce(): Promise<boolean>;
}

export interface StrakerBotDeps {
  readonly cfg: StrakerBotConfig;
  readonly logger: Logger;
  /** Straker's OWN liveness signal, monitored independently of the XTM bot's (FR-026a). */
  readonly heartbeat: HeartbeatPinger;
  readonly cycle: StrakerCycle;
  /** How long to wait out a previous instance's shutdown before refusing. */
  readonly lockRetryMs?: number;
  readonly acquireLock?: typeof acquireSingleInstanceLock;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface StrakerBotHandle {
  /** One cycle plus its liveness signal. Never throws: a 24/7 bot survives a bad cycle. */
  runOnce(): Promise<boolean>;
  /** The long-running loop. Resolves once `stop()` has been called and the loop has left. */
  run(): Promise<void>;
  /** Idempotent: release the lock and stop looping. */
  stop(): Promise<void>;
}

/**
 * The two URLs the Straker bot signals on. Derived only from Straker's own variable — the
 * XTM bot's is never consulted, because a shared signal means one bot can die while the
 * other keeps reporting health, and nobody notices until work stops arriving (FR-026a).
 */
export function strakerPingUrls(cfg: StrakerBotConfig): { ok: string; fail: string } {
  return { ok: cfg.healthcheckPingUrl, fail: `${cfg.healthcheckPingUrl}/fail` };
}

/** >= the PM2 kill_timeout so a restart waits out the old instance rather than refusing. */
const LOCK_RETRY_MS = 20_000;

/**
 * Run a reporting side effect — a log line, a liveness ping — without letting it take the
 * loop down with it.
 *
 * The fallback is `console.error` rather than an empty catch, and the distinction matters:
 * these two calls ARE how the bot reports anything, so when they are the thing that broke
 * there is nowhere left to report except the process's own stderr, which PM2 captures to
 * `logs/straker-err.log`. Swallowing here would mean a bot whose reporting is broken looks
 * exactly like a bot with nothing to report.
 */
function report(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('[jobcatch-straker] reporting failed:', err);
  }
}

async function reportAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error('[jobcatch-straker] reporting failed:', err);
  }
}

export async function startStrakerBot(deps: StrakerBotDeps): Promise<StrakerBotHandle> {
  const { cfg, logger, heartbeat, cycle } = deps;
  const acquire = deps.acquireLock ?? acquireSingleInstanceLock;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let release: () => Promise<void>;
  try {
    release = await acquire({
      port: cfg.singleInstancePort,
      retryMs: deps.lockRetryMs ?? LOCK_RETRY_MS,
      // The refusal has to reach the dead-man switch itself: at this point there is no
      // running loop to signal from, and nobody watches `pm2 status`.
      onRefused: () => heartbeat.fail().catch(() => undefined),
    });
  } catch {
    logger.error(
      { module: 'main', action: 'startup', outcome: 'refused', port: cfg.singleInstancePort },
      'another instance owns the Straker single-instance port',
    );
    throw new SingleInstanceRefused(cfg.singleInstancePort);
  }

  let running = false;
  let stopped = false;

  /**
   * `runOnce` promises never to throw, and everything it does is inside a guard because of
   * that promise. The reporting half used to sit outside one: `HeartbeatPinger` is an
   * interface, so nothing stops an implementation rejecting, and pino's rolling transport
   * can throw when the disk fills. Either would have escaped, rejected `run()`, and left
   * `main()` exiting WITHOUT releasing the single-instance lock — a process still holding
   * port 47812 and still reported online by PM2, but no longer polling.
   */
  const runOnce = async (): Promise<boolean> => {
    let ok = false;
    try {
      ok = await cycle.runOnce();
    } catch (err) {
      // A throw must not end the loop, and must not pass for silence either: the bot
      // signals "failing" so a limping bot stays tellable from a dead machine.
      report(() =>
        logger.error(
          { module: 'main', action: 'cycle', outcome: 'threw' },
          err instanceof Error ? err.message : String(err),
        ),
      );
      ok = false;
    }
    // Logged on EVERY cycle, including a quiet one that found no offers. Two things depend
    // on this line existing: the release script verifies a fresh one before calling a deploy
    // good (a bot that started but never completed a cycle is not a working bot), and it is
    // the same marker the XTM loop emits, which is what DC-3 asks of both loops.
    report(() =>
      logger.info({ module: 'main', action: 'cycle', outcome: ok ? 'ok' : 'failed' }, 'poll cycle'),
    );
    await reportAsync(() => (ok ? heartbeat.ok() : heartbeat.fail()));
    return ok;
  };

  return {
    runOnce,
    async run(): Promise<void> {
      running = true;
      while (running) {
        await runOnce();
        if (!running) break;
        await sleep(cfg.pollIntervalMs);
      }
    },
    async stop(): Promise<void> {
      running = false;
      if (stopped) return;
      stopped = true;
      await release().catch(() => undefined);
      logger.info(
        { module: 'main', action: 'shutdown', outcome: 'ok' },
        'jobcatch-straker stopped',
      );
      await logger.flush?.();
    },
  };
}

// --- T017: the capture probe's proven modules, consumed rather than rewritten ----------

/**
 * The portal side of the bot, assembled from the four modules the capture probe already
 * built and proved against the live portal: the transport (cookie jar, Origin/Referer,
 * budget headers), sign-in, the open-offer read with its shape guards, and the pure
 * sighting transition. None of them is reimplemented here.
 */
export interface StrakerPortal {
  readonly client: StrakerHttpClient;
  /** Signs in and reads the vendor identity back from the portal every time (FR-022) —
   *  never pinned in configuration, because it changes under impersonation or an account
   *  switch and a stale one would poll another vendor's work. */
  signIn(): Promise<StrakerSession>;
  listOpenOffers(vendorId: string): Promise<readonly RawOffer[]>;
}

/**
 * Per-attempt deadline (Constitution VI). Chosen against two numbers: recon measured a
 * round trip of 256–670 ms, so 2 s is roughly three times the slowest response ever
 * observed; and the whole retry sequence — 4 attempts plus ~1.75 s of waits — then lands
 * near 9.75 s, inside one 10 s poll interval. **Revisit at T043**, which sets the polling
 * rhythm from the capture probe's measured offer lifetime: if the rhythm drops to a second,
 * a worst-case read must not outlast several cycles.
 */
const REQUEST_TIMEOUT_MS = 2_000;

/** Seams the tests use to drive the portal without a network. Production passes none. */
export interface StrakerPortalDeps {
  readonly fetchImpl?: typeof fetch;
  readonly onWarning?: (warning: StrakerTransportWarning) => void;
}

export function createStrakerPortal(
  cfg: StrakerBotConfig,
  logger: Logger,
  deps: StrakerPortalDeps = {},
): StrakerPortal {
  const client = createHttpClient({
    baseUrl: cfg.baseUrl,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    // Constitution VI: no unbounded waits. Opt-in at the transport, which is what keeps the
    // capture probe unchanged — and passed HERE, because a deadline the composition root
    // never hands over is a deadline the running bot does not have. That gap has already
    // happened once in this feature with the retrying read door; the wiring is asserted in
    // `tests/integration/straker/sightingCycle.test.ts` so it cannot happen a third time.
    timeoutMs: REQUEST_TIMEOUT_MS,
    // Kept separate from `onAlert` deliberately: that handler logs at error level with a
    // message about the retry cap, so routing a missing budget header through it would
    // produce an alert that is both loud and about the wrong thing.
    onWarning:
      deps.onWarning ??
      ((warning) =>
        report(() =>
          logger.warn(
            { module: 'httpClient', action: warning.kind, outcome: warning.reason, ...warning },
            'request budget is not readable from the portal reply',
          ),
        )),
    // Without a sink the transport's own alert path is dead code: `raiseAlert` returns
    // immediately when this is absent, so exhausting the read cap would throw into a log
    // line and nothing else. Routing it to a durable channel is T054/T055's job; until
    // then it must at least be loud in the place an operator already looks.
    onAlert: (alert) =>
      report(() =>
        logger.error(
          { module: 'httpClient', action: alert.kind, outcome: 'exhausted', ...alert },
          'offer-list read gave up after exhausting its retry cap',
        ),
      ),
  });
  return {
    client,
    signIn: () =>
      openSession(client, {
        loginId: cfg.loginId,
        password: cfg.password,
        ...(cfg.totpCode === undefined ? {} : { totpCode: cfg.totpCode }),
      }),
    // `retry: true` is the join FR-019b depends on — see `offersApi.ts`. The probe leaves
    // it off, which is what keeps its behaviour unchanged while it finishes collecting.
    listOpenOffers: (vendorId) => listOpenOffers(client, vendorId, { retry: true }),
  };
}

/**
 * The sighting tracker, wrapped around the probe's pure `applySnapshot` so the bot keeps
 * the state between cycles without owning the transition. `detection/diff.ts` plays the
 * same role for the XTM bot: the pure function decides, the caller only persists.
 */
export interface SightingTracker {
  apply(snapshot: OfferSnapshot): SnapshotResult;
  readonly state: TrackerState;
}

export function createSightingTracker(
  initial: TrackerState = emptyTrackerState(),
): SightingTracker {
  let state = initial;
  return {
    apply(snapshot) {
      const result = applySnapshot(state, snapshot);
      state = result.state;
      return result;
    },
    get state() {
      return state;
    },
  };
}

/** Long-running 24/7 entry point under PM2 (`straker.config.cjs`). */
async function main(): Promise<void> {
  // Called HERE rather than at module scope on purpose: importing this module in a test
  // must not pull the real `.env` into `process.env`, or a test would silently run against
  // live credentials. Only the entry path needs it, and only the entry path gets it.
  loadDotenv();

  const cfg = loadStrakerBotConfig(process.env);
  const logger = createStrakerLogger(cfg);
  const urls = strakerPingUrls(cfg);
  const heartbeat = new Heartbeat(urls.ok, (e, action) =>
    logger.warn({ module: 'heartbeat', action, outcome: 'failed' }, String(e)),
  );

  const portal = createStrakerPortal(cfg, logger);

  const opened = openStrakerDatabase(cfg.stateDir, Date.now());
  if (opened.recoveredFromCorruption) {
    logger.error(
      {
        module: 'main',
        action: 'startup',
        outcome: 'db_quarantined',
        path: opened.corruptCopyPath,
      },
      'the Straker state file was unusable and was quarantined — this run starts cold, and any work held before it is known only to the portal until reconciliation runs',
    );
  }
  const store = new StrakerStore(opened.db);

  const cycle = createStrakerPollCycle({
    portal,
    tracker: createSightingTracker(),
    store,
    ledger: new StrakerLedger(store, cfg.maxWordsPerDay, {
      hoursStartMin: cfg.hoursStartMin,
      workdays: cfg.workdays,
    }),
    outbox: new StrakerOutbox(opened.db),
    logger,
    settings: {
      throughputWordsPerHour: cfg.throughputWordsPerHour,
      hoursStartMin: cfg.hoursStartMin,
      hoursEndMin: cfg.hoursEndMin,
      workdays: cfg.workdays,
    },
    extractOffers: createOfferExtractor({
      excludedLanguagePairs: cfg.excludedLanguagePairs,
      logger,
    }),
  });

  const bot = await startStrakerBot({ cfg, logger, heartbeat, cycle });

  const shutdown = (signal: string): void => {
    logger.info({ module: 'main', action: 'shutdown', signal }, 'shutdown requested');
    void bot.stop().catch((e: unknown) => console.error('[jobcatch-straker] stop failed:', e));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // PM2 on Windows cannot deliver POSIX signals to a daemon-spawned process; with
  // `--shutdown-with-message` it sends an IPC message instead. Harmless if it never comes.
  process.on('message', (msg) => {
    if (msg === 'shutdown') shutdown('shutdown-message');
  });

  logger.info(
    { module: 'main', action: 'startup', outcome: 'ok', port: cfg.singleInstancePort },
    'jobcatch-straker started',
  );
  await bot.run();
}

// Guarded so importing this module in a test does not start a bot (the XTM entry point
// cannot be imported at all for exactly this reason).
if (process.env.STRAKER_BOT_ENTRY === '1') {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
