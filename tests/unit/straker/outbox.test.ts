/**
 * T015 — durable outcome delivery (FR-016, FR-016b, V11).
 *
 * The requirement is one sentence: an outcome must not be lost when a reporting
 * destination is unavailable, and must be delivered once it recovers. Everything below is
 * that sentence taken apart — the queue survives the outage, survives a restart, counts
 * its attempts, backs off instead of hammering, and when it finally gives up it says so
 * loudly enough to be requeued rather than dropping the outcome on the floor.
 *
 * Straker's own queue in Straker's own database. The XTM bot's `outbox` table is never
 * touched, which is asserted here against a real XTM database rather than asserted in a
 * comment.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../../src/state/db.js';
import { openStrakerDatabase, type StrakerDB } from '../../../src/straker/strakerStore.js';
import { StrakerOutbox, type StrakerOutboxRow } from '../../../src/straker/outbox.js';

const NOW_MS = Date.parse('2026-09-14T10:00:00+07:00');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const roots: string[] = [];
const openDbs: StrakerDB[] = [];

function tempRoot(): { root: string; xtmDir: string; strakerDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'straker-outbox-'));
  roots.push(root);
  const xtmDir = join(root, 'xtm');
  const strakerDir = join(root, 'straker');
  mkdirSync(xtmDir, { recursive: true });
  mkdirSync(strakerDir, { recursive: true });
  return { root, xtmDir, strakerDir };
}

function freshOutbox(options?: { retryCap?: number; deadAfterHours?: number }): {
  outbox: StrakerOutbox;
  dir: string;
} {
  const { strakerDir } = tempRoot();
  const opened = openStrakerDatabase(strakerDir, NOW_MS);
  openDbs.push(opened.db);
  return {
    outbox:
      options === undefined ? new StrakerOutbox(opened.db) : new StrakerOutbox(opened.db, options),
    dir: strakerDir,
  };
}

/** The payload is opaque to the queue — the offer model is blocked by SC-000, and the
 *  queue is deliberately indifferent to what it carries. */
const payload = (note: string): string => JSON.stringify({ note });

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// V11 — a destination being down loses no outcome
// ---------------------------------------------------------------------------

describe('an outcome survives its destination being unavailable', () => {
  it('keeps the outcome queued through a failing destination and delivers it on recovery', () => {
    const { outbox } = freshOutbox();
    outbox.enqueue('offer-1:claim', 'tracking', payload('won'), NOW_MS);

    // The destination is down: the row is handed out, fails, and stays queued.
    const [firstTry] = outbox.due(NOW_MS);
    expect(firstTry?.eventId).toBe('offer-1:claim');
    expect(outbox.recordFailure(firstTry as StrakerOutboxRow, NOW_MS)).toBe('pending');

    // It is not retried immediately — that would hammer a destination already in trouble.
    expect(outbox.due(NOW_MS + 1)).toEqual([]);

    // The destination recovers. The outcome is still there, and is delivered.
    const [retry] = outbox.due(NOW_MS + 5 * MINUTE);
    expect(retry?.eventId).toBe('offer-1:claim');
    expect(retry?.attempts).toBe(1);
    outbox.markSent((retry as StrakerOutboxRow).outboxId, NOW_MS + 5 * MINUTE);

    expect(outbox.due(NOW_MS + HOUR)).toEqual([]);
    expect(outbox.countByStatus('sent')).toBe(1);
    expect(outbox.countByStatus('pending')).toBe(0);
  });

  it('keeps a queued outcome across a restart, because a queue in memory is no queue', () => {
    const { strakerDir } = tempRoot();
    const first = openStrakerDatabase(strakerDir, NOW_MS);
    new StrakerOutbox(first.db).enqueue('offer-1:claim', 'offers', payload('won'), NOW_MS);
    first.db.close();

    const second = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(second.db);
    const afterRestart = new StrakerOutbox(second.db).due(NOW_MS);

    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]?.eventId).toBe('offer-1:claim');
    expect(afterRestart[0]?.payloadJson).toBe(payload('won'));
  });

  it('hands out due rows oldest first, so outcomes are delivered in the order they happened', () => {
    const { outbox } = freshOutbox();
    outbox.enqueue('offer-1:claim', 'tracking', payload('first'), NOW_MS);
    outbox.enqueue('offer-2:claim', 'tracking', payload('second'), NOW_MS + 1_000);

    expect(outbox.due(NOW_MS + 2_000).map((r) => r.eventId)).toEqual([
      'offer-1:claim',
      'offer-2:claim',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Idempotent enqueue (Constitution VII, FR-014, FR-016b)
// ---------------------------------------------------------------------------

describe('enqueuing the same outcome twice', () => {
  it('queues one row per outcome per destination, so a re-run never duplicates a message', () => {
    const { outbox } = freshOutbox();

    expect(outbox.enqueue('offer-1:claim', 'tracking', payload('won'), NOW_MS)).toBe(true);
    expect(outbox.enqueue('offer-1:claim', 'tracking', payload('won'), NOW_MS + 30_000)).toBe(
      false,
    );

    expect(outbox.due(NOW_MS + MINUTE)).toHaveLength(1);
  });

  it('queues the same outcome separately for each destination it must reach', () => {
    const { outbox } = freshOutbox();
    outbox.enqueue('offer-1:claim', 'tracking', payload('won'), NOW_MS);
    outbox.enqueue('offer-1:claim', 'offers', payload('won'), NOW_MS);

    expect(
      outbox
        .due(NOW_MS)
        .map((r) => r.channel)
        .sort(),
    ).toEqual(['offers', 'tracking']);
  });

  it('keeps a recovery distinct from the claim it repairs, rather than collapsing the two', () => {
    // FR-016b: recovered work is marked as recovered rather than as a normal claim, so a
    // recurring gap stays visible. Keying on identity alone would have suppressed this.
    const { outbox } = freshOutbox();
    outbox.enqueue('offer-1:claim', 'tracking', payload('unknown'), NOW_MS);
    outbox.enqueue('offer-1:recovery', 'tracking', payload('recovered'), NOW_MS + HOUR);

    expect(outbox.due(NOW_MS + 2 * HOUR)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Attempt counting and backoff (Constitution IV)
// ---------------------------------------------------------------------------

describe('retrying a failing destination', () => {
  it('counts attempts and widens the gap between them instead of hammering', () => {
    // Retry cap and age-out lifted clear of the way: what is under test here is the shape
    // of the delay, and both of those giving up is the subject of its own test below.
    const { outbox } = freshOutbox({ retryCap: 50, deadAfterHours: 24 * 365 });
    outbox.enqueue('offer-1:claim', 'alerts', payload('failed'), NOW_MS);

    const gaps: number[] = [];
    let clock = NOW_MS;
    for (let i = 0; i < 4; i++) {
      const [row] = outbox.due(clock);
      expect(row?.attempts).toBe(i);
      expect(outbox.recordFailure(row as StrakerOutboxRow, clock)).toBe('pending');
      const [queued] = outbox.due(clock + 24 * HOUR); // look it up whenever it is next due
      const gap = (queued as StrakerOutboxRow).nextAttemptAtMs - clock;
      gaps.push(gap);
      clock += gap; // wait exactly as long as it asked to be left alone
    }

    expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000]);
  });

  it('caps the gap so a long outage does not push the retry out of sight', () => {
    const { outbox } = freshOutbox({ retryCap: 50, deadAfterHours: 24 * 365 });
    outbox.enqueue('offer-1:claim', 'alerts', payload('failed'), NOW_MS);

    let clock = NOW_MS;
    for (let i = 0; i < 10; i++) {
      const [row] = outbox.due(clock);
      outbox.recordFailure(row as StrakerOutboxRow, clock);
      clock += 24 * HOUR;
    }
    const [row] = outbox.due(clock);

    expect((row as StrakerOutboxRow).nextAttemptAtMs - (clock - 24 * HOUR)).toBe(5 * MINUTE);
  });
});

// ---------------------------------------------------------------------------
// Giving up visibly, and being brought back (Constitution IV, ops runbook)
// ---------------------------------------------------------------------------

describe('when the destination never comes back', () => {
  it('marks the outcome dead once the retry cap is spent, rather than retrying forever', () => {
    const { outbox } = freshOutbox({ retryCap: 3 });
    outbox.enqueue('offer-1:claim', 'tracking', payload('won'), NOW_MS);

    let clock = NOW_MS;
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const [row] = outbox.due(clock);
      results.push(outbox.recordFailure(row as StrakerOutboxRow, clock));
      clock += HOUR;
    }

    expect(results).toEqual(['pending', 'pending', 'dead']);
    expect(outbox.due(clock)).toEqual([]);
    expect(outbox.countByStatus('dead')).toBe(1);
  });

  it('gives up on an outcome that has aged out even with attempts to spare', () => {
    const { outbox } = freshOutbox({ retryCap: 100, deadAfterHours: 6 });
    outbox.enqueue('offer-1:claim', 'tracking', payload('won'), NOW_MS);

    const [row] = outbox.due(NOW_MS);
    expect(outbox.recordFailure(row as StrakerOutboxRow, NOW_MS + 7 * HOUR)).toBe('dead');
  });

  it('brings dead outcomes back and delivers them, which is why dead is not lost', () => {
    const { outbox } = freshOutbox({ retryCap: 1 });
    outbox.enqueue('offer-1:claim', 'tracking', payload('won'), NOW_MS);
    outbox.recordFailure(outbox.due(NOW_MS)[0] as StrakerOutboxRow, NOW_MS);
    expect(outbox.countByStatus('dead')).toBe(1);

    expect(outbox.requeueDead(NOW_MS + HOUR)).toBe(1);

    const [revived] = outbox.due(NOW_MS + HOUR);
    expect(revived?.eventId).toBe('offer-1:claim');
    expect(revived?.attempts).toBe(0);
    outbox.markSent((revived as StrakerOutboxRow).outboxId, NOW_MS + HOUR);
    expect(outbox.countByStatus('sent')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Straker's own queue (R11, FR-024)
// ---------------------------------------------------------------------------

describe('isolation from the XTM outbox', () => {
  it('queues into Straker own database and leaves the XTM queue empty', () => {
    const { xtmDir, strakerDir } = tempRoot();
    const xtm = openDatabase(xtmDir, new Date(NOW_MS).toISOString()).db;
    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(opened.db);

    new StrakerOutbox(opened.db).enqueue('offer-1:claim', 'offers', payload('won'), NOW_MS);

    expect((xtm.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(0);
    expect(
      (opened.db.prepare('SELECT COUNT(*) AS n FROM straker_outbox').get() as { n: number }).n,
    ).toBe(1);
    xtm.close();
  });

  it('refuses a destination that is not one of Straker own', () => {
    const { outbox } = freshOutbox();
    expect(() =>
      // Cast past the type on purpose: the schema, not only the compiler, must refuse it —
      // a channel the dispatcher cannot route would be an outcome queued into silence.
      outbox.enqueue('offer-1:claim', 'team' as 'offers', payload('won'), NOW_MS),
    ).toThrow();
  });

  it('never imports the XTM configuration or state layer', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/straker/outbox.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/from '\.\.\/state\//);
    expect(source).not.toMatch(/from '\.\.\/config\//);
  });
});
