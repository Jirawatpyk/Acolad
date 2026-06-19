import { diffXtm } from '../detection/xtmDiff.js';
import { isEligibleTarget } from '../detection/eligibility.js';
import { decideAccept } from '../detection/acceptDecision.js';
import { XtmJobStore } from '../state/xtmJobStore.js';
import { JobStore } from '../state/jobStore.js';
import { MetaStore } from '../state/meta.js';
import { Outbox, createOutbox } from '../state/outbox.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import type { DB } from '../state/db.js';
import type { AppConfig } from '../config/index.js';
import type { XtmJobSnapshot, XtmJobState } from '../detection/types.js';
import type { AcceptTarget, AcceptResult } from '../portal/errors.js';

/** The portal capability the cycle needs (injectable; the real impl is xtmClient). */
export interface XtmAcceptor {
  acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]>;
}

export interface XtmCycleSummary {
  jobs: number;
  baseline: boolean;
  accepted: number;
  failed: number;
  missing: number;
  skipped: number;
  eligibleDisabled: number;
}

/**
 * US1 orchestration (detect → decide → accept → record), independent of Sheets/
 * Chat. diff is the sole transition owner; eligibility/decision are pure; the
 * accept goes through an atomic claim (FR-008) and the outcome is recorded from
 * the FR-024 re-read the acceptor performs. The Sheets/Chat enqueue is layered on
 * in US2/US3 from the same nextStates + outcomes.
 */
export class XtmPollCycle {
  private readonly store: XtmJobStore;
  private readonly accept: JobStore; // accept-status state machine
  private readonly meta: MetaStore;
  private readonly outbox: Outbox;

  constructor(
    private readonly db: DB,
    private readonly cfg: AppConfig,
    private readonly acceptor: XtmAcceptor,
  ) {
    this.store = new XtmJobStore(db);
    this.accept = new JobStore(db);
    this.meta = new MetaStore(db);
    this.outbox = createOutbox(db, cfg);
  }

  async run(snapshot: XtmJobSnapshot): Promise<XtmCycleSummary> {
    const baseline = !this.meta.baselineDone;
    const prev = this.store.loadAll();
    const result = diffXtm(snapshot, prev, { baseline });

    // Eligibility for every next state (config-driven, R8).
    for (const s of result.nextStates.values()) {
      s.eligible = isEligibleTarget(s.targetLang, this.cfg.ACCEPT_LANGUAGES);
    }

    const summary: XtmCycleSummary = {
      jobs: snapshot.jobs.length,
      baseline,
      accepted: 0,
      failed: 0,
      missing: 0,
      skipped: 0,
      eligibleDisabled: 0,
    };
    const candidates: XtmJobState[] = [];
    let acceptedThisCycle = 0;

    for (const ev of result.events) {
      const s = result.nextStates.get(ev.jobKey);
      if (!s) continue;

      if (ev.eventType === 'missing') {
        // A job the bot never accepted leaving Active → Missing (FR-014). An
        // accepted job that disappears is resolved Closed/Removed in US2 — leave it.
        if (s.acceptStatus !== 'accepted') {
          s.lifecycleStatus = 'missing';
          summary.missing++;
        }
        continue;
      }

      // first_seen / relisted / cold_start (FR-005 accepts still-acceptable pre-existing).
      const decision = decideAccept({
        targetLang: s.targetLang,
        words: s.words,
        acceptEnabled: this.cfg.ACCEPT_ENABLED,
        acceptLanguages: this.cfg.ACCEPT_LANGUAGES,
        maxWords: this.cfg.ACCEPT_MAX_WORDS,
        acceptedThisCycle,
        maxPerCycle: this.cfg.ACCEPT_MAX_PER_CYCLE,
      });
      if (decision.action === 'skip') {
        s.lifecycleStatus = 'skipped';
        summary.skipped++;
      } else if (decision.action === 'disabled') {
        s.lifecycleStatus = 'new'; // eligible, but auto-accept is off (FR-012)
        summary.eligibleDisabled++;
      } else {
        candidates.push(s);
        acceptedThisCycle++; // counts toward the per-cycle cap for the next decision
      }
    }

    // Persist the next states first so the accept-state machine has rows to claim.
    this.store.upsertMany(result.nextStates.values());

    // Claim atomically (FR-008) then bulk-accept; outcome comes from the re-read.
    const targets: AcceptTarget[] = [];
    for (const s of candidates) {
      if (this.accept.claimForAccept(s.jobKey)) {
        targets.push({ jobKey: s.jobKey, targetLang: s.targetLang ?? '' });
      }
    }
    if (targets.length > 0) {
      const results = await this.acceptor.acceptEligibleTasks(targets);
      for (const r of results) {
        this.accept.recordAcceptOutcome(
          r.jobKey,
          r.outcome,
          r.outcome === 'accepted' ? r.at : null,
        );
        if (r.outcome === 'accepted') {
          summary.accepted++;
        } else if (r.outcome === 'missing') {
          summary.missing++;
        } else {
          summary.failed++;
          // T032 / Constitution V: an accept that could not be confirmed must
          // never be silent — raise a per-job system alert through the outbox.
          const s = result.nextStates.get(r.jobKey);
          const detail = `${s?.projectName ?? '-'} / ${s?.fileName ?? r.jobKey}: ${r.reason}`;
          raiseAlert(
            this.db,
            this.outbox,
            'accept_failed',
            snapshot.capturedAt,
            detail,
            {},
            `accept_failed:${r.jobKey}`,
          );
        }
      }
    }

    if (baseline) this.meta.markBaselineDone();
    this.meta.recordSuccessfulPoll(snapshot.capturedAt);
    return summary;
  }
}
