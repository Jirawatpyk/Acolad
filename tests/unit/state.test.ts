import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { JobStore } from '../../src/state/jobStore.js';
import { Outbox, type OutboxRow } from '../../src/state/outbox.js';
import { SystemEventStore } from '../../src/state/systemEvents.js';
import { MetaStore } from '../../src/state/meta.js';
import type { JobState } from '../../src/detection/types.js';

let dir: string;
let db: DB;

const NOW = '2026-06-10T10:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acolad-state-'));
  db = openDatabase(dir, NOW).db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const state = (over: Partial<JobState> = {}): JobState => ({
  jobKey: 'J1',
  portalJobId: 'J1',
  title: 'Job 1',
  languagePair: 'EN>TH',
  deadline: null,
  deadlineRaw: null,
  fee: null,
  url: null,
  status: 'visible',
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  snapshotHash: 'h1',
  consecutiveMisses: 0,
  ...over,
});

describe('JobStore', () => {
  it('round-trips job state including consecutive_misses', () => {
    const store = new JobStore(db);
    store.upsertMany([state({ consecutiveMisses: 1, status: 'missing' })]);
    const loaded = store.loadAll();
    expect(loaded.get('J1')!.consecutiveMisses).toBe(1);
    expect(loaded.get('J1')!.status).toBe('missing');
  });

  it('upsert updates existing rows', () => {
    const store = new JobStore(db);
    store.upsertMany([state({ fee: '€100' })]);
    store.upsertMany([state({ fee: '€200' })]);
    expect(store.loadAll().get('J1')!.fee).toBe('€200');
  });
});

describe('Outbox', () => {
  it('enqueues idempotently per (event_id, channel)', () => {
    const ob = new Outbox(db, 10, 6);
    expect(ob.enqueue('e1', '{}', NOW)).toBe(true);
    expect(ob.enqueue('e1', '{}', NOW)).toBe(false);
    expect(ob.due(NOW)).toHaveLength(1);
  });

  it('marks sent and removes from due', () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', '{}', NOW);
    const [row] = ob.due(NOW);
    ob.markSent(row!.outbox_id, NOW);
    expect(ob.due(NOW)).toHaveLength(0);
    expect(ob.countByStatus('sent')).toBe(1);
  });

  it('applies backoff then flips to dead at the retry cap', () => {
    const ob = new Outbox(db, 3, 6);
    ob.enqueue('e1', '{}', NOW);
    const row = ob.due(NOW)[0] as OutboxRow;
    const nowMs = Date.parse(NOW);
    expect(ob.recordFailure({ ...row, attempts: 0 }, nowMs)).toBe('pending');
    expect(ob.recordFailure({ ...row, attempts: 1 }, nowMs)).toBe('pending');
    expect(ob.recordFailure({ ...row, attempts: 2 }, nowMs)).toBe('dead');
    expect(ob.countByStatus('dead')).toBe(1);
  });

  it('flips to dead when aged past deadAfterHours regardless of attempts', () => {
    const ob = new Outbox(db, 100, 6);
    ob.enqueue('e1', '{}', NOW);
    const row = ob.due(NOW)[0] as OutboxRow;
    const sevenHoursLater = Date.parse(NOW) + 7 * 3_600_000;
    expect(ob.recordFailure(row, sevenHoursLater)).toBe('dead');
  });

  it('requeues dead rows back to pending', () => {
    const ob = new Outbox(db, 1, 6);
    ob.enqueue('e1', '{}', NOW);
    ob.recordFailure(ob.due(NOW)[0]!, Date.parse(NOW));
    expect(ob.requeueDead(NOW)).toBe(1);
    expect(ob.due(NOW)).toHaveLength(1);
  });
});

describe('SystemEventStore', () => {
  it('dedupes a second active alert with the same dedup_key', () => {
    const se = new SystemEventStore(db);
    expect(
      se.create({
        eventType: 'system_alert',
        severity: 'critical',
        dedupKey: 'login_failed',
        payloadJson: '{}',
        occurredAt: NOW,
      }),
    ).not.toBeNull();
    expect(
      se.create({
        eventType: 'system_alert',
        severity: 'critical',
        dedupKey: 'login_failed',
        payloadJson: '{}',
        occurredAt: NOW,
      }),
    ).toBeNull();
    expect(se.hasActiveAlert('login_failed')).toBe(true);
  });

  it('allows a new alert after the previous one is resolved', () => {
    const se = new SystemEventStore(db);
    se.create({
      eventType: 'system_alert',
      severity: 'warn',
      dedupKey: 'portal_down',
      payloadJson: '{}',
      occurredAt: NOW,
    });
    expect(se.resolve('portal_down', NOW)).not.toBeNull();
    expect(se.hasActiveAlert('portal_down')).toBe(false);
    expect(
      se.create({
        eventType: 'system_alert',
        severity: 'warn',
        dedupKey: 'portal_down',
        payloadJson: '{}',
        occurredAt: NOW,
      }),
    ).not.toBeNull();
  });

  it('cold_start_summary is not constrained by the active-alert index', () => {
    const se = new SystemEventStore(db);
    expect(
      se.create({
        eventType: 'cold_start_summary',
        severity: 'info',
        dedupKey: 'cold_start',
        payloadJson: '{}',
        occurredAt: NOW,
      }),
    ).not.toBeNull();
    expect(
      se.create({
        eventType: 'cold_start_summary',
        severity: 'info',
        dedupKey: 'cold_start',
        payloadJson: '{}',
        occurredAt: NOW,
      }),
    ).not.toBeNull();
  });
});

describe('openDatabase corruption recovery (FR-017)', () => {
  it('quarantines a corrupt db file and starts fresh', () => {
    db.close();
    // Write garbage to the db path to simulate corruption.
    writeFileSync(join(dir, 'acolad.db'), 'not a sqlite file at all');
    const res = openDatabase(dir, NOW);
    expect(res.recoveredFromCorruption).toBe(true);
    expect(res.corruptCopyPath).toBeDefined();
    expect(new MetaStore(res.db).get('schema_version')).toBe('2');
    res.db.close();
  });
});

describe('MetaStore', () => {
  it('tracks baseline + last successful poll', () => {
    const meta = new MetaStore(db);
    expect(meta.baselineDone).toBe(false);
    meta.markBaselineDone();
    expect(meta.baselineDone).toBe(true);
    meta.recordSuccessfulPoll(NOW);
    expect(meta.get('last_successful_poll_at')).toBe(NOW);
  });
});

// (Partner PollCyclePersister restart-idempotency test removed with the partner
// code in T052; XTM restart-idempotency is covered by tests/integration/xtmCycle.test.ts.)
