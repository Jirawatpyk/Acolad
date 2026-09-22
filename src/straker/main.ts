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
import type { ClaimDoor } from './claim.js';
import { createStrakerDispatcher, type StrakerSenders } from './dispatcher.js';
import {
  createHttpClient,
  type StrakerTransportAlert,
  type StrakerTransportWarning,
} from './httpClient.js';
import {
  createStrakerAlertsSender,
  createStrakerOffersSender,
  createTransportAlertHooks,
  type StrakerSystemAlert,
  type TransportAlertHooks,
} from './notifier.js';
import { GoogleChatSender } from '../reporting/googleChat.js';
import {
  createStrakerReconciler,
  readAssignedWork,
  readPurchaseOrders,
  type AssignedWork,
  type PurchaseOrder,
} from './reconcile.js';
import { createTrackingSink, GoogleTrackingSheet } from './trackingSink.js';
import { listOpenOffers } from './offersApi.js';
import {
  applySnapshot,
  emptyTrackerState,
  type OfferSnapshot,
  type SnapshotResult,
  type TrackerState,
} from './offerTracker.js';
import { createStrakerLogger, STRAKER_LOG_NAME } from './logger.js';
import { StrakerLedger } from './ledger.js';
import { StrakerOutbox, type StrakerOutboxOptions } from './outbox.js';
import { createOfferExtractor } from './offerParse.js';
import { createStrakerPollCycle } from './pollCycle.js';
import { enqueueQuarantineAlert, openStrakerDatabase, StrakerStore } from './strakerStore.js';
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
  /**
   * The claim door, and nothing else — deliberately narrower than the `StrakerHttpClient`
   * `createStrakerPortal` builds.
   *
   * `claimOffer` already narrows its own parameter, so nothing *inside* it can enquire
   * first (FR-002, V32). What that could not reach was the value handed to it: the poll
   * cycle held a whole client and cast it down at the call site, so a diagnostic `getJson`
   * added anywhere in the cycle would have compiled. Reads belong to `listOpenOffers`
   * below, which is the only read the bot makes.
   */
  readonly client: ClaimDoor;
  /** Signs in and reads the vendor identity back from the portal every time (FR-022) —
   *  never pinned in configuration, because it changes under impersonation or an account
   *  switch and a stale one would poll another vendor's work. */
  signIn(): Promise<StrakerSession>;
  listOpenOffers(vendorId: string): Promise<readonly RawOffer[]>;
  /**
   * The portal's assigned-work list, for reconciliation (FR-016a).
   *
   * A named capability rather than a wider `client`. Reconciliation needs `getJson`, and the
   * obvious move was to undo the narrowing above — which would hand the poll cycle a read
   * door again and lose the structural guarantee that nothing enquires before a claim
   * (FR-002/V32). Two named reads cost one line each and keep it.
   */
  listAssignedWork(vendorId: string): Promise<readonly AssignedWork[]>;
  /** Where won work waits for a person before it is assigned (2026-09-22). */
  listPurchaseOrders(vendorId: string): Promise<readonly PurchaseOrder[]>;
}

/**
 * Per-attempt deadline (Constitution VI). Chosen against two numbers: recon measured a round
 * trip of 256–670 ms, so 2 s is roughly three times the slowest response ever observed; and
 * the whole retry sequence — 4 attempts plus ~1.75 s of waits — lands near 9.75 s.
 *
 * **Revisited 2026-09-15, once T043 set the rhythm** (the note here used to say "revisit at
 * T043" and the revisit had not happened). The rhythm came out at **10 s**, so a worst-case
 * read of 9.75 s very nearly fills one interval — but it cannot overrun it, because the loop
 * sleeps *after* the cycle rather than on a fixed schedule: a maximally slow read stretches
 * that turn to ~19.75 s and the bot polls at half rate while the portal is struggling, which
 * is what FR-019b wants anyway. The original worry — a sub-second rhythm, where one bad read
 * would outlast several cycles — is off the table: T044's deferral records that the race is
 * decided at 204 s, not in milliseconds, so the rhythm is not going below ten.
 *
 * So 2 s stands, for a different reason than it was first chosen for. What would move it is a
 * shorter measured offer lifetime, which is the same observation that would reopen T044.
 */
const REQUEST_TIMEOUT_MS = 2_000;

/** Seams the tests use to drive the portal without a network. Production passes none. */
export interface StrakerPortalDeps {
  readonly fetchImpl?: typeof fetch;
  readonly onWarning?: (warning: StrakerTransportWarning) => void;
  /** The throttled pair from `notifier.ts`. Production passes them; a transport test does
   *  not, and falls back to the log-only handlers below. */
  readonly transportHooks?: TransportAlertHooks;
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
    // `tests/integration/straker/botWiring.test.ts` so it cannot happen a third time.
    timeoutMs: REQUEST_TIMEOUT_MS,
    // FR-019 / SC-003. Opt-in, exactly as the deadline and the retry door are, and for the
    // same reason: the live capture probe builds its client with `{ baseUrl }` alone and
    // must keep behaving as it does. Which makes this line the whole of the bot's pacing —
    // and `botWiring.test.ts` asserts it, because the two capabilities before this one were
    // each built, tested and left with no caller.
    //
    // `{}` takes every default: a hard ceiling of 240/minute (the measured 300 allowance
    // minus SC-003's 60 floor, so a client that cannot read the budget headers at all still
    // satisfies both halves of SC-003), deferrable work shed below 120 remaining, reading
    // paused below 60.
    pacing: {},
    onPacing: (event) =>
      report(() =>
        logger.warn(
          { module: 'httpClient', action: event.kind, outcome: event.cause, ...event },
          event.detail,
        ),
      ),
    // Both hooks come from `notifier.ts` (T055), which throttles them before they reach the
    // queue. They have to be throttled somewhere: neither carries an offer identity, so
    // FR-019a's "once per identity per outcome" has nothing to key on, and at a ten-second
    // rhythm a ten-minute outage would otherwise post about sixty cards into the channel
    // the live XTM bot also alerts on.
    //
    // Until this wiring landed both were log-only, with a comment saying a durable channel
    // was T054/T055's job — so the transport's alert path reached a file nobody watches.
    ...(deps.transportHooks ?? {
      onWarning:
        deps.onWarning ??
        ((warning) =>
          report(() =>
            logger.warn(
              { module: 'httpClient', action: warning.kind, outcome: warning.reason, ...warning },
              'request budget is not readable from the portal reply',
            ),
          )),
      onAlert: (alert: StrakerTransportAlert) =>
        report(() =>
          logger.error(
            { module: 'httpClient', action: alert.kind, outcome: 'exhausted', ...alert },
            'offer-list read gave up after exhausting its retry cap',
          ),
        ),
    }),
  });
  return {
    client,
    signIn: () =>
      openSession(client.essential, {
        loginId: cfg.loginId,
        password: cfg.password,
        ...(cfg.totpCode === undefined ? {} : { totpCode: cfg.totpCode }),
      }),
    // `retry: true` is the join FR-019b depends on — see `offersApi.ts`. The probe leaves
    // it off, which is what keeps its behaviour unchanged while it finishes collecting.
    listOpenOffers: (vendorId) => listOpenOffers(client, vendorId, { retry: true }),
    // Through the single-attempt door on purpose: FR-016c gives this read its own
    // fifteen-minute cadence instead of FR-019b's backoff. See `readAssignedWork`.
    listAssignedWork: (vendorId) => readAssignedWork(client, vendorId),
    listPurchaseOrders: (vendorId) => readPurchaseOrders(client, vendorId),
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

// --- The composition itself, as a value rather than as statements inside main() ---------

/** Seams the assembly tests use. Production passes none of them. */
export interface StrakerAssemblyDeps {
  readonly portal?: StrakerPortal;
  /** Injected by tests so delivery is asserted without a network. Production builds the
   *  real three from `cfg` below. */
  readonly senders?: StrakerSenders;
  readonly openDatabase?: typeof openStrakerDatabase;
  readonly now?: () => number;
  /** Retry cap and give-up age. A test lowers them so a dead backlog can be reached in one
   *  flush rather than in six hours; production takes the shared defaults. */
  readonly outboxOptions?: StrakerOutboxOptions;
}

export interface StrakerAssembly {
  readonly cycle: StrakerCycle;
  readonly store: StrakerStore;
  readonly outbox: StrakerOutbox;
  /**
   * Where the previous state file was renamed to, when it could not be opened — `null` on
   * every ordinary start. Returned rather than reported here: what a quarantine deserves is
   * the entry point's decision, and it is a different decision for a bot whose daily ceiling
   * is derived entirely from held work than for one that keeps a counter.
   */
  readonly quarantinedCopyPath: string | null;
  /** Releases the database handle. The long-running bot never calls it; a test does. */
  close(): void;
}

/**
 * Everything between the configuration and the startable bot.
 *
 * Extracted out of `main()` because `main()` is unreachable from a test — it runs only
 * behind an env-guarded module-level call — and a reviewer showed twice what that costs: the
 * offer extractor could be replaced by `() => []`, and the ledger's ceiling by a literal,
 * with the whole suite green and `tsc` clean. Neither is logic; both are **wiring**, a value
 * carried from configuration to the component that consumes it, and wiring is precisely what
 * a unit test of either end cannot see. Three capabilities in this feature have now shipped
 * built, tested and unreachable for that reason.
 *
 * So the composition is a function returning a value, and
 * `tests/integration/straker/botAssembly.test.ts` drives the result against payloads read
 * off disk: every line below is asserted by its effect on a real cycle.
 */
export function assembleStrakerBot(
  cfg: StrakerBotConfig,
  logger: Logger,
  deps: StrakerAssemblyDeps = {},
): StrakerAssembly {
  const now = deps.now ?? Date.now;
  const opened = (deps.openDatabase ?? openStrakerDatabase)(cfg.stateDir, now());
  const store = new StrakerStore(opened.db);
  const outbox = new StrakerOutbox(opened.db, deps.outboxOptions ?? {});
  // Here rather than in `main()`, despite the decision being the entry point's: a quarantine
  // is the one startup outcome that silently changes what the bot does all day — the held
  // set went with the file, so the ceiling reads zero committed work and every offer fits —
  // and `main()` is the one place a test cannot reach. Returns null on a healthy open, so
  // it is called unconditionally. `main()` still logs it; this is what a human sees.
  enqueueQuarantineAlert(outbox, opened, now());

  // Built before the portal, because the transport's own alerts have to reach the same
  // queue as everything else and the portal is what carries them.
  const senders =
    deps.senders ??
    ({
      offers: createStrakerOffersSender(new GoogleChatSender(cfg.offersWebhookUrl)),
      alerts: createStrakerAlertsSender(new GoogleChatSender(cfg.alertsWebhookUrl)),
      tracking: createTrackingSink(
        new GoogleTrackingSheet(
          cfg.trackingSheetId,
          cfg.trackingTabName,
          cfg.serviceAccountKeyPath,
        ),
      ),
    } satisfies StrakerSenders);

  const portal =
    deps.portal ??
    createStrakerPortal(cfg, logger, {
      transportHooks: createTransportAlertHooks({
        logger,
        now,
        raise: (eventId, alert) =>
          outbox.enqueue(eventId, 'alerts', JSON.stringify(alert), alert.occurredAtMs),
      }),
    });

  const dispatcher = createStrakerDispatcher(outbox, senders, logger);

  /**
   * One ceiling per kind of work, read once. The reconciler and the cycle each build their
   * own ledger, and two copies of this literal is the pair that silently diverges the day a
   * third kind is added to one of them.
   */
  const ceilings = { translation: cfg.maxWordsPerDay, monolingual: cfg.dtpMaxWordsPerDay };
  // The throughputs the gate measures each offer at. Handed to the ledger too, so a day's
  // capacity is measured at the same rate — see `StrakerLedger.dayCapacity`. `undefined`
  // before it keeps the default holiday calendar.
  const rates = {
    translation: cfg.throughputWordsPerHour,
    monolingual: cfg.dtpThroughputWordsPerHour,
  };
  // Same reason as `ceilings`: two ledgers, one calendar, declared once.
  const ledgerCalendar = {
    hoursStartMin: cfg.hoursStartMin,
    hoursEndMin: cfg.hoursEndMin,
    workdays: cfg.workdays,
  };
  const reconciler = createStrakerReconciler({
    portal,
    store,
    ledger: new StrakerLedger(store, ceilings, ledgerCalendar, undefined, rates),
    outbox,
    logger,
    now,
  });

  const cycle = createStrakerPollCycle({
    portal,
    // Resumed from the store, not started empty. The tracker's sighting count is what keys
    // every `offer_sightings` row, so a tracker that boots at zero writes back into
    // appearances a previous run already closed — see `StrakerStore.trackerState`.
    tracker: createSightingTracker(store.trackerState()),
    store,
    ledger: new StrakerLedger(store, ceilings, ledgerCalendar, undefined, rates),
    outbox,
    logger,
    settings: {
      throughputWordsPerHour: cfg.throughputWordsPerHour,
      // Both rates, because the gate picks by the kind of work in front of it. Passing only
      // the translation rate is how the DTP ceiling shipped configurable but unreachable.
      dtpThroughputWordsPerHour: cfg.dtpThroughputWordsPerHour,
      hoursStartMin: cfg.hoursStartMin,
      hoursEndMin: cfg.hoursEndMin,
      workdays: cfg.workdays,
    },
    extractOffers: createOfferExtractor({
      excludedLanguagePairs: cfg.excludedLanguagePairs,
      logger,
      // An offer the parser cannot read is passed over rather than taking the whole reading
      // down with it — but silently passing it over would be the other half of the same
      // failure, so it raises an alert. Keyed by offer identity, not by time: the portal
      // lists the same unreadable offer every ten seconds for as long as it stands, and on
      // 2026-09-17 that would have been seventeen identical pages in three minutes.
      onUnreadable: (objId, reason) => {
        const occurredAtMs = now();
        outbox.enqueue(
          `offer_unreadable:${objId ?? 'no-identity'}`,
          'alerts',
          JSON.stringify({
            kind: 'system',
            condition: 'offer_unreadable',
            subsystem: 'Straker offer parsing',
            occurredAtMs,
            consecutiveFailures: 1,
            failingSinceMs: occurredAtMs,
            detail: reason,
          } satisfies StrakerSystemAlert),
          occurredAtMs,
        );
      },
    }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });

  return {
    cycle: withDelivery({ cycle, dispatcher, reconciler, outbox, logger, now }),
    store,
    outbox,
    quarantinedCopyPath: opened.recoveredFromCorruption ? opened.corruptCopyPath : null,
    close: () => opened.db.close(),
  };
}

/**
 * The poll cycle, plus the two things that have to happen around it every turn: reconcile
 * if due, then drain the queue.
 *
 * **Here rather than inside `createStrakerPollCycle`** because the cycle's named steps are
 * the XTM loop's — fetch, diff, gate, act, persist, notify — and `notify` means *queued*,
 * not *delivered*. The XTM bot flushes at the loop level for the same reason (DC-3), and
 * keeping the two loops the same shape is what makes the later extraction mechanical.
 *
 * Reconciling **before** flushing, so a recovery found this pass is announced this pass
 * rather than waiting for the next one.
 *
 * Neither can fail the cycle. The boolean `runOnce` returns drives the liveness signal, and
 * that signal answers "is this bot still racing" — a Chat webhook being down is not an
 * answer to that question, and failing the heartbeat over it would page someone about the
 * wrong thing while the bot kept winning work. Nothing is lost by carrying on: the outcome
 * is already durable in the outbox, which is the entire point of queueing it first (FR-016).
 */
function withDelivery(deps: {
  readonly cycle: StrakerCycle;
  readonly dispatcher: {
    flush(nowMs: number): Promise<{ sent: number; failed: number; dead: number; dropped: number }>;
  };
  readonly reconciler: { runIfDue(): Promise<unknown> };
  /** Read only, and only for the dead backlog — the dispatcher owns every write. */
  readonly outbox: Pick<StrakerOutbox, 'countByStatus'>;
  readonly logger: Logger;
  readonly now: () => number;
}): StrakerCycle {
  return {
    async runOnce(): Promise<boolean> {
      const ok = await deps.cycle.runOnce();

      // `runIfDue` promises never to throw and costs one clock read when it is not due;
      // the guard is here because that promise belongs to another module and this one
      // cannot afford to find out it was broken.
      await reportAsync(async () => {
        await deps.reconciler.runIfDue();
      });

      let deadBacklog = 0;
      await reportAsync(async () => {
        const summary = await deps.dispatcher.flush(deps.now());
        // Only when something happened: at a ten-second rhythm a line per quiet cycle is
        // eight and a half thousand a day saying nothing.
        if (summary.sent + summary.failed + summary.dead + summary.dropped > 0) {
          deps.logger.info(
            { module: 'main', action: 'flush', outcome: 'ok', ...summary },
            'delivered queued outcomes',
          );
        }
        deadBacklog = deps.outbox.countByStatus('dead');
      });

      // A dead row is an outcome that will never be delivered until an operator requeues
      // it, and nothing else surfaces one: the dispatcher logs it, and a log line is not a
      // channel anybody watches. Gating the liveness signal on the **backlog** rather than
      // on this flush's count is what makes it persist — it stays red until the queue is
      // actually drained, which is the state that needs a human.
      //
      // A won claim whose announcement dies leaves the team owing work nobody was told
      // about, and reconciliation will not re-announce it: the work IS held, so there is
      // nothing missing for it to find. The live XTM bot has gated on this since 001.
      if (deadBacklog > 0) {
        deps.logger.error(
          { module: 'main', action: 'flush', outcome: 'dead_backlog', deadBacklog },
          'outcomes have been given up on undelivered — run `npm run straker:outbox:requeue` after fixing the destination',
        );
        return false;
      }

      return ok;
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

  const assembly = assembleStrakerBot(cfg, logger);
  if (assembly.quarantinedCopyPath !== null) {
    logger.error(
      {
        module: 'main',
        action: 'startup',
        outcome: 'db_quarantined',
        path: assembly.quarantinedCopyPath,
      },
      'the Straker state file was unusable and was quarantined — this run starts cold, and any work held before it is known only to the portal until reconciliation runs',
    );
  }

  const bot = await startStrakerBot({ cfg, logger, heartbeat, cycle: assembly.cycle });

  const shutdown = (signal: string): void => {
    logger.info({ module: 'main', action: 'shutdown', signal }, 'shutdown requested');
    void bot.stop().catch((e: unknown) => console.error('[jobcatch-straker] stop failed:', e));
  };
  // **Neither of these fires under PM2 on this host, and that is measured, not assumed.**
  // PM2 7 on Windows delivers no POSIX signal to a daemon-spawned process — no shutdown
  // line has ever appeared in either bot's log — and the `--shutdown-with-message` flag
  // that would send the IPC alternative does not exist in PM2 7 either. `pm2 stop` kills
  // the process outright, which releases the single-instance port (the OS closes the
  // socket) but skips `stop()`, so the last buffered log lines are lost with it.
  //
  // They are kept because they ARE reached the other way the bot is run: Ctrl-C in a
  // terminal, and `poll:once`-style manual runs. Registered rather than removed so that a
  // PM2 release which does deliver signals needs no change here.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
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
