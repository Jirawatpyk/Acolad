import { diffXtm } from '../detection/xtmDiff.js';
import { isEligibleTarget } from '../detection/eligibility.js';
import { decideAccept } from '../detection/acceptDecision.js';
import { computeXtmJobKey } from '../detection/jobKey.js';
import { XtmJobStore } from '../state/xtmJobStore.js';
import { JobStore } from '../state/jobStore.js';
import { MetaStore } from '../state/meta.js';
import { Outbox, createOutbox } from '../state/outbox.js';
import { raiseAlert, resolveAlert } from '../reporting/systemAlerts.js';
import { hasMaterialSheetChange } from '../reporting/sheetSync.js';
import { evaluateAcceptSchedule, type AcceptScheduleVerdict } from '../schedule/acceptSchedule.js';
import { decideGroupCapacity, type CapacityMember } from '../schedule/acceptCapacity.js';
import { resolveHolidaysForSpan, getThaiHolidays } from '../schedule/thaiHolidays.js';
import { bangkokYear } from '../schedule/bangkokCalendar.js';
import { deadlineDayOf, deadlineMsOf } from '../schedule/deadlineDay.js';
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
  /** Jobs the schedule gate blocked this cycle (per member of a rejected bulk group). */
  scheduleBlocked: number;
  /**
   * True when the CURRENT Bangkok year has no curated holiday list while the schedule
   * gate is ON — a TOTAL auto-accept outage (every job fail-closes). The loop threads
   * this into its heartbeat `stuck` gate so Healthchecks pages on-call (C1). False on
   * every other path (gate disabled, current year curated).
   */
  holidayCalendarStale: boolean;
  /**
   * One entry per job the schedule gate blocked this cycle, carrying the binding reject
   * reason + the fields needed to debug it (I1). The cycle stays logger-free (like
   * acceptLatencies); the loop logs these as structured warn lines so the FIRST real
   * rejection leaves a trail of WHY, not just a count.
   */
  scheduleRejects: {
    jobKey: string;
    reason: string;
    words: number | null;
    dueDate: string | null;
  }[];
  /**
   * §9 audit trail for the held-read → over-accept residual risk (deadline-bucketed capacity).
   * One entry per deadline day an accepted group advanced this cycle, carrying `wordsDueOn(day)`
   * — the RESULTING held + optimistically-advanced bucket the accept decision was based on. The
   * loop logs this map so a bucket that dropped then over-filled (e.g. a transient grid 0-read
   * mis-disappearing a held job; cf. the late-XHR bug) leaves an auditable trail. The cycle stays
   * logger-free (like acceptLatencies/scheduleRejects). Empty on every non-accepting / disabled /
   * early path.
   */
  acceptedDueDays: { day: string; words: number }[];
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
      s.acceptStatus = 'failed';
      s.lifecycleStatus = 'accept_failed';
      // F10: record the outcome AND enqueue the alert + Sheet row in ONE transaction (mirrors
      // the main accept-record txn). A crash between them would otherwise commit 'accept_failed'
      // to the DB while the alert/Sheet outbox rows are lost — the failure shows in state but
      // never reaches Chat/Sheet (an at-least-once gap). All-or-nothing: a throw rolls the record
      // back, so the job stays 'accepting' and is recovered cleanly next cycle.
      this.db.transaction(() => {
        this.accept.recordAcceptOutcome(s.jobKey, 'failed', null);
        raiseAlert(
          this.db,
          this.outbox,
          'accept_failed',
          snapshot.capturedAt,
          `${s.projectName} / ${s.fileName}: stuck in 'accepting' (prior cycle stopped mid-way)`,
          {},
          `accept_failed:${s.jobKey}`,
        );
        this.outbox.enqueue(
          `sheet:stranded:${s.jobKey}:${snapshot.pollCycleId}`,
          JSON.stringify({ op: 'upsert', row: this.toSheetRow(s, 'crash mid-accept') }),
          snapshot.capturedAt,
          'sheets',
        );
      })();
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
      scheduleBlocked: 0,
      holidayCalendarStale: false,
      scheduleRejects: [],
      acceptedDueDays: [],
    };
    const detectedMs = Date.parse(snapshot.capturedAt);
    // Schedule-gate state. Capacity is bucketed by DEADLINE day (held-derived), not accept
    // day: seed the per-deadline-day buckets ONCE from the held list (lifecycle 'accepted')
    // BEFORE this cycle records any new 'accepted' row — otherwise a job accepted this cycle
    // would be counted both in the seed and the optimistic advance (design §3). When the
    // gate is disabled the kill-switch path seeds nothing. A null/unparseable deadline is
    // already skipped by wordsDueByDeadline (no NaN key).
    const scheduleEnabled = this.cfg.ACCEPT_SCHEDULE_ENABLED;
    const dueSeed = scheduleEnabled ? this.store.wordsDueByDeadline() : new Map<string, number>();
    const dueBuckets = new Map<string, number>(); // memoized running buckets for THIS cycle
    // Current words due on a Bangkok deadline day, MEMOIZING the seed default into the map on
    // first miss (write `dueSeed.get(d) ?? 0`, don't re-read the seed each call) so a later
    // optimistic advance via dueBuckets.set(d, …) is never lost behind a stale `?? 0`.
    const bucketFor = (d: string): number => {
      let v = dueBuckets.get(d);
      if (v === undefined) {
        v = dueSeed.get(d) ?? 0;
        dueBuckets.set(d, v);
      }
      return v;
    };
    // The Bangkok deadline day of a job, or null when its deadline is missing/unparseable
    // (canonical helper — same parse the store bucket + the report use, F8).
    const deadlineDateOf = (s: XtmJobState): string | null => deadlineDayOf(s.dueDate);
    // Jobs whose decideAccept() → accept, collected from BOTH passes BEFORE the schedule
    // gate (C4 — one gate, no per-site drift). The gate then groups them per bulk-accept
    // unit and decides all-or-nothing (C1).
    const wouldAccept: XtmJobState[] = [];
    const candidates: XtmJobState[] = []; // post-gate accept set
    const disappearedAccepted: XtmJobState[] = [];
    // jobKey → why the job was blocked: a skip reason (non-Malay / cap) OR a schedule-
    // reject reason (I3). One map (F15) read by both the Sheet-note and Chat sites.
    const blockNotes = new Map<string, string>();
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
        blockNotes.set(ev.jobKey, decision.reason); // surface WHY (non-Malay / cap) on the Sheet
        summary.skipped++;
      } else if (decision.action === 'disabled') {
        s.lifecycleStatus = 'new'; // eligible, but auto-accept is off (FR-012)
        summary.eligibleDisabled++;
        // Capture the live accept-menu DOM for this eligible job (hover only, in the
        // loop) so acceptAvailable can be computed before auto-accept is ever enabled.
        if (this.cfg.ACCEPT_RECON) {
          summary.reconEligible.push({
            jobKey: s.jobKey,
            targetLang: s.targetLang ?? '',
            fileName: s.fileName,
            step: s.step,
            role: s.role,
          });
        }
      } else {
        wouldAccept.push(s); // schedule gate (below) decides accept vs reject per group
        // F6: counts would-accept candidates PRE-gate. The per-cycle cap mechanism relies
        // on incrementing here so the next decideAccept in THIS pass sees the running count
        // (moving it past the gate would defeat the cap, since the robustness pass below
        // reads the count before the gate runs). ACCEPT_MAX_PER_CYCLE MUST stay 0 (the
        // per-deadline-day capacity cap — decideGroupCapacity in this cycle — owns the
        // words/day limit); a cap > 0 is forbidden by the runbook for the bulk-claim hazard,
        // so this pre-gate count never gates a real accept in prod.
        acceptedThisCycle++;
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
        wouldAccept.push(s); // same gate as the event pass (C4 — no silent robustness reject)
        acceptedThisCycle++; // pre-gate count (see F6 note above); ACCEPT_MAX_PER_CYCLE must stay 0
      }
    }

    // Schedule gate (C1 bulk-group all-or-nothing). Applied ONLY where decideAccept()→accept;
    // skip/disabled/non-eligible paths are untouched. When the feature is OFF every
    // would-accept job becomes a candidate (byte-for-byte today's behavior). When ON, group
    // by the bulk-accept unit (one portal click claims the whole group) and accept a group
    // only if EVERY member ALLOWs (feasibility) AND every deadline-day bucket still fits the
    // cap (capacity); otherwise reject the WHOLE group with the binding reason — never leave a
    // sibling grabbed-on-portal-but-Rejected (the irreversible data-corruption hazard, §2.4).
    if (!scheduleEnabled) {
      // Gate OFF → byte-for-byte today's accept behavior (kill-switch): every would-accept
      // job becomes a candidate, no capacity cap, no seed (dueSeed is empty when disabled).
      for (const s of wouldAccept) candidates.push(s);
    } else {
      const cap = this.cfg.ACCEPT_MAX_WORDS_PER_DAY;
      const groups = new Map<string, XtmJobState[]>();
      for (const s of wouldAccept) {
        const key = this.bulkGroupKey(s);
        const g = groups.get(key);
        if (g) g.push(s);
        else groups.set(key, [s]);
      }
      for (const members of groups.values()) {
        // Feasibility pass first (unchanged): if ANY member fails, bind the FIRST failing
        // member's reason and block the WHOLE group — a bulk click claims every member, so a
        // partial accept would strand a sibling owned-but-Rejected (§2.4).
        let blockReason: string | null = null;
        for (const s of members) {
          const verdict = this.scheduleVerdict(s, detectedMs);
          if (blockReason === null && !verdict.allow)
            blockReason = `'${s.fileName}': ${verdict.reason}`;
        }
        // Capacity decision (group-level, per DEADLINE day) — gated behind feasibility so an
        // infeasible job reads "can't finish", never "cap reached" (§3). Buckets are the held
        // words due on each member's deadline day (held-derived), advanced optimistically per
        // day. Skipping a null deadlineDateOf is defensive: when ON every member already
        // passed feasibility (deadline known), so deadlineDateOf is non-null here.
        let capExhaustedDay: string | undefined;
        if (blockReason === null && cap > 0) {
          const capMembers: CapacityMember[] = members.map((s) => ({
            jobKey: s.jobKey,
            words: s.words ?? 0,
            deadlineDate: deadlineDateOf(s)!,
          }));
          const v = decideGroupCapacity(capMembers, bucketFor, cap);
          if (!v.accept) {
            // F6: a capacity block is DAY-level, not file-level — `v.reason` already names the
            // overflowing day + numbers. Do NOT prefix an arbitrary `members[0]` file (it is not
            // the member on the overflowing day, so it blamed the wrong file). The feasibility
            // path below still prefixes the actual failing member.
            blockReason = v.reason;
            capExhaustedDay = v.capExhaustedDay;
          } else {
            // Advance EACH deadline day's bucket by its OWN subtotal (never lump a
            // multi-deadline group onto one day) so a later group this cycle sees them.
            for (const [day, sub] of v.subtotalsByDay) dueBuckets.set(day, bucketFor(day) + sub);
            // §9 audit trail: record wordsDueOn(day) = the RESULTING bucket AFTER advancing, so
            // a bucket that dropped then over-filled is auditable in the loop's structured log.
            for (const day of v.subtotalsByDay.keys())
              summary.acceptedDueDays.push({ day, words: bucketFor(day) });
          }
        }
        if (blockReason === null) {
          for (const s of members) candidates.push(s);
        } else {
          const note = `group blocked: ${blockReason}`;
          for (const s of members) {
            s.lifecycleStatus = 'rejected';
            blockNotes.set(s.jobKey, note);
            summary.scheduleBlocked++;
            // I1: surface the binding reason per member so the loop can log WHY (the reason
            // otherwise lives only in the Chat/Sheet outbox payload). All members share the
            // group's binding reason but carry their own words/dueDate for debugging.
            summary.scheduleRejects.push({
              jobKey: s.jobKey,
              reason: blockReason,
              words: s.words,
              dueDate: s.dueDate,
            });
          }
          // I3b: a deadline day's budget is genuinely exhausted (not a single over-cap job) —
          // alert ONCE per DEADLINE day so ops knows "auto-accept paused for that day on
          // budget" (vs "no jobs"). Guarded behind scheduleEnabled (this whole block); the
          // dedupKey keys the deadline day so it fires at most once per that day.
          if (capExhaustedDay) {
            raiseAlert(
              this.db,
              this.outbox,
              'daily_cap_reached',
              snapshot.capturedAt,
              `the ${cap}-word daily cap is reached for ${capExhaustedDay}`,
              {},
              `daily_cap_reached:${capExhaustedDay}`,
            );
          }
        }
      }
      // Holiday-calendar staleness (C3, F1/F2): DATA-driven — raise iff the CURRENT Bangkok
      // year has no curated holiday list, INDEPENDENT of any job's presence. This persists
      // the alert until the year is curated (no flapping with job presence) and never
      // conflates it with a per-job capacity/feasibility block. A far deadline into an
      // uncurated NEXT year still fail-closes per-job via `scheduleVerdict`'s `resolveHolidaysForSpan` span-curation check above — it
      // just no longer raises this SYSTEM alert. Guarded behind ENABLED — a disabled feature
      // never resolves holidays or pages.
      const currentYear = bangkokYear(detectedMs);
      if (!getThaiHolidays(currentYear).curated) {
        // C1: a total auto-accept outage — surface it to the loop so the heartbeat fails
        // and Healthchecks pages on-call (not just a Chat card).
        summary.holidayCalendarStale = true;
        raiseAlert(
          this.db,
          this.outbox,
          'holiday_calendar_stale',
          snapshot.capturedAt,
          `the current year (${currentYear}) has no curated holiday list in src/schedule/thaiHolidaysData.ts`,
        );
      } else {
        resolveAlert(this.db, this.outbox, 'holiday_calendar_stale', snapshot.capturedAt, '—');
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
        targets.push({
          jobKey: s.jobKey,
          targetLang: s.targetLang ?? '',
          fileName: s.fileName,
          step: s.step,
          role: s.role,
        });
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
        // skipped → skip reason; schedule-blocked → the binding reject reason (I3). Both
        // live in the one blockNotes map now (F15).
        note = blockNotes.get(jobKey) ?? null;
      }
      this.outbox.enqueue(
        `sheet:${base}`,
        JSON.stringify({ op: 'upsert', row: this.toSheetRow(s, note) }),
        snapshot.capturedAt,
        'sheets',
      );
      // During baseline a single cold-start summary replaces per-job Chat (FR-005).
      if (!baseline) {
        const card = this.chatForEvent(
          ev?.eventType,
          ev?.firstSeenAt,
          s,
          outcome,
          snapshot.capturedAt,
          // Reuse the note already resolved above (E6) — the schedule-reject reason for a
          // rejected job, otherwise undefined. (For failed/missing outcomes `note` carries
          // the failure text, but chatForEvent's outcome branch handles those before it
          // reads rejectReason, so passing it here is harmless.)
          note ?? undefined,
        );
        if (card) {
          this.outbox.enqueue(`chat:${base}`, JSON.stringify(card), snapshot.capturedAt, 'chat');
          // Also notify the team channel for accepted jobs (Task 9).
          // Reuses the same card object — no rebuild. Fires ONLY on 'accepted'.
          if (outcome?.outcome === 'accepted') {
            this.outbox.enqueue(`team:${base}`, JSON.stringify(card), snapshot.capturedAt, 'team');
          }
        }
      }
    };
    for (const ev of result.events) reportJob(ev.jobKey, ev);
    for (const jobKey of acceptResults.keys()) reportJob(jobKey, undefined);
    // I3/C4: announce schedule rejections that produced NO appearance event and NO accept
    // outcome (a robustness-pass block) — otherwise they would be silently dropped. Only a
    // transition INTO 'rejected' is announced: a job already 'rejected' last cycle and still
    // blocked must NOT re-enqueue (the event_id carries pollCycleId, so re-reporting would
    // duplicate every cycle). A reason change within 'rejected' is intentionally not
    // re-announced (mirrors the accept_failed dedup philosophy). reportJob dedups by jobKey,
    // so a job already reported via its event/outcome above is skipped here. blockNotes also
    // holds skip reasons (F15), but every skipped job already fired via its appearance event
    // above, so reportJob's jobKey dedup makes those entries no-ops here.
    for (const jobKey of blockNotes.keys()) {
      if (prev.get(jobKey)?.lifecycleStatus === 'rejected') continue;
      reportJob(jobKey, undefined);
    }
    // Field-change re-sync (Bug B): a still-visible job whose Due date/Words XTM set AFTER
    // our last transition write reaches the DB but never the Sheet (which only writes on
    // transitions). The diff already records the change in detailsChanges (FR-019) — enqueue
    // a Sheet-ONLY upsert (no Chat: a silent correction) for any not-yet-reported job.
    for (const dc of result.detailsChanges) {
      if (reported.has(dc.jobKey) || !hasMaterialSheetChange(dc.changes)) continue;
      const s = result.nextStates.get(dc.jobKey);
      if (!s) continue;
      reported.add(dc.jobKey);
      // I3: a still-'rejected' job's silent field re-sync must NOT wipe the reject note.
      // The gate already re-ran this cycle (robustness pass) — if the new Due/Words made it
      // feasible it is now 'accepted' and was reported above (skipped here); otherwise it is
      // still 'rejected' and we preserve the binding reason instead of overwriting with null.
      const syncNote =
        s.lifecycleStatus === 'rejected' ? (blockNotes.get(dc.jobKey) ?? null) : null;
      this.outbox.enqueue(
        `sheet:fieldsync:${dc.jobKey}|${snapshot.pollCycleId}`,
        JSON.stringify({ op: 'upsert', row: this.toSheetRow(s, syncNote) }),
        snapshot.capturedAt,
        'sheets',
      );
    }
    if (baseline) {
      const card = renderXtmColdStartSummary(
        [...result.nextStates.values()],
        snapshot.pollCycleId,
        this.cfg.XTM_ACOLAD_OFFERS_URL,
      );
      this.outbox.enqueue(
        `coldstart:${snapshot.pollCycleId}`,
        JSON.stringify(card),
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

  /** The bulk-accept unit one portal click grabs (C1) — keyed by LANGUAGE ONLY, matching
   *  the acceptor's actual claim unit (`src/portal/xtmAccept.ts` groups its targets by
   *  `byLang` and the bulk "Accept all tasks for this language in this group" returns after
   *  the first claimable row). Language-only is the conservative, ACCEPT-safe key: it
   *  eliminates the cross-project owned-but-Rejected leak — if the portal's "group" ever
   *  spans more than one project, a single bulk click on an ALLOWed job would also grab a
   *  Malay sibling we marked Rejected in another project (irreversible). Trade-off: coarser
   *  capacity granularity — one infeasible Malay job rejects ALL Malay that cycle
   *  (all-or-nothing per language). Refine to (lang, project) ONLY after live-verifying the
   *  portal's bulk "group" boundary equals a single project. */
  private bulkGroupKey(s: XtmJobState): string {
    return s.targetLang ?? '';
  }

  /** Compose the schedule (feasibility-only) verdict for one would-accept job (C4 — the
   *  single gate used by both passes). Resolves the curated Thai-holiday map for every
   *  Bangkok year the now→deadline span touches and feeds the pure `evaluateAcceptSchedule`.
   *  Capacity is decided separately by `decideGroupCapacity` (per deadline day) in the cycle. */
  private scheduleVerdict(s: XtmJobState, nowMs: number): AcceptScheduleVerdict {
    const dueAtMs = deadlineMsOf(s.dueDate); // canonical parse (F8) — same one the bucket/report use
    // The per-job fail-closed still uses the SPAN's curation (a far deadline into an
    // uncurated year blocks); the cycle-level holiday_calendar_stale alert is decided
    // separately from the CURRENT year (F1/F2) in the gate block above.
    const { holidays, curated } = resolveHolidaysForSpan(nowMs, dueAtMs);
    return evaluateAcceptSchedule({
      enabled: true,
      nowMs,
      dueAtMs,
      words: s.words,
      throughputWordsPerHour: this.cfg.throughputWordsPerHour,
      calendar: {
        workdays: this.cfg.workdays,
        hoursStartMin: this.cfg.hoursStartMin,
        hoursEndMin: this.cfg.hoursEndMin,
        holidays,
      },
      holidaysCuratedForSpan: curated,
    });
  }

  /** The Chat card for an appearance, or undefined for sheet-only events. */
  private chatForEvent(
    eventType: AppearanceEventType | undefined,
    firstSeenAt: string | undefined,
    s: XtmJobState,
    outcome: AcceptResult | undefined,
    at: string,
    rejectReason?: string,
  ): { cardsV2: unknown[] } | undefined {
    const xtmUrl = this.cfg.XTM_ACOLAD_OFFERS_URL;
    if (outcome) {
      // An accept attempt happened → report its outcome (acceptance outcome → Chat).
      if (outcome.outcome === 'accepted') return renderXtmAccepted(s, xtmUrl);
      return renderXtmAcceptFailed(
        s,
        outcome.outcome,
        outcome.outcome === 'failed' ? outcome.reason : null,
        at,
        xtmUrl,
      );
    }
    // A schedule-blocked job (I3) → announce the reject reason, whether or not there was an
    // appearance event (a robustness-pass block has neither an event nor an outcome). Without
    // this it would wrongly read "Malay (MS) — accepting".
    if (s.lifecycleStatus === 'rejected') {
      const note = `Rejected — ${rejectReason ?? 'schedule blocked'}`;
      // F3: a RELISTED job that is now schedule-blocked must keep its "returned" context
      // (the stronger signal) — render the 🔁 relisted card (carrying the reject reason as a
      // Status row) rather than a 🆕 new-job card that would drop the firstSeenAt history.
      if (eventType === 'relisted') return renderXtmRelisted(s, firstSeenAt, at, xtmUrl, note);
      return renderXtmNewJob(s, at, note, xtmUrl);
    }
    // No accept outcome and no appearance event (robustness-pass job that wasn't
    // accepted) → nothing to announce.
    if (!eventType) return undefined;
    // A job the bot never accepted leaving Active is sheet-only (contracts §sheet-only).
    if (eventType === 'missing') return undefined;
    // A job that disappeared and returned is announced as relisted, not new (FR-019).
    if (eventType === 'relisted') return renderXtmRelisted(s, firstSeenAt, at, xtmUrl);
    let note: string;
    if (!s.eligible) {
      note = 'Not Malay — logged only';
    } else if (this.cfg.ACCEPT_ENABLED) {
      note = 'Malay (MS) — accepting';
    } else {
      note = 'Malay (MS) — auto-accept off';
    }
    return renderXtmNewJob(s, at, note, xtmUrl);
  }
}
