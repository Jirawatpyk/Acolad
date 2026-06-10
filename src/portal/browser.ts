import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;

/**
 * Owns the Chromium browser/context lifecycle. Persists session cookies via
 * storageState so a restart skips login while the session is still valid. The
 * context is recycled on a schedule to bound memory (Constitution VIII).
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private openedAtMs = 0;

  constructor(
    private readonly stateDir: string,
    private readonly recycleHours: number,
    private readonly nowMs: () => number,
  ) {}

  private get storageStatePath(): string {
    return join(this.stateDir, 'storageState.json');
  }

  async page(): Promise<Page> {
    if (!this.context) await this.open();
    const ctx = this.context;
    if (!ctx) throw new Error('browser context unavailable');
    const pages = ctx.pages();
    return pages[0] ?? (await ctx.newPage());
  }

  private async open(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    let storageState: string | undefined;
    if (existsSync(this.storageStatePath)) {
      try {
        storageState = this.storageStatePath;
      } catch {
        storageState = undefined;
      }
    }
    try {
      this.context = await this.browser.newContext(storageState ? { storageState } : {});
    } catch {
      // Corrupt/unreadable session file → start without it (FR-002).
      this.discardSession();
      this.context = await this.browser.newContext();
    }
    this.context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    this.context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    this.openedAtMs = this.nowMs();
  }

  async persistSession(): Promise<void> {
    if (this.context) await this.context.storageState({ path: this.storageStatePath });
  }

  discardSession(): void {
    if (existsSync(this.storageStatePath)) rmSync(this.storageStatePath, { force: true });
  }

  shouldRecycle(): boolean {
    return this.nowMs() - this.openedAtMs >= this.recycleHours * 3_600_000;
  }

  /** Recycle: open a fresh context before disposing the old one (no heartbeat gap). */
  async recycle(): Promise<void> {
    const old = { browser: this.browser, context: this.context };
    await this.open();
    await old.context?.close().catch(() => undefined);
    await old.browser?.close().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = undefined;
    this.browser = undefined;
  }
}
