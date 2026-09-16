import { vi } from 'vitest';
import type { OfferForDecision } from '../../../src/straker/claimDecision.js';
import { StrakerHttpError } from '../../../src/straker/httpClient.js';
import { createSightingTracker, type StrakerPortal } from '../../../src/straker/main.js';
import { createStrakerPollCycle } from '../../../src/straker/pollCycle.js';
import type { RawOffer } from '../../../src/straker/probe.js';

/**
 * A poll cycle driven by recording doubles.
 *
 * The doubles record **full payloads**, not labels. An earlier version collapsed each call
 * to a short string, and three content mutations survived because of it: the effort that
 * sets tomorrow's capacity ceiling, the identity every dedup and reconciliation keys on, and
 * the body of every announcement could each be replaced with a constant while the suite
 * stayed green. Ordering was proved; content was not looked at.
 *
 * `tx:begin` / `tx:end` are traced so a test can assert what happens *inside* the
 * transaction rather than merely that it happened.
 */
export interface HarnessOptions {
  /** A getter is allowed, so a test can change what the portal lists between cycles. */
  readonly offers?: readonly RawOffer[];
  readonly readFails?: unknown;
  /** Refuse the sign-in. Returning null lets it succeed, so a test can recover mid-run. */
  readonly signInFails?: () => unknown | null;
  readonly extract?: (raw: readonly RawOffer[]) => readonly OfferForDecision[];
  readonly claim?: (offerId: string) => { status: number } | 'accepted' | 'no_answer';
  /** Identities already carrying a claim event, as a previous cycle would have left them. */
  readonly alreadyClaimed?: readonly string[];
  /** Make the store reject one offer's event, to prove one bad write cannot lose the rest. */
  readonly recordEventFails?: (objId: string) => boolean;
  /** `false` means the tracker and the store disagree — the caller must notice. */
  readonly endSightingResult?: boolean;
  readonly enqueueResult?: () => 'queued' | 'already_pending' | 'already_sent' | 'already_dead';
  /** An advancing clock, for the rules that are about time rather than about sequence —
   *  the sign-in backoff cannot be exercised at all against a frozen one. */
  readonly now?: () => number;
}

export interface Harness {
  readonly cycle: { runOnce(): Promise<boolean> };
  readonly trace: string[];
  readonly claimed: string[];
  readonly events: Record<string, unknown>[];
  readonly holds: Record<string, unknown>[];
  readonly queued: { eventId: string; channel: string; payload: Record<string, unknown> }[];
  readonly logs: { level: string; fields: Record<string, unknown> }[];
}

export const raw = (id: string): RawOffer => ({ obj_id: id });

export const eligible = (id: string): OfferForDecision => ({
  objId: id,
  languageDirection: 'en-us>ms-my',
  eligible: true,
  effortWords: 4,
  deadlineMs: Date.parse('2026-09-16T17:00:00+07:00'),
});

export function harness(opts: HarnessOptions): Harness {
  const trace: string[] = [];
  const claimed: string[] = [];
  const events: Record<string, unknown>[] = [];
  const holds: Record<string, unknown>[] = [];
  const queued: { eventId: string; channel: string; payload: Record<string, unknown> }[] = [];
  const logs: { level: string; fields: Record<string, unknown> }[] = [];
  const claimedIds = new Set(opts.alreadyClaimed ?? []);

  const portal: StrakerPortal = {
    client: {
      getJson: vi.fn(),
      getJsonWithBackoff: vi.fn(),
      lastRateLimit: () => null,
      postJson: async (path: string) => {
        const id = /job-offers\/([^/]+)\/claim/.exec(path)?.[1] ?? '?';
        trace.push(`claim:${id}`);
        claimed.push(id);
        const outcome = opts.claim?.(id) ?? 'accepted';
        if (outcome === 'accepted') return {};
        if (outcome === 'no_answer') throw new Error('socket closed');
        throw new StrakerHttpError(outcome.status, path, 'refused');
      },
    } as never,
    signIn: async () => {
      // Traced BEFORE the refusal: what a sign-in test measures is how many times the bot
      // POSTed the credentials, and a refused attempt is still an attempt at a portal that
      // may be counting them toward a lockout.
      trace.push('signIn');
      const failure = opts.signInFails?.();
      if (failure !== null && failure !== undefined) throw failure;
      return { vendorId: 'vendor-1' };
    },
    listOpenOffers: async () => {
      trace.push('fetch');
      if (opts.readFails !== undefined) throw opts.readFails;
      return opts.offers ?? [];
    },
    // Reconciliation's read. Nothing in this harness drives it — the poll cycle does not
    // call it, the composition root does — so it is present to satisfy the portal's shape
    // and would be a loud failure if anything here did reach for it.
    listAssignedWork: () => {
      throw new Error('the poll cycle must not read the assigned-work list (FR-002)');
    },
  };

  // The barred flag is REAL in-memory state here, not a stub returning a constant: what
  // T073 is about is the state surviving from one `runOnce()` to the next, and a stub that
  // always answered null would make the test that proves it vacuous.
  let barredSinceMs: number | null = null;

  const store = {
    barredSinceMs: (): number | null => barredSinceMs,
    barAccount: (atMs: number): boolean => {
      if (barredSinceMs !== null) return false;
      barredSinceMs = atMs;
      return true;
    },
    clearBar: (): boolean => {
      const was = barredSinceMs !== null;
      barredSinceMs = null;
      return was;
    },
    transaction: <T>(fn: () => T): T => {
      trace.push('tx:begin');
      try {
        return fn();
      } finally {
        trace.push('tx:end');
      }
    },
    recordSighting: (o: { objId: string }) => trace.push(`persist:sighting:${o.objId}`),
    endSighting: (o: { objId: string }) => {
      trace.push(`persist:endSighting:${o.objId}`);
      return opts.endSightingResult ?? true;
    },
    recordEvent: (e: Record<string, unknown>) => {
      if (opts.recordEventFails?.(String(e.objId)) === true) {
        trace.push(`persist:event:REJECTED:${String(e.objId)}`);
        throw new Error(`refusing to record ${String(e.objId)}`);
      }
      events.push(e);
      // The real store answers `claimedObjIds()` from the rows it holds, so a claim recorded
      // this cycle is visible to the next one. A fixed set would have let the cross-cycle
      // guard look like it worked while testing nothing.
      if (e.eventType === 'claim') claimedIds.add(String(e.objId));
      trace.push(
        `persist:event:${String(e.eventType)}:${String(e.skipReason ?? e.outcome ?? '-')}`,
      );
    },
    heldWork: () => {
      trace.push('read:heldWork');
      return [];
    },
    claimedObjIds: () => {
      trace.push('read:claimedObjIds');
      return claimedIds;
    },
  };

  const ledger = {
    checkCapacity: () => {
      trace.push('gate:capacity');
      return { fits: true } as const;
    },
    hold: (work: Record<string, unknown>) => {
      holds.push(work);
      trace.push('persist:hold');
      return {
        deadlineDay: '2026-09-16',
        committedEffort: 4,
        ceiling: 2000,
        ceilingExceeded: false,
      };
    },
  };

  const outbox = {
    enqueue: (eventId: string, channel: string, payloadJson: string) => {
      queued.push({
        eventId,
        channel,
        payload: JSON.parse(payloadJson) as Record<string, unknown>,
      });
      trace.push(`notify:${channel}:${eventId}`);
      return opts.enqueueResult?.() ?? ('queued' as const);
    },
  };

  const logger = {
    info: (fields: Record<string, unknown>) => logs.push({ level: 'info', fields }),
    warn: (fields: Record<string, unknown>) => logs.push({ level: 'warn', fields }),
    error: (fields: Record<string, unknown>) => logs.push({ level: 'error', fields }),
  };

  const cycle = createStrakerPollCycle({
    portal,
    tracker: createSightingTracker(),
    store: store as never,
    ledger: ledger as never,
    outbox: outbox as never,
    logger: logger as never,
    settings: {
      throughputWordsPerHour: 100,
      hoursStartMin: 9 * 60,
      hoursEndMin: 18 * 60,
      workdays: new Set([1, 2, 3, 4, 5]),
    },
    extractOffers: opts.extract ?? (() => []),
    now: opts.now ?? (() => Date.parse('2026-09-16T10:00:00+07:00')),
  });

  return { cycle, trace, claimed, events, holds, queued, logs };
}
