import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { BrowserSession } from '../../src/portal/browser.js';

/**
 * BrowserSession lifecycle with a STUB launcher — no real Chromium. Covers the recycle path
 * (Constitution VIII) that runs every BROWSER_RECYCLE_HOURS in production: it must be logged, and a
 * failure part-way through opening the replacement must not leak the Chromium it just launched nor
 * strand the old one.
 */

interface StubContext {
  setDefaultNavigationTimeout: ReturnType<typeof vi.fn>;
  setDefaultTimeout: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  pages: () => unknown[];
  newPage: ReturnType<typeof vi.fn>;
  storageState: ReturnType<typeof vi.fn>;
  tag: string;
}
interface StubBrowser {
  newContext: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isConnected: () => boolean;
  tag: string;
}

function stubContext(tag: string): StubContext {
  const page = { tag: `${tag}-page` };
  return {
    setDefaultNavigationTimeout: vi.fn(),
    setDefaultTimeout: vi.fn(),
    close: vi.fn(async () => {}),
    pages: () => [page],
    newPage: vi.fn(async () => page),
    storageState: vi.fn(async () => {}),
    tag,
  };
}

/** A browser whose newContext resolves a stub context, or rejects `failContexts` times first. */
function stubBrowser(tag: string, failContexts = 0): StubBrowser {
  let failures = failContexts;
  return {
    newContext: vi.fn(async () => {
      if (failures > 0) {
        failures--;
        throw new Error(`${tag}: newContext failed`);
      }
      return stubContext(tag);
    }),
    close: vi.fn(async () => {}),
    isConnected: () => true,
    tag,
  };
}

const HOUR = 3_600_000;
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function harness(browsers: StubBrowser[], recycleHours = 1) {
  dir = mkdtempSync(join(tmpdir(), 'acolad-bs-'));
  let now = 10 * HOUR; // well past recycleHours from epoch, so 'never opened' cannot pass by accident
  const launched: StubBrowser[] = [];
  const launch = vi.fn(async () => {
    const b = browsers.shift();
    if (!b) throw new Error('no more stub browsers');
    launched.push(b);
    return b as unknown as Browser;
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const session = new BrowserSession(dir, recycleHours, () => now, { launch, logger });
  return {
    session,
    launch,
    launched,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('BrowserSession.shouldRecycle', () => {
  it('is false before any browser was opened (the first page() opens it; nothing to recycle)', () => {
    const h = harness([]);
    expect(h.session.shouldRecycle()).toBe(false);
  });

  it('flips exactly at recycleHours after the open (boundary)', async () => {
    const h = harness([stubBrowser('a')]);
    await h.session.page();
    h.advance(HOUR - 1);
    expect(h.session.shouldRecycle()).toBe(false);
    h.advance(1);
    expect(h.session.shouldRecycle()).toBe(true);
  });
});

describe('BrowserSession.recycle', () => {
  it('logs the recycle, opens the new browser, then closes the old context + browser', async () => {
    const h = harness([stubBrowser('old'), stubBrowser('new')]);
    await h.session.page();
    h.advance(HOUR);
    await h.session.recycle('scheduled');
    const [oldB, newB] = h.launched;
    expect(oldB?.close).toHaveBeenCalledTimes(1);
    expect(newB?.close).not.toHaveBeenCalled();
    const page = (await h.session.page()) as unknown as { tag: string };
    expect(page.tag).toBe('new-page');
    const ok = h.logger.info.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'recycle',
    );
    expect(ok?.[0]).toMatchObject({
      module: 'browser',
      action: 'recycle',
      outcome: 'ok',
      reason: 'scheduled',
      ageMs: HOUR,
    });
  });

  it('when the replacement fails part-way (newContext throws), closes the NEW browser, keeps the old one, logs error and rethrows', async () => {
    // new browser: first newContext (with no storageState) fails, the no-session retry fails too.
    const h = harness([stubBrowser('old'), stubBrowser('new', 2)]);
    await h.session.page();
    h.advance(HOUR);
    await expect(h.session.recycle('scheduled')).rejects.toThrow('newContext failed');
    const [oldB, newB] = h.launched;
    expect(newB?.close).toHaveBeenCalledTimes(1); // no leaked Chromium
    expect(oldB?.close).not.toHaveBeenCalled(); // the working browser survives
    const page = (await h.session.page()) as unknown as { tag: string };
    expect(page.tag).toBe('old-page'); // still serving from the old browser
    const err = h.logger.error.mock.calls.find(
      (c) => (c[0] as { action?: string }).action === 'recycle',
    );
    expect(err?.[0]).toMatchObject({ module: 'browser', action: 'recycle', outcome: 'error' });
  });
});

describe('BrowserSession.open failure cleanup', () => {
  it('closes the launched browser when no context can be created, and rethrows', async () => {
    const h = harness([stubBrowser('a', 2)]);
    await expect(h.session.page()).rejects.toThrow('newContext failed');
    expect(h.launched[0]?.close).toHaveBeenCalledTimes(1);
  });

  it('a corrupt session file still falls back to a fresh context (one failure is recovered)', async () => {
    const h = harness([stubBrowser('a', 1)]);
    const page = (await h.session.page()) as unknown as { tag: string };
    expect(page.tag).toBe('a-page');
    expect(h.launched[0]?.close).not.toHaveBeenCalled();
  });
});
