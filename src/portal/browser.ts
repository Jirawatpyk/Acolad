import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { withTimeout } from '../withTimeout.js';
import type { Logger } from '../monitoring/logger.js';

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 8_000;

/** Injectable collaborators (tests pass a stub launcher so no real Chromium starts). */
export interface BrowserSessionDeps {
  launch?: () => Promise<Browser>;
  logger?: Logger;
}

/**
 * channel:'chromium' uses the new headless mode (the full Chrome binary, a GUI app) instead of
 * chrome-headless-shell.exe (a console binary). On Windows 11 the console binary pops a stray
 * Windows Terminal window that stays open for the browser's lifetime; the full binary launches
 * silently.
 */
const launchChromium = (): Promise<Browser> =>
  chromium.launch({ headless: true, channel: 'chromium' });

/**
 * Owns the Chromium browser/context lifecycle. Persists session cookies via
 * storageState so a restart skips login while the session is still valid. The
 * context is recycled on a schedule to bound memory (Constitution VIII).
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private openedAtMs = 0;
  private readonly launch: () => Promise<Browser>;
  private readonly logger: Logger | undefined;

  constructor(
    private readonly stateDir: string,
    private readonly recycleHours: number,
    private readonly nowMs: () => number,
    deps: BrowserSessionDeps = {},
  ) {
    this.launch = deps.launch ?? launchChromium;
    this.logger = deps.logger;
  }

  private get storageStatePath(): string {
    return join(this.stateDir, 'storageState.json');
  }

  async page(): Promise<Page> {
    // Reopen when there is no context yet, or the browser has crashed/disconnected
    // (isConnected() === false). Without this a dead browser would never be replaced.
    if (!this.context || this.browser?.isConnected() === false) await this.reopen();
    try {
      const ctx = this.context;
      if (!ctx) throw new Error('browser context unavailable');
      const pages = ctx.pages();
      return pages[0] ?? (await ctx.newPage());
    } catch {
      // The context closed out from under us (Chromium crash) while we still held
      // a stale reference — the production stuck-loop cause. Reopen a fresh
      // browser/context and retry once so the poll loop self-heals.
      await this.reopen();
      const ctx = this.context;
      if (!ctx) throw new Error('browser context unavailable after reopen');
      return ctx.newPage();
    }
  }

  /** Drop any dead browser/context handles and open a fresh one. */
  private async reopen(): Promise<void> {
    await this.dispose();
    await this.open();
  }

  /**
   * Launch a browser + context and only THEN adopt them. All-or-nothing: the fields are assigned
   * after the whole sequence succeeds, so a failure part-way (e.g. newContext throws twice) leaves
   * the session exactly as it was -- and the Chromium launched here is closed before rethrowing,
   * never leaked as an orphan process (the recycle path depends on both).
   */
  private async open(): Promise<void> {
    const browser = await this.launch();
    try {
      const storageState = existsSync(this.storageStatePath) ? this.storageStatePath : undefined;
      let context: BrowserContext;
      try {
        context = await browser.newContext(storageState ? { storageState } : {});
      } catch {
        // Corrupt/unreadable session file → start without it (FR-002).
        this.discardSession();
        context = await browser.newContext();
      }
      context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      context.setDefaultTimeout(ACTION_TIMEOUT_MS);
      this.browser = browser;
      this.context = context;
      this.openedAtMs = this.nowMs();
    } catch (err) {
      await withTimeout(browser.close(), CLOSE_TIMEOUT_MS);
      throw err;
    }
  }

  async persistSession(): Promise<void> {
    if (this.context) await this.context.storageState({ path: this.storageStatePath });
  }

  discardSession(): void {
    if (existsSync(this.storageStatePath)) rmSync(this.storageStatePath, { force: true });
  }

  /** True once the OPEN browser has lived recycleHours. False before the first open: the first
   *  page() opens lazily, so there is nothing to recycle (and no misleading "recycle" log). */
  shouldRecycle(): boolean {
    if (!this.context) return false;
    return this.nowMs() - this.openedAtMs >= this.recycleHours * 3_600_000;
  }

  /**
   * Recycle: open a fresh browser before disposing the old one (no heartbeat gap). Logged either
   * way (it used to be silent). If opening the replacement fails, open() has already closed what it
   * launched and left the session untouched, so the OLD browser keeps serving; the error is logged
   * and rethrown (the cycle fails loud, and the next maybeRecycle retries since openedAtMs did not
   * move).
   */
  async recycle(reason = 'scheduled'): Promise<void> {
    const old = { browser: this.browser, context: this.context };
    const ageMs = old.context ? this.nowMs() - this.openedAtMs : null;
    try {
      await this.open();
    } catch (err) {
      this.logger?.error(
        { module: 'browser', action: 'recycle', outcome: 'error', reason, ageMs, err },
        'browser recycle failed — keeping the current browser',
      );
      throw err;
    }
    if (old.context) await withTimeout(old.context.close(), CLOSE_TIMEOUT_MS);
    if (old.browser) await withTimeout(old.browser.close(), CLOSE_TIMEOUT_MS);
    this.logger?.info(
      {
        module: 'browser',
        action: 'recycle',
        outcome: 'ok',
        reason,
        ageMs,
        recycleHours: this.recycleHours,
      },
      'browser recycled',
    );
  }

  async dispose(): Promise<void> {
    // Bounded: a hung Chromium close() must never block shutdown (orphan root cause). The
    // cap lets the process exit promptly; on the rare genuinely-hung close the caller logs
    // a dispose_timeout and the next `npm run deploy` orphan-sweep reaps the leftover.
    // (An in-process PID-targeted kill would need launchServer()+connect() — chromium.launch()
    // does not expose the browser PID — deferred rather than faked.)
    if (this.context) await withTimeout(this.context.close(), CLOSE_TIMEOUT_MS);
    if (this.browser) await withTimeout(this.browser.close(), CLOSE_TIMEOUT_MS);
    this.context = undefined;
    this.browser = undefined;
  }
}
