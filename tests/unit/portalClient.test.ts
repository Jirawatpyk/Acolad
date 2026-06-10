import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Page } from 'playwright';
import { PlaywrightPortalClient, type PortalOps } from '../../src/portal/portalClient.js';
import { RateLimiter } from '../../src/runtime/rateLimiter.js';
import { SessionExpiredError } from '../../src/portal/errors.js';
import type { BrowserSession } from '../../src/portal/browser.js';
import type { AppConfig } from '../../src/config/index.js';
import type { Clock } from '../../src/clock.js';
import type { JobSnapshot } from '../../src/detection/types.js';

const cfg = {
  ACOLAD_PORTAL_URL: 'https://portal/login',
  ACOLAD_OFFERS_URL: 'https://portal/offers',
  ACOLAD_EMAIL: 'e@x.com',
  ACOLAD_PASSWORD: 'pw',
  STATE_DIR: 'state',
} as AppConfig;

const clock: Clock = { nowMs: () => 1_000_000, nowIso: () => '2026-06-11T00:00:00.000Z' };

const snapshot = (cycle: string): JobSnapshot => ({
  jobs: [],
  malformed: [],
  capturedAt: clock.nowIso(),
  pollCycleId: cycle,
  emptyListConfirmed: true,
});

let gotoCalls: string[];
let fakePage: Page;
let browser: BrowserSession;
let persistCalls: number;

beforeEach(() => {
  gotoCalls = [];
  persistCalls = 0;
  fakePage = {
    goto: vi.fn(async (url: string) => {
      gotoCalls.push(url);
      return null;
    }),
  } as unknown as Page;
  browser = {
    page: async () => fakePage,
    persistSession: async () => {
      persistCalls++;
    },
    shouldRecycle: () => false,
    recycle: async () => {},
    dispose: async () => {},
  } as unknown as BrowserSession;
});

describe('PlaywrightPortalClient.fetchSnapshot navigation + rate', () => {
  it('steady state (already logged in): 1 navigation, 1 rate record, no login', async () => {
    const rate = new RateLimiter(180);
    const login = vi.fn();
    const ops: PortalOps = {
      isLoggedOut: async () => false,
      login,
      read: async (_p, id) => snapshot(id),
    };
    const client = new PlaywrightPortalClient(browser, cfg, rate, clock, ops);
    const snap = await client.fetchSnapshot('c1');

    expect(snap.pollCycleId).toBe('c1');
    expect(gotoCalls).toEqual(['https://portal/offers']); // 1 navigation
    expect(rate.count(clock.nowMs())).toBe(1);
    expect(login).not.toHaveBeenCalled();
    expect(persistCalls).toBe(0);
  });

  it('logged out on arrival: navigate, login, navigate again (2 navs + 1 login rate = 3 records)', async () => {
    const rate = new RateLimiter(180);
    let loggedOut = true;
    const login = vi.fn(async () => {
      loggedOut = false; // login succeeds
    });
    const ops: PortalOps = {
      isLoggedOut: async () => loggedOut,
      login,
      read: async (_p, id) => snapshot(id),
    };
    const client = new PlaywrightPortalClient(browser, cfg, rate, clock, ops);
    await client.fetchSnapshot('c1');

    expect(login).toHaveBeenCalledOnce();
    expect(persistCalls).toBe(1); // session persisted after login
    expect(gotoCalls).toEqual(['https://portal/offers', 'https://portal/offers']); // 2 navs
    expect(rate.count(clock.nowMs())).toBe(3); // 2 navs + 1 login
  });

  it('session expires while reading: re-login once then re-read (FR-002)', async () => {
    const rate = new RateLimiter(180);
    let firstRead = true;
    const login = vi.fn();
    const ops: PortalOps = {
      isLoggedOut: async () => false, // logged in on arrival
      login,
      read: async (_p, id) => {
        if (firstRead) {
          firstRead = false;
          throw new SessionExpiredError('expired mid-read');
        }
        return snapshot(id);
      },
    };
    const client = new PlaywrightPortalClient(browser, cfg, rate, clock, ops);
    const snap = await client.fetchSnapshot('c1');

    expect(snap.pollCycleId).toBe('c1');
    expect(login).toHaveBeenCalledOnce(); // re-login triggered by SessionExpiredError
    // navs: arrival(1) + re-login nav(1) = 2; plus login record(1) = 3 total
    expect(rate.count(clock.nowMs())).toBe(3);
  });

  it('propagates a non-session error from read without re-login', async () => {
    const rate = new RateLimiter(180);
    const login = vi.fn();
    const ops: PortalOps = {
      isLoggedOut: async () => false,
      login,
      read: async () => {
        throw new Error('layout boom');
      },
    };
    const client = new PlaywrightPortalClient(browser, cfg, rate, clock, ops);
    await expect(client.fetchSnapshot('c1')).rejects.toThrow('layout boom');
    expect(login).not.toHaveBeenCalled();
  });
});
