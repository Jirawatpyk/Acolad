/**
 * The outbox retry policy, tested once for both bots.
 *
 * Before this module existed the schedule lived twice — `src/state/outbox.ts` and
 * `src/straker/outbox.ts` each carried the two constants, the doubling formula and the
 * give-up decision, character for character. Two copies of a delivery schedule is how one
 * bot quietly starts hammering a webhook the other bot is politely backing off from, so
 * the policy is asserted here and nowhere else; each queue's own test now only has to show
 * that it persisted what the policy decided.
 */
import { describe, it, expect } from 'vitest';
import {
  OUTBOX_BASE_BACKOFF_MS,
  OUTBOX_MAX_BACKOFF_MS,
  decideOutboxRetry,
  outboxBackoffMs,
  type OutboxRetryPolicy,
} from '../../../src/shared/outboxRetry.js';

const NOW_MS = Date.parse('2026-09-11T10:00:00.000Z');
const HOUR_MS = 3_600_000;

/** The figures both queues run on today, so the numbers below read as production ones. */
const POLICY: OutboxRetryPolicy = { retryCap: 10, deadAfterHours: 6 };

describe('outboxBackoffMs (the doubling schedule)', () => {
  it('starts at 30 seconds on the first failure', () => {
    expect(outboxBackoffMs(1)).toBe(30_000);
    expect(outboxBackoffMs(1)).toBe(OUTBOX_BASE_BACKOFF_MS);
  });

  it('doubles per attempt until it meets the ceiling, then stays there', () => {
    // Written out rather than computed: a test that re-implements the formula agrees with
    // any formula, including a wrong one.
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(outboxBackoffMs)).toEqual([
      30_000, // 30s
      60_000, // 1m
      120_000, // 2m
      240_000, // 4m
      300_000, // 5m — the cap, reached mid-doubling (480s would overshoot)
      300_000,
      300_000,
      300_000,
    ]);
  });

  it('never exceeds five minutes, however many attempts have been spent', () => {
    // 2 ** 1000 is Infinity; Math.min must still answer the cap rather than propagate it.
    expect(outboxBackoffMs(1_000)).toBe(OUTBOX_MAX_BACKOFF_MS);
    expect(OUTBOX_MAX_BACKOFF_MS).toBe(5 * 60_000);
  });
});

describe('decideOutboxRetry (retry, or give up)', () => {
  it('counts the attempt and schedules the next one', () => {
    expect(decideOutboxRetry({ attempts: 0, createdAtMs: NOW_MS }, NOW_MS, POLICY)).toEqual({
      kind: 'pending',
      attempts: 1,
      nextAttemptAtMs: NOW_MS + 30_000,
    });
  });

  it('schedules from NOW, not from when the row was created', () => {
    // A row that sat in a dead channel for an hour must still wait a full backoff from
    // this failure — scheduling from creation would retry it instantly, forever.
    const created = NOW_MS - HOUR_MS;
    expect(decideOutboxRetry({ attempts: 2, createdAtMs: created }, NOW_MS, POLICY)).toEqual({
      kind: 'pending',
      attempts: 3,
      nextAttemptAtMs: NOW_MS + 120_000,
    });
  });

  it('gives up once the counted attempt reaches the cap', () => {
    // The cap counts the attempt being recorded, so with a cap of 10 the tenth failure is
    // the last one. The ninth is not.
    expect(decideOutboxRetry({ attempts: 8, createdAtMs: NOW_MS }, NOW_MS, POLICY)).toMatchObject({
      kind: 'pending',
      attempts: 9,
    });
    expect(decideOutboxRetry({ attempts: 9, createdAtMs: NOW_MS }, NOW_MS, POLICY)).toEqual({
      kind: 'dead',
      attempts: 10,
    });
  });

  it('gives up on an aged-out row even with attempts to spare', () => {
    // The two conditions are independent on purpose: a row whose channel has been down all
    // morning is stale news by the time it would be delivered, whatever its attempt count.
    const created = NOW_MS - 6 * HOUR_MS;
    expect(decideOutboxRetry({ attempts: 0, createdAtMs: created }, NOW_MS, POLICY)).toEqual({
      kind: 'dead',
      attempts: 1,
    });
  });

  it('treats the age limit as reached-or-passed, not strictly passed', () => {
    const sixHoursOld = NOW_MS - 6 * HOUR_MS;
    const aMomentYounger = sixHoursOld + 1;
    expect(decideOutboxRetry({ attempts: 0, createdAtMs: sixHoursOld }, NOW_MS, POLICY).kind).toBe(
      'dead',
    );
    expect(
      decideOutboxRetry({ attempts: 0, createdAtMs: aMomentYounger }, NOW_MS, POLICY).kind,
    ).toBe('pending');
  });

  it('reports the incremented attempt count on the giving-up decision too', () => {
    // The caller writes this number into the row. Returning the pre-increment count would
    // make a dead row claim one fewer attempt than it actually cost.
    const decision = decideOutboxRetry(
      { attempts: 4, createdAtMs: NOW_MS - 7 * HOUR_MS },
      NOW_MS,
      POLICY,
    );
    expect(decision).toEqual({ kind: 'dead', attempts: 5 });
  });

  it('honours a policy tuned away from the defaults', () => {
    // Both knobs are the caller's (the XTM bot reads them from env); the policy must not
    // quietly fall back to its own numbers.
    const strict: OutboxRetryPolicy = { retryCap: 2, deadAfterHours: 1 };
    expect(decideOutboxRetry({ attempts: 0, createdAtMs: NOW_MS }, NOW_MS, strict)).toMatchObject({
      kind: 'pending',
      attempts: 1,
    });
    expect(decideOutboxRetry({ attempts: 1, createdAtMs: NOW_MS }, NOW_MS, strict)).toEqual({
      kind: 'dead',
      attempts: 2,
    });
    expect(
      decideOutboxRetry({ attempts: 0, createdAtMs: NOW_MS - HOUR_MS }, NOW_MS, strict).kind,
    ).toBe('dead');
  });
});
