import { randomUUID } from 'node:crypto';
import type { DB } from '../state/db.js';
import { Outbox, createOutbox } from '../state/outbox.js';
import { XtmJobStore } from '../state/xtmJobStore.js';
import { MetaStore } from '../state/meta.js';
import { Dispatcher } from '../reporting/dispatcher.js';
import { GoogleChatSender, type ChatSender } from '../reporting/googleChat.js';
import type { SheetSender } from '../reporting/sheets.js';
import { raiseAlert, resolveAlert } from '../reporting/systemAlerts.js';
import { bangkokDate, buildDailyReportCard, dueDailyReport } from '../reporting/dailyReport.js';
import { Heartbeat, type HeartbeatPinger } from '../monitoring/heartbeat.js';
import type { XtmPortalClient } from '../portal/xtmClient.js';
import { XtmPollCycle } from './xtmPollCycle.js';
import {
  CaptchaDetectedError,
  LayoutChangedError,
  LoginFailedError,
  PaginationDetectedError,
} from '../portal/errors.js';
import type { AppConfig } from '../config/index.js';
import type { Logger } from '../monitoring/logger.js';
import { type Clock, systemClock } from '../clock.js';

const PORTAL_DOWN_THRESHOLD_MS = 10 * 60_000;

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
   * null channel (unknown event) intentionally pages — fail-loud safe default.
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
        onDead: (eventId) => {
          // Branch on CHANNEL (not event-id prefix) so the team-page invariant holds
          // even if new team-channel event types are added in future.
          // Team-channel delivery failures NEVER page on-call (Constitution IV); they
          // surface via this alert only. Today the only team row is the daily report.
          // A null/unknown channel (null !== 'team' → true) pages — fail-loud safe default.
          const ch = this.outbox.getChannelByEventId(eventId);
          if (ch === 'team') {
            const date = eventId.startsWith('daily:') ? eventId.slice('daily:'.length) : eventId;
            raiseAlert(db, this.outbox, 'daily_report_dead', this.clock.nowIso(), date);
          } else {
            raiseAlert(
              db,
              this.outbox,
              'outbox_dead',
              this.clock.nowIso(),
              'outbox row exceeded retry limit',
            );
            // Covers transient-exhausted, malformed, and 400-payload-rejected drops.
            this.nonTeamFailureThisFlush = true;
          }
        },
        onPermanent: (eventId) => {
          raiseAlert(
            db,
            this.outbox,
            'outbox_dead',
            this.clock.nowIso(),
            'channel/Sheets webhook permanently revoked',
          );
          // Covers webhook-revoked (permanent) failures on non-team channels.
          // A null/unknown channel (null !== 'team' → true) intentionally pages — fail-loud safe default.
          const ch = this.outbox.getChannelByEventId(eventId);
          if (ch !== 'team') {
            this.nonTeamFailureThisFlush = true;
          }
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
      const snapshot = await this.client.fetchJobSnapshot(pollCycleId);
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
      // between them can't double-send or lose the sent date).
      if (dueDailyReport(this.clock.nowMs(), this.meta.lastDailyReportDate)) {
        const held = this.store.listByLifecycle('accepted');
        const card = buildDailyReportCard(held, this.clock.nowMs(), this.cfg.XTM_ACOLAD_OFFERS_URL);
        const date = bangkokDate(this.clock.nowMs());
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
      const stuck =
        this.nonTeamFailureThisFlush || this.outbox.countDeadExcludingChannel('team') > 0;
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
          failed: summary.failed,
          dead: disp.dead,
        },
        'poll cycle ok',
      );
      return true;
    } catch (err) {
      await this.handleError(err);
      return false;
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
