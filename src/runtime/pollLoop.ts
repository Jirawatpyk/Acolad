import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { DB } from '../state/db.js';
import { Outbox } from '../state/outbox.js';
import { MetaStore } from '../state/meta.js';
import { PollCyclePersister } from './pollCycle.js';
import { Dispatcher } from '../reporting/dispatcher.js';
import { GoogleChatSender } from '../reporting/googleChat.js';
import { raiseAlert, resolveAlert } from '../reporting/systemAlerts.js';
import { RateLimiter } from './rateLimiter.js';
import { Heartbeat } from '../monitoring/heartbeat.js';
import { BrowserSession } from '../portal/browser.js';
import { performLogin } from '../portal/login.js';
import { readJobSnapshot, isLoggedOut } from '../portal/jobList.js';
import { captureEvidence } from '../portal/evidence.js';
import {
  CaptchaDetectedError,
  LayoutChangedError,
  LoginFailedError,
  PaginationDetectedError,
  SessionExpiredError,
} from '../portal/errors.js';
import type { AppConfig } from '../config/index.js';
import { secretValues } from '../config/index.js';
import type { Logger } from '../monitoring/logger.js';

const PORTAL_DOWN_THRESHOLD_MS = 10 * 60_000;

export interface Clock {
  nowMs(): number;
  nowIso(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

/**
 * One full poll cycle: ensure login → fetch snapshot → diff+persist+enqueue →
 * dispatch → heartbeat. Returns whether the cycle succeeded. Errors are mapped
 * to system alerts; reporting failures never block detection (Constitution IV).
 */
export class PollLoop {
  private readonly outbox: Outbox;
  private readonly persister: PollCyclePersister;
  private readonly dispatcher: Dispatcher;
  private readonly heartbeat: Heartbeat;
  private readonly rate: RateLimiter;
  private readonly meta: MetaStore;
  private readonly secrets: string[];
  private loginFailures = 0;
  private lockoutUntilMs = 0;
  private firstPortalErrorMs = 0;

  constructor(
    private readonly db: DB,
    private readonly browser: BrowserSession,
    private readonly cfg: AppConfig,
    private readonly logger: Logger,
    private readonly clock: Clock = systemClock,
  ) {
    this.outbox = new Outbox(db, cfg.OUTBOX_RETRY_CAP, cfg.OUTBOX_DEAD_AFTER_HOURS);
    this.persister = new PollCyclePersister(db, this.outbox, logger);
    this.heartbeat = new Heartbeat(cfg.HEALTHCHECKS_PING_URL, (e, action) =>
      logger.warn({ module: 'heartbeat', action, outcome: 'error', err: String(e) }),
    );
    this.dispatcher = new Dispatcher(
      this.outbox,
      new GoogleChatSender(cfg.GOOGLE_CHAT_WEBHOOK_SYSTEM),
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
            'webhook ถูก revoke/ลบ (ถาวร)',
          ),
      },
    );
    this.rate = new RateLimiter(cfg.REQUESTS_PER_HOUR_CAP);
    this.meta = new MetaStore(db);
    this.secrets = secretValues(cfg);
  }

  /** Run a single cycle. Returns true on success. */
  async runOnce(): Promise<boolean> {
    const nowMs = this.clock.nowMs();
    if (nowMs < this.lockoutUntilMs) {
      await this.heartbeat.fail();
      this.logger.warn(
        { module: 'pollLoop', action: 'cycle', outcome: 'locked_out' },
        'in login lockout',
      );
      return false;
    }

    const pollCycleId = randomUUID();
    const startMs = this.clock.nowMs();
    try {
      const page = await this.browser.page();
      const snapshot = await this.fetchSnapshot(page, pollCycleId);

      const persist = this.persister.persist(snapshot);
      this.onCycleSuccess();
      const summary = await this.dispatcher.flush(this.clock.nowIso(), this.clock.nowMs());

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

      // C1 (Constitution IV): if notifications are stuck (dead/permanent), the
      // alert can't leave via the same webhook — signal out-of-band via /fail so
      // the dead-man switch tells the operator. Only ping ok when truly healthy.
      const stuck =
        summary.dead > 0 || summary.permanentFailures > 0 || this.outbox.countByStatus('dead') > 0;
      if (stuck) await this.heartbeat.fail();
      else await this.heartbeat.ok();

      this.logger.info(
        {
          module: 'pollLoop',
          action: 'cycle',
          outcome: 'ok',
          latencyMs: this.clock.nowMs() - startMs,
          jobs: snapshot.jobs.length,
          malformed: snapshot.malformed.length,
          enqueued: persist.enqueued,
          coldStart: persist.coldStart,
          dead: summary.dead,
          permanentFailures: summary.permanentFailures,
        },
        'poll cycle ok',
      );
      return true;
    } catch (err) {
      await this.handleError(err);
      return false;
    }
  }

  /**
   * Navigate to the offers list and read a snapshot. Goes straight to the offers
   * URL (1 navigation in steady state — keeps requests under the FR-011 cap); a
   * full login runs only when we land logged-out, or once mid-cycle if the
   * session expires while reading (FR-002).
   */
  private async fetchSnapshot(page: Page, pollCycleId: string): ReturnType<typeof readJobSnapshot> {
    await this.navigateToOffers(page);
    if (await isLoggedOut(page)) {
      await this.login(page);
      await this.navigateToOffers(page);
    }
    try {
      return await this.readOffers(page, pollCycleId);
    } catch (err) {
      if (err instanceof SessionExpiredError || (await isLoggedOut(page))) {
        await this.login(page);
        await this.navigateToOffers(page);
        return this.readOffers(page, pollCycleId);
      }
      throw err;
    }
  }

  private async navigateToOffers(page: Page): Promise<void> {
    this.rate.record(this.clock.nowMs());
    await page.goto(this.cfg.ACOLAD_OFFERS_URL, { waitUntil: 'domcontentloaded' });
  }

  private async login(page: Page): Promise<void> {
    this.rate.record(this.clock.nowMs());
    await performLogin(page, {
      portalUrl: this.cfg.ACOLAD_PORTAL_URL,
      email: this.cfg.ACOLAD_EMAIL,
      password: this.cfg.ACOLAD_PASSWORD,
    });
    await this.browser.persistSession();
  }

  private readOffers(page: Page, pollCycleId: string): ReturnType<typeof readJobSnapshot> {
    return readJobSnapshot(page, pollCycleId, this.clock.nowIso(), (reason) =>
      captureEvidence(page, this.cfg.STATE_DIR, reason, this.clock.nowIso(), this.secrets),
    );
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
    // A failure while *handling* a failure must never kill the loop — wrap the
    // whole body so raiseAlert/flush (which touch the DB and network) cannot
    // escape and reject runOnce.
    try {
      const at = this.clock.nowIso();
      // login_failed accumulates only across consecutive login failures (FR-009).
      // Any other error type breaks the streak so we don't lock out spuriously.
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
        raiseAlert(this.db, this.outbox, 'pagination', at, err.message);
        await this.dispatcher.flush(at, this.clock.nowMs());
      } else {
        // Transient (network/timeout): track portal-down window.
        if (this.firstPortalErrorMs === 0) this.firstPortalErrorMs = this.clock.nowMs();
        if (this.clock.nowMs() - this.firstPortalErrorMs >= PORTAL_DOWN_THRESHOLD_MS) {
          if (raiseAlert(this.db, this.outbox, 'portal_down', at, 'portal ไม่ตอบสนองต่อเนื่อง')) {
            await this.dispatcher.flush(at, this.clock.nowMs());
          }
        }
      }
      await this.heartbeat.fail();
      this.logger.error(
        {
          module: 'pollLoop',
          action: 'cycle',
          outcome: 'error',
          errKind: (err as { kind?: string }).kind ?? 'unknown',
        },
        err instanceof Error ? err.message : 'unknown error',
      );
    } catch (handlerErr) {
      this.logger.error(
        { module: 'pollLoop', action: 'handle_error', outcome: 'error' },
        handlerErr instanceof Error ? handlerErr.message : 'error handler failed',
      );
    }
  }

  rateLimiter(): RateLimiter {
    return this.rate;
  }
}
