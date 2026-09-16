/**
 * Durable outcome delivery for Straker (FR-016, FR-016b).
 *
 * Every outcome — a win, a loss, a skip, a recovery, an operational alert — is written
 * into this queue in the **same transaction as the state change that produced it**, and a
 * dispatcher drains it afterwards. That ordering is the whole design: a destination being
 * unavailable can then delay an outcome but cannot lose one, because the outcome was
 * durable before anyone tried to send it.
 *
 * It is Straker's own queue in Straker's own database (table `straker_outbox`, declared in
 * `strakerStore.ts` alongside the rest of Straker's schema). It shares nothing with the
 * XTM bot's `outbox` — R11 — and this file imports neither `src/state/` nor `src/config/`.
 *
 * The discipline is the XTM outbox's, which has run in production since 2026-06:
 * idempotent enqueue, attempt counting, exponential backoff, and a `dead` state once the
 * retries are spent. The backoff and the give-up rule are not copied from it but literally
 * shared with it (`shared/outboxRetry.ts`) — a pure policy function, which is a different
 * thing from a shared database and leaves R11 exactly where it was.
 * **Dead is visible, not lost**: a dead row still holds its
 * payload and `requeueDead` brings it back, which is what an operator does after fixing a
 * webhook. Delivery is at-least-once — a row is marked sent immediately after the
 * destination accepts it, and the resulting window is the one the XTM plan already
 * recorded in its Complexity Tracking.
 */

import { decideOutboxRetry } from '../shared/outboxRetry.js';
import type { StrakerDB } from './strakerStore.js';

/**
 * Straker's three destinations (contract §1–§3). `offers` and `tracking` are Straker's
 * own — job news is separated per portal. `alerts` is the single existing operations
 * channel, shared with the XTM bot on purpose: on-call watches one place, and an alert
 * delivered where nobody looks is the same as no alert.
 */
export const STRAKER_OUTBOX_CHANNELS = ['offers', 'tracking', 'alerts'] as const;
export type StrakerOutboxChannel = (typeof STRAKER_OUTBOX_CHANNELS)[number];

/**
 * A queued outcome's three states. A runtime list rather than a bare union because
 * `strakerStore.ts` generates this column's CHECK from it: a status named in one place and
 * retyped in the other is a disagreement that type-checks (FR-016).
 */
export const STRAKER_OUTBOX_STATUSES = ['pending', 'sent', 'dead'] as const;
export type StrakerOutboxStatus = (typeof STRAKER_OUTBOX_STATUSES)[number];

/**
 * What `enqueue` did — and when it queued nothing, which of three situations it found. A
 * boolean collapsed those three into one "not queued", and they call for different things:
 *
 * - `queued` — the outcome is now durable and will be delivered.
 * - `already_pending` — a re-run of a cycle that had already queued it. Nothing to do:
 *   the outcome is still on its way.
 * - `already_sent` — it reached its destination on an earlier pass. Also nothing to do,
 *   but it says the earlier cycle completed, which `already_pending` does not.
 * - `already_dead` — delivery was given up on. **The opposite conclusion**: the outcome
 *   will never arrive unless an operator runs a requeue, so a caller that treats this as
 *   "already handled" has silently dropped it (FR-016). It is worth surfacing.
 */
export type StrakerEnqueueResult = 'queued' | 'already_pending' | 'already_sent' | 'already_dead';

export interface StrakerOutboxRow {
  readonly outboxId: number;
  /** Identifies the event, not the offer: an offer's claim and its later recovery are
   *  separate events and must both be delivered (FR-016b). */
  readonly eventId: string;
  readonly channel: StrakerOutboxChannel;
  readonly payloadJson: string;
  readonly status: StrakerOutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAtMs: number;
  readonly createdAtMs: number;
  readonly sentAtMs: number | null;
}

export interface StrakerOutboxOptions {
  /** Failures after which a row is given up on and marked dead. */
  readonly retryCap?: number;
  /** Age after which a row is given up on even with attempts to spare. */
  readonly deadAfterHours?: number;
}

/** The same figures the XTM bot runs on, so the two queues behave alike under an outage.
 *  They are constructor options rather than settings because `StrakerBotConfig` carries
 *  no outbox variables yet; adding `STRAKER_OUTBOX_*` there is a config change, not a
 *  change here. */
const DEFAULT_RETRY_CAP = 10;
const DEFAULT_DEAD_AFTER_HOURS = 6;

interface OutboxRowShape {
  outbox_id: number;
  event_id: string;
  channel: StrakerOutboxChannel;
  payload_json: string;
  status: StrakerOutboxStatus;
  attempts: number;
  next_attempt_at_ms: number;
  created_at_ms: number;
  sent_at_ms: number | null;
}

export class StrakerOutbox {
  private readonly retryCap: number;
  private readonly deadAfterHours: number;

  constructor(
    private readonly db: StrakerDB,
    options: StrakerOutboxOptions = {},
  ) {
    this.retryCap = options.retryCap ?? DEFAULT_RETRY_CAP;
    this.deadAfterHours = options.deadAfterHours ?? DEFAULT_DEAD_AFTER_HOURS;
  }

  /**
   * Queue one outcome for one destination. Idempotent on event id **together with**
   * channel: re-running a cycle after a crash re-queues nothing, while the same outcome
   * still reaches every destination it must.
   *
   * When it queues nothing it says **which** situation it found, rather than a bare false
   * — see `StrakerEnqueueResult`. The distinction is not decoration: `already_dead` means
   * this outcome will never be delivered, and is the one answer a caller must not read as
   * "already handled".
   *
   * An unknown channel is refused by the schema, not merely by the type — a channel the
   * dispatcher cannot route would be an outcome queued into silence.
   */
  enqueue(
    eventId: string,
    channel: StrakerOutboxChannel,
    payloadJson: string,
    nowMs: number,
  ): StrakerEnqueueResult {
    // `ON CONFLICT (event_id, channel) DO NOTHING` rather than `INSERT OR IGNORE`: the
    // latter ignores EVERY constraint violation, so a channel the dispatcher cannot route
    // would be dropped silently instead of raising. Only the dedup conflict is meant to
    // be ignored here, and naming it is what limits the ignoring to it.
    const res = this.db
      .prepare(
        `INSERT INTO straker_outbox
           (event_id, channel, payload_json, status, attempts, next_attempt_at_ms, created_at_ms)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)
         ON CONFLICT (event_id, channel) DO NOTHING`,
      )
      .run(eventId, channel, payloadJson, nowMs, nowMs);
    if (res.changes > 0) return 'queued';

    const existing = this.db
      .prepare('SELECT status FROM straker_outbox WHERE event_id = ? AND channel = ?')
      .get(eventId, channel) as { status: StrakerOutboxStatus } | undefined;
    if (existing === undefined) {
      // The insert was refused by the dedup index, so the row it collided with was there a
      // statement ago. Nothing in this module deletes a row, so reaching here means the
      // table was changed by something else — and answering "already queued" about an
      // outcome that is not queued is how an outcome gets lost quietly (FR-016).
      throw new Error(
        `straker_outbox: ${eventId} on '${channel}' collided with a row that is no longer there`,
      );
    }
    switch (existing.status) {
      case 'sent':
        return 'already_sent';
      case 'dead':
        return 'already_dead';
      case 'pending':
        return 'already_pending';
    }
  }

  /** Rows ready to be sent, oldest first, so outcomes leave in the order they happened. */
  due(nowMs: number): StrakerOutboxRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM straker_outbox
          WHERE status = 'pending' AND next_attempt_at_ms <= ?
          ORDER BY outbox_id`,
      )
      .all(nowMs) as OutboxRowShape[];
    return rows.map(toRow);
  }

  /** The destination accepted it. Marked sent immediately after, which is where the
   *  at-least-once window lives. */
  markSent(outboxId: number, nowMs: number): void {
    this.db
      .prepare(`UPDATE straker_outbox SET status = 'sent', sent_at_ms = ? WHERE outbox_id = ?`)
      .run(nowMs, outboxId);
  }

  /**
   * The destination refused or could not be reached. Counts the attempt and pushes the
   * next one out exponentially — retrying a destination already in trouble at the normal
   * rhythm is how a bad minute becomes a bad hour.
   *
   * Returns `'dead'` once the retry cap is spent or the row has aged past
   * `deadAfterHours`. A dead row keeps its payload and is brought back by `requeueDead`.
   *
   * The schedule is `shared/outboxRetry.ts` — one policy for both bots' queues, which is
   * what makes "the same figures the XTM bot runs on" a fact rather than an intention.
   */
  recordFailure(row: StrakerOutboxRow, nowMs: number): 'pending' | 'dead' {
    const decision = decideOutboxRetry(row, nowMs, {
      retryCap: this.retryCap,
      deadAfterHours: this.deadAfterHours,
    });
    if (decision.kind === 'dead') {
      this.db
        .prepare(`UPDATE straker_outbox SET status = 'dead', attempts = ? WHERE outbox_id = ?`)
        .run(decision.attempts, row.outboxId);
      return 'dead';
    }
    this.db
      .prepare('UPDATE straker_outbox SET attempts = ?, next_attempt_at_ms = ? WHERE outbox_id = ?')
      .run(decision.attempts, decision.nextAttemptAtMs, row.outboxId);
    return 'pending';
  }

  /**
   * Ops lever: put every dead row back in the queue with a fresh retry budget, after the
   * thing that was broken has been fixed. This is what makes `dead` a visible pause rather
   * than a lost outcome.
   */
  requeueDead(nowMs: number): number {
    const res = this.db
      .prepare(
        `UPDATE straker_outbox
            SET status = 'pending', attempts = 0, next_attempt_at_ms = ?, created_at_ms = ?
          WHERE status = 'dead'`,
      )
      .run(nowMs, nowMs);
    return res.changes;
  }

  countByStatus(status: StrakerOutboxStatus): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM straker_outbox WHERE status = ?')
      .get(status) as { n: number };
    return row.n;
  }
}

function toRow(r: OutboxRowShape): StrakerOutboxRow {
  return {
    outboxId: r.outbox_id,
    eventId: r.event_id,
    channel: r.channel,
    payloadJson: r.payload_json,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAtMs: r.next_attempt_at_ms,
    createdAtMs: r.created_at_ms,
    sentAtMs: r.sent_at_ms,
  };
}
