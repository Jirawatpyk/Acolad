/**
 * Reconciliation — T047, T048, T049 (FR-016a..d, SC-009, V9, V24, V25).
 *
 * Driven against the REAL store, the REAL ledger and the REAL outbox on a temp SQLite
 * file, because every property under test is a property of those three together: that a
 * recovery lands on the ledger even past the ceiling, that the announcement is durable in
 * the same transaction as the state change, and that a rejected write takes the whole
 * recovery with it rather than leaving a held row nobody announced. Stubbing any of the
 * three would have tested the stub.
 *
 * Only the portal is a double: it is the one thing that cannot be run here, and it is also
 * the thing whose failure FR-016c is about.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../../src/monitoring/logger.js';
import { StrakerBudgetSuspendedError, StrakerHttpError } from '../../../src/straker/httpClient.js';
import { StrakerLedger } from '../../../src/straker/ledger.js';
import { StrakerOutbox } from '../../../src/straker/outbox.js';
import {
  createStrakerReconciler,
  readAssignedWork,
  readPurchaseOrders,
  RECONCILE_FAILURE_ALERT_THRESHOLD,
  RECONCILE_INTERVAL_MS,
  type AssignedWork,
  type PurchaseOrder,
  type ReconcileOutcome,
  type StrakerReconciler,
} from '../../../src/straker/reconcile.js';
import {
  openStrakerDatabase,
  StrakerStore,
  type OfferEvent,
  type StrakerDB,
} from '../../../src/straker/strakerStore.js';
import {
  createStrakerAlertsSender,
  createStrakerOffersSender,
} from '../../../src/straker/notifier.js';
import { createTrackingSink, type TrackingSheetApi } from '../../../src/straker/trackingSink.js';

const NOW_MS = Date.parse('2026-09-16T10:00:00+07:00'); // a Wednesday
const DEADLINE_MS = Date.parse('2026-09-16T17:00:00+07:00');
const DEADLINE_DAY = '2026-09-16';
const CEILING = 2_000;

const roots: string[] = [];
const openDbs: StrakerDB[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface QueuedRow {
  readonly eventId: string;
  readonly channel: string;
  readonly payload: Record<string, unknown>;
}

interface FixtureOptions {
  readonly assigned?: readonly AssignedWork[];
  readonly purchaseOrders?: readonly PurchaseOrder[];
  /** Thrown by the purchase-order read. */
  readonly poReadFails?: () => unknown | null;
  /** Thrown by the assigned-work read. A function so a test can change it per pass. */
  readonly readFails?: () => unknown | null;
  readonly signInFails?: () => unknown | null;
  /** Break the held-work read — the one call that sat outside every guard. */
  readonly heldWorkFails?: () => unknown | null;
  /** Make one recovery's announcement fail, to prove what the transaction covers. */
  readonly enqueueThrowsFor?: (eventId: string) => boolean;
  readonly recordEventThrowsFor?: (objId: string) => boolean;
  readonly ceiling?: number;
}

interface Fixture {
  readonly reconciler: StrakerReconciler;
  readonly store: StrakerStore;
  readonly ledger: StrakerLedger;
  readonly outbox: StrakerOutbox;
  readonly queued: QueuedRow[];
  readonly trace: string[];
  readonly logs: { level: string; fields: Record<string, unknown> }[];
  readonly reads: string[];
  readonly signIns: () => number;
  setNow(ms: number): void;
  setAssigned(work: readonly AssignedWork[]): void;
  setPurchaseOrders(orders: readonly PurchaseOrder[]): void;
  /** What the fake portal's assigned list currently reports. */
  assigned(): readonly AssignedWork[];
}

function tempStrakerDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'straker-reconcile-'));
  roots.push(root);
  const dir = join(root, 'straker');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fixture(opts: FixtureOptions = {}): Fixture {
  const opened = openStrakerDatabase(tempStrakerDir(), NOW_MS);
  openDbs.push(opened.db);

  const store = new StrakerStore(opened.db);
  const outbox = new StrakerOutbox(opened.db);
  const ledger = new StrakerLedger(
    store,
    { translation: opts.ceiling ?? CEILING, monolingual: opts.ceiling ?? CEILING },
    { hoursStartMin: 9 * 60, hoursEndMin: 18 * 60, workdays: new Set([1, 2, 3, 4, 5]) },
    // Fixed rather than the curated calendar: this suite is about reconciliation, and a
    // holiday moving under it would change which day the ledger buckets into.
    () => new Map<string, string>(),
  );

  const queued: QueuedRow[] = [];
  const trace: string[] = [];
  const logs: { level: string; fields: Record<string, unknown> }[] = [];
  const reads: string[] = [];
  let signIns = 0;
  let now = NOW_MS;
  let assigned = opts.assigned ?? [];
  let purchaseOrders = opts.purchaseOrders ?? [];

  // Thin tracing wrappers over the REAL store and outbox: they delegate every call, so
  // what is asserted below is the real SQLite behaviour, with the transaction boundary
  // made visible.
  const tracingStore = {
    transaction: <T>(fn: () => T): T => {
      trace.push('tx:begin');
      try {
        const out = store.transaction(fn);
        trace.push('tx:commit');
        return out;
      } catch (err) {
        trace.push('tx:rollback');
        throw err;
      }
    },
    recordEvent: (event: OfferEvent): void => {
      if (opts.recordEventThrowsFor?.(event.objId) === true) {
        throw new Error(`refusing to record ${event.objId}`);
      }
      trace.push(`recordEvent:${event.objId}:${event.eventType}`);
      store.recordEvent(event);
    },
    heldWork: () => {
      const failure = opts.heldWorkFails?.();
      if (failure !== null && failure !== undefined) throw failure;
      return store.heldWork();
    },
    sightingsOf: (objId: string) => store.sightingsOf(objId),
    backfillHeldIdentity: (
      objId: string,
      identity: Parameters<StrakerStore['backfillHeldIdentity']>[1],
    ) => store.backfillHeldIdentity(objId, identity),
    claimEventByWorkKey: (key: string) => store.claimEventByWorkKey(key),
    legacyClaimEffortNear: (deadlineMs: number, windowMs: number) =>
      store.legacyClaimEffortNear(deadlineMs, windowMs),
    metaFlagSetAt: (key: string) => store.metaFlagSetAt(key),
    setMetaFlag: (key: string, atMs: number) => store.setMetaFlag(key, atMs),
    claimedObjIds: () => store.claimedObjIds(),
  };

  const tracingOutbox = {
    enqueue: (eventId: string, channel: string, payloadJson: string, atMs: number) => {
      if (opts.enqueueThrowsFor?.(eventId) === true) {
        throw new Error(`destination refused ${eventId}`);
      }
      trace.push(`enqueue:${channel}:${eventId}`);
      queued.push({
        eventId,
        channel,
        payload: JSON.parse(payloadJson) as Record<string, unknown>,
      });
      return outbox.enqueue(eventId, channel as never, payloadJson, atMs);
    },
  };

  const logger: Logger = {
    info: (fields) => void logs.push({ level: 'info', fields }),
    warn: (fields) => void logs.push({ level: 'warn', fields }),
    error: (fields) => void logs.push({ level: 'error', fields }),
  };

  const reconciler = createStrakerReconciler({
    portal: {
      signIn: async () => {
        // Counted before the refusal, not after: what these tests measure is how many times
        // the bot POSTed the credentials, and a rejected attempt is still an attempt at a
        // portal that may be counting them towards a lockout.
        signIns += 1;
        const failure = opts.signInFails?.();
        if (failure !== null && failure !== undefined) throw failure;
        return { vendorId: 'vendor-1' };
      },
      listAssignedWork: async (vendorId: string) => {
        reads.push(vendorId);
        const failure = opts.readFails?.();
        if (failure !== null && failure !== undefined) throw failure;
        return assigned;
      },
      listPurchaseOrders: async () => {
        const failure = opts.poReadFails?.();
        if (failure !== null && failure !== undefined) throw failure;
        return purchaseOrders;
      },
    },
    store: tracingStore as never,
    ledger,
    outbox: tracingOutbox as never,
    logger,
    now: () => now,
  });

  return {
    reconciler,
    store,
    ledger,
    outbox,
    queued,
    trace,
    logs,
    reads,
    signIns: () => signIns,
    setNow: (ms) => void (now = ms),
    setAssigned: (work) => void (assigned = work),
    setPurchaseOrders: (orders) => void (purchaseOrders = orders),
    assigned: () => assigned,
  };
}

function assignedWork(objId: string, over: Partial<AssignedWork> = {}): AssignedWork {
  return {
    objId,
    status: 'assigned',
    effortWords: 100,
    deadlineMs: DEADLINE_MS,
    languageDirection: 'en-us>ms-my',
    reference: `aj-${objId}`,
    ...over,
  };
}

function ran(outcome: ReconcileOutcome): boolean {
  return outcome.ran;
}

/**
 * What the outbox actually holds, as against what the reconciler tried to put there.
 *
 * `Fixture.queued` records every `enqueue` CALL; this reads the rows that survived the
 * outbox's own `(event_id, channel)` dedup. Where a requirement is "on-call sees one
 * message", this is the honest reading of it — the deduplication is the outbox's job and
 * asserting on the attempts would be asserting that the caller re-implemented it.
 */
function delivered(f: Fixture): QueuedRow[] {
  return f.outbox.due(NOW_MS + 100 * RECONCILE_INTERVAL_MS).map((row) => ({
    eventId: row.eventId,
    channel: row.channel,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// T047 — on start, every 15 minutes, adding what is missing, marked recovered
// ---------------------------------------------------------------------------

describe('T047 reconciliation runs on start and at least every 15 minutes (FR-016a, SC-009, V9)', () => {
  it('runs on the very first call, before any interval has passed', async () => {
    // Kills: gating the first pass behind the interval, which would leave the window
    // FR-003 opens unclosed for the first fifteen minutes of every process life — and a
    // deploy is a process life.
    const f = fixture({ assigned: [assignedWork('a')] });

    const outcome = await f.reconciler.runIfDue();

    expect(ran(outcome)).toBe(true);
    expect(f.reads).toEqual(['vendor-1']);
  });

  it('does not run again before the interval has elapsed', async () => {
    // Kills: ignoring the clock and reading the portal on every call, which at the ten
    // second poll rhythm is ninety reads per fifteen minutes instead of one.
    const f = fixture({ assigned: [] });

    await f.reconciler.runIfDue();
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS - 1);
    const second = await f.reconciler.runIfDue();

    expect(ran(second)).toBe(false);
    expect(f.reads).toHaveLength(1);
  });

  it('runs again once the interval has elapsed', async () => {
    // Kills: an off-by-one on the boundary, and a wrong interval constant.
    const f = fixture({ assigned: [] });

    await f.reconciler.runIfDue();
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    const second = await f.reconciler.runIfDue();

    expect(ran(second)).toBe(true);
    expect(f.reads).toHaveLength(2);
  });

  it('holds the interval at fifteen minutes', () => {
    // Kills: a silent change of the cadence SC-009 is expressed in.
    expect(RECONCILE_INTERVAL_MS).toBe(15 * 60_000);
  });

  it('reports when the next pass falls due', async () => {
    const f = fixture({ assigned: [] });
    expect(f.reconciler.nextDueAtMs()).toBeNull();

    await f.reconciler.runIfDue();

    expect(f.reconciler.nextDueAtMs()).toBe(NOW_MS + RECONCILE_INTERVAL_MS);
  });
});

describe('T047 what the record is missing is added, and marked recovered (FR-016b, V9)', () => {
  it('records work the portal holds and our record does not, as a recovery', async () => {
    // THE mutation this test exists to kill: recording recovered work as an ordinary
    // `claim`. A win the bot recorded and a win it only discovered afterwards mean
    // different things about whether the bot is working, and collapsing the two hides a
    // recurring gap behind a healthy-looking claim history (FR-016b).
    const f = fixture({ assigned: [assignedWork('a')] });

    await f.reconciler.runIfDue();

    const events = f.store.eventsOf('a');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      objId: 'a',
      eventType: 'recovery',
      outcome: 'recovered',
      effortWords: 100,
      deadlineMs: DEADLINE_MS,
    });
    expect(events.map((e) => e.eventType)).not.toContain('claim');
  });

  it('counts recovered work on the ledger, so it consumes the day it lands on', async () => {
    const f = fixture({ assigned: [assignedWork('a')] });

    await f.reconciler.runIfDue();

    expect(f.store.heldWork()).toMatchObject([{ objId: 'a', effortWords: 100 }]);
    expect(f.ledger.committedOn(DEADLINE_DAY, NOW_MS, 'translation')).toBe(100);
  });

  it('announces the recovery durably rather than only logging it (FR-016)', async () => {
    const f = fixture({ assigned: [assignedWork('a')] });

    await f.reconciler.runIfDue();

    // Both destinations, and one row each. `offers` because somebody has to actually do
    // this work; `alerts` because the claim path lost a record and on-call is where that
    // is visible (FR-016b).
    const recovery = delivered(f).filter((q) => q.eventId === 'recovery:a');
    expect(recovery.map((q) => q.channel).sort()).toEqual(['alerts', 'offers']);

    // The news, for the people who will do the work (contract 2).
    const news = recovery.find((q) => q.channel === 'offers');
    expect(news?.payload).toMatchObject({
      objId: 'a',
      outcome: 'recovered',
      languageDirection: 'en-us>ms-my',
      effortWords: 100,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS,
    });

    // The signal that the claim path lost a record (contract 3). Neither substitutes for
    // the other, and the condition comes from the notifier's own outcome table.
    const alert = recovery.find((q) => q.channel === 'alerts');
    expect(alert?.payload).toMatchObject({
      kind: 'offer',
      condition: 'work_recovered',
      objId: 'a',
      occurredAtMs: NOW_MS,
    });
  });

  it('queues payloads both senders actually accept', async () => {
    // Kills: a payload that answers to no contract and is refused at delivery. A refused
    // row retries, dies, and the recovery then reaches nobody — indistinguishable from
    // reconciliation having found nothing.
    const f = fixture({ assigned: [assignedWork('a')] });
    await f.reconciler.runIfDue();

    const posted: unknown[] = [];
    // `post()` treats anything but 'ok' as a refusal, so the double must answer as the
    // real `ChatSender` does or this test would pass for the wrong reason.
    const chat = {
      send: async (payload: unknown) => {
        posted.push(payload);
        return 'ok' as const;
      },
    };
    const rows = delivered(f).filter((q) => q.eventId === 'recovery:a');

    const news = rows.find((q) => q.channel === 'offers');
    const alert = rows.find((q) => q.channel === 'alerts');
    await expect(createStrakerOffersSender(chat)(news?.payload)).resolves.toEqual({ ok: true });
    await expect(createStrakerAlertsSender(chat)(alert?.payload)).resolves.toEqual({ ok: true });
    expect(posted).toHaveLength(2);
  });

  it('queues the announcement inside the same transaction as the state change (FR-016)', async () => {
    const f = fixture({ assigned: [assignedWork('a')] });

    await f.reconciler.runIfDue();

    const begin = f.trace.indexOf('tx:begin');
    const commit = f.trace.indexOf('tx:commit');
    const record = f.trace.indexOf('recordEvent:a:recovery');
    const announce = f.trace.findIndex((t) => t.startsWith('enqueue:') && t.endsWith('recovery:a'));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(record).toBeGreaterThan(begin);
    expect(announce).toBeGreaterThan(record);
    expect(commit).toBeGreaterThan(announce);
  });

  it('rolls the whole recovery back when its announcement cannot be queued', async () => {
    // Kills: enqueueing outside the transaction. Half a recovery — held work nobody was
    // told about — is the state FR-016 exists to make impossible, and it is invisible
    // precisely because the ledger looks right.
    const f = fixture({
      assigned: [assignedWork('a'), assignedWork('b')],
      enqueueThrowsFor: (eventId) => eventId === 'recovery:a',
    });

    const outcome = await f.reconciler.runIfDue();

    expect(f.store.eventsOf('a')).toEqual([]);
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['b']);
    expect(outcome).toMatchObject({ ran: true, ok: false, stage: 'record' });
  });

  it('one bad recovery does not cost the others', async () => {
    const f = fixture({
      assigned: [assignedWork('a'), assignedWork('b'), assignedWork('c')],
      recordEventThrowsFor: (objId) => objId === 'b',
    });

    await f.reconciler.runIfDue();

    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['a', 'c']);
  });

  it('resolves a claim left unknown without overwriting what the claim recorded (V9)', async () => {
    // V9: a claim whose outcome is unknown is never retried; reconciliation repairs the
    // record and marks it recovered. The `unknown` row stays as it is — it is the honest
    // record that the request produced no answer, and its timestamp is what any later
    // latency or win-rate reading is measured from. Overwriting it would smooth away the
    // very gap FR-016b asks to keep visible.
    const f = fixture({ assigned: [assignedWork('a')] });
    f.store.recordEvent({
      objId: 'a',
      eventType: 'claim',
      outcome: 'unknown',
      effortWords: 100,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 60_000,
    });

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true });
    const byType = new Map(f.store.eventsOf('a').map((e) => [e.eventType, e]));
    expect(byType.get('claim')).toMatchObject({
      outcome: 'unknown',
      occurredAtMs: NOW_MS - 60_000,
    });
    expect(byType.get('recovery')).toMatchObject({ outcome: 'recovered', occurredAtMs: NOW_MS });
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['a']);
  });

  it('recovers work the portal holds even though our claim recorded a lost race', async () => {
    // The portal is the authority and our record is a copy. A `lost` claim beside work the
    // portal says is ours is a contradiction, and the truthful answer is that we hold it.
    const f = fixture({ assigned: [assignedWork('a')] });
    f.store.recordEvent({
      objId: 'a',
      eventType: 'claim',
      outcome: 'lost',
      effortWords: 100,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 60_000,
    });

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true });
    const byType = new Map(f.store.eventsOf('a').map((e) => [e.eventType, e]));
    expect(byType.get('claim')).toMatchObject({ outcome: 'lost' });
    expect(byType.get('recovery')).toMatchObject({ outcome: 'recovered' });
  });

  it('leaves work it already holds alone, however many passes run (SC-009)', async () => {
    // Kills: re-recovering and re-announcing on every pass, which at four passes an hour
    // turns one gap into ninety-six alerts a day and makes the real ones unfindable.
    const f = fixture({ assigned: [assignedWork('a')] });

    await f.reconciler.runIfDue();
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    await f.reconciler.runIfDue();
    f.setNow(NOW_MS + 2 * RECONCILE_INTERVAL_MS);
    const third = await f.reconciler.runIfDue();

    expect(third).toMatchObject({ ran: true, ok: true, recovered: [] });
    expect(f.store.heldWork()).toHaveLength(1);
    expect(
      f.queued.filter((q) => q.eventId === 'recovery:a' && q.channel === 'alerts'),
    ).toHaveLength(1);
  });

  it('does not put finished work back on the ledger', async () => {
    // Kills: recovering `delivered` jobs. Nothing releases held work today, so a delivered
    // job put on the ledger consumes its deadline day's capacity permanently.
    const f = fixture({ assigned: [assignedWork('a', { status: 'delivered' })] });

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, recovered: [] });
    expect(f.store.heldWork()).toEqual([]);
  });

  it('recovers work whose status it does not recognise, and says so', async () => {
    // The conservative direction: over-stating the ceiling costs an offer the bot passes
    // over, under-stating it costs a commitment the team cannot deliver. A status nobody
    // has seen is not evidence that the work is finished.
    const f = fixture({ assigned: [assignedWork('a', { status: 'escalated' })] });

    await f.reconciler.runIfDue();

    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['a']);
    const alert = delivered(f).find((q) => q.channel === 'alerts');
    expect(String(alert?.payload['detail'])).toMatch(
      /status "escalated" is one this bot has never seen/,
    );
  });

  it('never throws, whatever the portal does', async () => {
    const f = fixture({ readFails: () => 'a string, not an Error' });

    await expect(f.reconciler.runIfDue()).resolves.toMatchObject({ ran: true, ok: false });
  });

  it('does not start a second pass while one is still running', async () => {
    const f = fixture({ assigned: [] });

    const [first, second] = await Promise.all([f.reconciler.runIfDue(), f.reconciler.runIfDue()]);

    expect([ran(first), ran(second)].filter(Boolean)).toHaveLength(1);
    expect(f.reads).toHaveLength(1);
  });
});

describe('T047 work the portal holds whose numbers cannot be read', () => {
  it('records and holds work with an unreadable deadline, and names it', async () => {
    // It is already committed on the portal. Refusing it because a number was missing
    // would leave the team holding work that counts against nothing — the exact failure
    // FR-016a exists to repair, caused by the code meant to repair it.
    const f = fixture({ assigned: [assignedWork('a', { deadlineMs: null })] });

    await f.reconciler.runIfDue();

    expect(f.store.heldWork()).toMatchObject([{ objId: 'a', deadlineMs: null }]);
    expect(f.ledger.heldWorkMissingDeadline(NOW_MS)).toEqual(['a']);
    const alert = delivered(f).find((q) => q.channel === 'alerts');
    expect(String(alert?.payload['detail'])).toMatch(/deadline could not be read/);
    // Omitted rather than sent as null: the card renders an absent field as unknown.
    expect(alert?.payload).not.toHaveProperty('deadlineMs');
  });

  it('records and holds work with an unreadable effort, and says the day understates', async () => {
    const f = fixture({ assigned: [assignedWork('a', { effortWords: null })] });

    await f.reconciler.runIfDue();

    expect(f.store.heldWork()).toMatchObject([{ objId: 'a', effortWords: 0 }]);
    const alert = delivered(f).find((q) => q.channel === 'alerts');
    expect(String(alert?.payload['detail'])).toMatch(/word count could not be read/);
  });
});

describe('T047 the recovery reaches the tracking record (FR-014, FR-011a)', () => {
  /** An in-memory sheet, so the queued payload can be put through the REAL sink. */
  function fakeSheet(): TrackingSheetApi & { readonly rows: string[][] } {
    const rows: string[][] = [];
    let header: string[] = [];
    return {
      rows,
      getHeader: async () => header,
      setHeader: async (values) => void (header = [...values]),
      getKeyColumn: async () => ['_row_key', ...rows.map((r) => r[r.length - 1] ?? '')],
      // Sheet row 1 is the header, so data row n is rows[n - 2].
      getKeyAt: async (rowNum) => {
        const r = rows[rowNum - 2];
        return r === undefined ? '' : (r[r.length - 1] ?? '');
      },
      appendRow: async (values) => void rows.push([...values]),
      writeRow: async (rowNum, values) => void (rows[rowNum - 2] = [...values]),
    };
  }

  it('queues a tracking row the sink accepts, keyed as the sink keys it', async () => {
    // Kills: queuing a payload the sink refuses. A refused row retries, dies, and is then
    // a recovered job that silently never reached the record — the opposite of the point.
    const f = fixture({ assigned: [assignedWork('a')] });

    await f.reconciler.runIfDue();

    const row = delivered(f).find((q) => q.channel === 'tracking');
    expect(row?.eventId).toBe('row:a|recovery');
    expect(row?.payload).toMatchObject({
      eventType: 'recovery',
      objId: 'a',
      outcome: 'recovered',
      languageDirection: 'en-us>ms-my',
      effortWords: 100,
      deadlineMs: DEADLINE_MS,
      claimedAtMs: NOW_MS,
    });

    const sheet = fakeSheet();
    await expect(createTrackingSink(sheet)(row?.payload)).resolves.toEqual({ ok: true });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.rows[0]).toContain('en-us>ms-my');
  });

  it('says "never sighted" rather than inventing a first-seen time', async () => {
    const f = fixture({ assigned: [assignedWork('a')] });

    await f.reconciler.runIfDue();

    const row = delivered(f).find((q) => q.channel === 'tracking');
    expect(row?.payload['firstSeenAtMs']).toBeNull();
  });

  it('carries the real first sighting when the offer was seen and the record was lost', async () => {
    // The difference is diagnostic: a recovery with a sighting says the claim path dropped
    // a record; one without says the offer never reached us at all.
    const f = fixture({ assigned: [assignedWork('a')] });
    f.store.recordSighting({
      objId: 'a',
      sighting: 1,
      firstSeenAtMs: NOW_MS - 300_000,
      lastSeenAtMs: NOW_MS - 240_000,
    });

    await f.reconciler.runIfDue();

    const row = delivered(f).find((q) => q.channel === 'tracking');
    expect(row?.payload['firstSeenAtMs']).toBe(NOW_MS - 300_000);
  });

  it('charges recovered DTP work to the DTP budget, read off its own direction', async () => {
    // FR-016a recovers work no sighting recorded, so the offer that would have said
    // `monolingual` is long gone. The only evidence left is the direction the assigned list
    // reports, and `ja>ja` is what DTP preparation looks like there — this is the shape the
    // live database actually holds for the 2026-09-17 job. Filing it as translation would
    // charge a 956-word formatting job to a ceiling it was never measured against.
    const f = fixture({ assigned: [assignedWork('dtp', { languageDirection: 'ja>ja' })] });

    await f.reconciler.runIfDue();

    expect(f.store.heldWork()).toMatchObject([{ objId: 'dtp', kind: 'monolingual' }]);
  });

  it('falls back to the translation budget when the direction says nothing', async () => {
    // The stricter of the two ceilings, deliberately: an unknown kind must not be able to
    // buy the larger budget by being unreadable.
    const f = fixture({ assigned: [assignedWork('a', { languageDirection: null })] });

    await f.reconciler.runIfDue();

    expect(f.store.heldWork()).toMatchObject([{ objId: 'a', kind: 'translation' }]);
  });

  it('withholds the tracking row when the language direction cannot be read, and says so', async () => {
    // Kills: inventing a placeholder direction, and kills queuing a row the sink refuses.
    // Nothing in the store carries a language direction to fall back on — neither
    // `offer_events` nor `offer_sightings` has such a column — so there is no third option.
    const f = fixture({ assigned: [assignedWork('a', { languageDirection: null })] });

    await f.reconciler.runIfDue();

    expect(delivered(f).filter((q) => q.channel === 'tracking')).toEqual([]);
    // The recovery itself is unaffected: recorded, held, counted, announced.
    expect(f.store.eventsOf('a')).toMatchObject([{ eventType: 'recovery', outcome: 'recovered' }]);
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['a']);
    const alert = delivered(f).find((q) => q.channel === 'alerts');
    expect(String(alert?.payload['detail'])).toMatch(/language direction could not be read/i);
  });

  it('reads the direction out of the payload the portal actually sends', async () => {
    // Case 1 of the three: recon note 4.2 confirms `source_lang` / `target_lang` on a real
    // assigned-job payload, and they are formatted by the same function the offer path
    // uses, so the two spellings cannot drift apart.
    const reply = {
      items: [
        {
          obj_id: 'a',
          status: 'assigned',
          words: 4,
          due_at: '2026-08-21T05:59:59.999000Z',
          source_lang: 'EN-US',
          target_lang: 'ms-my',
          external_job_id: 'aj-175',
        },
      ],
      total: 1,
    };

    const work = await readAssignedWork({ getJson: async <T>() => reply as T }, 'v1');

    expect(work[0]?.languageDirection).toBe('en-us>ms-my');
  });
});

// ---------------------------------------------------------------------------
// T048 — three consecutive failures raise an alert
// ---------------------------------------------------------------------------

describe('T048 three consecutive reconciliation failures raise an alert (FR-016c, V24)', () => {
  /** Run `n` passes, stepping the clock by one interval each time. */
  async function passes(f: Fixture, n: number): Promise<ReconcileOutcome[]> {
    const out: ReconcileOutcome[] = [];
    for (let i = 0; i < n; i += 1) {
      f.setNow(NOW_MS + i * RECONCILE_INTERVAL_MS);
      out.push(await f.reconciler.runIfDue());
    }
    return out;
  }

  it('holds the threshold at three', () => {
    expect(RECONCILE_FAILURE_ALERT_THRESHOLD).toBe(3);
  });

  it('stays quiet for the first two failures', async () => {
    // Kills: alerting on the first failure, which at four passes an hour would page
    // on-call for every transient blip the next pass fixes.
    const f = fixture({ readFails: () => new Error('portal down') });

    const results = await passes(f, 2);

    expect(results.every((r) => r.ran && !r.ok)).toBe(true);
    expect(f.queued.filter((q) => q.payload['condition'] === 'reconcile_failing')).toEqual([]);
  });

  it('raises exactly one alert on the third consecutive failure', async () => {
    // THE mutation this test exists to kill: the third consecutive failure not alerting.
    // A reconciliation that has silently stopped looks exactly like one that keeps finding
    // nothing, which is the whole reason FR-016c is a requirement rather than a nicety.
    const f = fixture({ readFails: () => new Error('portal down') });

    const results = await passes(f, 3);

    const alerts = f.queued.filter((q) => q.payload['condition'] === 'reconcile_failing');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.channel).toBe('alerts');
    expect(String(alerts[0]?.payload['detail'])).toMatch(/failed 3 times running/);
    // Without the count AND the span, a three-failure blip and a day-long outage read
    // identically on the channel.
    expect(alerts[0]?.payload).toMatchObject({
      kind: 'system',
      consecutiveFailures: RECONCILE_FAILURE_ALERT_THRESHOLD,
      failingSinceMs: NOW_MS,
    });
    expect(results[2]).toMatchObject({
      ran: true,
      ok: false,
      consecutiveFailures: 3,
      alerted: true,
    });
  });

  it('posts the alert through the real sender, so V24 holds end to end', async () => {
    // This replaces a tripwire. When reconciliation was written `notifier.ts` had no card
    // for `reconcile_failing`, so the alert was queued, refused, retried and dead-lettered:
    // FR-016c was satisfied up to the queue and nowhere past it. Its author left a test
    // asserting that failure, designed to go red the day the card landed — which it did, on
    // 2026-09-15, when the notifier gained a `system` alert kind for exactly this.
    //
    // The queued payload goes through the REAL sender rather than a shape assertion,
    // because the gap was never in the shape: it was in whether anything would accept it.
    const f = fixture({ readFails: () => new Error('portal down') });
    for (let i = 0; i < RECONCILE_FAILURE_ALERT_THRESHOLD; i += 1) {
      f.setNow(NOW_MS + i * RECONCILE_INTERVAL_MS);
      await f.reconciler.runIfDue();
    }

    const alert = delivered(f).find((q) => q.payload['condition'] === 'reconcile_failing');
    const posted: unknown[] = [];
    const chat = {
      send: async (payload: unknown) => {
        posted.push(payload);
        return 'ok' as const;
      },
    };

    await expect(createStrakerAlertsSender(chat)(alert?.payload)).resolves.toEqual({ ok: true });
    // The card has to name the portal (FR-026b) — both bots' alerts land in one channel.
    expect(JSON.stringify(posted)).toContain('Straker');
    expect(JSON.stringify(posted)).toContain('Reconciliation Failing');

    // The log line stays regardless: the channel decides what pages a human, not what is
    // recoverable afterwards (Constitution V).
    expect(f.logs.filter((l) => l.level === 'error' && l.fields['action'] === 'pass')).toHaveLength(
      RECONCILE_FAILURE_ALERT_THRESHOLD,
    );
  });

  it('a success between failures resets the count', async () => {
    // Kills: counting total failures rather than consecutive ones, which would alert on
    // three unrelated blips spread across a healthy day.
    let down = true;
    const f = fixture({ readFails: () => (down ? new Error('portal down') : null) });

    await passes(f, 2);
    down = false;
    f.setNow(NOW_MS + 2 * RECONCILE_INTERVAL_MS);
    const recovered = await f.reconciler.runIfDue();
    down = true;
    f.setNow(NOW_MS + 3 * RECONCILE_INTERVAL_MS);
    await f.reconciler.runIfDue();
    f.setNow(NOW_MS + 4 * RECONCILE_INTERVAL_MS);
    const last = await f.reconciler.runIfDue();

    expect(recovered).toMatchObject({ ran: true, ok: true });
    expect(last).toMatchObject({ consecutiveFailures: 2, alerted: false });
    expect(f.queued.filter((q) => q.payload['condition'] === 'reconcile_failing')).toEqual([]);
  });

  it('a later outage alerts again rather than being deduplicated away', async () => {
    // Kills: keying the alert on the streak length alone. `reconcile_failing:3` would be
    // swallowed by the outbox's own dedup the second time an outage reaches three, which
    // is the one case where a repeat is not a duplicate.
    let down = true;
    const f = fixture({ readFails: () => (down ? new Error('portal down') : null) });

    await passes(f, 3);
    down = false;
    f.setNow(NOW_MS + 3 * RECONCILE_INTERVAL_MS);
    await f.reconciler.runIfDue();
    down = true;
    for (let i = 4; i <= 6; i += 1) {
      f.setNow(NOW_MS + i * RECONCILE_INTERVAL_MS);
      await f.reconciler.runIfDue();
    }

    // Read from the OUTBOX, not from `f.queued`. `queued` records every `enqueue` call,
    // and the deduplication being tested happens *inside* `StrakerOutbox.enqueue` — so
    // asserting on the calls asserted that two were attempted, which is true whatever the
    // key is. The mutation this test names in its own first line (keying on the streak
    // length alone) left it green. `delivered()` exists in this file for exactly this and
    // says so in its docstring.
    const alerts = delivered(f).filter((q) => q.payload['condition'] === 'reconcile_failing');
    expect(alerts).toHaveLength(2);
    // And they are two distinct events rather than one row read twice: the second outage
    // began later, which is what makes its alert not a duplicate of the first.
    expect(alerts[0]?.payload['failingSinceMs']).not.toEqual(alerts[1]?.payload['failingSinceMs']);
  });

  it('keeps its own cadence after a failure rather than retrying sooner (FR-016c)', async () => {
    // FR-016c is explicit that FR-019b's exponential backoff does NOT apply here: a retry
    // already a quarter of an hour away cannot meaningfully be slowed down, and layering
    // the two would leave two implementers each able to cite a requirement.
    const f = fixture({ readFails: () => new Error('portal down') });

    await f.reconciler.runIfDue();
    f.setNow(NOW_MS + 1_000);
    const immediate = await f.reconciler.runIfDue();

    expect(ran(immediate)).toBe(false);
    expect(f.reads).toHaveLength(1);
  });

  it('counts a pass that read fine but could not record as a failure', async () => {
    // A reconciliation that reads the portal and then writes nothing is not doing its job
    // either, and the next pass will meet exactly the same rows.
    const f = fixture({
      assigned: [assignedWork('a')],
      recordEventThrowsFor: () => true,
    });

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({
      ran: true,
      ok: false,
      stage: 'record',
      consecutiveFailures: 1,
    });
  });

  it('signs in again after an expired session rather than losing the whole window', async () => {
    let first = true;
    const f = fixture({
      assigned: [assignedWork('a')],
      readFails: () => {
        if (!first) return null;
        first = false;
        return new StrakerHttpError(401, '/assigned-jobs', 'expired');
      },
    });

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true });
    expect(f.signIns()).toBe(2);
    expect(f.store.heldWork()).toHaveLength(1);
  });

  it('does not sign in again after a barred account', async () => {
    // Contract 4a: reading a suspension as an expiry turns it into a sign-in storm
    // against a portal that has already said no.
    const f = fixture({ readFails: () => new StrakerHttpError(403, '/assigned-jobs', 'barred') });

    await f.reconciler.runIfDue();

    expect(f.signIns()).toBe(1);
    expect(f.reads).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T049 — recovered work counts past the ceiling, and warns
// ---------------------------------------------------------------------------

describe('T049 recovered work is counted even past the ceiling, and warns (FR-016d, V25)', () => {
  /**
   * Seed the day to within `room` words of the ceiling, as earlier wins would have.
   *
   * A win is held in our record AND listed on the portal's assigned list — that is what
   * having won it means. This used to seed only the record, which was harmless while absence
   * released nothing. Once it does, a win the portal does not list is a job the client
   * cancelled, and it is released like one: the fixture has to say what reality says.
   */
  function seedNearlyFull(f: Fixture, room: number): void {
    f.store.hold({
      objId: 'earlier-win',
      effortWords: CEILING - room,
      kind: 'translation',
      deadlineMs: DEADLINE_MS,
      heldSinceMs: NOW_MS - 3_600_000,
    });
    f.setAssigned([...f.assigned(), assignedWork('earlier-win', { effortWords: CEILING - room })]);
  }

  it('records and counts work that pushes the day past its ceiling', async () => {
    // Kills: refusing the hold, or trimming it to fit. The work is already committed on
    // the portal — the ledger is recording reality, not making a decision.
    const f = fixture({ assigned: [assignedWork('a', { effortWords: 500 })] });
    seedNearlyFull(f, 100);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork().map((w) => w.objId)).toContain('a');
    expect(f.ledger.committedOn(DEADLINE_DAY, NOW_MS, 'translation')).toBe(CEILING + 400);
  });

  it('warns when a recovery takes the day past its ceiling', async () => {
    // Kills: counting it silently. Crossing the ceiling because of work nobody recorded is
    // the signal that the claim path lost something, and it is the only one there is.
    const f = fixture({ assigned: [assignedWork('a', { effortWords: 500 })] });
    seedNearlyFull(f, 100);

    await f.reconciler.runIfDue();

    // FR-016d's warning rides in the one card this discovery raises, rather than as a
    // second alert about the same offer at the same moment (FR-019a).
    const warning = delivered(f).find((q) => q.channel === 'alerts');
    expect(warning?.payload).toMatchObject({ condition: 'work_recovered', objId: 'a' });
    expect(String(warning?.payload['detail'])).toContain(
      `taken ${DEADLINE_DAY} past its ceiling: ${CEILING + 400} words are now due by then, ` +
        `against the ${CEILING} the working time left through it can hold`,
    );
  });

  it('does not warn when the recovery still fits', async () => {
    const f = fixture({ assigned: [assignedWork('a', { effortWords: 50 })] });
    seedNearlyFull(f, 100);

    await f.reconciler.runIfDue();

    const alert = delivered(f).find((q) => q.channel === 'alerts');
    expect(String(alert?.payload['detail'])).not.toMatch(/ceiling/);
  });

  it('blocks further claims for that day as normal once the ceiling is crossed', async () => {
    // The second half of FR-016d, and the reason the first half is safe: recording reality
    // past the ceiling does not widen the ceiling.
    const f = fixture({ assigned: [assignedWork('a', { effortWords: 500 })] });
    seedNearlyFull(f, 100);

    await f.reconciler.runIfDue();

    expect(
      f.ledger.checkCapacity(
        { objId: 'next', effortWords: 1, deadlineMs: DEADLINE_MS, kind: 'translation' },
        NOW_MS,
      ),
    ).toMatchObject({ fits: false, reason: 'ceiling_reached' });
  });

  it('names the offer that crossed, on each recovery that crossed', async () => {
    const f = fixture({
      assigned: [assignedWork('a', { effortWords: 500 }), assignedWork('b', { effortWords: 500 })],
    });
    seedNearlyFull(f, 100);

    await f.reconciler.runIfDue();

    // One card per recovered offer, each naming the breach it caused — which is also
    // FR-019a's "once per offer identity per outcome".
    const breaches = delivered(f).filter(
      (q) => q.channel === 'alerts' && String(q.payload['detail']).includes('past its ceiling'),
    );
    expect(breaches.map((q) => q.payload['objId'])).toEqual(['a', 'b']);
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['earlier-win', 'a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// The read itself — the envelope, and the silent zero
// ---------------------------------------------------------------------------

describe('reading the portal assigned-work list (contract 5)', () => {
  function client(replies: readonly unknown[]): {
    getJson: <T>(path: string) => Promise<T>;
    paths: string[];
  } {
    const paths: string[] = [];
    let n = 0;
    return {
      paths,
      getJson: async <T>(path: string): Promise<T> => {
        paths.push(path);
        const reply = replies[Math.min(n, replies.length - 1)];
        n += 1;
        return reply as T;
      },
    };
  }

  const item = (objId: string): Record<string, unknown> => ({
    obj_id: objId,
    status: 'assigned',
    words: 4,
    due_at: '2026-09-16T10:00:00.000000Z',
    source_lang: 'en-us',
    target_lang: 'ms-my',
    external_job_id: `aj-${objId}`,
  });

  it('reads the envelope the assigned list actually returns', async () => {
    const c = client([{ items: [item('a')], total: 1, limit: 100, offset: 0 }]);

    const work = await readAssignedWork(c, 'v1');

    expect(work).toMatchObject([{ objId: 'a', status: 'assigned', effortWords: 4 }]);
    expect(c.paths).toEqual(['/api/vendors/v1/assigned-jobs?limit=100&offset=0']);
  });

  it('refuses a replayed page rather than counting it toward the total (page 2 = page 1)', async () => {
    // A portal that serves page one twice delivers `total` entries and looks complete — while
    // the real second page, and the work on it, was never read.
    const page = { items: [item('a'), item('b')], total: 4, limit: 2, offset: 0 };
    const c = client([page, { ...page, offset: 2 }]);

    await expect(readAssignedWork(c, 'v1', { pageLimit: 2 })).rejects.toThrow(/duplicate/i);
  });

  it('refuses a duplicate obj_id inside one page too', async () => {
    const c = client([{ items: [item('a'), item('a')], total: 2, limit: 100, offset: 0 }]);

    await expect(readAssignedWork(c, 'v1')).rejects.toThrow(/duplicate/i);
  });

  it('refuses a bare array rather than reading an envelope change as no work', async () => {
    // The silent zero, from the other side: `job-offers` returns a bare array and
    // `assigned-jobs` an envelope, and a permissive cast that reads one as the other says
    // the team holds nothing — which is indistinguishable from a healthy quiet day.
    const c = client([[item('a')]]);

    await expect(readAssignedWork(c, 'v1')).rejects.toThrow(/envelope|array/i);
  });

  it('refuses a reply whose items are not a list', async () => {
    const c = client([{ items: null, total: 0 }]);

    await expect(readAssignedWork(c, 'v1')).rejects.toThrow(/items/i);
  });

  it('refuses an entry with no identity', async () => {
    const c = client([{ items: [{ status: 'assigned' }], total: 1 }]);

    await expect(readAssignedWork(c, 'v1')).rejects.toThrow(/obj_id|identity/i);
  });

  it('reads every page, so work past the first page is not invisible', async () => {
    // Kills: reading page one only. An offer sitting on page two is an offer the record is
    // missing for as long as the pagination is ignored — SC-009 measured in days.
    const c = client([
      { items: [item('a'), item('b')], total: 3, limit: 2, offset: 0 },
      { items: [item('c')], total: 3, limit: 2, offset: 2 },
    ]);

    const work = await readAssignedWork(c, 'v1', { pageLimit: 2 });

    expect(work.map((w) => w.objId)).toEqual(['a', 'b', 'c']);
    expect(c.paths).toHaveLength(2);
  });

  it('refuses a short page that does not account for the total the portal claims', async () => {
    // The guard that makes release-on-absence safe, and the one gap the old positive-evidence
    // rule was really protecting against. A page shorter than `limit` is normally the
    // portal's own end-of-list signal — but when it arrives alongside a `total` it does not
    // reach, the two disagree and nothing here can say which is right. Returning the short
    // list would tell the reconciler that everything missing from it has been cancelled, and
    // it would hand back the ceiling for work the team still owes.
    const c = client([{ items: [item('a')], total: 2, limit: 100, offset: 0 }]);

    await expect(readAssignedWork(c, 'v1')).rejects.toThrow(/1 of 2|short list/i);
  });

  it('accepts a short page that does account for the total', async () => {
    // The ordinary case, and the control for the test above: one item, and the portal says
    // there is one. A guard that also refused this would fail every normal read.
    const c = client([{ items: [item('a')], total: 1, limit: 100, offset: 0 }]);

    expect((await readAssignedWork(c, 'v1')).map((w) => w.objId)).toEqual(['a']);
  });

  it('accepts an empty list the portal says is empty', async () => {
    // The steady state on a quiet day. `0 < 0` is false, so the guard must not fire here.
    const c = client([{ items: [], total: 0, limit: 100, offset: 0 }]);

    expect(await readAssignedWork(c, 'v1')).toEqual([]);
  });

  it('stops rather than looping forever when the portal never finishes the list', async () => {
    // Distinct entries per page: a replayed page is refused on its own grounds (duplicates),
    // and this test is about the page cap.
    const c = client(
      ['a', 'b', 'c', 'd'].map((id, offset) => ({
        items: [item(id)],
        total: 10_000,
        limit: 1,
        offset,
      })),
    );

    await expect(readAssignedWork(c, 'v1', { pageLimit: 1, maxPages: 3 })).rejects.toThrow(
      /pages|incomplete/i,
    );
    expect(c.paths).toHaveLength(3);
  });

  it('reads a zone-stamped deadline as the instant it states', async () => {
    const c = client([
      { items: [{ ...item('a'), due_at: '2026-09-16T10:00:00.999000Z' }], total: 1 },
    ]);

    const work = await readAssignedWork(c, 'v1');

    expect(work[0]?.deadlineMs).toBe(Date.parse('2026-09-16T10:00:00.999Z'));
  });

  it('leaves an unreadable deadline unread rather than inventing one', async () => {
    const c = client([{ items: [{ ...item('a'), due_at: 'next Tuesday' }], total: 1 }]);

    const work = await readAssignedWork(c, 'v1');

    expect(work[0]?.deadlineMs).toBeNull();
  });
});

describe('a pass shed to protect the request budget is not a failure (FR-019 vs FR-016c)', () => {
  /**
   * Reconciliation reads through the **deferrable** door on purpose — it is the one read
   * this bot can afford to skip, and FR-019 sheds it below 120 remaining. But being shed
   * and failing are different events with opposite responses: one is the bot obeying a rule
   * correctly, the other is work going unrecorded.
   *
   * Counted together, three shed passes — forty-five minutes of a busy portal — raise
   * FR-016c's "reconciliation has failed three times running" against a portal that is
   * perfectly healthy. That alert is the one an operator is meant to act on, and a version
   * of it that cries wolf during normal budget pressure is worse than none.
   */
  /** Local copy: the one above is scoped to another describe. `from` lets a second run
   *  continue the clock rather than restart it. */
  async function runPasses(f: Fixture, n: number, from = 0): Promise<ReconcileOutcome[]> {
    const out: ReconcileOutcome[] = [];
    for (let i = 0; i < n; i += 1) {
      f.setNow(NOW_MS + (from + i) * RECONCILE_INTERVAL_MS);
      out.push(await f.reconciler.runIfDue());
    }
    return out;
  }

  it('does not count a budget shed toward the three-strike alert', async () => {
    const f = fixture({
      readFails: () =>
        new StrakerBudgetSuspendedError(
          '/api/vendors/v/assigned-jobs',
          'budget_low',
          5,
          'deferrable work is suspended below 120 remaining',
        ),
    });

    const results = await runPasses(f, RECONCILE_FAILURE_ALERT_THRESHOLD + 1);

    expect(f.queued.filter((q) => q.payload['condition'] === 'reconcile_failing')).toEqual([]);
    expect(results[results.length - 1]).toMatchObject({ consecutiveFailures: 0 });
  });

  it('still counts a genuine failure that follows a shed, rather than losing the streak', async () => {
    // The shed must be invisible to the counter, not a reset of it: a portal that is both
    // busy and broken should still reach the alert.
    let shed = true;
    const f = fixture({
      readFails: () =>
        shed
          ? new StrakerBudgetSuspendedError(
              '/api/vendors/v/assigned-jobs',
              'budget_low',
              5,
              'suspended',
            )
          : new Error('portal down'),
    });

    await runPasses(f, 1);
    shed = false;
    await runPasses(f, RECONCILE_FAILURE_ALERT_THRESHOLD, 1);

    expect(f.queued.filter((q) => q.payload['condition'] === 'reconcile_failing')).toHaveLength(1);
  });
});

describe('a rejected sign-in is not retried as though the session had expired', () => {
  /**
   * The expiry retry exists because this pass runs only every fifteen minutes, so losing one
   * to an ordinary expiry costs a whole window. But the guard wrapped **both** calls — the
   * sign-in and the read — and a 401 from the login POST itself is indistinguishable from a
   * 401 on the read. So a wrong password was posted, read as "the session expired", and
   * posted again immediately.
   *
   * That matters more here than it looks. RP-1 records that this account's password was
   * shared over chat and is to be treated as compromised, and the portal's lockout policy is
   * unknown — contract §4a exists precisely because a bot that argues with a refusal is how
   * an account earns a permanent block rather than recovers from one. Doubling the failed
   * logins is the wrong direction to be wrong in.
   */
  it('attempts the login once when the credentials themselves are refused', async () => {
    const f = fixture({ signInFails: () => new StrakerHttpError(401, '/auth/login', 'bad creds') });

    f.setNow(NOW_MS);
    await f.reconciler.runIfDue();

    expect(f.signIns()).toBe(1);
  });

  it('still retries once when the session expires on the read, which is what the retry is for', async () => {
    let first = true;
    const f = fixture({
      readFails: () => {
        if (!first) return null;
        first = false;
        return new StrakerHttpError(401, '/assigned-jobs', 'expired');
      },
    });

    f.setNow(NOW_MS);
    await f.reconciler.runIfDue();

    expect(f.signIns()).toBe(2);
  });
});

describe('runIfDue keeps its never-throws promise (S3)', () => {
  /**
   * `runIfDue` is documented as never throwing, and the composition root relies on it —
   * `withDelivery` wraps it in a guard whose comment says "this one cannot afford to find
   * out it was broken". The promise was not kept: `store.heldWork()`, the success log and
   * the `logger.error` inside `fail()` itself all sat outside every try.
   *
   * The consequence was specific and permanent. `lastAttemptAtMs` is set **before** the
   * pass runs, so a throwing `heldWork()` meant reconciliation attempted a pass every
   * fifteen minutes, threw every time, advanced its own schedule every time, and **never
   * reconciled again for the life of the process** — with nothing but stderr saying so.
   *
   * Reconciliation is what repairs the FR-003 window. A bot that has silently stopped
   * reconciling is a bot accumulating work the record does not know about.
   */
  it('does not throw when the held-work read fails, and says so as a failure', async () => {
    const f = fixture({
      heldWorkFails: () => new Error('SQLITE_IOERR: disk I/O error'),
    });

    f.setNow(NOW_MS);
    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: false });
  });

  it('keeps reconciling on later passes rather than dying for the life of the process', async () => {
    // The permanent half. One bad read must cost one pass, not all of them.
    let broken = true;
    const f = fixture({
      heldWorkFails: () => (broken ? new Error('SQLITE_IOERR: disk I/O error') : null),
    });

    f.setNow(NOW_MS);
    await f.reconciler.runIfDue();
    broken = false;
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    const second = await f.reconciler.runIfDue();

    expect(second).toMatchObject({ ran: true, ok: true });
  });
});

describe('finished work gives its budget back (T056b, FR-016d)', () => {
  // The subtractive direction, which T053 deliberately left unbuilt because "a partial read
  // would free capacity for work the team genuinely holds". The rule that makes it safe is
  // POSITIVE EVIDENCE ONLY: release what this read *shows* as finished, never what it omits.
  // Absence therefore cannot release anything, which is what makes a partial or paginated
  // read harmless here rather than catastrophic.

  it('releases held work the portal reports as delivered, and the ceiling recovers', async () => {
    const f = fixture({ ceiling: 150 });

    // The team holds 100 words for the deadline day. Recovered through reconciliation, so
    // the hold is made by the same path production uses.
    f.setAssigned([assignedWork('job-1')]);
    f.setNow(NOW_MS);
    await f.reconciler.runIfDue();
    expect(f.store.heldWork()).toHaveLength(1);

    // A second 100-word offer for the same day does not fit under a 150 ceiling.
    const before = f.ledger.checkCapacity(
      { objId: 'job-2', effortWords: 100, deadlineMs: DEADLINE_MS, kind: 'translation' },
      NOW_MS,
    );
    expect(before.fits).toBe(false);

    // The portal now reports job-1 delivered.
    f.setAssigned([assignedWork('job-1', { status: 'delivered' })]);
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, released: ['job-1'] });
    expect(f.store.heldWork()).toHaveLength(0);

    // The load-bearing assertion: the budget came back, so the day can be claimed against
    // again. Kills a mutation that marks the row released without the ledger noticing.
    const after = f.ledger.checkCapacity(
      { objId: 'job-2', effortWords: 100, deadlineMs: DEADLINE_MS, kind: 'translation' },
      NOW_MS + RECONCILE_INTERVAL_MS,
    );
    expect(after.fits).toBe(true);
  });

  it('releases work a complete read does not mention, because the portal no longer has it', async () => {
    /**
     * This test asserted the OPPOSITE until 2026-09-17, on the argument that "a truncated
     * page looks exactly like 'the job is gone' — and treating it that way would free
     * capacity for work the team still owes."
     *
     * The danger was real; the remedy was in the wrong place. Refusing to read absence did
     * not make a short read safe, it only moved the cost: a job the CLIENT CANCELS vanishes
     * from the list with no status and no final page, so nothing could ever release it and
     * its words stayed charged against its deadline day permanently. `b7000ad1` — 956 words,
     * cancelled — did exactly that, and `released` had been `0` on all 132 reconciliation
     * passes the bot had ever run. Rule 1 had never fired once.
     *
     * Completeness is now checked where it is knowable: `readAssignedWork` throws on a list
     * shorter than the `total` the portal claims, so a truncated page fails the pass and
     * releases nothing — see the test below. A list that reaches the rule is one the portal
     * vouched for.
     */
    const f = fixture();

    f.setAssigned([assignedWork('job-1'), assignedWork('job-2')]);
    f.setNow(NOW_MS);
    await f.reconciler.runIfDue();
    expect(f.store.heldWork()).toHaveLength(2);

    // The portal now lists only job-1, and says so completely: job-2 is gone.
    f.setAssigned([assignedWork('job-1')]);
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    const early = await f.reconciler.runIfDue();

    // Not yet (2026-09-22). This work carries no work key, so a purchase order or assigned
    // job for it would never match by id either — absence from both lists cannot tell
    // "gone" from "moved on under a new id". It is held until its deadline is a day past,
    // the same rule keyed work has, and said so on the pass.
    expect(early).toMatchObject({ ran: true, ok: true, released: [] });
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['job-1', 'job-2']);
    expect(
      f.logs.some(
        (l) =>
          l.level === 'warn' &&
          l.fields['outcome'] === 'held_work_absent_keyless' &&
          l.fields['objId'] === 'job-2',
      ),
    ).toBe(true);

    f.setNow(DEADLINE_MS + 24 * 3_600_000 + RECONCILE_INTERVAL_MS);
    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, released: ['job-2'] });
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['job-1']);
  });

  it('does not release a job it has just won that the portal has not listed yet', async () => {
    // The race release-on-absence opens, and the reason for its grace. A claim writes
    // `held_work` the moment the portal answers; the job reaches the assigned list some
    // moments later. A pass landing in between sees "held, not listed" — and releasing it
    // would free the ceiling for a job the bot has JUST WON, so the next offer claimed
    // against that ceiling is an over-commitment that cannot be undone.
    const f = fixture({ ceiling: 150 });
    f.store.hold({
      objId: 'just-won',
      effortWords: 100,
      kind: 'translation',
      deadlineMs: DEADLINE_MS,
      heldSinceMs: NOW_MS - 5_000, // claimed five seconds ago
    });
    f.setAssigned([]); // the portal has not caught up
    f.setNow(NOW_MS);

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, released: [] });
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['just-won']);
    // And the ceiling it occupies is still occupied — the assertion that matters.
    expect(
      f.ledger.checkCapacity(
        { objId: 'next', effortWords: 100, deadlineMs: DEADLINE_MS, kind: 'translation' },
        NOW_MS,
      ).fits,
    ).toBe(false);
  });

  it('releases it once its deadline is a day past, not after one interval', async () => {
    // The other edge of the grace: it delays a release, it does not prevent one. This used
    // to release after a single interval; a keyless claim (an offer without job_ref or
    // service is still claimed) can never be matched by its purchase order or assigned job,
    // so one interval handed its ceiling back while the team still owed it.
    const f = fixture();
    f.store.hold({
      objId: 'long-gone',
      effortWords: 100,
      kind: 'translation',
      deadlineMs: DEADLINE_MS,
      heldSinceMs: NOW_MS - RECONCILE_INTERVAL_MS,
    });
    f.setAssigned([]);
    f.setNow(NOW_MS);

    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: true, ok: true, released: [] });

    // One minute short of the grace: still held.
    f.setNow(DEADLINE_MS + 24 * 3_600_000 - 60_000);
    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: true, ok: true, released: [] });

    f.setNow(DEADLINE_MS + 24 * 3_600_000 + RECONCILE_INTERVAL_MS);
    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, released: ['long-gone'] });
    expect(f.store.heldWork()).toEqual([]);
  });

  it('keeps keyless absent work with no deadline held, since no grace can end', async () => {
    const f = fixture();
    f.store.hold({
      objId: 'no-deadline',
      effortWords: 100,
      kind: 'translation',
      deadlineMs: null,
      heldSinceMs: NOW_MS - RECONCILE_INTERVAL_MS,
    });
    f.setAssigned([]);
    f.setNow(NOW_MS + 30 * 24 * 3_600_000);

    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: true, ok: true, released: [] });
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['no-deadline']);
  });

  it('gives the ceiling back when the absent work is released, not just the row', async () => {
    // The load-bearing half. Marking the row released without the ledger noticing leaves the
    // day exactly as blocked as before, which is the failure this whole change exists to fix.
    const f = fixture({ ceiling: 150 });

    f.setAssigned([assignedWork('job-1')]);
    f.setNow(NOW_MS);
    await f.reconciler.runIfDue();

    const blocked = f.ledger.checkCapacity(
      { objId: 'job-2', effortWords: 100, deadlineMs: DEADLINE_MS, kind: 'translation' },
      NOW_MS,
    );
    expect(blocked.fits).toBe(false);

    f.setAssigned([]); // the client cancelled it
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    await f.reconciler.runIfDue();

    // Absent but keyless, and its deadline not yet a day gone: still counted.
    expect(
      f.ledger.checkCapacity(
        { objId: 'job-2', effortWords: 100, deadlineMs: DEADLINE_MS, kind: 'translation' },
        NOW_MS + RECONCILE_INTERVAL_MS,
      ).fits,
    ).toBe(false);

    const later = DEADLINE_MS + 24 * 3_600_000 + RECONCILE_INTERVAL_MS;
    f.setNow(later);
    await f.reconciler.runIfDue();

    // A later-deadline offer, so the check is about the released row and not about an
    // overdue deadline.
    const freed = f.ledger.checkCapacity(
      {
        objId: 'job-2',
        effortWords: 100,
        deadlineMs: DEADLINE_MS + 2 * 24 * 3_600_000,
        kind: 'translation',
      },
      later,
    );
    expect(freed.fits).toBe(true);
  });

  it('never releases on a status it does not recognise', async () => {
    // `isFinished` is "recognised AND not outstanding", so an unknown word falls on the side
    // that keeps the work — the same asymmetry recovery already uses. A portal that renames
    // 'delivered' must not silently hand the ceiling back.
    const f = fixture();

    f.setAssigned([assignedWork('job-1')]);
    f.setNow(NOW_MS);
    await f.reconciler.runIfDue();

    f.setAssigned([assignedWork('job-1', { status: 'completed_v2' })]);
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, released: [] });
    expect(f.store.heldWork()).toHaveLength(1);
  });

  it('releasing twice is not an error, and the second pass reports nothing released', async () => {
    // Reconciliation runs every fifteen minutes against a portal that keeps reporting the
    // same delivered job. The second pass must be a no-op, not a repeated event.
    const f = fixture();

    f.setAssigned([assignedWork('job-1')]);
    f.setNow(NOW_MS);
    await f.reconciler.runIfDue();

    f.setAssigned([assignedWork('job-1', { status: 'delivered' })]);
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    const first = await f.reconciler.runIfDue();
    f.setNow(NOW_MS + 2 * RECONCILE_INTERVAL_MS);
    const second = await f.reconciler.runIfDue();

    expect(first).toMatchObject({ released: ['job-1'] });
    expect(second).toMatchObject({ ran: true, ok: true, released: [] });
  });
});

// ---------------------------------------------------------------------------
// Offer → purchase order → assigned job: one piece of work, three ids (2026-09-22)
// ---------------------------------------------------------------------------

const KEY = 'aj-1|ms-my|translation';
const IDENTITY = {
  jobRef: 'aj-1',
  title: 'NBA - NTRY Hangtag.xlsx',
  service: 'translation',
  workKey: KEY,
};

function purchaseOrder(poObjId: string, over: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    poObjId,
    status: 'pending',
    deadlineMs: DEADLINE_MS,
    languageDirection: 'en-us>ms-my',
    identity: { jobRef: 'aj-1', title: null, service: 'translation', workKey: KEY },
    ...over,
  };
}

/** A claim the poll cycle won, held under the OFFER's id with its work key. */
function holdWonClaim(f: Fixture, over: { heldSinceMs?: number; deadlineMs?: number } = {}): void {
  f.store.recordEvent({
    objId: 'offer-1',
    eventType: 'claim',
    outcome: 'won',
    effortWords: 100,
    deadlineMs: over.deadlineMs ?? DEADLINE_MS,
    occurredAtMs: over.heldSinceMs ?? NOW_MS,
    identity: IDENTITY,
  });
  f.store.hold({
    objId: 'offer-1',
    effortWords: 100,
    kind: 'translation',
    deadlineMs: over.deadlineMs ?? DEADLINE_MS,
    heldSinceMs: over.heldSinceMs ?? NOW_MS,
    identity: IDENTITY,
  });
}

/** Past the one-time adoption of pre-existing purchase orders. */
function adopted(f: Fixture): void {
  f.store.setMetaFlag('po_adoption_done', NOW_MS - 1);
}

describe('a won claim waiting at its purchase order stays counted (2026-09-22)', () => {
  it('keeps holding a claim whose purchase order is still pending, however long it waits', async () => {
    // THE bug: the job sat at /purchase-orders, absent from /assigned-jobs, and was released
    // one pass after it was won — freeing the ceiling for work the team still owed.
    const f = fixture({ ceiling: 150 });
    adopted(f);
    holdWonClaim(f);
    f.setPurchaseOrders([purchaseOrder('po-1')]);

    f.setNow(NOW_MS + 3 * RECONCILE_INTERVAL_MS);
    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, released: [], recovered: [] });
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['offer-1']);
    expect(
      f.ledger.checkCapacity(
        { objId: 'next', effortWords: 100, deadlineMs: DEADLINE_MS, kind: 'translation' },
        NOW_MS + 3 * RECONCILE_INTERVAL_MS,
      ).fits,
    ).toBe(false);
  });

  it('recognises the assigned job by its key, so the same work is not found a second time', async () => {
    // The second half of the bug: the job reappears under a new id and was recorded again
    // as "found by reconciliation" — a second row, a second card, a second alert.
    const f = fixture();
    adopted(f);
    holdWonClaim(f);
    f.setPurchaseOrders([purchaseOrder('po-1', { status: 'accepted' })]);
    f.setAssigned([assignedWork('job-9', { reference: 'aj-1', identity: IDENTITY })]);

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, recovered: [], released: [] });
    expect(f.queued).toEqual([]);
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['offer-1']);
  });

  it('releases the claim when its assigned job is delivered, matched by key', async () => {
    const f = fixture();
    adopted(f);
    holdWonClaim(f);
    f.setAssigned([
      assignedWork('job-9', { status: 'delivered', reference: 'aj-1', identity: IDENTITY }),
    ]);

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, released: ['offer-1'] });
    expect(f.store.heldWork()).toEqual([]);
  });

  it('releases the claim when its purchase order is revoked', async () => {
    const f = fixture();
    adopted(f);
    holdWonClaim(f);
    f.setPurchaseOrders([purchaseOrder('po-1', { status: 'revoked' })]);

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, released: ['offer-1'] });
  });

  it('lets the assigned job decide over its purchase order', async () => {
    // A confirmed purchase order with an assigned job still in progress is still owed.
    const f = fixture();
    adopted(f);
    holdWonClaim(f);
    f.setPurchaseOrders([purchaseOrder('po-1', { status: 'confirmed' })]);
    f.setAssigned([assignedWork('job-9', { status: 'in_progress', identity: IDENTITY })]);

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ released: [] });
  });

  it('keeps a purchase order in a status it has never seen', async () => {
    const f = fixture();
    adopted(f);
    holdWonClaim(f);
    f.setPurchaseOrders([purchaseOrder('po-1', { status: 'on_hold_v2' })]);

    f.setNow(NOW_MS + 2 * RECONCILE_INTERVAL_MS);
    expect(await f.reconciler.runIfDue()).toMatchObject({ released: [] });
  });

  it('does not release keyed work that matches nothing until its deadline is a day gone', async () => {
    // If the offer's service ever stops matching the purchase order's po_type, the key finds
    // nothing — and releasing on absence would bring the original bug straight back.
    const f = fixture();
    adopted(f);
    holdWonClaim(f, { heldSinceMs: NOW_MS - 2 * RECONCILE_INTERVAL_MS });

    const early = await f.reconciler.runIfDue();
    expect(early).toMatchObject({ released: [] });
    expect(
      f.logs.some((l) => l.level === 'warn' && l.fields['outcome'] === 'held_work_unmatched'),
    ).toBe(true);

    f.setNow(DEADLINE_MS + 86_400_000 + 1);
    expect(await f.reconciler.runIfDue()).toMatchObject({ released: ['offer-1'] });
  });

  it('fails the pass and releases nothing when the purchase-order read fails', async () => {
    const f = fixture();
    adopted(f);
    holdWonClaim(f, { heldSinceMs: NOW_MS - 2 * RECONCILE_INTERVAL_MS });
    const failing = fixture({ poReadFails: () => new Error('portal down') });
    adopted(failing);
    holdWonClaim(failing, { heldSinceMs: NOW_MS - 2 * RECONCILE_INTERVAL_MS });

    const outcome = await failing.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: false, stage: 'read' });
    expect(failing.store.heldWork()).toHaveLength(1);
  });
});

describe('a claim whose reply never came is settled by its purchase order (2026-09-22)', () => {
  it('turns an unknown claim into a won one when its purchase order appears', async () => {
    const f = fixture();
    adopted(f);
    f.store.recordEvent({
      objId: 'offer-1',
      eventType: 'claim',
      outcome: 'unknown',
      effortWords: 20,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 60_000,
      identity: IDENTITY,
    });
    f.setPurchaseOrders([purchaseOrder('po-1')]);

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, recovered: [] });
    expect(f.store.eventsOf('offer-1')).toContainEqual(
      expect.objectContaining({ eventType: 'claim', outcome: 'won', effortWords: 20 }),
    );
    expect(f.store.heldWork()).toEqual([
      expect.objectContaining({ objId: 'offer-1', effortWords: 20 }),
    ]);
    // The claim's own row and card, not a recovery.
    expect(f.queued.map((q) => q.eventId)).toEqual(
      expect.arrayContaining(['claim:offer-1:won', 'row:offer-1|claim:settled']),
    );
    expect(f.queued.find((q) => q.eventId === 'row:offer-1|claim:settled')?.payload).toMatchObject({
      outcome: 'won',
    });
    expect(f.queued.some((q) => q.eventId.startsWith('recovery:'))).toBe(false);
  });
});

describe('purchase orders nobody recorded', () => {
  it('recovers one found after the first pass, weighing it at zero words and saying so', async () => {
    const f = fixture();
    adopted(f);
    f.setPurchaseOrders([purchaseOrder('po-7')]);

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, recovered: ['po-7'] });
    expect(f.store.heldWork()).toEqual([
      expect.objectContaining({
        objId: 'po-7',
        effortWords: 0,
        identity: expect.objectContaining({ workKey: KEY }),
      }),
    ]);
    expect(f.queued.some((q) => q.eventId === 'recovery:po-7')).toBe(true);
  });

  it('adopts pending purchase orders silently on the first pass, at the largest effort claimed for that deadline', async () => {
    // The claims won before identities were recorded carry no key. Their purchase orders are
    // adopted once, without a card or a row each — they were announced when they were won —
    // at the largest effort any keyless claim for that deadline had, so the day is not
    // under-counted.
    const f = fixture();
    for (const [objId, words] of [
      ['old-1', 6],
      ['old-2', 20],
    ] as const) {
      f.store.recordEvent({
        objId,
        eventType: 'claim',
        outcome: 'won',
        effortWords: words,
        deadlineMs: DEADLINE_MS,
        occurredAtMs: NOW_MS - 3_600_000,
      });
    }
    f.setPurchaseOrders([
      purchaseOrder('po-1'),
      purchaseOrder('po-2', { identity: { ...IDENTITY, workKey: 'aj-2|ms-my|translation' } }),
    ]);

    const first = await f.reconciler.runIfDue();

    expect(first).toMatchObject({ ran: true, ok: true, recovered: [] });
    expect(f.queued).toEqual([]);
    expect(f.store.heldWork().map((w) => [w.objId, w.effortWords])).toEqual([
      ['po-1', 20],
      ['po-2', 20],
    ]);
    expect(f.store.metaFlagSetAt('po_adoption_done')).toBe(NOW_MS);

    // Once only: a purchase order that appears later is an ordinary recovery.
    f.setPurchaseOrders([
      ...f.store
        .heldWork()
        .map((w) => purchaseOrder(w.objId, { identity: w.identity ?? IDENTITY })),
      purchaseOrder('po-3', { identity: { ...IDENTITY, workKey: 'aj-3|ms-my|translation' } }),
    ]);
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    expect(await f.reconciler.runIfDue()).toMatchObject({ recovered: ['po-3'] });
  });

  it('fills in the identity of held work matched by its own id', async () => {
    const f = fixture();
    adopted(f);
    f.store.hold({
      objId: 'job-9',
      effortWords: 52,
      kind: 'translation',
      deadlineMs: DEADLINE_MS,
      heldSinceMs: NOW_MS,
    });
    f.setAssigned([assignedWork('job-9', { identity: IDENTITY })]);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork()[0]?.identity).toEqual(IDENTITY);
  });
});

describe('readPurchaseOrders', () => {
  const PO = {
    po_obj_id: '58da4c92-b729-4466-9e63-507445b7096f',
    status: 'pending',
    job_ref: 'aj-325',
    source_language_code: 'en-us',
    target_language_code: 'ko',
    po_type: 'translation',
    due_at: '2026-09-23T05:59:00Z',
  };

  function door(pages: unknown[]): { getJson: <T>(path: string) => Promise<T>; paths: string[] } {
    const paths: string[] = [];
    return {
      paths,
      getJson: async <T>(path: string): Promise<T> => {
        paths.push(path);
        return pages.shift() as T;
      },
    };
  }

  it('refuses a replayed page rather than counting it toward the total (page 2 = page 1)', async () => {
    const other = { ...PO, po_obj_id: 'po-other' };
    const page = { items: [PO, other], total: 4, page: 1, page_size: 2 };
    const d = door([page, { ...page, page: 2 }]);

    await expect(readPurchaseOrders(d, 'vendor-1', { pageSize: 2 })).rejects.toThrow(/duplicate/i);
  });

  it('reads the page the portal web app reads, and names each order by its key', async () => {
    const d = door([{ items: [PO], total: 1, page: 1, page_size: 100 }]);

    const orders = await readPurchaseOrders(d, 'vendor-1');

    expect(d.paths[0]).toBe(
      '/api/hitl/vendor/purchase-orders?vendor_id=vendor-1&sort_by=created_at&sort_order=desc&page=1&page_size=100',
    );
    expect(orders).toEqual([
      {
        poObjId: PO.po_obj_id,
        status: 'pending',
        deadlineMs: Date.parse('2026-09-23T05:59:00Z'),
        languageDirection: 'en-us>ko',
        identity: {
          jobRef: 'aj-325',
          title: null,
          service: 'translation',
          workKey: 'aj-325|ko|translation',
        },
      },
    ]);
  });

  it('reads a DTP order, whose language codes are empty, under the same key as its job', async () => {
    const d = door([
      {
        items: [
          {
            ...PO,
            job_ref: 'aj-295',
            source_language_code: '',
            target_language_code: '',
            po_type: 'dtp_prep',
          },
        ],
        total: 1,
      },
    ]);

    const [order] = await readPurchaseOrders(d, 'vendor-1');

    expect(order?.identity.workKey).toBe('aj-295||dtp_prep');
    expect(order?.languageDirection).toBeNull();
  });

  it('follows the pages to the total, and refuses a list shorter than it claims', async () => {
    const two = door([
      { items: [PO], total: 2 },
      { items: [{ ...PO, po_obj_id: 'po-2' }], total: 2 },
    ]);
    expect(await readPurchaseOrders(two, 'v', { pageSize: 1 })).toHaveLength(2);
    expect(two.paths[1]).toContain('page=2');

    const short = door([{ items: [PO], total: 5 }]);
    await expect(readPurchaseOrders(short, 'v')).rejects.toThrow(/1 of 5/);
  });

  it('refuses a reply that is not the envelope, rather than reading it as no orders', async () => {
    await expect(readPurchaseOrders(door([[PO]]), 'v')).rejects.toThrow(/envelope/);
    await expect(
      readPurchaseOrders(door([{ items: [{ ...PO, po_obj_id: '' }], total: 1 }]), 'v'),
    ).rejects.toThrow(/po_obj_id/);
  });
});

describe('review fixes — the paths the first cut missed (2026-09-22)', () => {
  function unknownClaim(
    f: Fixture,
    over: { languageDirection?: string; identity?: typeof IDENTITY } = {},
  ): void {
    f.store.recordEvent({
      objId: 'offer-1',
      eventType: 'claim',
      outcome: 'unknown',
      effortWords: 20,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 60_000,
      identity: over.identity ?? IDENTITY,
      languageDirection: over.languageDirection ?? 'en-us>ms-my',
    });
  }

  it('settles an unknown claim whose purchase order was accepted before the pass — from the assigned job', async () => {
    // The team accepted the order inside the 15 minutes; the job is already assigned. It was
    // being recovered as "never announced" while the claim row stayed Unknown.
    const f = fixture();
    adopted(f);
    unknownClaim(f);
    f.setAssigned([assignedWork('job-9', { effortWords: 20, identity: IDENTITY })]);

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, recovered: [] });
    expect(f.store.eventsOf('offer-1')).toContainEqual(
      expect.objectContaining({ eventType: 'claim', outcome: 'won' }),
    );
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['offer-1']);
    expect(f.queued.some((q) => q.eventId.startsWith('recovery:'))).toBe(false);
  });

  it('settles a DTP claim from its purchase order and still updates its sheet row', async () => {
    // A DTP order carries no language codes; the claim remembers its own direction.
    const f = fixture();
    adopted(f);
    const dtp = { ...IDENTITY, service: 'dtp_prep', workKey: 'aj-1||dtp_prep' };
    unknownClaim(f, { identity: dtp, languageDirection: 'ja>ja' });
    f.setPurchaseOrders([purchaseOrder('po-1', { languageDirection: null, identity: dtp })]);

    await f.reconciler.runIfDue();

    const row = f.queued.find((q) => q.eventId === 'row:offer-1|claim:settled');
    expect(row?.payload).toMatchObject({ outcome: 'won', languageDirection: 'ja>ja' });
  });

  it('raises held work counted at zero to the word count its assigned job reports', async () => {
    // A purchase order has no word count; the assigned job does. Left at zero, the day read
    // emptier than it was until the work was delivered.
    const f = fixture();
    adopted(f);
    f.setPurchaseOrders([purchaseOrder('po-7')]);
    await f.reconciler.runIfDue();
    expect(f.store.heldWork()[0]?.effortWords).toBe(0);

    f.setPurchaseOrders([purchaseOrder('po-7', { status: 'accepted' })]);
    f.setAssigned([assignedWork('job-9', { effortWords: 52, identity: IDENTITY })]);
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    await f.reconciler.runIfDue();

    expect(f.store.heldWork()).toEqual([
      expect.objectContaining({ objId: 'po-7', effortWords: 52, heldSinceMs: NOW_MS }),
    ]);
  });

  it('keeps a claim held while any stage still owes it, even beside a finished twin on the same key', async () => {
    // One job reference can come round again. A delivered first round must not release the
    // second round's pending order.
    const f = fixture();
    adopted(f);
    holdWonClaim(f);
    f.setAssigned([assignedWork('job-old', { status: 'delivered', identity: IDENTITY })]);
    f.setPurchaseOrders([purchaseOrder('po-2')]);

    f.setNow(NOW_MS + 2 * RECONCILE_INTERVAL_MS);
    expect(await f.reconciler.runIfDue()).toMatchObject({ released: [] });
  });

  it('settles an unknown claim on a pending order even when an older round of the key was assigned', async () => {
    const f = fixture();
    adopted(f);
    unknownClaim(f);
    f.setAssigned([assignedWork('job-old', { status: 'delivered', identity: IDENTITY })]);
    f.setPurchaseOrders([purchaseOrder('po-2')]);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['offer-1']);
  });

  it('adopts at the legacy effort even when the deadlines differ by seconds', async () => {
    const f = fixture();
    f.store.recordEvent({
      objId: 'old-1',
      eventType: 'claim',
      outcome: 'won',
      effortWords: 20,
      deadlineMs: DEADLINE_MS + 30_000,
      occurredAtMs: NOW_MS - 3_600_000,
    });
    f.setPurchaseOrders([purchaseOrder('po-1')]);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork()[0]?.effortWords).toBe(20);
  });

  it('prefers the claim due at the same moment over a larger one due hours away', async () => {
    // The half-day window is a fallback. When a keyless claim matches the deadline itself,
    // it is the better evidence for this order's size than a bigger job due later that day.
    const f = fixture();
    for (const [objId, words, offsetMs] of [
      ['same', 20, 30_000],
      ['later', 500, 6 * 3_600_000],
    ] as const) {
      f.store.recordEvent({
        objId,
        eventType: 'claim',
        outcome: 'won',
        effortWords: words,
        deadlineMs: DEADLINE_MS + offsetMs,
        occurredAtMs: NOW_MS - 3_600_000,
      });
    }
    f.setPurchaseOrders([purchaseOrder('po-1')]);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork()[0]?.effortWords).toBe(20);
  });

  it('weighs a recovered order at a keyless claim for its deadline rather than at zero', async () => {
    // A won offer that carried no job reference has no key; its order must still not be
    // counted at nothing.
    const f = fixture();
    adopted(f);
    f.store.recordEvent({
      objId: 'keyless',
      eventType: 'claim',
      outcome: 'won',
      effortWords: 300,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 60_000,
    });
    f.setPurchaseOrders([purchaseOrder('po-9')]);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork()).toEqual([
      expect.objectContaining({ objId: 'po-9', effortWords: 300 }),
    ]);
  });
});

describe('the pass line counts what the pass did (observability, 2026-09-22)', () => {
  function passLine(f: Fixture): Record<string, unknown> | undefined {
    return f.logs.find((l) => l.fields['module'] === 'reconcile' && l.fields['action'] === 'pass')
      ?.fields;
  }

  it('counts orders read, settlements and effort upgrades', async () => {
    const f = fixture();
    adopted(f);
    // An unknown claim that its purchase order settles.
    f.store.recordEvent({
      objId: 'offer-1',
      eventType: 'claim',
      outcome: 'unknown',
      effortWords: 20,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 60_000,
      identity: IDENTITY,
    });
    // Held work weighed at zero that its assigned job re-weighs.
    const otherKey = 'aj-2|ms-my|translation';
    const other = { jobRef: 'aj-2', title: null, service: 'translation', workKey: otherKey };
    f.store.hold({
      objId: 'po-2',
      effortWords: 0,
      kind: 'translation',
      deadlineMs: DEADLINE_MS,
      heldSinceMs: NOW_MS - 60_000,
      identity: other,
    });
    f.setPurchaseOrders([
      purchaseOrder('po-1'),
      purchaseOrder('po-2', { status: 'accepted', identity: other }),
    ]);
    f.setAssigned([assignedWork('job-2', { effortWords: 500, identity: other })]);

    const outcome = await f.reconciler.runIfDue();

    expect(passLine(f)).toMatchObject({
      outcome: 'ok',
      orders: 2,
      settled: 1,
      adopted: 0,
      effortUpgraded: 1,
    });
    expect(outcome).toMatchObject({
      ran: true,
      ok: true,
      settled: 1,
      adopted: 0,
      effortUpgraded: 1,
    });
  });

  it('counts adoptions on the one-time adoption pass', async () => {
    const f = fixture();
    f.setPurchaseOrders([purchaseOrder('po-1')]);

    await f.reconciler.runIfDue();

    expect(passLine(f)).toMatchObject({ orders: 1, settled: 0, adopted: 1, effortUpgraded: 0 });
  });
});

describe('a keyless win is held once, not twice, when its order or job appears (2026-09-22)', () => {
  /** A claim the poll cycle won from an offer that carried no job reference: no work key. */
  function holdKeylessWin(f: Fixture, effortWords = 100): void {
    f.store.recordEvent({
      objId: 'offer-k',
      eventType: 'claim',
      outcome: 'won',
      effortWords,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 60_000,
    });
    f.store.hold({
      objId: 'offer-k',
      effortWords,
      kind: 'translation',
      deadlineMs: DEADLINE_MS,
      heldSinceMs: NOW_MS - 60_000,
    });
  }
  const sum = (f: Fixture): number => f.store.heldWork().reduce((n, w) => n + w.effortWords, 0);

  it('transfers the hold to the recovered purchase order: one row, the same effort', async () => {
    const f = fixture();
    adopted(f);
    holdKeylessWin(f);
    f.setPurchaseOrders([purchaseOrder('po-1', { deadlineMs: DEADLINE_MS + 30_000 })]);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['po-1']);
    expect(sum(f)).toBe(100);
    expect(
      f.logs.some(
        (l) =>
          l.fields['action'] === 'transfer' &&
          l.fields['from'] === 'offer-k' &&
          l.fields['to'] === 'po-1',
      ),
    ).toBe(true);
  });

  it('transfers on the one-time adoption too', async () => {
    const f = fixture();
    holdKeylessWin(f);
    f.setPurchaseOrders([purchaseOrder('po-1')]);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['po-1']);
    expect(sum(f)).toBe(100);
  });

  it('transfers to a recovered assigned job whose words match', async () => {
    const f = fixture();
    adopted(f);
    holdKeylessWin(f);
    f.setAssigned([assignedWork('job-1', { identity: IDENTITY })]);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['job-1']);
    expect(sum(f)).toBe(100);
  });

  it('does not transfer when the deadline is more than a minute away', async () => {
    const f = fixture();
    adopted(f);
    holdKeylessWin(f);
    f.setAssigned([
      assignedWork('job-1', { identity: IDENTITY, deadlineMs: DEADLINE_MS + 61_000 }),
    ]);

    await f.reconciler.runIfDue();

    expect(
      f.store
        .heldWork()
        .map((w) => w.objId)
        .sort(),
    ).toEqual(['job-1', 'offer-k']);
  });

  it('transfers one-to-one: two orders cannot both take the same keyless row', async () => {
    const f = fixture();
    adopted(f);
    holdKeylessWin(f);
    const other = {
      jobRef: 'aj-2',
      title: null,
      service: 'translation',
      workKey: 'aj-2|ms-my|translation',
    };
    f.setAssigned([
      assignedWork('job-1', { identity: IDENTITY }),
      assignedWork('job-2', { identity: other }),
    ]);

    await f.reconciler.runIfDue();

    expect(
      f.store
        .heldWork()
        .map((w) => w.objId)
        .sort(),
    ).toEqual(['job-1', 'job-2']);
    expect(sum(f)).toBe(200);
  });
});

describe('until a first pass succeeds, reconciliation retries every minute (2026-09-22)', () => {
  it('runs again one minute after a failed first pass, then keeps the fifteen-minute cadence', async () => {
    let down = true;
    const f = fixture({ poReadFails: () => (down ? new Error('portal down') : null) });

    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: true, ok: false });
    f.setNow(NOW_MS + 30_000);
    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: false, reason: 'not_due' });
    f.setNow(NOW_MS + 60_000);
    down = false;
    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: true, ok: true });

    // Once one has succeeded, a failure is retried on the ordinary cadence again.
    down = true;
    f.setNow(NOW_MS + 60_000 + RECONCILE_INTERVAL_MS);
    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: true, ok: false });
    f.setNow(NOW_MS + 2 * 60_000 + RECONCILE_INTERVAL_MS);
    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: false, reason: 'not_due' });
  });

  it('does not count a pass shed to protect the budget as the first success', async () => {
    let shed = true;
    const f = fixture({
      readFails: () =>
        shed
          ? new StrakerBudgetSuspendedError(
              '/api/vendors/v/assigned-jobs',
              'budget_low',
              5,
              'suspended',
            )
          : null,
    });

    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: true, ok: false, shed: true });
    shed = false;
    f.setNow(NOW_MS + 60_000);
    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: true, ok: true });
  });
});

// ---------------------------------------------------------------------------
// Log-only signals reach Chat, once per offer (follow-ups, 2026-09-22)
// ---------------------------------------------------------------------------

describe('held work kept on absence alerts once per offer, not only in the log', () => {
  const alertsFor = (f: Fixture, condition: string): QueuedRow[] =>
    delivered(f).filter((q) => q.channel === 'alerts' && q.payload['condition'] === condition);

  it('raises held_work_unmatched once for keyed work that matches nothing, and keeps the per-pass warn', async () => {
    const f = fixture();
    adopted(f);
    holdWonClaim(f, { heldSinceMs: NOW_MS - 2 * RECONCILE_INTERVAL_MS });

    await f.reconciler.runIfDue();
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    await f.reconciler.runIfDue();

    const alerts = alertsFor(f, 'held_work_unmatched');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      eventId: 'held_work_unmatched:offer-1',
      payload: {
        kind: 'offer',
        objId: 'offer-1',
        effortWords: 100,
        deadlineMs: DEADLINE_MS,
        jobRef: 'aj-1',
        service: 'translation',
        title: IDENTITY.title,
        occurredAtMs: NOW_MS,
      },
    });
    expect(String(alerts[0]?.payload['detail'])).toContain(KEY);
    expect(
      f.logs.filter((l) => l.level === 'warn' && l.fields['outcome'] === 'held_work_unmatched'),
    ).toHaveLength(2);
    // And the alerts sender accepts what was queued: a condition it does not know would
    // retry into `dead` instead of reaching anyone.
    const posted: unknown[] = [];
    const send = createStrakerAlertsSender({
      send: async (card: unknown) => {
        posted.push(card);
        return 'ok';
      },
    } as never);
    expect(await send(alerts[0]?.payload)).toEqual({ ok: true });
    expect(JSON.stringify(posted[0])).toContain('⚠️');
  });

  it('raises held_work_absent_keyless once for keyless work absent from both lists', async () => {
    const f = fixture();
    adopted(f);
    f.store.hold({
      objId: 'job-2',
      effortWords: 70,
      kind: 'translation',
      deadlineMs: DEADLINE_MS,
      heldSinceMs: NOW_MS - 2 * RECONCILE_INTERVAL_MS,
    });

    await f.reconciler.runIfDue();
    f.setNow(NOW_MS + RECONCILE_INTERVAL_MS);
    await f.reconciler.runIfDue();

    const alerts = alertsFor(f, 'held_work_absent_keyless');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      eventId: 'held_work_absent_keyless:job-2',
      payload: { kind: 'offer', objId: 'job-2', effortWords: 70, deadlineMs: DEADLINE_MS },
    });
    expect(
      f.logs.filter(
        (l) => l.level === 'warn' && l.fields['outcome'] === 'held_work_absent_keyless',
      ),
    ).toHaveLength(2);
  });

  it('a refused alert neither fails the pass nor skips the other held rows', async () => {
    // releaseFinished runs outside any transaction, so a throw here would escape into the
    // pass — and skip every held row after it.
    const f = fixture({ enqueueThrowsFor: (id) => id === 'held_work_absent_keyless:job-a' });
    adopted(f);
    for (const objId of ['job-a', 'job-b']) {
      f.store.hold({
        objId,
        effortWords: 70,
        kind: 'translation',
        deadlineMs: DEADLINE_MS,
        heldSinceMs: NOW_MS - 2 * RECONCILE_INTERVAL_MS,
      });
    }

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true });
    expect(alertsFor(f, 'held_work_absent_keyless').map((q) => q.eventId)).toEqual([
      'held_work_absent_keyless:job-b',
    ]);
    expect(
      f.logs.some(
        (l) =>
          l.level === 'error' && l.fields['action'] === 'alert' && l.fields['objId'] === 'job-a',
      ),
    ).toBe(true);
  });
});

describe('a purchase order adopted without a word count alerts once', () => {
  const adoptAlerts = (f: Fixture): QueuedRow[] =>
    delivered(f).filter((q) => q.payload['condition'] === 'adopted_without_effort');

  it('alerts when no earlier claim gave the order a word count', async () => {
    const f = fixture();
    f.setPurchaseOrders([purchaseOrder('po-1')]);

    expect(await f.reconciler.runIfDue()).toMatchObject({ ran: true, ok: true, adopted: 1 });

    const alerts = adoptAlerts(f);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      eventId: 'adopted_without_effort:po-1',
      channel: 'alerts',
      payload: { kind: 'offer', objId: 'po-1', deadlineMs: DEADLINE_MS, jobRef: 'aj-1' },
    });
    // The held row is still there: the alert rides beside the adoption, it does not replace it.
    expect(f.store.heldWork().map((w) => [w.objId, w.effortWords])).toEqual([['po-1', 0]]);
  });

  it('alerts when the earlier claim recorded zero words', async () => {
    const f = fixture();
    f.store.recordEvent({
      objId: 'old-0',
      eventType: 'claim',
      outcome: 'won',
      effortWords: 0,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 3_600_000,
    });
    f.setPurchaseOrders([purchaseOrder('po-1')]);

    await f.reconciler.runIfDue();

    expect(adoptAlerts(f).map((q) => q.eventId)).toEqual(['adopted_without_effort:po-1']);
  });

  it('stays silent when the adoption found a real word count', async () => {
    const f = fixture();
    f.store.recordEvent({
      objId: 'old-1',
      eventType: 'claim',
      outcome: 'won',
      effortWords: 20,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 3_600_000,
    });
    f.setPurchaseOrders([purchaseOrder('po-1')]);

    await f.reconciler.runIfDue();

    expect(adoptAlerts(f)).toEqual([]);
  });
});

describe('a transferred keyless win is not announced a second time as recovered', () => {
  function holdKeylessWin(f: Fixture): void {
    f.store.recordEvent({
      objId: 'offer-k',
      eventType: 'claim',
      outcome: 'won',
      effortWords: 100,
      deadlineMs: DEADLINE_MS,
      occurredAtMs: NOW_MS - 60_000,
    });
    f.store.hold({
      objId: 'offer-k',
      effortWords: 100,
      kind: 'translation',
      deadlineMs: DEADLINE_MS,
      heldSinceMs: NOW_MS - 60_000,
    });
  }

  it('records the recovery and moves the hold, but queues no card, alert or row for it', async () => {
    const f = fixture();
    adopted(f);
    holdKeylessWin(f);
    f.setAssigned([assignedWork('job-1', { identity: IDENTITY })]);

    const outcome = await f.reconciler.runIfDue();

    expect(outcome).toMatchObject({ ran: true, ok: true, recovered: ['job-1'] });
    expect(f.trace).toContain('recordEvent:job-1:recovery');
    expect(f.store.heldWork().map((w) => w.objId)).toEqual(['job-1']);
    expect(f.queued.filter((q) => q.eventId.includes('job-1'))).toEqual([]);
    expect(
      f.logs.some(
        (l) =>
          l.level === 'info' &&
          l.fields['module'] === 'reconcile' &&
          l.fields['action'] === 'transfer' &&
          l.fields['announced'] === false &&
          l.fields['from'] === 'offer-k' &&
          l.fields['to'] === 'job-1',
      ),
    ).toBe(true);
  });

  it('still announces a recovery that took nothing over', async () => {
    const f = fixture();
    adopted(f);
    f.setAssigned([assignedWork('job-1', { identity: IDENTITY })]);

    await f.reconciler.runIfDue();

    const ids = f.queued
      .filter((q) => q.eventId.includes('job-1'))
      .map((q) => `${q.channel}:${q.eventId}`);
    expect(ids).toContain('offers:recovery:job-1');
    expect(ids).toContain('alerts:recovery:job-1');
    expect(ids.some((id) => id.startsWith('tracking:'))).toBe(true);
  });
});
