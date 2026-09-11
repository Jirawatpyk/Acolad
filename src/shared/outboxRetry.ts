/**
 * The retry schedule every outbox in this repo runs on.
 *
 * Both bots keep a durable queue of things that must reach somewhere else — Google Chat, a
 * Sheet, an operations channel — and both answer the same two questions after a delivery
 * fails: *when do we try again*, and *when do we stop trying*. Those answers are policy,
 * not plumbing: they decide how hard a struggling webhook gets hit and how long an
 * undelivered outcome stays recoverable. They lived in two files and had to agree by
 * everybody remembering to change both. Now they live here.
 *
 * Deliberately pure and storage-agnostic. It knows nothing about SQLite, about ISO strings
 * versus epoch milliseconds, or about which table a row came from — the two queues store
 * their timestamps differently and each converts at its own edge. What they share is the
 * decision, and the decision is all that is here.
 */

/** First wait after a failure. Long enough that a blip is over, short enough to matter. */
export const OUTBOX_BASE_BACKOFF_MS = 30_000;

/** The ceiling the doubling stops at, so a long outage still retries twelve times an hour. */
export const OUTBOX_MAX_BACKOFF_MS = 5 * 60_000;

const MS_PER_HOUR = 3_600_000;

/** How much patience a queue has. Both knobs belong to the caller — the XTM bot reads
 *  them from configuration, Straker takes them as constructor options. */
export interface OutboxRetryPolicy {
  /** Failures after which a row is given up on and marked dead. */
  readonly retryCap: number;
  /** Age after which a row is given up on even with attempts to spare. */
  readonly deadAfterHours: number;
}

/** The only two things about a failing row that the decision depends on. */
export interface OutboxAttemptState {
  /** Failures recorded so far, NOT counting the one being recorded now. */
  readonly attempts: number;
  /** When the row was enqueued, as epoch milliseconds. */
  readonly createdAtMs: number;
}

/**
 * What to do with the row. `attempts` is the incremented count in both cases and is what
 * the caller persists — a dead row that reported the pre-increment count would understate
 * what delivery actually cost.
 */
export type OutboxRetryDecision =
  | { readonly kind: 'dead'; readonly attempts: number }
  | {
      readonly kind: 'pending';
      readonly attempts: number;
      /** Epoch milliseconds; measured from **now**, not from when the row was created. */
      readonly nextAttemptAtMs: number;
    };

/**
 * How long to wait before the nth attempt: exponential from the base, clamped at the
 * ceiling. Retrying a destination that is already in trouble at the normal rhythm is how a
 * bad minute becomes a bad hour, which is what the doubling is for; the clamp is what stops
 * the doubling from turning a six-hour outage into a single retry at the end of it.
 */
export function outboxBackoffMs(attempts: number): number {
  return Math.min(OUTBOX_BASE_BACKOFF_MS * 2 ** (attempts - 1), OUTBOX_MAX_BACKOFF_MS);
}

/**
 * Record one failed delivery and say what becomes of the row.
 *
 * A row is given up on when its attempts reach the cap **or** when it has aged past the
 * limit — two independent conditions, because a row whose channel has been down all
 * morning is stale news by the time it would arrive, whatever its attempt count. The age
 * limit is reached-or-passed rather than strictly passed, matching both queues as shipped.
 *
 * Giving up is not losing: a dead row keeps its payload, and requeueing it is what an
 * operator does after fixing the destination.
 */
export function decideOutboxRetry(
  row: OutboxAttemptState,
  nowMs: number,
  policy: OutboxRetryPolicy,
): OutboxRetryDecision {
  const attempts = row.attempts + 1;
  const agedOut = nowMs - row.createdAtMs >= policy.deadAfterHours * MS_PER_HOUR;
  if (attempts >= policy.retryCap || agedOut) return { kind: 'dead', attempts };
  return { kind: 'pending', attempts, nextAttemptAtMs: nowMs + outboxBackoffMs(attempts) };
}
