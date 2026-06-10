import type { Page } from 'playwright';
import type { AppConfig } from '../config/index.js';
import { secretValues } from '../config/index.js';
import type { Clock } from '../clock.js';
import type { RateLimiter } from '../runtime/rateLimiter.js';
import type { JobSnapshot } from '../detection/types.js';
import { BrowserSession } from './browser.js';
import { performLogin, type Credentials } from './login.js';
import { readJobSnapshot, isLoggedOut } from './jobList.js';
import { captureEvidence } from './evidence.js';
import { SessionExpiredError } from './errors.js';

/**
 * The page-level portal operations, injectable so the navigation/rate logic of
 * PlaywrightPortalClient can be unit-tested without a real browser.
 */
export interface PortalOps {
  isLoggedOut(page: Page): Promise<boolean>;
  login(page: Page, creds: Credentials): Promise<void>;
  read(page: Page, pollCycleId: string): Promise<JobSnapshot>;
}

/**
 * The single surface the orchestrator (PollLoop) uses to talk to the portal
 * (contracts/portal-adapter.md). Hides all Playwright detail so the loop's
 * business logic can be unit-tested against a stub. Throws typed PortalErrors.
 */
export interface PortalClient {
  /** Navigate to the offers list and return the current snapshot. */
  fetchSnapshot(pollCycleId: string): Promise<JobSnapshot>;
  /** Recycle the browser if its scheduled lifetime elapsed (Constitution VIII). */
  maybeRecycle(): Promise<void>;
  /** Release browser resources. */
  dispose(): Promise<void>;
}

/**
 * Playwright-backed PortalClient. Goes straight to the offers URL (1 navigation
 * in steady state — keeps requests under the FR-011 cap) and only performs a
 * full login when landed logged-out, or once mid-cycle if the session expires
 * while reading (FR-002). Every navigation is recorded against the rate limiter.
 */
export class PlaywrightPortalClient implements PortalClient {
  private readonly ops: PortalOps;

  constructor(
    private readonly browser: BrowserSession,
    private readonly cfg: AppConfig,
    private readonly rate: RateLimiter,
    private readonly clock: Clock,
    ops?: PortalOps,
  ) {
    const secrets = secretValues(cfg);
    this.ops = ops ?? {
      isLoggedOut: (page) => isLoggedOut(page),
      login: (page, creds) => performLogin(page, creds),
      read: (page, pollCycleId) =>
        readJobSnapshot(page, pollCycleId, this.clock.nowIso(), (reason) =>
          captureEvidence(page, this.cfg.STATE_DIR, reason, this.clock.nowIso(), secrets),
        ),
    };
  }

  async fetchSnapshot(pollCycleId: string): Promise<JobSnapshot> {
    const page = await this.browser.page();
    await this.navigateToOffers(page);
    if (await this.ops.isLoggedOut(page)) {
      await this.login(page);
      await this.navigateToOffers(page);
    }
    try {
      return await this.ops.read(page, pollCycleId);
    } catch (err) {
      if (err instanceof SessionExpiredError || (await this.ops.isLoggedOut(page))) {
        await this.login(page);
        await this.navigateToOffers(page);
        return this.ops.read(page, pollCycleId);
      }
      throw err;
    }
  }

  async maybeRecycle(): Promise<void> {
    if (this.browser.shouldRecycle()) await this.browser.recycle();
  }

  async dispose(): Promise<void> {
    await this.browser.dispose();
  }

  private async navigateToOffers(page: Page): Promise<void> {
    this.rate.record(this.clock.nowMs());
    await page.goto(this.cfg.ACOLAD_OFFERS_URL, { waitUntil: 'domcontentloaded' });
  }

  private async login(page: Page): Promise<void> {
    this.rate.record(this.clock.nowMs());
    await this.ops.login(page, {
      portalUrl: this.cfg.ACOLAD_PORTAL_URL,
      email: this.cfg.ACOLAD_EMAIL,
      password: this.cfg.ACOLAD_PASSWORD,
    });
    await this.browser.persistSession();
  }
}
