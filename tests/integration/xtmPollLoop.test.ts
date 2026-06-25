import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { XtmPollLoop } from '../../src/runtime/xtmPollLoop.js';
import { XtmJobStore } from '../../src/state/xtmJobStore.js';
import { LoginFailedError } from '../../src/portal/errors.js';
import type { XtmPortalClient } from '../../src/portal/xtmClient.js';
import type { AppConfig } from '../../src/config/index.js';
import type { XtmRawJob, XtmJobSnapshot, XtmJobState } from '../../src/detection/types.js';
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
  async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
    return { outcome: 'ok', status: 200 };
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

// ---------------------------------------------------------------------------
// Daily report integration tests
// ---------------------------------------------------------------------------

/** Seed an accepted XtmJobState directly into the store (bypassing a full cycle). */
function seedAcceptedJob(db: DB, over: Partial<XtmJobState> = {}): void {
  const store = new XtmJobStore(db);
  const base: XtmJobState = {
    jobKey: `J-${Math.random().toString(36).slice(2)}`,
    xtmTaskId: 'T1',
    projectName: 'Project X',
    fileName: 'doc.xlf',
    sourceLang: 'English (USA)',
    targetLang: 'Malay (Malaysia)',
    dueDate: '2026-06-30T00:00:00Z',
    dueRaw: null,
    words: 1000,
    step: 'PE 1',
    role: 'Corrector',
    eligible: true,
    lifecycleStatus: 'accepted',
    acceptStatus: 'accepted',
    acceptedAt: '2026-06-25T02:00:00Z',
    status: 'visible',
    firstSeenAt: '2026-06-24T10:00:00Z',
    lastSeenAt: '2026-06-25T03:00:00Z',
    snapshotHash: 'abc',
    consecutiveMisses: 0,
    ...over,
  };
  store.upsertMany([base]);
}

// Clock at 10:00 Bangkok (UTC 03:00 on 25 Jun)
const BKK_10_00 = Date.parse('2026-06-25T03:00:00Z');
// Clock at 08:00 Bangkok (UTC 01:00 on 25 Jun) — before 09:00 trigger
const BKK_08_00 = Date.parse('2026-06-25T01:00:00Z');

describe('XtmPollLoop — daily report', () => {
  it('enqueues exactly one team outbox row at 10:00 Bangkok with 2 accepted jobs', async () => {
    fresh();
    // Seed 2 accepted jobs
    seedAcceptedJob(db, { jobKey: 'J-A1', projectName: 'Alpha', fileName: 'a.xlf' });
    seedAcceptedJob(db, { jobKey: 'J-A2', projectName: 'Beta', fileName: 'b.xlf' });

    const clockAt10 = { nowMs: () => BKK_10_00, nowIso: () => new Date(BKK_10_00).toISOString() };
    const client = new StubClient(); // empty Active → no new jobs, just daily trigger
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ XTM_ACOLAD_OFFERS_URL: 'https://xtm.example.com' } as Partial<AppConfig>),
      noopLogger,
      clockAt10,
      { chatSender: okChat, sheetSender: new CapturingSheet(), heartbeat },
    );

    await loop.runOnce();

    // Exactly one 'team' outbox row with event_id 'daily:2026-06-25'
    const rows = db
      .prepare("SELECT * FROM outbox WHERE event_id = 'daily:2026-06-25' AND channel = 'team'")
      .all() as { payload_json: string }[];
    expect(rows).toHaveLength(1);

    // Card title includes (2)
    const payload = JSON.parse(rows[0]!.payload_json) as { cardsV2: unknown[] };
    const entry = payload.cardsV2[0] as { card: { header: { title: string } } };
    expect(entry.card.header.title).toBe('📋 Jobs in Progress (2)');
  });

  it('does NOT enqueue a second daily row when runOnce is called again on the same Bangkok day', async () => {
    fresh();
    seedAcceptedJob(db, { jobKey: 'J-B1' });

    const clockAt10 = { nowMs: () => BKK_10_00, nowIso: () => new Date(BKK_10_00).toISOString() };
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ XTM_ACOLAD_OFFERS_URL: 'https://xtm.example.com' } as Partial<AppConfig>),
      noopLogger,
      clockAt10,
      { chatSender: okChat, sheetSender: new CapturingSheet(), heartbeat },
    );

    await loop.runOnce(); // first run — enqueues
    await loop.runOnce(); // second run same clock — meta gate prevents duplicate

    const rows = db
      .prepare("SELECT * FROM outbox WHERE event_id = 'daily:2026-06-25' AND channel = 'team'")
      .all();
    expect(rows).toHaveLength(1); // still exactly one, not two
  });

  it('does NOT enqueue a daily row when Bangkok hour < 09 (08:00 Bangkok)', async () => {
    fresh();
    seedAcceptedJob(db, { jobKey: 'J-C1' });

    const clockAt8 = { nowMs: () => BKK_08_00, nowIso: () => new Date(BKK_08_00).toISOString() };
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ XTM_ACOLAD_OFFERS_URL: 'https://xtm.example.com' } as Partial<AppConfig>),
      noopLogger,
      clockAt8,
      { chatSender: okChat, sheetSender: new CapturingSheet(), heartbeat },
    );

    await loop.runOnce();

    const rows = db
      .prepare("SELECT * FROM outbox WHERE channel = 'team' AND event_id LIKE 'daily:%'")
      .all();
    expect(rows).toHaveLength(0); // nothing enqueued before 09:00
  });
});
