import { diffXtm } from '../detection/xtmDiff.js';
import { isEligibleTarget } from '../detection/eligibility.js';
import { decideAccept } from '../detection/acceptDecision.js';
import { XtmJobStore } from '../state/xtmJobStore.js';
import { JobStore } from '../state/jobStore.js';
import { MetaStore } from '../state/meta.js';
import { Outbox, createOutbox } from '../state/outbox.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import { lifecycleToSheetStatus, type SheetRow } from '../reporting/sheets.js';
import {
  renderXtmNewJob,
  renderXtmAccepted,
  renderXtmAcceptFailed,
  renderXtmColdStartSummary,
} from '../reporting/xtmNotifier.js';
import type { DB } from '../state/db.js';
import type { AppConfig } from '../config/index.js';
import type { AppearanceEventType, XtmJobSnapshot, XtmJobState } from '../detection/types.js';
import type { AcceptTarget, AcceptResult } from '../portal/errors.js';

/** The portal capability the cycle needs (injectable; the real impl is xtmClient). */
export interface XtmAcceptor {
  acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]>;
}

/**
 * Reads the job keys currently in the Closed tab (FR-014). Queried ONLY when an
 * accepted job disappears from Active (cost-bounded) to tell Closed from Removed.
 */
export interface ClosedReader {
  readClosedKeys(): Promise<Set<string>>;
}

export interface XtmCycleSummary {
  jobs: number;
  baseline: boolean;
  accepted: number;
  failed: number;
  missing: number;
  skipped: number;
  eligibleDisabled: number;
  closed: number;
  removed: number;
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
    private readonly closedReader?: ClosedReader,
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
      closed: 0,
      removed: 0,
    };
    const candidates: XtmJobState[] = [];
    const disappearedAccepted: XtmJobState[] = [];
    let acceptedThisCycle = 0;

    for (const ev of result.events) {
      const s = result.nextStates.get(ev.jobKey);
      if (!s) continue;

      if (ev.eventType === 'missing') {
        // A job the bot never accepted leaving Active → Missing (FR-014). An
        // accepted job that left Active is resolved Closed vs Removed below.
        if (s.acceptStatus === 'accepted') {
          disappearedAccepted.push(s);
        } else {
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

    // FR-014: an accepted job that left Active is Closed (found in the Closed tab)
    // or Removed (cancelled/reassigned). Checked ONLY on disappearance to respect
    // the rate budget (FR-027). Without a closedReader the job is left as-is.
    if (disappearedAccepted.length > 0 && this.closedReader) {
      const closedKeys = await this.closedReader.readClosedKeys();
      for (const s of disappearedAccepted) {
        if (closedKeys.has(s.jobKey)) {
          s.lifecycleStatus = 'closed';
          summary.closed++;
        } else {
          s.lifecycleStatus = 'removed';
          summary.removed++;
        }
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
    const acceptResults = new Map<string, AcceptResult>();
    if (targets.length > 0) {
      const results = await this.acceptor.acceptEligibleTasks(targets);
      for (const r of results) {
        acceptResults.set(r.jobKey, r);
        this.accept.recordAcceptOutcome(
          r.jobKey,
          r.outcome,
          r.outcome === 'accepted' ? r.at : null,
        );
        const s = result.nextStates.get(r.jobKey);
        if (r.outcome === 'accepted') {
          summary.accepted++;
          if (s) {
            s.lifecycleStatus = 'accepted';
            s.acceptStatus = 'accepted';
            s.acceptedAt = r.at;
          }
        } else if (r.outcome === 'missing') {
          summary.missing++;
          if (s) {
            s.lifecycleStatus = 'missing';
            s.acceptStatus = 'none';
          }
        } else {
          summary.failed++;
          if (s) {
            s.lifecycleStatus = 'accept_failed';
            s.acceptStatus = 'failed';
          }
          // T032 / Constitution V: an accept that could not be confirmed must
          // never be silent — raise a per-job system alert through the outbox.
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

    // Enqueue the per-job Sheets row (every changed job, all statuses) + the Chat
    // message (T041/T048). One event_id per transition per cycle; the outbox dedups
    // by (event_id, channel) so a re-run never duplicates (Constitution VII).
    for (const ev of result.events) {
      const s = result.nextStates.get(ev.jobKey);
      if (!s) continue;
      const base = `${ev.jobKey}|${s.lifecycleStatus}|${snapshot.pollCycleId}`;
      const outcome = acceptResults.get(ev.jobKey);
      const note =
        outcome?.outcome === 'failed'
          ? outcome.reason
          : outcome?.outcome === 'missing'
            ? 'snatched'
            : null;
      this.outbox.enqueue(
        `sheet:${base}`,
        JSON.stringify({ op: 'upsert', row: this.toSheetRow(s, note) }),
        snapshot.capturedAt,
        'sheets',
      );
      // During baseline a single cold-start summary replaces per-job Chat (FR-005).
      if (!baseline) {
        const text = this.chatForEvent(ev.eventType, s, outcome, snapshot.capturedAt);
        if (text) {
          this.outbox.enqueue(
            `chat:${base}`,
            JSON.stringify({ text }),
            snapshot.capturedAt,
            'chat',
          );
        }
      }
    }
    if (baseline) {
      const text = renderXtmColdStartSummary([...result.nextStates.values()], snapshot.capturedAt);
      this.outbox.enqueue(
        `coldstart:${snapshot.pollCycleId}`,
        JSON.stringify({ text }),
        snapshot.capturedAt,
        'chat',
      );
    }

    if (baseline) this.meta.markBaselineDone();
    this.meta.recordSuccessfulPoll(snapshot.capturedAt);
    return summary;
  }

  private toSheetRow(s: XtmJobState, note: string | null): SheetRow {
    return {
      jobKey: s.jobKey,
      receivedDate: s.firstSeenAt,
      status: lifecycleToSheetStatus(s.lifecycleStatus),
      projectName: s.projectName,
      fileName: s.fileName,
      sourceLang: s.sourceLang,
      targetLang: s.targetLang,
      dueDate: s.dueDate ?? s.dueRaw,
      words: s.words,
      step: s.step,
      role: s.role,
      acceptedAt: s.acceptedAt,
      note,
    };
  }

  /** The Chat message for an appearance, or undefined for sheet-only events. */
  private chatForEvent(
    eventType: AppearanceEventType,
    s: XtmJobState,
    outcome: AcceptResult | undefined,
    at: string,
  ): string | undefined {
    if (outcome) {
      // An accept attempt happened → report its outcome (acceptance outcome → Chat).
      if (outcome.outcome === 'accepted') return renderXtmAccepted(s);
      return renderXtmAcceptFailed(
        s,
        outcome.outcome,
        outcome.outcome === 'failed' ? outcome.reason : null,
        at,
      );
    }
    // A job the bot never accepted leaving Active is sheet-only (contracts §sheet-only).
    if (eventType === 'missing') return undefined;
    const note = s.eligible
      ? this.cfg.ACCEPT_ENABLED
        ? 'เข้าเกณฑ์มาเลย์ (MS) — กำลังกดรับ'
        : 'เข้าเกณฑ์มาเลย์ (MS) — auto-accept ปิดอยู่'
      : 'ไม่ใช่มาเลย์ — บันทึกไว้เฉย ๆ';
    return renderXtmNewJob(s, at, note);
  }
}
