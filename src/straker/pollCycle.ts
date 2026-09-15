/**
 * The Straker poll cycle (T037, FR-029 / DC-3).
 *
 * The step names are the XTM loop's, on purpose: **fetch → diff → gate → act → persist →
 * notify**. DC-3 asks both portals' loops to follow the same sequence so the two can be read
 * side by side and real duplication becomes visible rather than being discovered during a
 * later extraction.
 *
 * ## The ordering is the requirement, not a side effect
 *
 * FR-003: between noticing an eligible offer and dispatching its claim, nothing deferrable
 * may happen — no recording, no announcing. That is why `persist` and `notify` are the last
 * two steps rather than being interleaved where each result arrives. A durable write in
 * front of the claim adds latency to the single step where latency decides whether the team
 * gets the work at all.
 *
 * The window that opens behind the claim — the portal committed work we have not recorded
 * yet — is closed by **reconciliation** (FR-016a, T053), which compares the portal's
 * assigned list against our record on start and every fifteen minutes. That is the deviation
 * recorded in the plan's Complexity Tracking: the principle's intent, never losing track of
 * an irreversible action, is met behind the action instead of in front of it.
 */

import type { Logger } from '../monitoring/logger.js';
import { classifyClaim } from './claimOutcome.js';
import { claimOffer, type ClaimFollowUp } from './claim.js';
import {
  decideClaims,
  type ClaimDecision,
  type ClaimDecisionSettings,
  type OfferForDecision,
} from './claimDecision.js';
import { isSessionExpired, StrakerHttpError } from './httpClient.js';
import type { StrakerLedger } from './ledger.js';
import type { SightingTracker, StrakerCycle, StrakerPortal } from './main.js';
import {
  CLAIM_ALERT_CONDITION,
  SKIP_ALERT_CONDITION,
  type StrakerOfferAlert,
  type StrakerOfferAnnouncement,
} from './notifier.js';
import { countsTowardLedger } from './outcomePolicy.js';
import { trackingRowKey, type TrackingRecord } from './trackingSink.js';
import type { StrakerOutbox } from './outbox.js';
import type { RawOffer } from './probe.js';
import type { StrakerStore } from './strakerStore.js';
import type { SkipReason } from './types.js';
import type { StrakerSession } from './session.js';

/**
 * Turns the portal's raw entries into the values a decision needs.
 *
 * Injected rather than implemented here because it is the one part of this cycle SC-000
 * still blocks: naming a portal field is T042 (parsing) and the 44-direction rule is T041
 * (eligibility), and both wait for the capture probe to reach exit. Everything around it —
 * the sequence, the ordering guarantee, the outcome handling — needs no such assumption and
 * is built and tested today.
 */
export type OfferExtractor = (raw: readonly RawOffer[]) => readonly OfferForDecision[];

export interface StrakerPollCycleDeps {
  readonly portal: StrakerPortal;
  readonly tracker: SightingTracker;
  readonly store: StrakerStore;
  readonly ledger: StrakerLedger;
  readonly outbox: StrakerOutbox;
  readonly logger: Logger;
  readonly settings: ClaimDecisionSettings;
  readonly extractOffers: OfferExtractor;
  readonly now?: () => number;
}

/** What one claim attempt produced, carried from `act` to `persist` without touching disk. */
interface ActedClaim {
  readonly decision: Extract<ClaimDecision, { action: 'claim' }>;
  readonly outcome: ReturnType<typeof classifyClaim>;
  readonly detail: string;
}

export function createStrakerPollCycle(deps: StrakerPollCycleDeps): StrakerCycle {
  const now = deps.now ?? Date.now;
  let session: StrakerSession | null = null;

  return {
    async runOnce(): Promise<boolean> {
      const atMs = now();

      // --- fetch -----------------------------------------------------------------
      let raw: readonly RawOffer[];
      let offers: readonly OfferForDecision[];
      try {
        session ??= await deps.portal.signIn();
        raw = await deps.portal.listOpenOffers(session.vendorId);
        // Parsed HERE, inside the read's own guard and before the tracker sees anything.
        // A payload that breaks the contract is the same class of event as a read that
        // failed, and FR-023 says a failed read drives no transition. Parsing after the
        // diff would let a shape violation advance the tracker in memory while the store
        // recorded nothing — the two would then disagree about which offers are known, and
        // nothing would say so.
        offers = deps.extractOffers(raw);
      } catch (err) {
        // Asked of the transport rather than decided here: DC-1 keeps the portal's own codes
        // at the edge, and this line used to read `err.status === 401` in the orchestrator.
        // The narrowness is the point — dropping the session on every error would turn a
        // barred account into a sign-in storm against a portal that has already said no.
        if (isSessionExpired(err)) session = null;
        deps.logger.error(
          {
            module: 'pollCycle',
            action: 'fetch',
            outcome: 'failed',
            errName: err instanceof Error ? err.name : typeof err,
            ...(err instanceof StrakerHttpError ? { status: err.status } : {}),
          },
          err instanceof Error ? err.message : String(err),
        );
        // A failed read drives NO transition. Applying an empty list here would mark every
        // live offer as vanished and stamp a fabricated lifetime on each — and it would do
        // so in silence, because a zero read as fact is indistinguishable from a true one.
        // That invisibility, not any particular mechanism, is what let the XTM bot's own
        // silent zero run for 38 minutes; `offersApi.ts` records what actually happened.
        return false;
      }

      // --- diff ------------------------------------------------------------------
      const sightings = deps.tracker.apply({ atMs, offerIds: raw.map((o) => o.obj_id) });

      // --- gate ------------------------------------------------------------------
      // One held-list snapshot per cycle, read before any decision: the capacity check and
      // every subsequent one must see the same set, or two offers in one read can each be
      // told there is room for them alone.
      const held = deps.store.heldWork();
      // R7 across cycles. `claim.ts` refuses to retry inside the one call it is given, but
      // FR-019c forbids a retry "at all, at any interval" — and the poll rhythm is an
      // interval. An offer whose claim came back `unknown` is still listed precisely because
      // nobody knows whether it landed, so re-deciding it is how "we do not know" becomes
      // "we may have committed twice". One query per cycle, like the held list.
      const alreadyClaimed = deps.store.claimedObjIds();
      const candidates = offers.filter((o) => !alreadyClaimed.has(o.objId));
      if (candidates.length < offers.length) {
        deps.logger.info(
          {
            module: 'pollCycle',
            action: 'skip_reclaim',
            outcome: 'ok',
            offers: offers.length - candidates.length,
          },
          'offers still listed that this bot has already attempted — not claiming them again',
        );
      }
      const decisions = decideClaims(candidates, {
        nowMs: atMs,
        settings: deps.settings,
        ledger: deps.ledger,
        held,
      });

      // --- act -------------------------------------------------------------------
      // Nothing below writes or announces until every claim has resolved (FR-003).
      const acted: ActedClaim[] = [];
      // Decided `claim` but never attempted, because the cycle halted first. They are not
      // `acted` (nothing was sent) and they are not `skip` decisions (our rules said yes),
      // so without collecting them here they reach no row at all — see `claiming_halted`.
      const halted: Extract<ClaimDecision, { action: 'claim' }>[] = [];
      // Read once, before the loop: `re_authenticate` below clears `session`, and a claim
      // that reached for it afterwards would be aiming at nothing.
      const { vendorId } = session;
      let stopClaiming: ClaimFollowUp | null = null;
      for (const decision of decisions) {
        if (decision.action !== 'claim') continue;
        if (stopClaiming !== null) {
          halted.push(decision);
          continue;
        }
        const attempt = await claimOffer(deps.portal.client, {
          vendorId,
          offerId: decision.objId,
        });
        acted.push({
          decision,
          outcome: classifyClaim(attempt.response),
          detail: attempt.detail,
        });
        // Both follow-ups stop the rest of the cycle, for different reasons.
        //
        // A barred account must never be retried around as though it were transient
        // (contract §4a) — carrying on is how a suspension becomes permanent.
        //
        // An expired session self-heals, but not within this cycle: every remaining claim
        // would meet the same 401, each would classify as a fault, and one dead session
        // would arrive as a burst of alerts about unrelated offers. Stopping here costs
        // one cycle and the next one signs in fresh.
        if (attempt.followUp !== 'none') stopClaiming = attempt.followUp;
        if (attempt.followUp === 're_authenticate') session = null;
      }
      if (stopClaiming !== null) {
        // Once for the cycle, not once per offer — which is the whole point of halting.
        // The rows below say *that* each offer was passed over; this says why, and how
        // much it cost, in the one place an operator can act on it.
        deps.logger.warn(
          {
            module: 'pollCycle',
            action: 'claiming_halted',
            outcome: 'failed',
            followUp: stopClaiming,
            passedOver: halted.length,
          },
          stopClaiming === 'stop_claiming'
            ? 'the portal has barred this account — stopped claiming for this cycle, and it will not self-heal'
            : 'the session expired mid-cycle — stopped claiming, and the next cycle signs in fresh',
        );
      }

      // --- persist + notify -------------------------------------------------------
      // The claims go first, and each one alone.
      //
      // A claim is already committed on the portal by the time we get here, so its record is
      // the most valuable row in the cycle — and the previous shape put it in one transaction
      // with every sighting and every skip, where a single rejected write discarded the lot.
      // That is the gap FR-016a then has to go and find. One transaction per claim means a
      // bad row loses that row, not the others.
      //
      // The announcement is enqueued INSIDE the same transaction, which is what `outbox.ts`
      // asks for: queued with the state change that produced it, so a destination being
      // unavailable can delay an outcome but never lose one (FR-016).
      for (const { decision, outcome, detail } of acted) {
        try {
          deps.store.transaction(() => {
            deps.store.recordEvent({
              objId: decision.objId,
              eventType: 'claim',
              outcome,
              effortWords: decision.effortWords,
              deadlineMs: decision.deadlineMs,
              occurredAtMs: atMs,
            });
            // Only work the team actually holds goes on the ledger. A lost race and a fault
            // consume no capacity — counting them would shrink tomorrow's budget for work
            // nobody has.
            if (countsTowardLedger(outcome)) {
              deps.ledger.hold(
                {
                  objId: decision.objId,
                  effortWords: decision.effortWords,
                  deadlineMs: decision.deadlineMs,
                },
                atMs,
              );
            }
            // Contract §1: EVERY offer produces a tracking row, won and lost alike —
            // without the losses the win rate has no denominator and "Straker sends us
            // nothing" cannot be told from "we keep arriving second".
            enqueue(deps, 'tracking', `row:${trackingRowKey(decision.objId, 'claim')}`, atMs, {
              objId: decision.objId,
              eventType: 'claim',
              outcome,
              languageDirection: decision.languageDirection,
              effortWords: decision.effortWords,
              deadlineMs: decision.deadlineMs,
              firstSeenAtMs: atMs,
              claimedAtMs: atMs,
              note: detail,
            } satisfies TrackingRecord);
            // Announced or alerted — never both, and never neither by accident. The
            // condition comes from `notifier.ts`'s table rather than a literal, so an
            // outcome added without deciding how it alerts fails the typecheck there.
            const condition = CLAIM_ALERT_CONDITION[outcome];
            if (condition !== null) {
              enqueue(deps, 'alerts', `claim:${decision.objId}:${outcome}`, atMs, {
                kind: 'offer',
                condition,
                objId: decision.objId,
                detail,
                occurredAtMs: atMs,
                ...optionalOffer(decision),
              } satisfies StrakerOfferAlert);
            } else if (outcome === 'won') {
              enqueue(deps, 'offers', `claim:${decision.objId}:${outcome}`, atMs, {
                objId: decision.objId,
                outcome: 'won',
                languageDirection: decision.languageDirection,
                effortWords: decision.effortWords,
                deadlineMs: decision.deadlineMs,
                occurredAtMs: atMs,
                detail,
              } satisfies StrakerOfferAnnouncement);
            }
          });
        } catch (err) {
          // The worst state this bot can reach: the portal has committed work to the team and
          // nothing here records it. Loud, per claim, and named so it can be searched for —
          // reconciliation (FR-016a) is what repairs it.
          deps.logger.error(
            {
              module: 'pollCycle',
              action: 'persist_claim',
              outcome: 'failed',
              objId: decision.objId,
              claimOutcome: outcome,
            },
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Then the observational half, which is recoverable: a lost sighting costs a lifetime
      // measurement, not a commitment.
      const diverged: string[] = [];
      try {
        deps.store.transaction(() => {
          for (const offer of sightings.appeared) deps.store.recordSighting(offer);
          for (const offer of sightings.vanished) {
            // `false` here is not "nothing to do" — it means the tracker is closing an
            // appearance the store never recorded, and the store's own docstring says the
            // caller is the only thing in a position to notice.
            if (!deps.store.endSighting(offer)) diverged.push(offer.objId);
          }
          for (const decision of halted) {
            // No alert: the claim that triggered the halt already raised one, and a second
            // per passed-over offer is the burst that stopping early exists to prevent.
            deps.store.recordEvent({
              objId: decision.objId,
              eventType: 'skip',
              skipReason: 'claiming_halted',
              occurredAtMs: atMs,
            });
            enqueueSkipRow(deps, decision, 'claiming_halted', atMs, null);
          }
          for (const decision of decisions) {
            if (decision.action !== 'skip') continue;
            deps.store.recordEvent({
              objId: decision.objId,
              eventType: 'skip',
              skipReason: decision.reason,
              occurredAtMs: atMs,
            });
            enqueueSkipRow(deps, decision, decision.reason, atMs, decision.detail);
            const condition = SKIP_ALERT_CONDITION[decision.reason];
            if (condition !== null) {
              enqueue(deps, 'alerts', `skip:${decision.objId}:${decision.reason}`, atMs, {
                kind: 'offer',
                condition,
                objId: decision.objId,
                detail: decision.detail,
                occurredAtMs: atMs,
              } satisfies StrakerOfferAlert);
            }
          }
        });
      } catch (err) {
        deps.logger.error(
          { module: 'pollCycle', action: 'persist_observations', outcome: 'failed' },
          err instanceof Error ? err.message : String(err),
        );
      }
      for (const objId of diverged) {
        deps.logger.warn(
          { module: 'pollCycle', action: 'sighting_divergence', outcome: 'failed', objId },
          'ended a sighting the store never recorded — the tracker and the store have diverged',
        );
      }

      deps.logger.info(
        {
          module: 'pollCycle',
          action: 'cycle',
          outcome: 'ok',
          offers: raw.length,
          claimed: acted.filter((a) => a.outcome === 'won').length,
          skipped: decisions.filter((d) => d.action === 'skip').length,
        },
        'poll cycle',
      );
      return true;
    },
  };
}

/**
 * The optional half of an offer alert. Spread rather than assigned, because
 * `exactOptionalPropertyTypes` makes `languageDirection: undefined` a different thing from
 * the key being absent, and the notifier's shape says absent.
 */
function optionalOffer(decision: Extract<ClaimDecision, { action: 'claim' }>): {
  languageDirection?: string;
  effortWords?: number;
  deadlineMs?: number;
} {
  return {
    languageDirection: decision.languageDirection,
    effortWords: decision.effortWords,
    deadlineMs: decision.deadlineMs,
  };
}

/**
 * The tracking row for an offer that was passed over.
 *
 * Effort and deadline are null: the gate refused before they mattered, or refused precisely
 * because they were missing. The **language direction is not** — the sink requires it and
 * is right to (FR-011a), and every decision carries it, skips included, because eligibility
 * is decided on it.
 */
function enqueueSkipRow(
  deps: StrakerPollCycleDeps,
  decision:
    | Extract<ClaimDecision, { action: 'skip' }>
    | { objId: string; languageDirection: string },
  skipReason: SkipReason,
  atMs: number,
  note: string | null,
): void {
  const { objId } = decision;
  enqueue(deps, 'tracking', `row:${trackingRowKey(objId, 'skip')}`, atMs, {
    objId,
    eventType: 'skip',
    skipReason,
    languageDirection: decision.languageDirection,
    effortWords: null,
    deadlineMs: null,
    firstSeenAtMs: atMs,
    note,
  } satisfies TrackingRecord);
}

/**
 * Queue one outbound record. Dedup is the outbox's own, keyed on event id plus channel, so
 * a re-run of the same cycle never doubles a message.
 *
 * `already_dead` is deliberately louder than the other duplicates: that outcome will not be
 * delivered until ops requeues it, so reading it as "handled" would lose the record —
 * exactly what FR-016 forbids.
 */
function enqueue(
  deps: StrakerPollCycleDeps,
  channel: 'offers' | 'tracking' | 'alerts',
  eventId: string,
  atMs: number,
  payload: unknown,
): void {
  const result = deps.outbox.enqueue(eventId, channel, JSON.stringify(payload), atMs);
  if (result === 'already_dead') {
    deps.logger.error(
      { module: 'pollCycle', action: 'notify', outcome: 'already_dead', eventId, channel },
      'an outcome was queued before and has since died undelivered — requeue it, it will not resend itself',
    );
  }
}
