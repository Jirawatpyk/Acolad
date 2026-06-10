import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';
import { PollLoop } from '../../src/runtime/pollLoop.js';
import type { PortalClient } from '../../src/portal/portalClient.js';
import type { ChatSender, SendOutcome } from '../../src/reporting/googleChat.js';
import type { HeartbeatPinger } from '../../src/monitoring/heartbeat.js';
import type { Clock } from '../../src/clock.js';
import type { AppConfig } from '../../src/config/index.js';
import type { JobSnapshot } from '../../src/detection/types.js';
import { LoginFailedError, CaptchaDetectedError } from '../../src/portal/errors.js';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const cfg = {
  ACOLAD_PORTAL_URL: 'https://portal/login',
  ACOLAD_OFFERS_URL: 'https://portal/offers',
  ACOLAD_EMAIL: 'e@x.com',
  ACOLAD_PASSWORD: 'pw',
  GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat/x',
  HEALTHCHECKS_PING_URL: 'https://hc/x',
  POLL_INTERVAL_MS: 25_000,
  LOGIN_MAX_RETRY: 3,
  LOGIN_LOCKOUT_MINUTES: 15,
  BROWSER_RECYCLE_HOURS: 6,
  OUTBOX_RETRY_CAP: 10,
  OUTBOX_DEAD_AFTER_HOURS: 6,
  REQUESTS_PER_HOUR_CAP: 180,
  LOG_DIR: 'logs',
  STATE_DIR: 'state',
  TZ_DISPLAY: 'Asia/Bangkok',
  LIVE_PORTAL: false,
} as AppConfig;

/** Snapshot of an empty offers page (confirmed empty). */
const emptySnapshot = (cycle: string): JobSnapshot => ({
  jobs: [],
  malformed: [],
  capturedAt: '2026-06-10T03:00:00.000Z',
  pollCycleId: cycle,
  emptyListConfirmed: true,
});

class StubPortal implements PortalClient {
  /** Queue of results: a JobSnapshot is returned, an Error is thrown. */
  script: (JobSnapshot | Error)[] = [];
  calls = 0;
  async fetchSnapshot(pollCycleId: string): Promise<JobSnapshot> {
    this.calls++;
    const next = this.script.shift() ?? emptySnapshot(pollCycleId);
    if (next instanceof Error) throw next;
    return next;
  }
  async maybeRecycle(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class SpyHeartbeat implements HeartbeatPinger {
  okCount = 0;
  failCount = 0;
  async ok(): Promise<void> {
    this.okCount++;
  }
  async fail(): Promise<void> {
    this.failCount++;
  }
}

class StubSender implements ChatSender {
  constructor(public outcome: SendOutcome = 'ok') {}
  sent: string[] = [];
  async send(text: string): Promise<SendOutcome> {
    if (this.outcome === 'ok') this.sent.push(text);
    return this.outcome;
  }
}

class FakeClock implements Clock {
  constructor(public ms = Date.parse('2026-06-10T03:00:00.000Z')) {}
  advance(ms: number): void {
    this.ms += ms;
  }
  nowMs(): number {
    return this.ms;
  }
  nowIso(): string {
    return new Date(this.ms).toISOString();
  }
}

let dir: string;
let db: DB;
let portal: StubPortal;
let heartbeat: SpyHeartbeat;
let sender: StubSender;
let clock: FakeClock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acolad-loop-'));
  db = openDatabase(dir, '2026-06-10T03:00:00.000Z').db;
  portal = new StubPortal();
  heartbeat = new SpyHeartbeat();
  sender = new StubSender('ok');
  clock = new FakeClock();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const makeLoop = (): PollLoop =>
  new PollLoop(db, portal, cfg, noopLogger, clock, { sender, heartbeat });

describe('PollLoop orchestration', () => {
  it('a healthy cycle pings heartbeat ok and uses exactly one fetchSnapshot', async () => {
    const loop = makeLoop();
    const ok = await loop.runOnce();
    expect(ok).toBe(true);
    expect(portal.calls).toBe(1);
    expect(heartbeat.okCount).toBe(1);
    expect(heartbeat.failCount).toBe(0);
  });

  it('pings /fail (not ok) when the outbox already has a dead row (C1, Constitution IV)', async () => {
    // Pre-seed a dead outbox row.
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('stale', JSON.stringify({ text: 'x' }), clock.nowIso());
    ob.recordFailure(
      { ...ob.due(clock.nowIso())[0]!, attempts: 99 },
      clock.nowMs() + 7 * 3_600_000,
    );
    expect(ob.countByStatus('dead')).toBe(1);

    await makeLoop().runOnce();
    expect(heartbeat.failCount).toBe(1);
    expect(heartbeat.okCount).toBe(0);
  });

  it('locks out after LOGIN_MAX_RETRY consecutive login failures (FR-009)', async () => {
    const loop = makeLoop();
    portal.script = [
      new LoginFailedError('x'),
      new LoginFailedError('x'),
      new LoginFailedError('x'),
    ];
    for (let i = 0; i < 3; i++) {
      expect(await loop.runOnce()).toBe(false);
    }
    // Now locked out: next cycle short-circuits, pings /fail, does not call portal.
    const callsBefore = portal.calls;
    expect(await loop.runOnce()).toBe(false);
    expect(portal.calls).toBe(callsBefore); // portal not touched during lockout
    // A login_failed alert was dispatched to chat.
    expect(sender.sent.some((t) => t.includes('เข้าสู่ระบบไม่สำเร็จ'))).toBe(true);
  });

  it('does not lock out when login failures are interleaved with other errors', async () => {
    const loop = makeLoop();
    portal.script = [
      new LoginFailedError('x'),
      new Error('network blip'), // resets the streak
      new LoginFailedError('x'),
      new LoginFailedError('x'),
    ];
    for (let i = 0; i < 4; i++) await loop.runOnce();
    // Streak never reached 3 consecutive → a healthy cycle proceeds (no lockout).
    expect(await loop.runOnce()).toBe(true);
    expect(heartbeat.okCount).toBe(1);
  });

  it('raises a CAPTCHA alert without locking out', async () => {
    const loop = makeLoop();
    portal.script = [new CaptchaDetectedError('captcha')];
    expect(await loop.runOnce()).toBe(false);
    // Not locked out: a following healthy cycle runs normally.
    expect(await loop.runOnce()).toBe(true);
    expect(sender.sent.some((t) => t.includes('CAPTCHA'))).toBe(true);
  });

  it('alerts portal_down only after the 10-minute outage threshold', async () => {
    const loop = makeLoop();
    const downAlerted = (): boolean => sender.sent.some((t) => t.includes('portal เข้าถึงไม่ได้'));

    portal.script = [new Error('down'), new Error('down')];
    await loop.runOnce(); // t0: first error, window starts
    expect(downAlerted()).toBe(false);
    clock.advance(11 * 60_000); // > 10 min
    await loop.runOnce();
    expect(downAlerted()).toBe(true);
  });
});
