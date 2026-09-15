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
import { claimOffer, type ClaimDoor } from './claim.js';
import {
  decideClaims,
  type ClaimDecision,
  type ClaimDecisionSettings,
  type OfferForDecision,
} from './claimDecision.js';
import { StrakerHttpError } from './httpClient.js';
import type { StrakerLedger } from './ledger.js';
import type { StrakerCycle, StrakerPortal } from './main.js';
import type { SightingTracker } from './main.js';
import { alertsOn, alertsOnSkip, countsTowardLedger } from './outcomePolicy.js';
import type { StrakerOutbox } from './outbox.js';
import type { RawOffer } from './probe.js';
import type { StrakerStore } from './strakerStore.js';
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
        // Only a 401 means the session expired. Dropping it on every error would turn a
        // barred account into a sign-in storm against a portal that has already said no.
        if (err instanceof StrakerHttpError && err.status === 401) session = null;
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
        // live offer as vanished and stamp a fabricated lifetime on each — the bug that
        // cost the XTM bot 38 minutes of missed work.
        return false;
      }

      // --- diff ------------------------------------------------------------------
      const sightings = deps.tracker.apply({ atMs, offerIds: raw.map((o) => o.obj_id) });

      // --- gate ------------------------------------------------------------------
      // One held-list snapshot per cycle, read before any decision: the capacity check and
      // every subsequent one must see the same set, or two offers in one read can each be
      // told there is room for them alone.
      const held = deps.store.heldWork();
      const decisions = decideClaims(offers, {
        nowMs: atMs,
        settings: deps.settings,
        ledger: deps.ledger,
        held,
      });

      // --- act -------------------------------------------------------------------
      // Nothing below writes or announces until every claim has resolved (FR-003).
      const acted: ActedClaim[] = [];
      // Read once, before the loop: `re_authenticate` below clears `session`, and a claim
      // that reached for it afterwards would be aiming at nothing.
      const { vendorId } = session;
      let stopClaiming = false;
      for (const decision of decisions) {
        if (decision.action !== 'claim' || stopClaiming) continue;
        const attempt = await claimOffer(deps.portal.client as ClaimDoor, {
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
        if (attempt.followUp !== 'none') stopClaiming = true;
        if (attempt.followUp === 're_authenticate') session = null;
      }

      // --- persist ---------------------------------------------------------------
      deps.store.transaction(() => {
        for (const offer of sightings.appeared) deps.store.recordSighting(offer);
        for (const offer of sightings.vanished) deps.store.endSighting(offer);

        for (const decision of decisions) {
          if (decision.action !== 'skip') continue;
          deps.store.recordEvent({
            objId: decision.objId,
            eventType: 'skip',
            outcome: null,
            skipReason: decision.reason,
            effortWords: null,
            deadlineMs: null,
            occurredAtMs: atMs,
          });
        }

        for (const { decision, outcome } of acted) {
          deps.store.recordEvent({
            objId: decision.objId,
            eventType: 'claim',
            outcome,
            skipReason: null,
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
        }
      });

      // --- notify ----------------------------------------------------------------
      for (const decision of decisions) {
        if (decision.action === 'skip' && alertsOnSkip(decision.reason)) {
          enqueue(deps, 'alerts', `skip:${decision.objId}:${decision.reason}`, atMs, {
            objId: decision.objId,
            reason: decision.reason,
            detail: decision.detail,
          });
        }
      }
      for (const { decision, outcome, detail } of acted) {
        const channel = alertsOn(outcome) ? 'alerts' : 'offers';
        if (!alertsOn(outcome) && outcome !== 'won') continue;
        enqueue(deps, channel, `claim:${decision.objId}:${outcome}`, atMs, {
          objId: decision.objId,
          languageDirection: decision.languageDirection,
          effortWords: decision.effortWords,
          deadlineMs: decision.deadlineMs,
          outcome,
          detail,
        });
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
