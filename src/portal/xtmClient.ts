import type { Page, Frame } from 'playwright';
import type { AppConfig } from '../config/index.js';
import { secretValues } from '../config/index.js';
import type { Clock } from '../clock.js';
import type { RateLimiter } from '../runtime/rateLimiter.js';
import type { XtmJobSnapshot } from '../detection/types.js';
import { BrowserSession } from './browser.js';
import { performXtmLogin, isXtmLoggedOut, type XtmCredentials } from './xtmLogin.js';
import { readActiveSnapshot, readClosedKeys as readClosedKeysFromGrid } from './xtmInbox.js';
import { acceptEligibleTasks } from './xtmAccept.js';
import { captureEvidence } from './evidence.js';
import { XTM } from './selectors.js';
import { LayoutChangedError, SessionExpiredError } from './errors.js';
import type { AcceptTarget, AcceptResult } from './errors.js';

/**
 * The single surface the orchestrator uses to talk to XTM (contracts/
 * xtm-portal-adapter.md). Hides all Playwright/iframe detail. `acceptEligibleTasks`
 * is added in US1 (T027) once the accept flow is captured evidence-first.
 */
export interface XtmPortalClient {
  /** Login only if there is no usable session; idempotent. */
  ensureLoggedIn(): Promise<void>;
  /** Read the current Active (IN_PROGRESS) task list once. */
  fetchJobSnapshot(pollCycleId: string): Promise<XtmJobSnapshot>;
  /** Bulk-accept eligible (Malay) tasks; outcome per job from the FR-024 re-read. */
  acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]>;
  /** Job keys in the Closed tab (FR-014 Closed-vs-Removed; only on disappearance). */
  readClosedKeys(): Promise<Set<string>>;
  /** Recycle the browser if its scheduled lifetime elapsed (Constitution VIII). */
  maybeRecycle(): Promise<void>;
  dispose(): Promise<void>;
}

/** Page-level ops, injectable so navigation/rate/recovery logic is unit-testable via stubs. */
export interface XtmOps {
  isLoggedOut(page: Page): Promise<boolean>;
  login(page: Page, creds: XtmCredentials): Promise<void>;
  /** Resolve the Active frame and read it once (the unit the re-login retry repeats). */
  readActiveOnce(page: Page, pollCycleId: string): Promise<XtmJobSnapshot>;
}

/**
 * Playwright-backed XtmPortalClient. Goes straight to the inbox URL (1 navigation
 * in steady state — keeps requests under the FR-003 rate budget) and only logs in
 * when landed logged-out, or once mid-cycle if the session expires mid-read
 * (FR-021, shared account → re-login is silent on success). The task grid lives
 * inside `iframe#myInboxIframe`; every navigation is recorded against the limiter.
 */
export class PlaywrightXtmClient implements XtmPortalClient {
  private readonly ops: XtmOps;

  constructor(
    private readonly browser: BrowserSession,
    private readonly cfg: AppConfig,
    private readonly rate: RateLimiter,
    private readonly clock: Clock,
    ops?: XtmOps,
  ) {
    this.ops = ops ?? {
      isLoggedOut: (page) => isXtmLoggedOut(page),
      login: (page, creds) => performXtmLogin(page, creds),
      readActiveOnce: (page, pollCycleId) => this.readActiveOnceImpl(page, pollCycleId),
    };
  }

  async ensureLoggedIn(): Promise<void> {
    const page = await this.browser.page();
    await this.navigateToInbox(page);
    if (await this.ops.isLoggedOut(page)) await this.login(page);
  }

  async fetchJobSnapshot(pollCycleId: string): Promise<XtmJobSnapshot> {
    const page = await this.browser.page();
    await this.navigateToInbox(page);
    if (await this.ops.isLoggedOut(page)) {
      await this.login(page);
      await this.navigateToInbox(page);
    }
    try {
      return await this.ops.readActiveOnce(page, pollCycleId);
    } catch (err) {
      // Session expired mid-read (shared account) → re-login once, silently.
      if (err instanceof SessionExpiredError || (await this.ops.isLoggedOut(page))) {
        await this.login(page);
        await this.navigateToInbox(page);
        return this.ops.readActiveOnce(page, pollCycleId);
      }
      throw err;
    }
  }

  /** Default readActiveOnce: resolve the Active frame, then read it (overridable via ops). */
  private async readActiveOnceImpl(page: Page, pollCycleId: string): Promise<XtmJobSnapshot> {
    const frame = await this.activeFrame(page);
    return this.readActive(page, frame, pollCycleId);
  }

  async acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]> {
    if (targets.length === 0) return [];
    const page = await this.browser.page();
    const frame = await this.activeFrame(page);
    const secrets = secretValues(this.cfg);
    const evidence = (reason: string): Promise<string | undefined> =>
      captureEvidence(page, this.cfg.STATE_DIR, reason, this.clock.nowIso(), secrets);
    return acceptEligibleTasks(frame, targets, {
      // FR-027: the post-accept re-read counts against the same rate budget.
      reReadActive: async () => {
        this.rate.record(this.clock.nowMs());
        const snap = await readActiveSnapshot(
          frame,
          `reread-${this.clock.nowIso()}`,
          this.clock.nowIso(),
          evidence,
        );
        return snap.jobs;
      },
      captureEvidence: evidence,
      nowIso: () => this.clock.nowIso(),
    });
  }

  async readClosedKeys(): Promise<Set<string>> {
    const page = await this.browser.page();
    const frame = await this.activeFrame(page);
    this.rate.record(this.clock.nowMs()); // FR-027: the Closed read counts against the budget
    await frame
      .locator(XTM.tabs.closed)
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await frame
      .locator(XTM.closed.stateMarker)
      .first()
      .waitFor({ state: 'attached', timeout: 10_000 })
      .catch(() => undefined);
    const keys = await readClosedKeysFromGrid(frame);
    // Return to Active so the next fetch reads the right tab — also a grid reload (FR-027).
    this.rate.record(this.clock.nowMs());
    await frame
      .locator(XTM.tabs.active)
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    return keys;
  }

  async maybeRecycle(): Promise<void> {
    if (this.browser.shouldRecycle()) await this.browser.recycle();
  }

  async dispose(): Promise<void> {
    await this.browser.dispose();
  }

  private async navigateToInbox(page: Page): Promise<void> {
    this.rate.record(this.clock.nowMs());
    await page.goto(this.cfg.XTM_ACOLAD_OFFERS_URL, { waitUntil: 'domcontentloaded' });
  }

  private async login(page: Page): Promise<void> {
    this.rate.record(this.clock.nowMs());
    await this.ops.login(page, {
      loginUrl: this.cfg.XTM_ACOLAD_PORTAL_URL,
      company: this.cfg.XTM_ACOLAD_Company,
      username: this.cfg.XTM_ACOLAD_Username,
      password: this.cfg.XTM_ACOLAD_Password,
    });
    await this.browser.persistSession();
  }

  /** Resolve the inbox iframe and ensure the Active (IN_PROGRESS) tab is selected. */
  private async activeFrame(page: Page): Promise<Frame> {
    const handle = await page.waitForSelector(XTM.iframe.el, { timeout: 20_000 });
    const frame = await handle.contentFrame();
    if (!frame) throw new LayoutChangedError('inbox iframe present but has no content frame');
    // The inbox defaults to Active, but be explicit: if the ACTIVE marker is not
    // present, click the Active tab (keyed off aria-controls, not display text).
    if ((await frame.locator(XTM.active.stateMarker).count()) === 0) {
      this.rate.record(this.clock.nowMs()); // tab switch is a grid reload (FR-027)
      await frame
        .locator(XTM.tabs.active)
        .first()
        .click({ timeout: 10_000 })
        .catch(() => undefined);
      await frame
        .locator(XTM.active.stateMarker)
        .first()
        .waitFor({ state: 'attached', timeout: 10_000 })
        .catch(() => undefined);
    }
    return frame;
  }

  private readActive(page: Page, frame: Frame, pollCycleId: string): Promise<XtmJobSnapshot> {
    const secrets = secretValues(this.cfg);
    return readActiveSnapshot(frame, pollCycleId, this.clock.nowIso(), (reason) =>
      captureEvidence(page, this.cfg.STATE_DIR, reason, this.clock.nowIso(), secrets),
    );
  }
}
