import { randomUUID } from 'node:crypto';
import type { DB } from '../state/db.js';
import { Outbox, createOutbox, type OutboxChannel } from '../state/outbox.js';
import { XtmJobStore } from '../state/xtmJobStore.js';
import { MetaStore } from '../state/meta.js';
import { Dispatcher } from '../reporting/dispatcher.js';
import { GoogleChatSender, type ChatSender } from '../reporting/googleChat.js';
import type { SheetSender } from '../reporting/sheets.js';
import { raiseAlert, resolveAlert } from '../reporting/systemAlerts.js';
import { buildDailyReportCard, dueDailyReport } from '../reporting/dailyReport.js';
import { getThaiHolidays, holidaysForEffectiveDay } from '../schedule/thaiHolidays.js';
import { bangkokYear, bangkokDateString } from '../schedule/bangkokCalendar.js';
import { makeEffectiveDayOf } from '../schedule/deadlineDay.js';
import { Heartbeat, type HeartbeatPinger } from '../monitoring/heartbeat.js';
import type { XtmPortalClient } from '../portal/xtmClient.js';
import { XtmPollCycle } from './xtmPollCycle.js';
import {
  CaptchaDetectedError,
  LayoutChangedError,
  LoginFailedError,
  PaginationDetectedError,
  SessionYieldError,
  type LogoutKind,
} from '../portal/errors.js';
import { inCooldown, yieldStuck, shouldYieldOnLogout } from './yieldPolicy.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../monitoring/logger.js';
import { type Clock, systemClock } from '../clock.js';

const PORTAL_DOWN_THRESHOLD_MS = 10 * 60_000;

/** Consecutive clean reads required after a yield before declaring full resume. */
const RESUME_STABLE_CYCLES = 2;

/** Collaborators injected for testing (default to production impls). */
export interface XtmPollLoopDeps {
  chatSender?: ChatSender;
  teamChatSender?: ChatSender;
  sheetSender?: SheetSender;
  heartbeat?: HeartbeatPinger;
}

/**
 * One full XTM poll cycle: fetch Active snapshot → run the detect/accept/log/
 * notify cycle → dispatch outbox (chat + sheets) → heartbeat. Errors map to
 * system alerts; reporting failures never block detection (Constitution IV).
 * Session expiry is handled inside the client (silent re-login, FR-021); login
 * failures accumulate to a lockout. Mirrors the 001 PollLoop shell.
 */
export class XtmPollLoop {
  private readonly outbox: Outbox;
  private readonly store: XtmJobStore;
  private readonly meta: MetaStore;
  private readonly cycle: XtmPollCycle;
  private readonly dispatcher: Dispatcher;
  private readonly heartbeat: HeartbeatPinger;
  private readonly sheetSender: SheetSender | undefined;
  private loginFailures = 0;
  private consecutiveActiveCycles = 0;
  private lockoutUntilMs = 0;
  private firstPortalErrorMs = 0;
  private lastDiagMs = 0;
  /**
   * Set true during flush() when onDead OR onPermanent fires for a non-team channel row.
   * Covers all terminal failures this flush: transient-exhausted, malformed, 400-payload-
   * rejected (onDead path), and webhook-revoked (onPermanent path). A terminal failure on
   * the 'team' channel (daily report delivery) must NOT page on-call — it surfaces via
   * the system alert only (Constitution IV). Reset once before the first flush() so the
   * flag accumulates across both flush() calls in a malformed cycle.
   * Any channel other than 'team' pages on-call.
   */
  private nonTeamFailureThisFlush = false;

  constructor(
    private readonly db: DB,
    private readonly client: XtmPortalClient,
    private readonly cfg: AppConfig,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock,
    deps: XtmPollLoopDeps = {},
  ) {
    this.outbox = createOutbox(db, cfg);
    this.store = new XtmJobStore(db);
    this.meta = new MetaStore(db);
    this.cycle = new XtmPollCycle(db, cfg, client, {
      // The Closed read can still throw LayoutChangedError on a real structural drift (#8 header
      // guard); it propagates through cycle.run() to this loop's handleError (layout_changed alert
      // + heartbeat.fail). A zero cross-key match is the routine Removed case, not drift (reverted
      // #2b — see xtmInbox.ts), so no disappeared-accepted keys are forwarded.
      readClosedKeys: () => client.readClosedKeys(),
    });
    this.heartbeat =
      deps.heartbeat ??
      new Heartbeat(cfg.HEALTHCHECKS_PING_URL, (e, action) =>
        logger.warn({ module: 'heartbeat', action, outcome: 'error', err: String(e) }),
      );
    this.sheetSender = deps.sheetSender;
    const chatSender = deps.chatSender ?? new GoogleChatSender(cfg.GOOGLE_CHAT_WEBHOOK_SYSTEM);
    const teamChatSender =
      deps.teamChatSender ?? new GoogleChatSender(cfg.GOOGLE_CHAT_WEBHOOK_TEAM);
    this.dispatcher = new Dispatcher(
      this.outbox,
      {
        chat: chatSender,
        team: teamChatSender,
        ...(deps.sheetSender ? { sheet: deps.sheetSender } : {}),
      },
      logger,
      {
        onDead: (eventId, channel, reason) => {
          // Branch on CHANNEL (not event-id prefix) so the team-page invariant holds
          // even if new team-channel event types are added in future.
          // Team-channel delivery failures NEVER page on-call (Constitution IV); they
          // surface via this alert only. Today the only team row is the daily report.
          // Any channel other than 'team' pages on-call.
          // Fix 5: channel passed by dispatcher — no extra DB lookup needed.
          this.raiseTerminalAlert(eventId, channel, reason);
        },
        onPermanent: (eventId, channel) => {
          // Fix 1: mirror the onDead channel branch so a revoked team webhook raises
          // daily_report_dead instead of the generic outbox_dead (which would be wrong
          // and would also incorrectly omit the team channel from the page gate).
          // Fix 5: channel passed by dispatcher — no extra DB lookup needed.
          this.raiseTerminalAlert(eventId, channel, 'webhook rejected (permanent)');
        },
      },
    );
  }

  /** Run a single cycle. Returns true on success. */
  async runOnce(): Promise<boolean> {
    const nowMs = this.clock.nowMs();
    if (nowMs < this.lockoutUntilMs) {
      await this.heartbeat.fail();
      this.logger.warn(
        { module: 'xtmPollLoop', action: 'cycle', outcome: 'locked_out' },
        'in login lockout',
      );
      return false;
    }

    // --- auto-yield gate (shared-account session collision) ---
    // Reuse the `nowMs` read at the top of runOnce — a second clock read here is wasteful
    // and could drift the gate's stuck/cooldown decisions apart by a few ms.
    if (this.cfg.XTM_YIELD_ENABLED) {
      const stuck = yieldStuck(
        this.meta.yieldEpisodeStartedMs,
        nowMs,
        this.cfg.XTM_YIELD_MAX_MINUTES,
      );
      if (stuck) {
        // Louder escalation (deduped) — but DO NOT stop probing: still fall through so the
        // bot retries each cooldown and auto-recovers if the human leaves.
        const min = Math.round((nowMs - this.meta.yieldEpisodeStartedMs) / 60_000);
        raiseAlert(
          this.db,
          this.outbox,
          'yield_stuck',
          this.clock.nowIso(),
          `bot paused ${min} min — confirm a teammate is using XTM, or free the account / disable the bot`,
        );
      }
      if (inCooldown(this.meta.yieldUntilMs, nowMs)) {
        this.logger.info(
          { module: 'xtmPollLoop', action: 'yield', outcome: 'cooldown', stuck },
          'yielding to another XTM session (cooldown)',
        );
        await this.flushAndHeartbeat(stuck);
        return !stuck;
      }
    }

    const pollCycleId = randomUUID();
    const startMs = this.clock.nowMs();
    try {
      await this.client.maybeRecycle();
      // Proactively create the Sheet's v2 header on the first healthy cycle so an
      // empty Active list still leaves a headed sheet (idempotent; never blocks
      // detection — Constitution IV). A Sheets outage just retries next cycle.
      if (this.sheetSender?.ensureReady) {
        const ready = await this.sheetSender.ensureReady();
        if (ready !== 'ok') {
          this.logger.warn(
            { module: 'xtmPollLoop', action: 'sheet_ensure', outcome: ready },
            'sheet header not ensured yet (will retry next cycle)',
          );
        }
      }
      // A post-cooldown PROBE (episode active + not yet retaken this episode, i.e.
      // consecutiveActiveCycles === 0) MUST force a relogin to retake the account.
      // Without this, the kicked_by_other policy would yield forever and never resume.
      // After the probe retakes (consecutiveActiveCycles >= 1) we fall back to the
      // normal yield-on-kick policy.
      const probing =
        this.cfg.XTM_YIELD_ENABLED &&
        this.meta.yieldEpisodeStartedMs > 0 &&
        this.consecutiveActiveCycles === 0;
      const decideRelogin = this.cfg.XTM_YIELD_ENABLED
        ? (kind: LogoutKind): boolean =>
            probing ||
            !shouldYieldOnLogout({
              kind,
              lastAuthSuccessMs: this.meta.lastAuthSuccessMs,
              nowMs: this.clock.nowMs(),
              windowMs: this.cfg.XTM_YIELD_WINDOW_MS,
            })
        : undefined;
      const snapshot = await this.client.fetchJobSnapshot(
        pollCycleId,
        decideRelogin ? { decideRelogin } : undefined,
      );
      // last_auth_success_ms is read ONLY by the yield recency heuristic — don't write it
      // every ~20s when yield is disabled (F12).
      if (this.cfg.XTM_YIELD_ENABLED) this.meta.setLastAuthSuccessMs(this.clock.nowMs());
      if (this.cfg.XTM_YIELD_ENABLED && this.meta.yieldEpisodeStartedMs > 0) {
        this.consecutiveActiveCycles += 1;
        if (this.consecutiveActiveCycles >= RESUME_STABLE_CYCLES) {
          const min = Math.round((this.clock.nowMs() - this.meta.yieldEpisodeStartedMs) / 60_000);
          // Fold both resolveAlert calls and the meta-clear into one outer transaction so a
          // crash cannot resolve standing alerts without clearing the episode (which would
          // silently drop the next episode's paused card). resolveAlert opens its own inner
          // transaction; better-sqlite3 nests via savepoints — safe.
          this.db.transaction(() => {
            resolveAlert(this.db, this.outbox, 'xtm_yielding', this.clock.nowIso(), `${min} min`);
            resolveAlert(this.db, this.outbox, 'yield_stuck', this.clock.nowIso(), `${min} min`);
            this.meta.setYieldUntilMs(0);
            this.meta.setYieldEpisodeStartedMs(0);
          })();
          this.consecutiveActiveCycles = 0;
          this.logger.info(
            { module: 'xtmPollLoop', action: 'yield', outcome: 'resumed' },
            'resumed XTM monitoring',
          );
        }
      }
      const summary = await this.cycle.run(snapshot);
      this.onCycleSuccess();

      // DIAG (config.DIAG): snapshot the bot's OWN rendered Active grid right after
      // the read, so a "job present but read as 0" can be inspected from the bot's
      // exact view. Zero portal requests (serializes the already-loaded page), but
      // throttled to ~60s to bound disk. Logs the jobs count seen so evidence and
      // read agree/disagree visibly. Turn off after diagnosis.
      if (this.cfg.DIAG && this.client.captureDiag) {
        const sinceMs = this.clock.nowMs() - this.lastDiagMs;
        if (this.lastDiagMs === 0 || sinceMs >= 60_000) {
          this.lastDiagMs = this.clock.nowMs();
          try {
            const path = await this.client.captureDiag();
            // captureDiag swallows internal failures and returns undefined — branch on
            // the path so a silently-failed capture is not logged as a clean success
            // (the diagnostic exists to chase a silent read, it must not fail silently).
            this.logger.info(
              {
                module: 'diag',
                action: 'capture',
                outcome: path ? 'ok' : 'no_evidence',
                pollCycleId,
                jobsRead: snapshot.jobs.length,
                malformed: snapshot.malformed.length,
                evidence: path,
              },
              path ? 'diag inbox capture' : 'diag capture produced no evidence',
            );
          } catch (e) {
            this.logger.warn(
              { module: 'diag', action: 'capture', outcome: 'error', pollCycleId },
              e instanceof Error ? e.message : 'diag capture failed',
            );
          }
        }
      }

      // Per-accept latency lines for `npm run report:latency` (T050 / V16+V16b).
      // Empty while ACCEPT_ENABLED=0, so this is silent until accept is live.
      for (const lat of summary.acceptLatencies) {
        this.logger.info(
          {
            module: 'xtmPollLoop',
            action: 'accept',
            outcome: 'ok',
            jobKey: lat.jobKey,
            clickLatencyMs: lat.clickLatencyMs,
            outcomeLatencyMs: lat.outcomeLatencyMs,
          },
          'accept latency',
        );
      }

      // I1: one structured warn line per schedule-gate reject. The binding reason lives only
      // in the Chat/Sheet outbox payload otherwise — this leaves a grep-able log trail of WHY
      // a job was blocked (not just the scheduleBlocked count). Surfaced via the summary so
      // XtmPollCycle stays logger-free (consistent with acceptLatencies above).
      for (const r of summary.scheduleRejects) {
        this.logger.warn(
          {
            module: 'scheduleGate',
            action: 'reject',
            jobKey: r.jobKey,
            reason: r.reason,
            words: r.words,
            dueDate: r.dueDate,
          },
          'job blocked by schedule gate',
        );
      }

      // A malformed lastSeenAt reached the Sheet-row build — the sticky-Rejected "(left Active …)"
      // suffix was silently dropped. Unreachable in production, so a warn line makes the ops write /
      // bug that produced it grep-able instead of an invisibly-degraded row.
      for (const jobKey of summary.malformedLastSeen) {
        this.logger.warn(
          { module: 'xtmPollCycle', action: 'malformedLastSeen', jobKey },
          'lastSeenAt did not parse — (left Active …) suffix omitted on the Sheet row',
        );
      }

      // ACCEPT_RECON (accept off): capture the live accept-menu DOM for the first
      // eligible job — hover only, NEVER accepts — while it is still in Active this
      // cycle (beats the < 1 min snatch window). Best-effort; a one-time Chat ping
      // (deduped event_id) tells the team the menu is ready to verify.
      if (summary.reconEligible.length > 0 && this.client.captureAcceptMenu) {
        try {
          const path = await this.client.captureAcceptMenu(summary.reconEligible);
          if (path) {
            this.logger.info(
              { module: 'acceptRecon', action: 'capture', outcome: 'ok', evidence: path },
              'captured accept menu DOM',
            );
            this.outbox.enqueue(
              'accept_recon_captured',
              JSON.stringify({
                text: `🔍 Accept-menu DOM captured (${path}) — ready to verify selector + compute acceptAvailable before enabling accept`,
              }),
              this.clock.nowIso(),
              'chat',
            );
          }
        } catch (e) {
          this.logger.warn(
            { module: 'acceptRecon', action: 'capture', outcome: 'error' },
            e instanceof Error ? e.message : 'accept-menu recon capture failed',
          );
        }
      }

      // Daily 09:00 Bangkok report — once per calendar day, crash-safe via one
      // SQLite transaction (enqueue outbox row + set meta in same txn so a crash
      // between them can't double-send or lose the sent date). Non-fatal: a throw
      // is logged and swallowed so detection is never blocked (Constitution IV).
      // Meta stays unset on failure so the next cycle retries.
      // Capture the clock ONCE (E2) so the dueDailyReport guard, the card builder,
      // and the meta write all key off the identical instant.
      const nowMs = this.clock.nowMs();
      if (
        dueDailyReport(
          nowMs,
          this.meta.lastDailyReportDate,
          this.cfg.workdays,
          getThaiHolidays(bangkokYear(nowMs)).holidays,
        )
      ) {
        const date = bangkokDateString(nowMs);
        try {
          // Build INSIDE the try so a DB-read or render throw becomes "no report this
          // cycle, retry next" — never an outer-catch heartbeat.fail() page (Constitution
          // IV). Meta stays unset on a throw (the set below is never reached), so the next
          // eligible cycle retries.
          const held = this.store.listByLifecycle('accepted');
          // Bucket "Due today" by the EFFECTIVE deadline day (the working day the work lands on)
          // so the report's headline matches the capacity cap — same mapper the cycle uses.
          const card = buildDailyReportCard(
            held,
            nowMs,
            this.cfg.XTM_ACOLAD_OFFERS_URL,
            this.cfg.activeMaxPerDay,
            makeEffectiveDayOf(
              this.cfg.hoursStartMin,
              this.cfg.workdays,
              holidaysForEffectiveDay(nowMs),
            ),
            // #8: only advertise the per-deadline cap when the schedule gate is ON. With the gate
            // off the cap is not enforced (accept 24/7), so the headline must not claim a limit.
            this.cfg.ACCEPT_SCHEDULE_ENABLED,
            this.cfg.ACCEPT_EFFORT_METRIC,
          );
          this.db.transaction(() => {
            this.outbox.enqueue(`daily:${date}`, JSON.stringify(card), this.clock.nowIso(), 'team');
            this.meta.set('last_daily_report_date', date);
          })();
          this.logger.info(
            {
              module: 'xtmPollLoop',
              action: 'daily_report',
              outcome: 'enqueued',
              date,
              held: held.length,
            },
            'daily in-progress report enqueued',
          );
        } catch (e) {
          this.logger.error(
            {
              module: 'xtmPollLoop',
              action: 'daily_report',
              outcome: 'error',
              date,
              // Pass the error object through pino's `err` serializer so the stack/type
              // survive (String(e) collapsed them to a bare message). Constitution V.
              err: e,
            },
            'daily report enqueue failed — will retry next cycle',
          );
          // Do NOT re-throw: a non-critical report failure must not tank the detection cycle.
          // Meta stays unset so the next eligible cycle retries.
        }
      }

      // Reset the per-flush terminal-failure flag once, before the first flush(), so it
      // accumulates across both flush() calls in a malformed cycle (the second flush sends
      // the layout-alert row). Stale state from a prior cycle must not bleed in.
      this.nonTeamFailureThisFlush = false;
      const disp = await this.dispatcher.flush(this.clock.nowIso(), this.clock.nowMs());

      if (snapshot.malformed.length > 0) {
        raiseAlert(
          this.db,
          this.outbox,
          'layout_changed',
          this.clock.nowIso(),
          `${snapshot.malformed.length} row(s) failed parsing (quarantined)`,
        );
        await this.dispatcher.flush(this.clock.nowIso(), this.clock.nowMs());
      } else {
        // Clean read → clear any standing layout alert (once). Resolving here, not in
        // onCycleSuccess, avoids a recovered↔alert flap when a row stays malformed.
        resolveAlert(
          this.db,
          this.outbox,
          'layout_changed',
          this.clock.nowIso(),
          'page read clean',
        );
      }

      // A dead or permanently-failing 'team' channel row (daily report delivery
      // failure) must NEVER page on-call — it surfaces only via the onDead/onPermanent
      // system alert (Constitution IV: reporting outages never block detection or
      // on-call paging). Only non-team terminal failures trigger the /fail dead-man switch.
      //
      // nonTeamFailureThisFlush is set by BOTH onDead (transient-exhausted, malformed,
      // 400-payload-rejected) and onPermanent (webhook-revoked) when the failing row's
      // channel is NOT 'team'. This supersedes the former channel-agnostic disp.dead /
      // disp.permanentFailures terms which leaked team failures into the page gate.
      //
      // countDeadExcludingChannel('team') catches the persistent cross-cycle dead backlog
      // (rows that died in a prior cycle and were never resolved).
      //
      // F4: a probe that SUCCEEDS during a still-open yield episode past the hard cap must
      // also page — otherwise a lucky read mid-stuck-episode would flip the heartbeat back
      // to ok with no on-call signal. (The resume path clears the episode BEFORE this check,
      // so a genuine resume cycle is not falsely flagged.)
      const yieldStuckNow =
        this.cfg.XTM_YIELD_ENABLED &&
        yieldStuck(
          this.meta.yieldEpisodeStartedMs,
          this.clock.nowMs(),
          this.cfg.XTM_YIELD_MAX_MINUTES,
        );
      const stuck =
        yieldStuckNow ||
        this.nonTeamFailureThisFlush ||
        this.outbox.countDeadExcludingChannel('team') > 0 ||
        // C1: an uncurated CURRENT Bangkok year = total auto-accept outage. Fail the
        // heartbeat so Healthchecks pages; the cycle resolves the alert (and clears this
        // flag) once the year is curated, flipping the heartbeat back to ok.
        summary.holidayCalendarStale;
      if (stuck) {
        await this.heartbeat.fail();
      } else {
        resolveAlert(
          this.db,
          this.outbox,
          'outbox_dead',
          this.clock.nowIso(),
          'notifications delivering normally',
        );
        await this.heartbeat.ok();
      }

      this.logger.info(
        {
          module: 'xtmPollLoop',
          action: 'cycle',
          outcome: 'ok',
          latencyMs: this.clock.nowMs() - startMs,
          jobs: snapshot.jobs.length,
          accepted: summary.accepted,
          skipped: summary.skipped,
          scheduleBlocked: summary.scheduleBlocked,
          holidayCalendarStale: summary.holidayCalendarStale,
          // §9 audit trail: an array of {day, resultingBucketEffort} entries (effort under the
          // active metric per deadline day — the bucket the accept decisions used this cycle) so a
          // held-read drift that over-fills a bucket leaves a grep-able trail.
          acceptedDueDays: summary.acceptedDueDays,
          failed: summary.failed,
          dead: disp.dead,
        },
        'poll cycle ok',
      );
      // F4: return !stuck (not bare true) so a probe-success during a stuck episode reports
      // unhealthy for the console label too — consistent with the heartbeat it just failed.
      return !stuck;
    } catch (err) {
      // F2: a yield is a healthy, expected state — but a yield that crosses the hard cap is
      // NOT healthy. handleYield returns !stuck, so the console label stays consistent
      // (shows "error" while stuck) and the heartbeat it set agrees with the return.
      if (err instanceof SessionYieldError) return await this.handleYield(err);
      await this.handleError(err);
      return false;
    }
  }

  /** Flush the outbox and set heartbeat ok/fail by the dead-backlog gate (or forceFail). */
  private async flushAndHeartbeat(forceFail: boolean): Promise<void> {
    this.nonTeamFailureThisFlush = false;
    await this.dispatcher.flush(this.clock.nowIso(), this.clock.nowMs());
    const stuck =
      forceFail ||
      this.nonTeamFailureThisFlush ||
      this.outbox.countDeadExcludingChannel('team') > 0;
    if (stuck) {
      await this.heartbeat.fail();
    } else {
      resolveAlert(
        this.db,
        this.outbox,
        'outbox_dead',
        this.clock.nowIso(),
        'notifications delivering normally',
      );
      await this.heartbeat.ok();
    }
  }

  /**
   * Enter (or extend) a yield episode. Returns `!stuck` so runOnce's console label stays
   * consistent with the heartbeat (F2): a quiet yield is healthy, a yield past the hard cap
   * is not. raiseAlert runs BEFORE the meta writes so a crash between them is self-healing:
   * on restart the episode is unset → firstEntry is true again → raiseAlert re-fires but the
   * active-alert dedup drops the duplicate, and the meta gets set on the retry. The whole
   * body is wrapped (F3) so a throw from raiseAlert/dispatcher.flush can never escape runOnce
   * — it is logged and converted to a heartbeat fail, mirroring handleError.
   */
  private async handleYield(err: SessionYieldError): Promise<boolean> {
    const nowMs = this.clock.nowMs();
    const nowIso = this.clock.nowIso();
    this.consecutiveActiveCycles = 0;
    // F11: a yield is NOT a login failure — clear the pre-yield counter so a stray failure
    // from before the yield can't combine with post-yield failures to trip the lockout early.
    this.loginFailures = 0;
    const firstEntry = this.meta.yieldEpisodeStartedMs === 0;
    // A re-yield while already past the hard cap must keep paging (not silently flip
    // heartbeat back to ok). firstEntry can never be stuck (episode just started).
    const stuck =
      !firstEntry &&
      yieldStuck(this.meta.yieldEpisodeStartedMs, nowMs, this.cfg.XTM_YIELD_MAX_MINUTES);
    try {
      if (firstEntry) {
        const windowMin = Math.round(this.cfg.XTM_YIELD_WINDOW_MS / 60_000);
        raiseAlert(
          this.db,
          this.outbox,
          'xtm_yielding',
          nowIso,
          `XTM account in use by another session (logout: ${err.logoutKind}) — monitoring paused, retrying ~every ${windowMin} min`,
        );
      }
      // F5: a yield that crosses the cap mid-probe must ALSO raise the yield_stuck card
      // (deduped — safe if the gate already raised it). Without this, a fetch that crosses
      // the cap while probing fails the heartbeat with no escalation card.
      if (stuck) {
        const min = Math.round((nowMs - this.meta.yieldEpisodeStartedMs) / 60_000);
        raiseAlert(
          this.db,
          this.outbox,
          'yield_stuck',
          nowIso,
          `bot paused ${min} min — confirm a teammate is using XTM, or free the account / disable the bot`,
        );
      }
      this.db.transaction(() => {
        this.meta.setYieldUntilMs(nowMs + this.cfg.XTM_YIELD_WINDOW_MS);
        if (firstEntry) this.meta.setYieldEpisodeStartedMs(nowMs);
      })();
      this.logger.info(
        { module: 'xtmPollLoop', action: 'yield', outcome: 'paused', kind: err.logoutKind, stuck },
        'yielded XTM account to another session',
      );
      await this.flushAndHeartbeat(stuck); // healthy unless the outbox is dead OR past the cap
      return !stuck;
    } catch (handlerErr) {
      // F3: never let a dispatcher/alert throw escape runOnce — log it and fail the heartbeat.
      this.logger.error(
        { module: 'xtmPollLoop', action: 'handle_yield', outcome: 'error' },
        handlerErr instanceof Error ? handlerErr.message : 'yield handler failed',
      );
      await this.heartbeat.fail();
      return false;
    }
  }

  /**
   * Shared terminal-alert helper for onDead and onPermanent (Fix 1 + Fix 5 + Fix 6).
   *
   * Branch on CHANNEL so the team-page invariant holds for both dead and permanent paths:
   *   team   → raise 'daily_report_dead' with a detail of `${date} — ${reason}`.
   *            Does NOT set nonTeamFailureThisFlush (Constitution IV: team failures never page).
   *   others → raise 'outbox_dead' with detail `outbox row dead — ${reason}` and
   *            set nonTeamFailureThisFlush = true. Any channel other than 'team' pages on-call.
   */
  private raiseTerminalAlert(eventId: string, channel: OutboxChannel, reason: string): void {
    if (channel === 'team') {
      // Fix 6: detail = "<date> — <reason>" so the card's Detail row is informative.
      const date = eventId.startsWith('daily:') ? eventId.slice('daily:'.length) : eventId;
      const detail = `${date} — ${reason}`;
      raiseAlert(this.db, this.outbox, 'daily_report_dead', this.clock.nowIso(), detail);
    } else {
      raiseAlert(
        this.db,
        this.outbox,
        'outbox_dead',
        this.clock.nowIso(),
        `outbox row dead — ${reason}`,
      );
      // Covers transient-exhausted, malformed, 400-payload-rejected (onDead path), and
      // webhook-revoked (onPermanent path) failures on non-team channels.
      this.nonTeamFailureThisFlush = true;
    }
  }

  private onCycleSuccess(): void {
    this.loginFailures = 0;
    if (this.firstPortalErrorMs !== 0) {
      const downMs = this.clock.nowMs() - this.firstPortalErrorMs;
      resolveAlert(
        this.db,
        this.outbox,
        'portal_down',
        this.clock.nowIso(),
        `${Math.round(downMs / 60000)} min`,
      );
      this.firstPortalErrorMs = 0;
    }
    resolveAlert(this.db, this.outbox, 'login_failed', this.clock.nowIso(), 'login succeeded');
    // layout_changed is resolved/raised in runOnce based on THIS cycle's malformed
    // count — not here — so a persistently-malformed row does not flap recovered↔alert
    // every cycle (onCycleSuccess runs before the malformed check).
  }

  private async handleError(err: unknown): Promise<void> {
    try {
      const at = this.clock.nowIso();
      // F6: an errored cycle is NOT a clean read — reset the resume counter so a yield
      // episode cannot resume after fewer than RESUME_STABLE_CYCLES truly-clean reads.
      this.consecutiveActiveCycles = 0;
      if (!(err instanceof LoginFailedError)) this.loginFailures = 0;

      if (err instanceof LoginFailedError) {
        this.loginFailures++;
        if (this.loginFailures >= this.cfg.LOGIN_MAX_RETRY) {
          this.lockoutUntilMs = this.clock.nowMs() + this.cfg.LOGIN_LOCKOUT_MINUTES * 60_000;
          raiseAlert(
            this.db,
            this.outbox,
            'login_failed',
            at,
            `login failed ${this.loginFailures} consecutive times`,
          );
          await this.dispatcher.flush(at, this.clock.nowMs());
        }
      } else if (err instanceof CaptchaDetectedError) {
        raiseAlert(this.db, this.outbox, 'captcha', at, err.message);
        await this.dispatcher.flush(at, this.clock.nowMs());
      } else if (err instanceof LayoutChangedError) {
        raiseAlert(this.db, this.outbox, 'layout_changed', at, err.message);
        await this.dispatcher.flush(at, this.clock.nowMs());
      } else if (err instanceof PaginationDetectedError) {
        // FR-009: more jobs than one page — surface so read scope can be widened.
        raiseAlert(this.db, this.outbox, 'pagination', at, err.message);
        await this.dispatcher.flush(at, this.clock.nowMs());
      } else {
        // Transient (network/timeout/session): track the portal-down window.
        if (this.firstPortalErrorMs === 0) this.firstPortalErrorMs = this.clock.nowMs();
        if (this.clock.nowMs() - this.firstPortalErrorMs >= PORTAL_DOWN_THRESHOLD_MS) {
          if (
            raiseAlert(this.db, this.outbox, 'portal_down', at, 'portal not responding (sustained)')
          ) {
            await this.dispatcher.flush(at, this.clock.nowMs());
          }
        }
      }
      this.logger.error(
        {
          module: 'xtmPollLoop',
          action: 'cycle',
          outcome: 'error',
          errKind: (err as { kind?: string }).kind ?? 'unknown',
        },
        err instanceof Error ? err.message : 'unknown error',
      );
    } catch (handlerErr) {
      this.logger.error(
        { module: 'xtmPollLoop', action: 'handle_error', outcome: 'error' },
        handlerErr instanceof Error ? handlerErr.message : 'error handler failed',
      );
    } finally {
      await this.heartbeat.fail();
    }
  }
}
