import { describe, it, expect, vi } from 'vitest';
import { PlaywrightXtmClient, type XtmOps } from '../../src/portal/xtmClient.js';
import {
  SessionExpiredError,
  LayoutChangedError,
  PaginationDetectedError,
  CaptchaDetectedError,
} from '../../src/portal/errors.js';
import type { BrowserSession } from '../../src/portal/browser.js';
import type { RateLimiter } from '../../src/runtime/rateLimiter.js';
import type { AppConfig } from '../../src/config/index.js';
import type { XtmJobSnapshot } from '../../src/detection/types.js';

/**
 * T049 mode 2 (session expiry mid-read → silent re-login, NO alert): the recovery
 * lives in PlaywrightXtmClient.fetchJobSnapshot, NOT the loop (the loop treats a
 * leaked expiry as a generic transient). These stub the injected ops/browser so
 * the re-login retry is exercised without Playwright.
 */
const NOW = '2026-06-19T10:00:00.000Z';
const clock = { nowMs: () => 0, nowIso: () => NOW };

const cfg = {
  XTM_ACOLAD_OFFERS_URL: 'https://xtm.example/inbox',
  XTM_ACOLAD_PORTAL_URL: 'https://xtm.example/login.jsp',
  XTM_ACOLAD_Username: 'u',
  XTM_ACOLAD_Password: 'p',
  STATE_DIR: 'state',
} as unknown as AppConfig;

const snapshot = (id: string): XtmJobSnapshot => ({
  jobs: [],
  malformed: [],
  capturedAt: NOW,
  pollCycleId: id,
  emptyListConfirmed: true,
});

/** A browser/page/rate stub good enough for navigate + login bookkeeping. */
function fakes() {
  const page = { goto: vi.fn(async () => {}) };
  const browser = {
    page: vi.fn(async () => page),
    persistSession: vi.fn(async () => {}),
  } as unknown as BrowserSession;
  const rate = { record: vi.fn(() => {}) } as unknown as RateLimiter;
  return { browser, rate };
}

describe('PlaywrightXtmClient.fetchJobSnapshot — session recovery (FR-021 / T049 mode 2)', () => {
  it('silently re-logins once and returns the snapshot when the read expires mid-cycle', async () => {
    const { browser, rate } = fakes();
    let reads = 0;
    const ops: XtmOps = {
      isLoggedOut: vi.fn(async () => false),
      login: vi.fn(async () => {}),
      readActiveOnce: vi.fn(async (_p, id: string) => {
        reads++;
        if (reads === 1) throw new SessionExpiredError('session lost mid-read');
        return snapshot(id);
      }),
    };
    const client = new PlaywrightXtmClient(browser, cfg, rate, clock, ops);

    const result = await client.fetchJobSnapshot('c1'); // must NOT throw

    expect(result.pollCycleId).toBe('c1'); // recovered read returned
    expect(ops.login).toHaveBeenCalledTimes(1); // re-logged in exactly once
    expect(ops.readActiveOnce).toHaveBeenCalledTimes(2); // first failed, retry succeeded
  });

  it('logs in first when it lands logged-out, then reads (no expiry path)', async () => {
    const { browser, rate } = fakes();
    const ops: XtmOps = {
      isLoggedOut: vi.fn(async () => true), // landed logged-out
      login: vi.fn(async () => {}),
      readActiveOnce: vi.fn(async (_p, id: string) => snapshot(id)),
    };
    const client = new PlaywrightXtmClient(browser, cfg, rate, clock, ops);

    await client.fetchJobSnapshot('c2');

    expect(ops.login).toHaveBeenCalledTimes(1);
    expect(ops.readActiveOnce).toHaveBeenCalledTimes(1); // no expiry → single read
  });

  it('propagates a non-session error without re-login (fail loud, no relogin loop)', async () => {
    const { browser, rate } = fakes();
    const ops: XtmOps = {
      isLoggedOut: vi.fn(async () => false), // not a session problem
      login: vi.fn(async () => {}),
      readActiveOnce: vi.fn(async () => {
        throw new LayoutChangedError('grid marker gone');
      }),
    };
    const client = new PlaywrightXtmClient(browser, cfg, rate, clock, ops);

    await expect(client.fetchJobSnapshot('c3')).rejects.toBeInstanceOf(LayoutChangedError);
    expect(ops.login).not.toHaveBeenCalled(); // never re-logins on a real layout failure
    expect(ops.readActiveOnce).toHaveBeenCalledTimes(1); // no silent retry
  });

  it.each([
    ['LayoutChangedError', () => new LayoutChangedError('grid marker gone')],
    ['PaginationDetectedError', () => new PaginationDetectedError('paginated')],
    ['CaptchaDetectedError', () => new CaptchaDetectedError('captcha')],
  ] as const)(
    'does not let a logged-out probe demote a classified %s (I3)',
    async (_name, makeErr) => {
      const { browser, rate } = fakes();
      let probes = 0;
      const err = makeErr();
      const ops: XtmOps = {
        // First call = the initial pre-read check (logged in, no pre-login). A SECOND
        // call would only come from the catch probe and would say "logged out". The
        // fix must NOT make that second call for a classified error — so the error
        // survives instead of being demoted to a silent re-login.
        isLoggedOut: vi.fn(async () => {
          probes++;
          return probes > 1;
        }),
        login: vi.fn(async () => {}),
        readActiveOnce: vi.fn(async () => {
          throw err;
        }),
      };
      const client = new PlaywrightXtmClient(browser, cfg, rate, clock, ops);

      await expect(client.fetchJobSnapshot('c4')).rejects.toBe(err); // original classification preserved
      expect(probes).toBe(1); // only the initial check — the catch did NOT probe
      expect(ops.login).not.toHaveBeenCalled(); // not demoted to a silent re-login
    },
  );
});
