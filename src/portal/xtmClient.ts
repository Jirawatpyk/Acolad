import type { Page, Frame } from 'playwright';
import type { AppConfig } from '../config/index.js';
import { secretValues } from '../config/index.js';
import type { Clock } from '../clock.js';
import type { Logger } from '../monitoring/logger.js';
import type { RateLimiter } from '../runtime/rateLimiter.js';
import type { XtmJobSnapshot } from '../detection/types.js';
import { BrowserSession } from './browser.js';
import { performXtmLogin, isXtmLoggedOut, type XtmCredentials } from './xtmLogin.js';
import {
  readActiveSnapshot,
  readClosedKeys as readClosedKeysFromGrid,
  parseItemsTotal,
} from './xtmInbox.js';
import { acceptEligibleTasks, readAcceptAvailability } from './xtmAccept.js';
import { computeXtmJobKey } from '../detection/jobKey.js';
import { captureAcceptMenuDom } from './xtmAcceptRecon.js';
import { captureEvidence } from './evidence.js';
import { XTM } from './selectors.js';
import {
  LayoutChangedError,
  SessionExpiredError,
  PaginationDetectedError,
  CaptchaDetectedError,
  SessionYieldError,
  classifyLogout,
  type LogoutKind,
} from './errors.js';
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
  fetchJobSnapshot(
    pollCycleId: string,
    opts?: { decideRelogin?: (kind: LogoutKind) => boolean },
  ): Promise<XtmJobSnapshot>;
  /** Bulk-accept eligible (Malay) tasks; outcome per job from the FR-024 re-read. */
  acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]>;
  /** Evidence-only (ACCEPT_RECON): capture the real accept-menu DOM, hover only, no accept. */
  captureAcceptMenu?(targets: AcceptTarget[]): Promise<string | undefined>;
  /** Diagnostic (DIAG): capture the bot's own rendered inbox (HTML + iframe + screenshot). */
  captureDiag?(): Promise<string | undefined>;
  /**
   * Job keys in the Closed tab (FR-014 Closed-vs-Removed; only on disappearance). `activeKeys`
   * (the disappeared-accepted keys being classified) feeds the Closed grid's #2b cross-keying
   * drift guard — when supplied and no recomputed Closed key matches, the read throws
   * `LayoutChangedError` instead of returning a mis-keyed Set.
   */
  readClosedKeys(activeKeys?: Set<string>): Promise<Set<string>>;
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
    private readonly logger?: Logger,
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

  async fetchJobSnapshot(
    pollCycleId: string,
    opts?: { decideRelogin?: (kind: LogoutKind) => boolean },
  ): Promise<XtmJobSnapshot> {
    // Default: always relogin (preserves pre-yield behavior + existing tests).
    const decideRelogin = opts?.decideRelogin ?? ((): boolean => true);
    const page = await this.browser.page();
    await this.navigateToInbox(page);
    if (await this.ops.isLoggedOut(page)) {
      const kind = this.classifyLoggedOut(page.url());
      if (!decideRelogin(kind)) throw new SessionYieldError(kind);
      await this.login(page);
      await this.navigateToInbox(page);
    }
    try {
      return await this.ops.readActiveOnce(page, pollCycleId);
    } catch (err) {
      // A classified non-session portal failure (layout/pagination/captcha) keeps its
      // classification — never let the logged-out probe demote it to a silent re-login.
      const classified =
        err instanceof LayoutChangedError ||
        err instanceof PaginationDetectedError ||
        err instanceof CaptchaDetectedError;
      let loggedOut = false;
      if (!classified) {
        try {
          loggedOut = await this.ops.isLoggedOut(page);
        } catch {
          throw err; // probe itself failed → preserve the ORIGINAL classification
        }
      }
      if (err instanceof SessionExpiredError || loggedOut) {
        const kind = this.classifyLoggedOut(page.url());
        if (!decideRelogin(kind)) throw new SessionYieldError(kind);
        await this.login(page);
        await this.navigateToInbox(page);
        return this.ops.readActiveOnce(page, pollCycleId);
      }
      throw err;
    }
  }

  /**
   * Classify the logout URL and, on an UNRECOGNISED type, emit a LOUD warn so a portal
   * logout-URL change is diagnosable (F10, Constitution VI: fail loud). Control flow is
   * unchanged — an 'unknown' still flows through the same decideRelogin policy. Only the
   * URL PATH is logged (the query string can carry tokens — never log it, FR-012).
   */
  private classifyLoggedOut(url: string): LogoutKind {
    const kind = classifyLogout(url);
    if (kind === 'unknown') {
      let path = url;
      try {
        path = new URL(url).pathname;
      } catch {
        path = url.split('?')[0] ?? url; // relative/empty URL → strip query defensively
      }
      this.logger?.warn(
        { module: 'xtmClient', action: 'classifyLogout', outcome: 'unknown', path },
        'landed logged-out with an unrecognised logout type — the portal logout URL may have changed',
      );
    }
    return kind;
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
    await this.waitForGridComplete(frame, 'accept-scan');
    const secrets = secretValues(this.cfg);
    const evidence = (reason: string): Promise<string | undefined> =>
      captureEvidence(page, this.cfg.STATE_DIR, reason, this.clock.nowIso(), secrets);
    const targetKeys = new Set(targets.map((t) => t.jobKey));
    return acceptEligibleTasks(frame, targets, {
      // FR-027: the post-accept re-read counts against the same rate budget.
      reReadActive: async () => {
        this.rate.record(this.clock.nowMs());
        // RELOAD the inbox so the re-read sees the POST-accept grid. The accepted row's
        // menu flips Accept→Finish only after the grid refreshes; reading the pre-accept
        // frame IN PLACE re-opens a stale menu still showing "Accept task" and misreads a
        // successful accept as "still acceptable" → false accept_failed (observed live
        // 2026-06-22: the job WAS accepted but reported failed). Re-resolve the frame
        // after navigation (the iframe reloaded), then read + probe acceptability fresh.
        await this.navigateToInbox(page);
        const freshFrame = await this.activeFrame(page);
        await this.waitForGridComplete(freshFrame, 'reread');
        const snap = await readActiveSnapshot(
          freshFrame,
          `reread-${this.clock.nowIso()}`,
          this.clock.nowIso(),
          evidence,
        );
        // D6: the grid does not expose acceptability — read it from each target row's
        // menu (Accept-task item present = still claimable; absent = we own it now) and
        // override the placeholder, so determineAcceptOutcomes tells accepted from failed.
        // #13: forward the SAME observers used by the Active scrape / accept evidence so an
        // empty-project row on the re-read emits the structured drift WARN + evidence AT SOURCE
        // (instead of only the downstream `probe_miss` below). Reuses the in-scope `evidence`
        // sink + this.logger — mirrors the Closed-grid drift wiring. Logger spread guarded by
        // exactOptionalPropertyTypes (this.logger is Logger | undefined).
        const availability = await readAcceptAvailability(freshFrame, page, targetKeys, {
          ...(this.logger ? { logger: this.logger } : {}),
          captureEvidence: evidence,
        });
        const keyed = snap.jobs.map((j) => ({ job: j, key: computeXtmJobKey(j) }));
        // A target PRESENT in the re-read but unresolved by the probe keeps the optimistic
        // grid placeholder (true) and would be reported as a FALSE accept_failed — surface
        // it LOUD (a probe/selector mismatch must be diagnosable, not a silent false alert).
        const presentKeys = new Set(keyed.map((e) => e.key));
        for (const k of targetKeys) {
          if (presentKeys.has(k) && !availability.has(k)) {
            this.logger?.warn(
              { module: 'xtmClient', action: 'reread', outcome: 'probe_miss', jobKey: k },
              'post-accept acceptability probe did not resolve a present target — will report failed (verify selectors)',
            );
          }
        }
        return keyed.map(({ job, key }) => {
          const a = availability.get(key);
          return a === undefined ? job : { ...job, acceptAvailable: a };
        });
      },
      captureEvidence: evidence,
      nowIso: () => this.clock.nowIso(),
      logError: (err) =>
        this.logger?.warn(
          {
            module: 'xtmAccept',
            action: 'accept',
            outcome: 'error',
            errKind: (err as { kind?: string }).kind ?? 'unknown',
          },
          err instanceof Error ? err.message : 'accept menu failed',
        ),
      onAcceptObserved: (obs) =>
        this.logger?.info(
          {
            module: 'xtmAccept',
            action: 'accept_observed',
            reReadRows: obs.reReadRows,
            noClickWhilePresent: obs.noClickWhilePresent,
          },
          'accept pass observed',
        ),
    });
  }

  /**
   * DIAG: snapshot the bot's OWN rendered inbox right now (HTML + iframe grid +
   * screenshot, sanitized). Zero extra portal requests — it serializes the page
   * already loaded by fetchJobSnapshot — so it is rate-safe (FR-011) to run every
   * cycle. Lets us see EXACTLY what the bot's session renders for Active when a job
   * is reportedly present but read as jobs=0.
   */
  async captureDiag(): Promise<string | undefined> {
    const page = await this.browser.page();
    return captureEvidence(
      page,
      this.cfg.STATE_DIR,
      'diag-active',
      this.clock.nowIso(),
      secretValues(this.cfg),
    );
  }

  async captureAcceptMenu(targets: AcceptTarget[]): Promise<string | undefined> {
    if (targets.length === 0) return undefined;
    const page = await this.browser.page();
    const frame = await this.activeFrame(page);
    const secrets = secretValues(this.cfg);
    const evidence = (reason: string): Promise<string | undefined> =>
      captureEvidence(page, this.cfg.STATE_DIR, reason, this.clock.nowIso(), secrets);
    try {
      return await captureAcceptMenuDom(frame, targets[0]?.targetLang ?? '', {
        captureEvidence: evidence,
      });
    } finally {
      // Close the menu — pressing Escape performs no action on the task.
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }

  async readClosedKeys(activeKeys?: Set<string>): Promise<Set<string>> {
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
    await this.settleGrid(page, 'closed'); // Closed rows arrive via a later XHR than its shell, too
    // Wire the layout-drift observers (logger + sanitized-evidence) the same way the Active path
    // does. We are still on the Closed tab here (the return-to-Active click is below), so a
    // capture inside readClosedKeysFromGrid serializes the Closed grid DOM. Without this the
    // drift WARN/evidence would be DORMANT in production (observers default to no-op).
    const secrets = secretValues(this.cfg);
    const keys = await readClosedKeysFromGrid(frame, {
      // Spread the logger/activeKeys only when present — exactOptionalPropertyTypes forbids an
      // explicit `undefined` on these optional properties (this.logger is Logger | undefined;
      // activeKeys is omitted by callers that don't cross-key, e.g. older tests).
      ...(this.logger ? { logger: this.logger } : {}),
      // #2b/#3: when the cycle hands us the disappeared-accepted keys, the grid read can detect a
      // wrong-but-non-null project-column drift (zero cross-key match → LayoutChangedError) and
      // fail loud instead of returning a mis-keyed Set. Empty/undefined → cross-keying stays off.
      ...(activeKeys ? { activeKeys } : {}),
      captureEvidence: (reason) =>
        captureEvidence(page, this.cfg.STATE_DIR, reason, this.clock.nowIso(), secrets),
    });
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

  /**
   * After networkidle, wait until the grid is FULLY rendered: the footer "… of N" total
   * equals the rendered kebab-data-row count. networkidle means the data XHR finished, but
   * the AngularJS row render can lag it — reading in that gap sees a partial grid and
   * mis-attributes a present accept target as 'missing'. Bounded (~3s); on cap we proceed
   * (the empty-re-read guard + retriable classification remain the net) and log loud.
   */
  private async waitForGridComplete(frame: Frame, context: string): Promise<void> {
    const deadline = this.clock.nowMs() + 3_000;
    while (this.clock.nowMs() < deadline) {
      const footer = await frame
        .locator(XTM.active.itemsCount)
        .first()
        .textContent()
        .catch(() => null);
      const total = parseItemsTotal(footer);
      const rows = await frame
        .locator(`${XTM.active.gridContainer} tbody tr`)
        .filter({ has: frame.locator(XTM.active.rowKebab) })
        .count();
      if (total !== null && rows === total) return;
      await new Promise<void>((r) => setTimeout(r, 200));
    }
    this.logger?.warn(
      { module: 'xtmClient', action: 'gridComplete', outcome: 'timeout', context },
      'grid footer total != rendered rows within cap — read may see a partial grid',
    );
  }

  /**
   * Wait for the inbox grid's data XHR to settle before reading. ROOT-CAUSE fix
   * (confirmed live, scripts/diag-race.ts): the XTM grid renders its table shell —
   * thead AND a "0 - 0 of 0" footer AND a placeholder tbody row — IMMEDIATELY, then
   * fills the real rows via a later XHR. Every DOM-level ready signal (thead, first
   * tbody row, footer total) is therefore satisfied while the grid is still empty,
   * so a read fired right after navigation/tab-switch sees 0 rows EVERY time even
   * when jobs are present. `networkidle` (no network for 500ms) is the only reliable
   * "data loaded" signal — it gives the true row count for both populated and
   * genuinely-empty grids. Costs zero portal requests (FR-011) — it only observes
   * the in-flight XHR.
   *
   * On TIMEOUT we proceed (a hard throw would starve reads if XTM ever keeps the
   * network busy), but we log LOUD (Constitution VI): a settle-timeout means the
   * read that follows may race the data XHR and silently report a false "empty" —
   * exactly the 0-jobs regression this guard exists to prevent. The warn makes that
   * condition diagnosable instead of invisible (networkidle settles reliably for
   * XTM today, so a timeout signals its network behavior changed).
   */
  private async settleGrid(page: Page, context: string): Promise<void> {
    const settled = await page
      .waitForLoadState('networkidle', { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (!settled) {
      this.logger?.warn(
        {
          module: 'xtmClient',
          action: 'settleGrid',
          outcome: 'timeout',
          context,
          timeoutMs: 15_000,
        },
        'grid networkidle did not settle — the following read may race the data XHR (false-empty / 0-jobs risk)',
      );
    }
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
    // The iframe element mounts immediately but navigates to its grid asynchronously
    // (we load with domcontentloaded, which does not wait for it). Wait for the grid
    // to actually render inside before reading/clicking — otherwise, esp. right after
    // a fresh login, the marker/grid is briefly absent and the read fails loud.
    await frame
      .locator(XTM.active.gridLoadedMarker)
      .first()
      .waitFor({ state: 'attached', timeout: 20_000 })
      .catch(() => undefined);
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
    // The grid's row data arrives via a later XHR than the table shell — wait for it
    // to settle before any read, or the read sees 0 rows even when jobs are present.
    await this.settleGrid(page, 'active');
    return frame;
  }

  private readActive(page: Page, frame: Frame, pollCycleId: string): Promise<XtmJobSnapshot> {
    const secrets = secretValues(this.cfg);
    return readActiveSnapshot(frame, pollCycleId, this.clock.nowIso(), (reason) =>
      captureEvidence(page, this.cfg.STATE_DIR, reason, this.clock.nowIso(), secrets),
    );
  }
}
