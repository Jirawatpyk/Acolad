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
  RECONCILE_FAILURE_ALERT_THRESHOLD,
  RECONCILE_INTERVAL_MS,
  type AssignedWork,
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
    opts.ceiling ?? CEILING,
    { hoursStartMin: 9 * 60, workdays: new Set([1, 2, 3, 4, 5]) },
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
    expect(f.ledger.committedOn(DEADLINE_DAY, NOW_MS)).toBe(100);
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
      appendRow: async (values) => void rows.push([...values]),
      writeRow: async (rowNum, values) => void (rows[rowNum - 1] = [...values]),
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

    expect(f.queued.filter((q) => q.payload['condition'] === 'reconcile_failing')).toHaveLength(2);
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
  /** Seed the day to within `room` words of the ceiling, as earlier wins would have. */
  function seedNearlyFull(f: Fixture, room: number): void {
    f.store.hold({
      objId: 'earlier-win',
      effortWords: CEILING - room,
      deadlineMs: DEADLINE_MS,
      heldSinceMs: NOW_MS - 3_600_000,
    });
  }

  it('records and counts work that pushes the day past its ceiling', async () => {
    // Kills: refusing the hold, or trimming it to fit. The work is already committed on
    // the portal — the ledger is recording reality, not making a decision.
    const f = fixture({ assigned: [assignedWork('a', { effortWords: 500 })] });
    seedNearlyFull(f, 100);

    await f.reconciler.runIfDue();

    expect(f.store.heldWork().map((w) => w.objId)).toContain('a');
    expect(f.ledger.committedOn(DEADLINE_DAY, NOW_MS)).toBe(CEILING + 400);
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
      `taken ${DEADLINE_DAY} past its ceiling (${CEILING + 400} of ${CEILING} words)`,
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
      f.ledger.checkCapacity({ objId: 'next', effortWords: 1, deadlineMs: DEADLINE_MS }, NOW_MS),
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

  it('stops rather than looping forever when the portal never finishes the list', async () => {
    const c = client([{ items: [item('a')], total: 10_000, limit: 1, offset: 0 }]);

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
