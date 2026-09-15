/**
 * Draining the Straker outbox (T052a, FR-016).
 *
 * ## Why this file exists, and why it nearly did not
 *
 * Every outcome is written into `straker_outbox` in the same transaction as the state change
 * that produced it, so a destination being unavailable can delay an outcome but never lose
 * one. That guarantee is only half a delivery path: something has to read the queue. The
 * Phase 4 task breakdown had tasks for the senders and for the card builders and **none for
 * the drain**, which is the same shape of gap that has already shipped three capabilities in
 * this feature fully built and completely unreachable. A win would have been recorded
 * durably, correctly, and announced to nobody.
 *
 * ## What is deliberately NOT here
 *
 * The retry arithmetic. `StrakerOutbox.recordFailure` owns the backoff and the give-up rule,
 * and it shares both with the live XTM bot through `shared/outboxRetry.ts` — so a row that
 * fails here is simply handed back, and the outbox decides whether it waits or dies. A
 * second schedule living in the dispatcher is exactly the divergence that extraction removed.
 *
 * What IS this file's own is the rule that **one bad row must not stop the rows behind it**,
 * in both of its forms: a payload that cannot be parsed is dropped rather than retried
 * forever at the head of the queue, and a sender that fails — or throws — costs its own row
 * and no other. The XTM dispatcher learned the first of those in production.
 */

import type { Logger } from '../monitoring/logger.js';
import type { StrakerOutbox, StrakerOutboxChannel, StrakerOutboxRow } from './outbox.js';

/**
 * What a destination reported. A result rather than an exception so the loop can tell "this
 * row did not go" from "the dispatcher broke", and carry on either way.
 */
export type SendOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** One destination. Takes the parsed payload — the dispatcher owns reading the row. */
export type StrakerSender = (payload: unknown) => Promise<SendOutcome>;

/**
 * The three destinations, one per outbox channel.
 *
 * **This interface is the contract the senders are written to**, and it is defined here,
 * before them, on purpose: four things were being built in parallel against it, and a seam
 * agreed after the fact is a seam nobody owns. `offers` and `tracking` are Straker's own
 * (job news is separated per portal); `alerts` is the single operations channel shared with
 * the XTM bot, because on-call watches one place — see the reporting contract §3.
 */
export interface StrakerSenders {
  readonly offers: StrakerSender;
  readonly tracking: StrakerSender;
  readonly alerts: StrakerSender;
}

/**
 * What one flush did. `dead` is counted apart from `failed` because they call for different
 * things: a failed row will be tried again on its own schedule, while a dead one will not be
 * delivered at all until an operator runs a requeue.
 */
export interface FlushSummary {
  readonly sent: number;
  readonly failed: number;
  readonly dead: number;
  /** Rows removed because they could never be sent. Each one is a lost outcome. */
  readonly dropped: number;
}

export interface StrakerDispatcher {
  flush(nowMs: number): Promise<FlushSummary>;
}

export function createStrakerDispatcher(
  outbox: StrakerOutbox,
  senders: StrakerSenders,
  logger: Logger,
): StrakerDispatcher {
  return {
    async flush(nowMs: number): Promise<FlushSummary> {
      let sent = 0;
      let failed = 0;
      let dead = 0;
      let dropped = 0;

      for (const row of outbox.due(nowMs)) {
        const payload = parsePayload(row);
        if (payload === UNREADABLE) {
          // Dropped, not retried. The queue is drained in order, so a row no sender could
          // ever be given anything for would sit at the head of it forever and hold up
          // everything behind it. Marking it sent is the only way out of the queue that
          // `StrakerOutbox` offers, so the log line below is the record that it happened —
          // an outcome has been lost here, and that must not be inferable only from a gap.
          outbox.markSent(row.outboxId, nowMs);
          dropped++;
          logger.error(
            {
              module: 'dispatcher',
              action: 'drop',
              outcome: 'unreadable',
              eventId: row.eventId,
              channel: row.channel,
            },
            'dropped a queued outcome whose payload could not be read — it will never be delivered',
          );
          continue;
        }

        const result = await attemptSend(senders, row.channel, payload);
        if (result.ok) {
          outbox.markSent(row.outboxId, nowMs);
          sent++;
          continue;
        }

        // Handed back to the outbox, which owns the backoff and the give-up rule.
        const status = outbox.recordFailure(row, nowMs);
        if (status === 'dead') {
          dead++;
          logger.error(
            {
              module: 'dispatcher',
              action: 'send',
              outcome: 'dead',
              eventId: row.eventId,
              channel: row.channel,
              attempts: row.attempts + 1,
            },
            `giving up on a queued outcome after repeated failures — it will not be delivered until requeued: ${result.reason}`,
          );
        } else {
          failed++;
          logger.warn(
            {
              module: 'dispatcher',
              action: 'send',
              outcome: 'failed',
              eventId: row.eventId,
              channel: row.channel,
              attempts: row.attempts + 1,
            },
            result.reason,
          );
        }
      }

      return { sent, failed, dead, dropped };
    },
  };
}

/** Distinct from `undefined`, which is a payload a sender may legitimately be handed. */
const UNREADABLE = Symbol('unreadable payload');

function parsePayload(row: StrakerOutboxRow): unknown {
  try {
    return JSON.parse(row.payloadJson);
  } catch {
    return UNREADABLE;
  }
}

/**
 * A sender is an interface, so an implementation can reject rather than return. Letting that
 * escape would abandon the flush part-way, leaving the remaining rows unattempted while the
 * cycle's own error handling decided what had happened — so a throw is read as exactly what
 * a reported failure is, and the row waits its turn again.
 */
async function attemptSend(
  senders: StrakerSenders,
  channel: StrakerOutboxChannel,
  payload: unknown,
): Promise<SendOutcome> {
  try {
    return await senders[channel](payload);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
