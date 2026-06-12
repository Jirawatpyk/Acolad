import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../../src/portal/browser.js';

// Regression: on 2026-06-12 the live bot's Chromium context closed unexpectedly
// (one-off crash, not OOM — node was at 38MB). BrowserSession.page() only
// reopened when `this.context` was null, so a closed-but-referenced context made
// every cycle throw "browserContext.newPage: Target page, context or browser has
// been closed" forever. page() must self-heal by reopening a fresh context.

let session: BrowserSession | undefined;
let dir: string;

afterEach(async () => {
  await session?.dispose().catch(() => undefined);
  session = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('BrowserSession recovery (real Chromium)', () => {
  it('reopens a usable page after the context is closed out from under it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'acolad-browser-'));
    session = new BrowserSession(dir, 24, () => Date.now());

    const page1 = await session.page();
    // Simulate the production crash: the context dies but the session keeps its
    // (now-stale) reference, exactly the state that caused the stuck error loop.
    await page1.context().close();

    // Must NOT throw — should detect the dead context and reopen a fresh one.
    const page2 = await session.page();
    await page2.goto('about:blank');
    expect(page2.isClosed()).toBe(false);
  });

  it('reopens after the whole browser disconnects', async () => {
    dir = mkdtempSync(join(tmpdir(), 'acolad-browser-'));
    session = new BrowserSession(dir, 24, () => Date.now());

    const page1 = await session.page();
    await page1.context().browser()?.close();

    const page2 = await session.page();
    await page2.goto('about:blank');
    expect(page2.isClosed()).toBe(false);
  });
});
