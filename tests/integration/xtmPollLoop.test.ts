import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { XtmPollLoop } from '../../src/runtime/xtmPollLoop.js';
import { LoginFailedError } from '../../src/portal/errors.js';
import type { XtmPortalClient } from '../../src/portal/xtmClient.js';
import type { AppConfig } from '../../src/config/index.js';
import type { XtmRawJob, XtmJobSnapshot } from '../../src/detection/types.js';
import type { ChatSender, SendOutcome } from '../../src/reporting/googleChat.js';
import type { SheetSender, SheetRow } from '../../src/reporting/sheets.js';

const NOW = '2026-06-19T10:00:00.000Z';
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const cfg = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    ACCEPT_ENABLED: false,
    ACCEPT_LANGUAGES: ['Malay (Malaysia)'],
    ACCEPT_MAX_WORDS: 0,
    ACCEPT_MAX_PER_CYCLE: 0,
    OUTBOX_RETRY_CAP: 10,
    OUTBOX_DEAD_AFTER_HOURS: 6,
    LOGIN_MAX_RETRY: 3,
    LOGIN_LOCKOUT_MINUTES: 15,
    ...over,
  }) as AppConfig;

const xraw = (over: Partial<XtmRawJob> = {}): XtmRawJob => ({
  xtmTaskId: 'ID-1',
  projectName: 'P',
  fileName: 'a.docx',
  sourceLang: 'English (USA)',
  targetLang: 'Malay (Malaysia)',
  dueDate: null,
  dueRaw: null,
  words: 100,
  step: 'PE 1',
  role: 'Corrector',
  acceptAvailable: true,
  ...over,
});
const snap = (jobs: XtmRawJob[]): XtmJobSnapshot => ({
  jobs,
  malformed: [],
  capturedAt: NOW,
  pollCycleId: 'c1',
  emptyListConfirmed: jobs.length === 0,
});

class StubClient implements XtmPortalClient {
  snapshot: XtmJobSnapshot = snap([]);
  fetchError: Error | undefined;
  ensureLoggedIn = vi.fn(async () => {});
  async fetchJobSnapshot(): Promise<XtmJobSnapshot> {
    if (this.fetchError) throw this.fetchError;
    return this.snapshot;
  }
  async acceptEligibleTasks(): Promise<[]> {
    return [];
  }
  captureAcceptMenu = vi.fn(async () => 'state/evidence/accept_menu_recon-x');
  async readClosedKeys(): Promise<Set<string>> {
    return new Set();
  }
  async maybeRecycle(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const okChat: ChatSender = {
  async send(): Promise<SendOutcome> {
    return 'ok';
  },
};
class CapturingSheet implements SheetSender {
  rows: SheetRow[] = [];
  ready = 0;
  async send(row: SheetRow): Promise<SendOutcome> {
    this.rows.push(row);
    return 'ok';
  }
  async ensureReady(): Promise<SendOutcome> {
    this.ready++;
    return 'ok';
  }
}

let now = Date.parse(NOW);
const clock = { nowMs: () => now, nowIso: () => new Date(now).toISOString() };

let db: DB;
const dirs: string[] = [];
function fresh(): DB {
  const d = mkdtempSync(join(tmpdir(), 'acolad-loop-'));
  dirs.push(d);
  db = openDatabase(d, NOW).db;
  now = Date.parse(NOW);
  return db;
}
afterEach(() => {
  db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('XtmPollLoop (runtime driver)', () => {
  it('runs a successful cycle, dispatches Sheets, and pings heartbeat ok', async () => {
    fresh();
    const client = new StubClient();
    client.snapshot = snap([xraw()]);
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const sheet = new CapturingSheet();
    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      sheetSender: sheet,
      heartbeat,
    });
    expect(await loop.runOnce()).toBe(true);
    expect(heartbeat.ok).toHaveBeenCalledTimes(1);
    expect(heartbeat.fail).not.toHaveBeenCalled();
    expect(sheet.rows.length).toBeGreaterThanOrEqual(1); // job logged to Sheets
  });

  it('captures the accept-menu DOM and pings Chat once when ACCEPT_RECON is on', async () => {
    fresh();
    const client = new StubClient();
    client.snapshot = snap([xraw()]); // one eligible Malay job, accept off
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ ACCEPT_ENABLED: false, ACCEPT_RECON: true }),
      noopLogger,
      clock,
      { chatSender: okChat, sheetSender: new CapturingSheet(), heartbeat },
    );
    await loop.runOnce();
    expect(client.captureAcceptMenu).toHaveBeenCalledTimes(1); // hover-only menu capture
    const ping = db
      .prepare("SELECT 1 FROM outbox WHERE event_id='accept_recon_captured' AND channel='chat'")
      .all();
    expect(ping.length).toBe(1); // one-time, deduped notification
  });

  it('ensures the Sheet header even when Active is empty (no jobs → still headed)', async () => {
    fresh();
    const client = new StubClient(); // default snapshot = snap([]) → empty Active
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const sheet = new CapturingSheet();
    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      sheetSender: sheet,
      heartbeat,
    });
    expect(await loop.runOnce()).toBe(true);
    expect(sheet.ready).toBe(1); // header ensured up front...
    expect(sheet.rows.length).toBe(0); // ...without any job row written
  });

  it('on a portal error returns false and pings heartbeat fail (dead-man switch)', async () => {
    fresh();
    const client = new StubClient();
    client.fetchError = new Error('network timeout');
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });
    expect(await loop.runOnce()).toBe(false);
    expect(heartbeat.fail).toHaveBeenCalled();
    expect(heartbeat.ok).not.toHaveBeenCalled();
  });

  it('locks out after LOGIN_MAX_RETRY consecutive login failures', async () => {
    fresh();
    const client = new StubClient();
    client.fetchError = new LoginFailedError('bad creds');
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg({ LOGIN_MAX_RETRY: 2 }), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });
    await loop.runOnce(); // failure 1
    await loop.runOnce(); // failure 2 → lockout
    // Now in lockout: fetch is not even attempted.
    const before = client.fetchError;
    client.fetchError = undefined;
    client.snapshot = snap([xraw()]);
    const result = await loop.runOnce(); // still locked out
    expect(result).toBe(false);
    expect(before).toBeInstanceOf(LoginFailedError);
  });
});
