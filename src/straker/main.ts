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
import { createHttpClient, type StrakerHttpClient } from './httpClient.js';
import { listOpenOffers } from './offersApi.js';
import {
  applySnapshot,
  emptyTrackerState,
  type SnapshotResult,
  type TrackerState,
} from './offerTracker.js';
import type { OfferSnapshot } from './offerTracker.js';
import { createStrakerLogger, STRAKER_LOG_NAME } from './logger.js';
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

  const runOnce = async (): Promise<boolean> => {
    let ok = false;
    try {
      ok = await cycle.runOnce();
    } catch (err) {
      // A throw must not end the loop, and must not pass for silence either: the bot
      // signals "failing" so a limping bot stays tellable from a dead machine.
      logger.error(
        { module: 'main', action: 'cycle', outcome: 'threw' },
        err instanceof Error ? err.message : String(err),
      );
      ok = false;
    }
    // Logged on EVERY cycle, including a quiet one that found no offers. Two things depend
    // on this line existing: the release script verifies a fresh one before calling a deploy
    // good (a bot that started but never completed a cycle is not a working bot), and it is
    // the same marker the XTM loop emits, which is what DC-3 asks of both loops.
    logger.info({ module: 'main', action: 'cycle', outcome: ok ? 'ok' : 'failed' }, 'poll cycle');
    await (ok ? heartbeat.ok() : heartbeat.fail());
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

export function createStrakerPortal(cfg: StrakerBotConfig): StrakerPortal {
  const client = createHttpClient({ baseUrl: cfg.baseUrl });
  return {
    client,
    signIn: () =>
      openSession(client, {
        loginId: cfg.loginId,
        password: cfg.password,
        ...(cfg.totpCode === undefined ? {} : { totpCode: cfg.totpCode }),
      }),
    listOpenOffers: (vendorId) => listOpenOffers(client, vendorId),
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

/**
 * The Phase 2 cycle: sign in once, read the open list, and let the tracker decide what
 * appeared and what vanished. It claims nothing — claiming is Phase 3 (T035) and gated by
 * the schedule (T039) — but it exercises the whole wiring above, which is what T017 is for.
 *
 * **This is the seam T037 replaces**, extending it to the full named sequence the XTM loop
 * uses: fetch -> diff -> gate -> act -> persist -> notify (DC-3).
 *
 * A failed read returns `false` with the tracker state UNTOUCHED. Applying an empty list
 * after a failure would mark every live offer as vanished and stamp fabricated lifetimes on
 * all of them — the one way this model can silently produce wrong answers, and the bug that
 * cost the XTM bot 38 minutes of missed work.
 */
export function createSightingCycle(
  portal: StrakerPortal,
  tracker: SightingTracker,
  logger: Logger,
  now: () => number = Date.now,
): StrakerCycle {
  let session: StrakerSession | null = null;

  return {
    async runOnce(): Promise<boolean> {
      const atMs = now();
      try {
        session ??= await portal.signIn();
        const offers = await portal.listOpenOffers(session.vendorId);
        const result = tracker.apply({ atMs, offerIds: offers.map((o) => o.obj_id) });
        for (const offer of result.appeared) {
          logger.info(
            {
              module: 'pollCycle',
              action: 'offer_appeared',
              objId: offer.objId,
              sighting: offer.sighting,
            },
            'open offer appeared',
          );
        }
        for (const offer of result.vanished) {
          logger.info(
            {
              module: 'pollCycle',
              action: 'offer_vanished',
              objId: offer.objId,
              lifetimeMs: offer.lifetimeMs,
            },
            'open offer vanished',
          );
        }
        return true;
      } catch (err) {
        // Drop the session so the next cycle signs in again; an expired session is the
        // common case and self-heals, while a genuine fault simply fails again and is seen.
        session = null;
        logger.error(
          { module: 'pollCycle', action: 'read', outcome: 'failed' },
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
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

  const portal = createStrakerPortal(cfg);
  const cycle = createSightingCycle(portal, createSightingTracker(), logger);

  const bot = await startStrakerBot({ cfg, logger, heartbeat, cycle });

  const shutdown = (signal: string): void => {
    logger.info({ module: 'main', action: 'shutdown', signal }, 'shutdown requested');
    void bot.stop();
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
