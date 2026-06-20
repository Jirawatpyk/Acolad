import { randomUUID } from 'node:crypto';
import type { DB } from '../state/db.js';
import { Outbox, createOutbox } from '../state/outbox.js';
import { Dispatcher } from '../reporting/dispatcher.js';
import { GoogleChatSender, type ChatSender } from '../reporting/googleChat.js';
import type { SheetSender } from '../reporting/sheets.js';
import { raiseAlert, resolveAlert } from '../reporting/systemAlerts.js';
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
  private readonly cycle: XtmPollCycle;
  private readonly dispatcher: Dispatcher;
  private readonly heartbeat: HeartbeatPinger;
  private readonly sheetSender: SheetSender | undefined;
  private loginFailures = 0;
  private lockoutUntilMs = 0;
  private firstPortalErrorMs = 0;

  constructor(
    private readonly db: DB,
    private readonly client: XtmPortalClient,
    private readonly cfg: AppConfig,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock,
    deps: XtmPollLoopDeps = {},
  ) {
    this.outbox = createOutbox(db, cfg);
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
    this.dispatcher = new Dispatcher(
      this.outbox,
      chatSender,
      logger,
      {
        onDead: () =>
          raiseAlert(
            db,
            this.outbox,
            'outbox_dead',
            this.clock.nowIso(),
            'รายการ outbox เกินเพดาน retry',
          ),
        onPermanent: () =>
          raiseAlert(
            db,
            this.outbox,
            'outbox_dead',
            this.clock.nowIso(),
            'ช่องแจ้ง/Sheets ถูก revoke (ถาวร)',
          ),
      },
      deps.sheetSender,
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

      const disp = await this.dispatcher.flush(this.clock.nowIso(), this.clock.nowMs());

      if (snapshot.malformed.length > 0) {
        raiseAlert(
          this.db,
          this.outbox,
          'layout_changed',
          this.clock.nowIso(),
          `พบ ${snapshot.malformed.length} แถวที่ parse ไม่ผ่าน (quarantine)`,
        );
        await this.dispatcher.flush(this.clock.nowIso(), this.clock.nowMs());
      }

      const stuck =
        disp.dead > 0 || disp.permanentFailures > 0 || this.outbox.countByStatus('dead') > 0;
      if (stuck) {
        await this.heartbeat.fail();
      } else {
        resolveAlert(
          this.db,
          this.outbox,
          'outbox_dead',
          this.clock.nowIso(),
          'แจ้งเตือนส่งได้ตามปกติ',
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
        `${Math.round(downMs / 60000)} นาที`,
      );
      this.firstPortalErrorMs = 0;
    }
    resolveAlert(this.db, this.outbox, 'login_failed', this.clock.nowIso(), 'login สำเร็จ');
    resolveAlert(
      this.db,
      this.outbox,
      'layout_changed',
      this.clock.nowIso(),
      'อ่านหน้าได้อีกครั้ง',
    );
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
            `login ล้มเหลว ${this.loginFailures} ครั้งติดต่อกัน`,
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
          if (raiseAlert(this.db, this.outbox, 'portal_down', at, 'portal ไม่ตอบสนองต่อเนื่อง')) {
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
