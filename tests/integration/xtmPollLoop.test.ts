import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { XtmPollLoop } from '../../src/runtime/xtmPollLoop.js';
import { XtmJobStore } from '../../src/state/xtmJobStore.js';
import { LoginFailedError, SessionYieldError, type LogoutKind } from '../../src/portal/errors.js';
import { MetaStore } from '../../src/state/meta.js';
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
    ACCEPT_MAX_WORDS_PER_DAY: 1000, // so the daily-report capacity row shows "N / 1000", not "(no cap)"
    OUTBOX_RETRY_CAP: 10,
    OUTBOX_DEAD_AFTER_HOURS: 6,
    LOGIN_MAX_RETRY: 3,
    LOGIN_LOCKOUT_MINUTES: 15,
    workdays: new Set([1, 2, 3, 4, 5]), // Mon–Fri: required by dueDailyReport working-day gate
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
  async fetchJobSnapshot(
    _id: string,
    _opts?: { decideRelogin?: (kind: LogoutKind) => boolean },
  ): Promise<XtmJobSnapshot> {
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
    // Seed 2 accepted jobs, both due TODAY (25 Jun 2026 Bangkok) with TZ-explicit +07:00
    // deadlines, so the "Due today" word bucket is a clear, asserted sum (700 + 500 = 1200)
    // that holds under TZ=UTC. Both deadlines fall after 10:00, so neither is Overdue.
    seedAcceptedJob(db, {
      jobKey: 'J-A1',
      projectName: 'Alpha',
      fileName: 'a.xlf',
      dueDate: '2026-06-25T15:00:00+07:00',
      words: 700,
    });
    seedAcceptedJob(db, {
      jobKey: 'J-A2',
      projectName: 'Beta',
      fileName: 'b.xlf',
      dueDate: '2026-06-25T20:00:00+07:00',
      words: 500,
    });

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

    // New card format (Task 1, commit 6f75ce3): header is "📋 Daily Report — DD/MM/YYYY".
    const payload = JSON.parse(rows[0]!.payload_json) as { cardsV2: unknown[] };
    const entry = payload.cardsV2[0] as { card: { header: { title: string } } };
    expect(entry.card.header.title).toBe('📋 Daily Report — 25/06/2026');

    // The "Due today" row sums the held words whose Bangkok deadline date == today
    // (700 + 500 = 1200) and threads ACCEPT_MAX_WORDS_PER_DAY through as the cap.
    expect(rows[0]!.payload_json).toContain('1200 words (cap 1000/day per deadline)');
    // Both accepted jobs appear as in-progress rows (preserves the original "2 jobs" intent).
    expect(rows[0]!.payload_json).toContain('Alpha');
    expect(rows[0]!.payload_json).toContain('Beta');
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

  it('a daily-report build throw does not page (no heartbeat.fail) and does not advance lastDailyReportDate', async () => {
    fresh();
    // 10:00 Bangkok on a working day (Thu 25 Jun 2026) → dueDailyReport true.
    const clockAt10 = { nowMs: () => BKK_10_00, nowIso: () => new Date(BKK_10_00).toISOString() };

    // Force the report's DB read to throw, exercising the moved try-scope. listByLifecycle
    // is the loop's ONLY caller and the detection cycle never calls it, so the throw is
    // isolated to the daily-report build — not the detection cycle (Constitution IV: a
    // reporting bug must never block detection or page on-call).
    const readSpy = vi.spyOn(XtmJobStore.prototype, 'listByLifecycle').mockImplementation(() => {
      throw new Error('boom: accepted-jobs read failed');
    });

    const client = new StubClient(); // empty Active → the detection cycle still runs cleanly
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ XTM_ACOLAD_OFFERS_URL: 'https://xtm.example.com' } as Partial<AppConfig>),
      noopLogger,
      clockAt10,
      { chatSender: okChat, sheetSender: new CapturingSheet(), heartbeat },
    );

    const result = await loop.runOnce();
    // Capture state, then restore the prototype spy BEFORE asserting so a failed
    // expectation can never leak the throwing impl into the next test.
    const calledWithAccepted = readSpy.mock.calls.some((c) => c[0] === 'accepted');
    const metaDate = new MetaStore(db).lastDailyReportDate;
    readSpy.mockRestore();

    expect(calledWithAccepted).toBe(true); // proves the throw came from the moved read (not vacuous)
    expect(result).toBe(true); // cycle produced a result — not tanked by the report bug
    expect(heartbeat.fail).not.toHaveBeenCalled(); // a report throw must NOT page on-call
    expect(heartbeat.ok).toHaveBeenCalledTimes(1); // the cycle still reported healthy
    expect(metaDate).toBeNull(); // last_daily_report_date NOT advanced → retries next cycle
  });
});

// ---------------------------------------------------------------------------
// Stuck-gate isolation: team-channel dead rows must NOT page on-call (Finding 1/2)
// ---------------------------------------------------------------------------

import { Outbox } from '../../src/state/outbox.js';

describe('XtmPollLoop — heartbeat stuck gate excludes team channel', () => {
  /**
   * Helper: builds a loop with a sender that always fails transiently, then seeds
   * a pre-dead outbox row for the given channel so the NEXT runOnce sees it via
   * countDeadExcludingChannel (past-dead path). This covers the "dead row already
   * in DB" case; the freshly-dead-this-flush path is covered by the transient-sender
   * tests below.
   */
  function seedDeadRow(
    outbox: Outbox,
    eventId: string,
    channel: 'team' | 'chat',
    nowIso: string,
  ): void {
    // Enqueue then mark dead directly via SQL so we bypass the retry cap
    outbox.enqueue(eventId, JSON.stringify({ text: 'test' }), nowIso, channel);
    // Force status=dead via recordFailure exhaustion simulation — just update directly
    const loopDb = (outbox as unknown as { db: import('../../src/state/db.js').DB }).db;
    loopDb.prepare("UPDATE outbox SET status = 'dead' WHERE event_id = ?").run(eventId);
  }

  it('a dead team-channel row does NOT call heartbeat.fail()', async () => {
    fresh();
    const client = new StubClient(); // empty snapshot, no jobs
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      sheetSender: new CapturingSheet(),
      heartbeat,
    });

    // Seed a pre-dead 'team' row directly (simulates daily report delivery failure)
    const outbox = new Outbox(db, 10, 6);
    seedDeadRow(outbox, 'daily:2026-06-24', 'team', NOW);

    await loop.runOnce();

    // The team dead row must NOT trigger paging
    expect(heartbeat.fail).not.toHaveBeenCalled();
    expect(heartbeat.ok).toHaveBeenCalledTimes(1);
  });

  it('a dead chat-channel row DOES call heartbeat.fail()', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      sheetSender: new CapturingSheet(),
      heartbeat,
    });

    // Seed a pre-dead 'chat' row (simulates a failed job notification)
    const outbox = new Outbox(db, 10, 6);
    seedDeadRow(outbox, 'job:some-key:first_seen', 'chat', NOW);

    await loop.runOnce();

    // A dead chat row MUST page on-call
    expect(heartbeat.fail).toHaveBeenCalled();
    expect(heartbeat.ok).not.toHaveBeenCalled();
  });

  it('a freshly-dead team-channel row (exhausts retries this flush) does NOT call heartbeat.fail()', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };

    // Sender that always returns transient so the row exhausts its retry cap this flush
    const failingTeamSender: ChatSender = {
      async send(): Promise<SendOutcome> {
        return 'transient';
      },
      async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
        return { outcome: 'transient', status: 503 };
      },
    };

    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ OUTBOX_RETRY_CAP: 1, OUTBOX_DEAD_AFTER_HOURS: 6 }),
      noopLogger,
      clock,
      {
        chatSender: okChat,
        teamChatSender: failingTeamSender,
        sheetSender: new CapturingSheet(),
        heartbeat,
      },
    );

    // Seed a pending 'team' row — it will exhaust retries (cap=1) in this flush
    const outbox = new Outbox(db, 1, 6);
    outbox.enqueue('daily:2026-06-19', JSON.stringify({ text: 'daily' }), NOW, 'team');

    await loop.runOnce();

    // Even though the team row just died this flush, it must NOT page on-call
    expect(heartbeat.fail).not.toHaveBeenCalled();
    expect(heartbeat.ok).toHaveBeenCalledTimes(1);
  });

  it('a freshly-dead chat-channel row (exhausts retries this flush) DOES call heartbeat.fail()', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };

    // Sender that always fails — will exhaust retry cap = 1 for chat
    const failingChatSender: ChatSender = {
      async send(): Promise<SendOutcome> {
        return 'transient';
      },
      async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
        return { outcome: 'transient', status: 503 };
      },
    };

    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ OUTBOX_RETRY_CAP: 1, OUTBOX_DEAD_AFTER_HOURS: 6 }),
      noopLogger,
      clock,
      { chatSender: failingChatSender, sheetSender: new CapturingSheet(), heartbeat },
    );

    // Seed a pending 'chat' row — will die this flush
    const outbox = new Outbox(db, 1, 6);
    outbox.enqueue('job:some-key:first_seen', JSON.stringify({ text: 'job found' }), NOW, 'chat');

    await loop.runOnce();

    // A freshly-dead chat row MUST page on-call
    expect(heartbeat.fail).toHaveBeenCalled();
    expect(heartbeat.ok).not.toHaveBeenCalled();
  });

  it('a permanent-failure team-channel row does NOT call heartbeat.fail()', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };

    // Sender that returns permanent (webhook revoked) for the team channel
    const permanentTeamSender: ChatSender = {
      async send(): Promise<SendOutcome> {
        return 'permanent';
      },
      async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
        return { outcome: 'permanent', status: 403 };
      },
    };

    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      teamChatSender: permanentTeamSender,
      sheetSender: new CapturingSheet(),
      heartbeat,
    });

    // Seed a pending 'team' row — will get a permanent failure this flush (but stays pending)
    const outbox = new Outbox(db, 10, 6);
    outbox.enqueue('daily:2026-06-19', JSON.stringify({ cardsV2: [{}] }), NOW, 'team');

    await loop.runOnce();

    // A permanent-failure team row must NOT page on-call
    expect(heartbeat.fail).not.toHaveBeenCalled();
    expect(heartbeat.ok).toHaveBeenCalledTimes(1);
  });

  it('a permanent-failure chat-channel row DOES call heartbeat.fail()', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };

    // Sender that returns permanent (webhook revoked) for the chat channel
    const permanentChatSender: ChatSender = {
      async send(): Promise<SendOutcome> {
        return 'permanent';
      },
      async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
        return { outcome: 'permanent', status: 403 };
      },
    };

    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: permanentChatSender,
      sheetSender: new CapturingSheet(),
      heartbeat,
    });

    // Seed a pending 'chat' row — will get a permanent failure this flush
    const outbox = new Outbox(db, 10, 6);
    outbox.enqueue('job:some-key:first_seen', JSON.stringify({ cardsV2: [{}] }), NOW, 'chat');

    await loop.runOnce();

    // A permanent-failure chat row MUST page on-call
    expect(heartbeat.fail).toHaveBeenCalled();
    expect(heartbeat.ok).not.toHaveBeenCalled();
  });

  it('a malformed/payload-rejected chat-channel drop DOES call heartbeat.fail() (parity with pre-branch behavior)', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };

    // Sender that returns 400 payload-rejection for the chat channel — dispatcher drops via markSent + onDead
    const rejectionChatSender: ChatSender = {
      async send(): Promise<SendOutcome> {
        return 'permanent';
      },
      async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
        return { outcome: 'permanent', status: 400 }; // isPayloadRejection(400) → true → onDead path
      },
    };

    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: rejectionChatSender,
      sheetSender: new CapturingSheet(),
      heartbeat,
    });

    // Seed a pending 'chat' row with a cardsV2 payload so it passes shape-check and hits the sender
    const outbox = new Outbox(db, 10, 6);
    outbox.enqueue('job:some-key:first_seen', JSON.stringify({ cardsV2: [{}] }), NOW, 'chat');

    await loop.runOnce();

    // A dropped (payload-rejected) non-team row MUST page on-call — regression guard
    expect(heartbeat.fail).toHaveBeenCalled();
    expect(heartbeat.ok).not.toHaveBeenCalled();
  });

  it('a malformed/payload-rejected team-channel drop does NOT call heartbeat.fail()', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };

    // Sender that returns 400 payload-rejection for the team channel — dispatcher drops via markSent + onDead
    const rejectionTeamSender: ChatSender = {
      async send(): Promise<SendOutcome> {
        return 'permanent';
      },
      async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
        return { outcome: 'permanent', status: 400 }; // isPayloadRejection(400) → true → onDead path
      },
    };

    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      teamChatSender: rejectionTeamSender,
      sheetSender: new CapturingSheet(),
      heartbeat,
    });

    // Seed a pending 'team' row with a cardsV2 payload so it passes shape-check and hits the sender
    const outbox = new Outbox(db, 10, 6);
    outbox.enqueue('daily:2026-06-19', JSON.stringify({ cardsV2: [{}] }), NOW, 'team');

    await loop.runOnce();

    // A dropped (payload-rejected) team row must NOT page on-call
    expect(heartbeat.fail).not.toHaveBeenCalled();
    expect(heartbeat.ok).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 2: outbox_dead alert detail must contain the reason (not a static string)
// ---------------------------------------------------------------------------

describe('XtmPollLoop — outbox_dead detail contains reason', () => {
  it('outbox_dead system alert detail includes "rejected by Chat (400)" when a chat row is 400-rejected', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };

    // Sender that returns 400 — isPayloadRejection → onDead with 'rejected by Chat (400)'
    const rejectionChatSender: ChatSender = {
      async send(): Promise<SendOutcome> {
        return 'permanent';
      },
      async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
        return { outcome: 'permanent', status: 400 };
      },
    };

    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: rejectionChatSender,
      sheetSender: new CapturingSheet(),
      heartbeat,
    });

    const outbox = new Outbox(db, 10, 6);
    outbox.enqueue('job:key-x:first_seen', JSON.stringify({ cardsV2: [{}] }), NOW, 'chat');

    await loop.runOnce();

    // The outbox_dead system alert must have the reason in its payload_json (the 'Detail' card row)
    const alert = db
      .prepare(
        "SELECT payload_json FROM system_events WHERE event_type='system_alert' AND dedup_key='outbox_dead'",
      )
      .get() as { payload_json: string } | undefined;
    expect(alert).toBeDefined();
    expect(alert!.payload_json).toContain('rejected by Chat (400)');
  });

  it('outbox_dead system alert detail includes "retry limit exceeded" when a chat row exhausts retries', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };

    const failingChatSender: ChatSender = {
      async send(): Promise<SendOutcome> {
        return 'transient';
      },
      async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
        return { outcome: 'transient', status: 503 };
      },
    };

    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ OUTBOX_RETRY_CAP: 1, OUTBOX_DEAD_AFTER_HOURS: 6 }),
      noopLogger,
      clock,
      { chatSender: failingChatSender, sheetSender: new CapturingSheet(), heartbeat },
    );

    const outbox = new Outbox(db, 1, 6);
    outbox.enqueue('job:key-y:first_seen', JSON.stringify({ text: 'hi' }), NOW, 'chat');

    await loop.runOnce();

    const alert = db
      .prepare(
        "SELECT payload_json FROM system_events WHERE event_type='system_alert' AND dedup_key='outbox_dead'",
      )
      .get() as { payload_json: string } | undefined;
    expect(alert).toBeDefined();
    expect(alert!.payload_json).toContain('retry limit exceeded');
  });
});

// ---------------------------------------------------------------------------
// Fix 7: daily_report_dead alert raised when team row dies (retry-exhausted)
// ---------------------------------------------------------------------------

describe('XtmPollLoop — daily_report_dead alert when team row dies', () => {
  it('raises daily_report_dead alert with date in detail when a daily:<date> team row exhausts retries', async () => {
    fresh();
    const client = new StubClient(); // empty Active
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };

    // Sender that always returns transient — will exhaust retry cap in this flush
    const failingTeamSender: ChatSender = {
      async send(): Promise<SendOutcome> {
        return 'transient';
      },
      async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
        return { outcome: 'transient', status: 503 };
      },
    };

    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ OUTBOX_RETRY_CAP: 1, OUTBOX_DEAD_AFTER_HOURS: 6 }),
      noopLogger,
      clock,
      {
        chatSender: okChat,
        teamChatSender: failingTeamSender,
        sheetSender: new CapturingSheet(),
        heartbeat,
      },
    );

    // Seed a pending 'team' daily row — it will exhaust retries (cap=1) in this flush
    const outbox = new Outbox(db, 1, 6);
    outbox.enqueue('daily:2026-06-19', JSON.stringify({ text: 'daily' }), NOW, 'team');

    await loop.runOnce();

    // heartbeat.fail must NOT be called (team failure never pages on-call)
    expect(heartbeat.fail).not.toHaveBeenCalled();
    expect(heartbeat.ok).toHaveBeenCalledTimes(1);

    // A system_alert with dedup_key='daily_report_dead' must be enqueued
    const alert = db
      .prepare(
        "SELECT payload_json FROM system_events WHERE event_type='system_alert' AND dedup_key='daily_report_dead'",
      )
      .get() as { payload_json: string } | undefined;
    expect(alert).toBeDefined();

    // The alert detail must contain the date from the event_id ('daily:2026-06-19' → '2026-06-19')
    expect(alert!.payload_json).toContain('2026-06-19');
  });
});

// ---------------------------------------------------------------------------
// C1: holiday_calendar_stale (current Bangkok year uncurated) fails the heartbeat → pages
// ---------------------------------------------------------------------------

describe('XtmPollLoop — holiday_calendar_stale pages on-call (C1)', () => {
  // Schedule gate fields the loop cfg() does not set (Task 9 derives these in loadConfig).
  const SCHED = {
    ACCEPT_SCHEDULE_ENABLED: true,
    ACCEPT_MAX_WORDS_PER_DAY: 1000,
    hoursStartMin: 9 * 60,
    hoursEndMin: 18 * 60,
    workdays: new Set([1, 2, 3, 4, 5]),
    throughputWordsPerHour: 1000 / 9,
  };
  // The gate keys its Bangkok-year check off snapshot.capturedAt; the loop clock (NOW, 2026)
  // only drives daily-report/heartbeat timing — kept at 2026 so the daily report path is
  // identical in both cases and the only variable is the snapshot's Bangkok year.
  const staleSnap: XtmJobSnapshot = {
    jobs: [],
    malformed: [],
    capturedAt: '2099-06-22T10:00:00+07:00', // uncurated current Bangkok year → total outage
    pollCycleId: 'c1',
    emptyListConfirmed: true,
  };

  it('an uncurated current-year cycle fails the heartbeat (total auto-accept outage pages)', async () => {
    fresh();
    const client = new StubClient();
    client.snapshot = staleSnap;
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ ...SCHED } as Partial<AppConfig>),
      noopLogger,
      clock,
      {
        chatSender: okChat,
        teamChatSender: okChat,
        sheetSender: new CapturingSheet(),
        heartbeat,
      },
    );
    expect(await loop.runOnce()).toBe(false); // unhealthy — auto-accept is fully paused
    expect(heartbeat.fail).toHaveBeenCalledTimes(1);
    expect(heartbeat.ok).not.toHaveBeenCalled();
  });

  it('a curated current-year cycle keeps the heartbeat green', async () => {
    fresh();
    const client = new StubClient();
    client.snapshot = { ...staleSnap, capturedAt: NOW }; // 2026 — curated current year
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ ...SCHED } as Partial<AppConfig>),
      noopLogger,
      clock,
      {
        chatSender: okChat,
        teamChatSender: okChat,
        sheetSender: new CapturingSheet(),
        heartbeat,
      },
    );
    expect(await loop.runOnce()).toBe(true);
    expect(heartbeat.ok).toHaveBeenCalledTimes(1);
    expect(heartbeat.fail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// I1: the loop logs one structured warn line per schedule-gate reject
// ---------------------------------------------------------------------------

describe('XtmPollLoop — schedule-gate reject logging (I1)', () => {
  const SCHED = {
    ACCEPT_ENABLED: true,
    ACCEPT_SCHEDULE_ENABLED: true,
    ACCEPT_MAX_WORDS_PER_DAY: 1000,
    hoursStartMin: 9 * 60,
    hoursEndMin: 18 * 60,
    workdays: new Set([1, 2, 3, 4, 5]),
    throughputWordsPerHour: 1000 / 9,
  };

  it('logs one warn line per reject with the binding reason/words/dueDate', async () => {
    fresh();
    const client = new StubClient();
    // capturedAt = NOW (2026-06-19 17:00 BKK, Friday). 5000 words due 18:00 same day →
    // ~60 working min available → "cannot finish in time" → schedule-rejected.
    const tightDue = '2026-06-19T18:00:00+07:00';
    client.snapshot = snap([xraw({ dueDate: tightDue, words: 5000 })]);
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(
      db,
      client,
      cfg({ ...SCHED } as Partial<AppConfig>),
      noopLogger,
      clock,
      {
        chatSender: okChat,
        teamChatSender: okChat,
        sheetSender: new CapturingSheet(),
        heartbeat,
      },
    );

    await loop.runOnce();

    const rejectLogs = noopLogger.warn.mock.calls.filter(
      (c) =>
        (c[0] as { module?: string }).module === 'scheduleGate' &&
        (c[0] as { action?: string }).action === 'reject',
    );
    expect(rejectLogs).toHaveLength(1);
    const meta = rejectLogs[0]![0] as {
      jobKey: string;
      reason: string;
      words: number | null;
      dueDate: string | null;
    };
    expect(meta.reason).toContain('cannot finish'); // the WHY, not just a count
    expect(meta.words).toBe(5000);
    expect(meta.dueDate).toBe(tightDue);
    expect(meta.jobKey.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// auto-yield state machine (Task 6)
// ---------------------------------------------------------------------------

describe('auto-yield', () => {
  /** cfg with yield enabled and safe defaults. */
  const yCfg = (over: Partial<AppConfig> = {}) =>
    cfg({
      XTM_YIELD_ENABLED: true,
      XTM_YIELD_WINDOW_MS: 600_000,
      XTM_YIELD_MAX_MINUTES: 60,
      ...over,
    });

  it('enters YIELDING on a kicked logout: no error escalation, heartbeat ok, paused alert once', async () => {
    fresh();
    const client = new StubClient();
    client.fetchJobSnapshot = async () => {
      throw new SessionYieldError('kicked_by_other');
    };
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, yCfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });
    const ok = await loop.runOnce();
    expect(ok).toBe(true); // a quiet yield is healthy
    expect(heartbeat.fail).not.toHaveBeenCalled();
    expect(heartbeat.ok).toHaveBeenCalledTimes(1);
    // 'xtm_yielding' alert raised exactly once
    const alerts = db
      .prepare(
        "SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key='xtm_yielding'",
      )
      .all();
    expect(alerts.length).toBe(1);
    // meta marks the episode + cooldown
    const meta = new MetaStore(db);
    expect(meta.yieldEpisodeStartedMs).toBeGreaterThan(0);
    expect(meta.yieldUntilMs).toBeGreaterThan(0);
  });

  it('skips the portal read during cooldown but still flushes the outbox', async () => {
    fresh();
    const client = new StubClient();
    const setup = new MetaStore(db);
    setup.setYieldEpisodeStartedMs(clock.nowMs());
    setup.setYieldUntilMs(clock.nowMs() + 600_000); // far future → in cooldown
    let fetched = 0;
    client.fetchJobSnapshot = async (_id, _opts) => {
      fetched++;
      return snap([]);
    };
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    // Seed a pending chat row before the cooldown cycle so we can prove flush ran
    const seedOutbox = new Outbox(db, 10, 6);
    seedOutbox.enqueue('yield_flush_probe', JSON.stringify({ text: 'probe' }), NOW, 'chat');
    const loop = new XtmPollLoop(db, client, yCfg(), noopLogger, clock, {
      chatSender: okChat, // returns 'ok' → row transitions to 'sent'
      heartbeat,
    });
    const ok = await loop.runOnce();
    expect(ok).toBe(true);
    expect(fetched).toBe(0); // never touched the portal
    // The cooldown cycle MUST have flushed: the seeded row should be sent now
    const row = db
      .prepare("SELECT status FROM outbox WHERE event_id = 'yield_flush_probe'")
      .get() as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe('sent'); // proves dispatcher.flush executed during cooldown
    expect(heartbeat.ok).toHaveBeenCalledTimes(1); // heartbeat follows the flush
  });

  it('escalates to yield_stuck + heartbeat.fail once the episode exceeds the cap', async () => {
    fresh();
    const setup = new MetaStore(db);
    setup.setYieldEpisodeStartedMs(clock.nowMs() - 61 * 60_000); // 61 min ago → past cap
    setup.setYieldUntilMs(clock.nowMs() + 600_000); // still in cooldown
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, yCfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });
    const ok = await loop.runOnce();
    expect(ok).toBe(false); // stuck → not healthy
    expect(heartbeat.fail).toHaveBeenCalledTimes(1);
    // yield_stuck critical alert raised
    const stuckAlerts = db
      .prepare(
        "SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key='yield_stuck'",
      )
      .all();
    expect(stuckAlerts.length).toBe(1);
  });

  it('resumes only after RESUME_STABLE_CYCLES consecutive successful reads', async () => {
    fresh();
    const setup = new MetaStore(db);
    setup.setYieldEpisodeStartedMs(clock.nowMs() - 5_000); // episode active, not stuck
    setup.setYieldUntilMs(0); // cooldown already elapsed → probe allowed
    setup.setLastAuthSuccessMs(clock.nowMs() - 5_000);
    const client = new StubClient();
    client.fetchJobSnapshot = async () => snap([]);
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, yCfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });
    await loop.runOnce(); // probe #1: still tentative, episode not cleared yet
    expect(new MetaStore(db).yieldEpisodeStartedMs).toBeGreaterThan(0);
    await loop.runOnce(); // probe #2: stable → resume
    expect(new MetaStore(db).yieldEpisodeStartedMs).toBe(0);
    expect(new MetaStore(db).yieldUntilMs).toBe(0);
  });

  it('is a no-op when XTM_YIELD_ENABLED=false: no decideRelogin passed to client', async () => {
    fresh();
    const client = new StubClient();
    let receivedOpts: { decideRelogin?: (kind: LogoutKind) => boolean } | undefined =
      'NOT_SET' as never;
    client.fetchJobSnapshot = async (_id, opts) => {
      receivedOpts = opts;
      return snap([]);
    };
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg({ XTM_YIELD_ENABLED: false }), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });
    expect(await loop.runOnce()).toBe(true);
    expect(receivedOpts).toBeUndefined(); // no policy passed when disabled
  });

  // F4: a probe that SUCCEEDS during a stuck episode must still page on-call.
  it('F4: a successful probe during a stuck episode still pages (heartbeat.fail), no early resume', async () => {
    fresh();
    const setup = new MetaStore(db);
    setup.setYieldEpisodeStartedMs(clock.nowMs() - 61 * 60_000); // 61 min ago → past the 60-min cap
    setup.setYieldUntilMs(0); // cooldown elapsed → probe allowed
    setup.setLastAuthSuccessMs(clock.nowMs() - 5_000);
    const client = new StubClient();
    client.fetchJobSnapshot = async () => snap([]); // the probe read SUCCEEDS
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, yCfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });

    const ok = await loop.runOnce();

    expect(ok).toBe(false); // stuck → unhealthy even though the read succeeded (console consistency)
    expect(heartbeat.fail).toHaveBeenCalledTimes(1);
    expect(heartbeat.ok).not.toHaveBeenCalled();
    // a single clean probe must NOT resume (needs RESUME_STABLE_CYCLES) → episode still open
    expect(new MetaStore(db).yieldEpisodeStartedMs).toBeGreaterThan(0);
  });

  // F5: a yield that crosses the cap mid-probe must raise a yield_stuck card (not just fail silently).
  it('F5: a yield crossing the cap mid-probe raises yield_stuck + fails heartbeat', async () => {
    fresh();
    const setup = new MetaStore(db);
    // Episode started 59m50s ago — NOT stuck at gate time, so the gate raises NO yield_stuck.
    setup.setYieldEpisodeStartedMs(clock.nowMs() - (60 * 60_000 - 10_000));
    setup.setYieldUntilMs(0); // not in cooldown → probe
    setup.setLastAuthSuccessMs(clock.nowMs() - 5_000);
    const client = new StubClient();
    client.fetchJobSnapshot = async () => {
      now += 60_000; // the probe fetch takes long enough to cross the 60-min cap
      throw new SessionYieldError('kicked_by_other');
    };
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, yCfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });

    const ok = await loop.runOnce();

    expect(ok).toBe(false); // re-yield while stuck is unhealthy
    expect(heartbeat.fail).toHaveBeenCalledTimes(1);
    expect(heartbeat.ok).not.toHaveBeenCalled();
    // handleYield (not the gate) must have raised the yield_stuck card for the crossed cap
    const stuck = db
      .prepare(
        "SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key='yield_stuck'",
      )
      .all();
    expect(stuck.length).toBe(1);
  });

  // F3: an unexpected throw inside handleYield must be caught — never escape runOnce.
  it('F3: an unexpected throw inside handleYield is caught (heartbeat.fail, runOnce does not reject)', async () => {
    fresh();
    const client = new StubClient();
    client.fetchJobSnapshot = async () => {
      throw new SessionYieldError('kicked_by_other');
    };
    // heartbeat.ok throws on the yield happy-path; the F3 catch must convert it to fail + false.
    const heartbeat = {
      ok: vi.fn(async () => {
        throw new Error('healthcheck endpoint unreachable');
      }),
      fail: vi.fn(async () => {}),
    };
    const loop = new XtmPollLoop(db, client, yCfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });

    const ok = await loop.runOnce(); // must NOT throw out of runOnce
    expect(ok).toBe(false); // handler error → unhealthy
    expect(heartbeat.fail).toHaveBeenCalled(); // F3 fail path ran
  });

  // F6: an errored cycle mid-probe must reset the resume counter (no early resume).
  it('F6: an errored cycle resets the resume counter so resume needs fresh clean cycles', async () => {
    fresh();
    const setup = new MetaStore(db);
    setup.setYieldEpisodeStartedMs(clock.nowMs() - 5_000); // active, not stuck
    setup.setYieldUntilMs(0); // cooldown elapsed → probe allowed
    setup.setLastAuthSuccessMs(clock.nowMs() - 5_000);
    const client = new StubClient(); // default empty snapshot, no fetchError
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, yCfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });

    await loop.runOnce(); // clean probe #1 → resume counter = 1
    expect(new MetaStore(db).yieldEpisodeStartedMs).toBeGreaterThan(0);

    client.fetchError = new Error('network blip'); // errored cycle → F6 resets counter to 0
    await loop.runOnce();
    client.fetchError = undefined;

    await loop.runOnce(); // one clean probe → counter back to 1 only (NOT yet 2) → still paused
    expect(new MetaStore(db).yieldEpisodeStartedMs).toBeGreaterThan(0);

    await loop.runOnce(); // second clean probe → counter = 2 → resume
    expect(new MetaStore(db).yieldEpisodeStartedMs).toBe(0);
  });

  // F11: a yield must clear the login-failure counter so a post-yield failure does not lock out early.
  it('F11: a yield resets loginFailures so a post-yield login failure does not lock out early', async () => {
    fresh();
    const client = new StubClient();
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, yCfg({ LOGIN_MAX_RETRY: 2 }), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });

    client.fetchError = new LoginFailedError('bad creds'); // login failure #1 (1 < 2 → no lockout)
    await loop.runOnce();

    client.fetchError = undefined;
    client.fetchJobSnapshot = async () => {
      throw new SessionYieldError('kicked_by_other'); // yield → F11 must reset the counter to 0
    };
    await loop.runOnce();

    now += 600_001; // elapse the cooldown so the next cycle actually probes
    client.fetchJobSnapshot = async () => {
      throw new LoginFailedError('bad creds again'); // post-yield failure → counts as #1, not #2
    };
    await loop.runOnce();

    // With F11 the counter restarted at 0 → only failure #1 → NO lockout alert raised.
    const lockout = db
      .prepare(
        "SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key='login_failed'",
      )
      .all();
    expect(lockout.length).toBe(0);
  });

  // F12: last_auth_success_ms is only read by yield logic — do not write it when yield is off.
  it('F12: does NOT persist last_auth_success_ms when yield is disabled', async () => {
    fresh();
    const client = new StubClient();
    client.snapshot = snap([xraw()]);
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg({ XTM_YIELD_ENABLED: false }), noopLogger, clock, {
      chatSender: okChat,
      sheetSender: new CapturingSheet(),
      heartbeat,
    });

    await loop.runOnce();
    expect(new MetaStore(db).lastAuthSuccessMs).toBe(0); // never written when disabled
  });

  it('F12: DOES persist last_auth_success_ms when yield is enabled', async () => {
    fresh();
    const client = new StubClient();
    client.snapshot = snap([xraw()]);
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, yCfg(), noopLogger, clock, {
      chatSender: okChat,
      sheetSender: new CapturingSheet(),
      heartbeat,
    });

    await loop.runOnce();
    expect(new MetaStore(db).lastAuthSuccessMs).toBeGreaterThan(0); // written when enabled (yield reads it)
  });
});
