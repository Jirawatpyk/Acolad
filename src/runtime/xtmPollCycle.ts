import { diffXtm } from '../detection/xtmDiff.js';
import { isEligibleTarget } from '../detection/eligibility.js';
import { decideAccept } from '../detection/acceptDecision.js';
import { computeXtmJobKey } from '../detection/jobKey.js';
import { XtmJobStore } from '../state/xtmJobStore.js';
import { JobStore } from '../state/jobStore.js';
import { MetaStore } from '../state/meta.js';
import { Outbox, createOutbox } from '../state/outbox.js';
import { raiseAlert } from '../reporting/systemAlerts.js';
import { lifecycleToSheetStatus, type SheetRow } from '../reporting/sheets.js';
import {
  renderXtmNewJob,
  renderXtmRelisted,
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

/** Per-accept latency sample (T050) — both measured from detection (capturedAt). */
export interface AcceptLatencySample {
  jobKey: string;
  /** detection → confirm-click (V16, ≤ 5 s); null if the acceptor didn't stamp it. */
  clickLatencyMs: number | null;
  /** detection → FR-024-confirmed outcome (V16b/SC-003, ≤ 60 s). */
  outcomeLatencyMs: number;
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
  /** One entry per confirmed accept this cycle (empty while ACCEPT_ENABLED=0). */
  acceptLatencies: AcceptLatencySample[];
  /** Eligible jobs to recon the accept-menu DOM for (ACCEPT_RECON on + accept off). */
  reconEligible: AcceptTarget[];
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

    // Recovery (FR-008/FR-011, Constitution V/VII): a job still in 'accepting' is
    // from a prior cycle that crashed or threw after the claim but before recording
    // the outcome. Record it accept_failed + alert + sync to Sheets — never silently
    // dropped, and never re-accepted (accept_status stays out of 'none').
    for (const s of prev.values()) {
      if (s.acceptStatus !== 'accepting') continue;
      this.accept.recordAcceptOutcome(s.jobKey, 'failed', null);
      s.acceptStatus = 'failed';
      s.lifecycleStatus = 'accept_failed';
      raiseAlert(
        this.db,
        this.outbox,
        'accept_failed',
        snapshot.capturedAt,
        `${s.projectName} / ${s.fileName}: ค้างสถานะ accepting (รอบก่อนหยุดกลางคัน)`,
        {},
        `accept_failed:${s.jobKey}`,
      );
      this.outbox.enqueue(
        `sheet:stranded:${s.jobKey}:${snapshot.pollCycleId}`,
        JSON.stringify({ op: 'upsert', row: this.toSheetRow(s, 'crash mid-accept') }),
        snapshot.capturedAt,
        'sheets',
      );
    }

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
      acceptLatencies: [],
      reconEligible: [],
    };
    const detectedMs = Date.parse(snapshot.capturedAt);
    const candidates: XtmJobState[] = [];
    const disappearedAccepted: XtmJobState[] = [];
    const skipNotes = new Map<string, string>(); // jobKey → why it was skipped (Sheet note)
    let acceptedThisCycle = 0;

    for (const ev of result.events) {
      const s = result.nextStates.get(ev.jobKey);
      if (!s) continue;

      if (ev.eventType === 'missing') {
        // A job the bot never touched leaving Active → Missing (FR-014). An accepted
        // job that left Active is resolved Closed vs Removed below. A job already in
        // accept_failed/accepting (e.g. stranded-mid-accept recovered this cycle) keeps
        // that lifecycle — disappearing must not relabel it the softer 'missing'.
        if (s.acceptStatus === 'accepted') {
          disappearedAccepted.push(s);
        } else if (s.acceptStatus === 'none') {
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
        skipNotes.set(ev.jobKey, decision.reason); // surface WHY (non-Malay / cap) on the Sheet
        summary.skipped++;
      } else if (decision.action === 'disabled') {
        s.lifecycleStatus = 'new'; // eligible, but auto-accept is off (FR-012)
        summary.eligibleDisabled++;
        // Capture the live accept-menu DOM for this eligible job (hover only, in the
        // loop) so acceptAvailable can be computed before auto-accept is ever enabled.
        if (this.cfg.ACCEPT_RECON) {
          summary.reconEligible.push({ jobKey: s.jobKey, targetLang: s.targetLang ?? '' });
        }
      } else {
        candidates.push(s);
        acceptedThisCycle++; // counts toward the per-cycle cap for the next decision
      }
    }

    // Robustness: also attempt eligible jobs PRESENT in Active that produced NO fresh
    // appearance event this cycle — e.g. accept was enabled (or the bot restarted, or a
    // per-cycle cap deferred them) while the job was already showing. Without this a
    // still-acceptable Malay job sits un-grabbed forever (its only first_seen event fired
    // while accept was off). Bounded + idempotent: only accept_status 'none' (a grabbed /
    // failed / accepting job is never re-attempted), gated by the same cap and the atomic
    // claim below, and the job leaves Active once grabbed.
    const eventKeys = new Set(result.events.map((e) => e.jobKey));
    const presentKeys = new Set(snapshot.jobs.map((j) => computeXtmJobKey(j)));
    for (const s of result.nextStates.values()) {
      if (eventKeys.has(s.jobKey) || !presentKeys.has(s.jobKey)) continue;
      if (!s.eligible || s.acceptStatus !== 'none') continue;
      const decision = decideAccept({
        targetLang: s.targetLang,
        words: s.words,
        acceptEnabled: this.cfg.ACCEPT_ENABLED,
        acceptLanguages: this.cfg.ACCEPT_LANGUAGES,
        maxWords: this.cfg.ACCEPT_MAX_WORDS,
        acceptedThisCycle,
        maxPerCycle: this.cfg.ACCEPT_MAX_PER_CYCLE,
      });
      if (decision.action === 'accept') {
        candidates.push(s);
        acceptedThisCycle++;
      }
    }

    // FR-014: an accepted job that left Active is Closed (found in the Closed tab)
    // or Removed (cancelled/reassigned). Checked ONLY on disappearance to respect
    // the rate budget (FR-027). bootstrap always wires a closedReader in production;
    // the guarded path keeps the job 'accepted' as-is only when one is absent (tests).
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
      // Record every outcome in ONE transaction so a crash mid-batch is all-or-nothing
      // — a partial record would strand the rest in 'accepting' (recovered next cycle).
      this.db.transaction(() => {
        for (const r of results) {
          acceptResults.set(r.jobKey, r);
          this.accept.recordAcceptOutcome(
            r.jobKey,
            r.outcome,
            r.outcome === 'accepted' ? r.at : null,
          );
        }
      })();
      // Summary + in-memory state + alerts (outside the record transaction).
      for (const r of results) {
        const s = result.nextStates.get(r.jobKey);
        if (r.outcome === 'accepted') {
          summary.accepted++;
          if (s) {
            s.lifecycleStatus = 'accepted';
            s.acceptStatus = 'accepted';
            s.acceptedAt = r.at;
          }
          // Latency split for the report (T050 / V16 + V16b), measured from detection.
          // Bot-stamped timestamps always parse; guard anyway so a clock/parse
          // anomaly drops the telemetry sample rather than emitting a NaN latency.
          const outcomeLatencyMs = Date.parse(r.at) - detectedMs;
          if (Number.isFinite(outcomeLatencyMs)) {
            const click = r.clickedAt ? Date.parse(r.clickedAt) - detectedMs : null;
            summary.acceptLatencies.push({
              jobKey: r.jobKey,
              clickLatencyMs: click !== null && Number.isFinite(click) ? click : null,
              outcomeLatencyMs,
            });
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
    // Report every job that had an appearance event OR a fresh accept outcome this cycle.
    // The robustness pass can accept a job that produced no event — its Sheet row + Chat
    // must still fire (never a silent accept). Deduped by jobKey so an event-bearing
    // accept is reported once.
    const reported = new Set<string>();
    const reportJob = (jobKey: string, ev: (typeof result.events)[number] | undefined): void => {
      const s = result.nextStates.get(jobKey);
      if (!s || reported.has(jobKey)) return;
      reported.add(jobKey);
      const base = `${jobKey}|${s.lifecycleStatus}|${snapshot.pollCycleId}`;
      const outcome = acceptResults.get(jobKey);
      let note: string | null;
      if (outcome?.outcome === 'failed') {
        note = outcome.reason;
      } else if (outcome?.outcome === 'missing') {
        note = 'snatched';
      } else {
        note = skipNotes.get(jobKey) ?? null; // skipped → record the skip reason
      }
      this.outbox.enqueue(
        `sheet:${base}`,
        JSON.stringify({ op: 'upsert', row: this.toSheetRow(s, note) }),
        snapshot.capturedAt,
        'sheets',
      );
      // During baseline a single cold-start summary replaces per-job Chat (FR-005).
      if (!baseline) {
        const text = this.chatForEvent(
          ev?.eventType,
          ev?.firstSeenAt,
          s,
          outcome,
          snapshot.capturedAt,
        );
        if (text) {
          this.outbox.enqueue(
            `chat:${base}`,
            JSON.stringify({ text }),
            snapshot.capturedAt,
            'chat',
          );
        }
      }
    };
    for (const ev of result.events) reportJob(ev.jobKey, ev);
    for (const jobKey of acceptResults.keys()) reportJob(jobKey, undefined);
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
    eventType: AppearanceEventType | undefined,
    firstSeenAt: string | undefined,
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
    // No accept outcome and no appearance event (robustness-pass job that wasn't
    // accepted) → nothing to announce.
    if (!eventType) return undefined;
    // A job the bot never accepted leaving Active is sheet-only (contracts §sheet-only).
    if (eventType === 'missing') return undefined;
    // A job that disappeared and returned is announced as relisted, not new (FR-019).
    if (eventType === 'relisted') return renderXtmRelisted(s, firstSeenAt, at);
    let note: string;
    if (!s.eligible) {
      note = 'ไม่ใช่มาเลย์ — บันทึกไว้เฉย ๆ';
    } else if (this.cfg.ACCEPT_ENABLED) {
      note = 'เข้าเกณฑ์มาเลย์ (MS) — กำลังกดรับ';
    } else {
      note = 'เข้าเกณฑ์มาเลย์ (MS) — auto-accept ปิดอยู่';
    }
    return renderXtmNewJob(s, at, note);
  }
}
