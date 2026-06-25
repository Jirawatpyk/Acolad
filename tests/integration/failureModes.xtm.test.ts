import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { XtmPollLoop } from '../../src/runtime/xtmPollLoop.js';
import type { XtmPortalClient } from '../../src/portal/xtmClient.js';
import type { AppConfig } from '../../src/config/index.js';
import type { XtmRawJob, XtmJobSnapshot } from '../../src/detection/types.js';
import type { ChatSender, SendOutcome } from '../../src/reporting/googleChat.js';
import type { SheetSender, SheetRow } from '../../src/reporting/sheets.js';
import { LoginFailedError } from '../../src/portal/errors.js';

/**
 * Consolidated failure-mode suite (Constitution II). Maps the six T049 modes to
 * integrated loop-level coverage here, plus the dedicated tests that exercise the
 * client/accept-path modes (the loop is the wrong layer for those):
 *
 *   1. login fail (shared acct) → lockout ............. here ("login lockout")
 *   2. session expiry mid-READ → silent re-login ...... xtmClient.test (fetchJobSnapshot recovery).
 *        mid-ACCEPT expiry is deliberately NOT silently re-logged-in (it would risk a double-claim);
 *        it surfaces and is recovered as accept_failed by the stranded-'accepting' path (mode 6).
 *   3. accept timeout / menu-not-found ............... accept.test ("accept timeout" — acceptEligibleTasks)
 *   4. malformed rows quarantine ..................... here ("malformed") + xtmInbox.test
 *   5. Sheets quota/auth ............................. here ("Sheets outage") + sheetsOutbox.test
 *   6. restart mid-accept (re-read, no double-click) . xtmCycle.test (stranded-'accepting' recovery)
 *
 * The portal-down window (transient errors ≥ 10 min) is also asserted here.
 */
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
const snap = (jobs: XtmRawJob[], malformed: unknown[] = []): XtmJobSnapshot => ({
  jobs,
  malformed,
  capturedAt: NOW,
  pollCycleId: 'c1',
  emptyListConfirmed: jobs.length === 0 && malformed.length === 0,
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
class FlakySheet implements SheetSender {
  outcome: SendOutcome = 'transient';
  async send(_row: SheetRow): Promise<SendOutcome> {
    return this.outcome;
  }
}
let now = Date.parse(NOW);
const clock = { nowMs: () => now, nowIso: () => new Date(now).toISOString() };

let db: DB;
const dirs: string[] = [];
function fresh(): DB {
  const d = mkdtempSync(join(tmpdir(), 'acolad-fm-'));
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

describe('XTM failure modes (integrated, Constitution II/IV)', () => {
  it('a Sheets outage does not block detection — the row queues and is not lost', async () => {
    fresh();
    const client = new StubClient();
    client.snapshot = snap([xraw()]);
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      sheetSender: new FlakySheet(), // Sheets API down (transient)
      heartbeat,
    });
    expect(await loop.runOnce()).toBe(true); // detection succeeded despite Sheets down
    expect(heartbeat.ok).toHaveBeenCalled(); // not stuck (transient, not dead)
    const pendingSheets = db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel='sheets' AND status='pending'")
      .get() as { n: number };
    expect(pendingSheets.n).toBeGreaterThanOrEqual(1); // queued for retry, never lost
  });

  it('malformed rows raise a layout_changed alert (fail loud, Constitution VI)', async () => {
    fresh();
    const client = new StubClient();
    client.snapshot = snap([xraw()], [{ junk: true }]); // one row failed to parse
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });
    await loop.runOnce();
    const alerts = db
      .prepare(
        "SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key='layout_changed'",
      )
      .all();
    expect(alerts.length).toBe(1);
  });

  it('does not flap recovered↔alert while a row stays malformed across cycles (review #6)', async () => {
    fresh();
    const client = new StubClient();
    client.snapshot = snap([xraw()], [{ junk: true }]); // persistently malformed
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const okSheet: SheetSender = {
      async send() {
        return 'ok';
      },
    };
    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      sheetSender: okSheet,
      heartbeat,
    });
    await loop.runOnce(); // raise layout_changed
    await loop.runOnce(); // still malformed — must NOT resolve+re-raise
    const recovered = db
      .prepare(
        "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_recovered' AND dedup_key LIKE 'layout_changed%'",
      )
      .get() as { n: number };
    expect(recovered.n).toBe(0); // no spurious layout SYSTEM_RECOVERED while still broken
  });

  it('persistent portal errors raise portal_down after the 10-minute window', async () => {
    fresh();
    const client = new StubClient();
    client.fetchError = new Error('ECONNRESET');
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg(), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });
    await loop.runOnce(); // first error → starts the down window
    now += 11 * 60_000; // 11 minutes later, still failing
    await loop.runOnce();
    const alerts = db
      .prepare(
        "SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key='portal_down'",
      )
      .all();
    expect(alerts.length).toBe(1);
    expect(heartbeat.fail).toHaveBeenCalled();
  });

  it('repeated login failures (shared acct) lock out and raise login_failed (FR-021)', async () => {
    fresh();
    const client = new StubClient();
    client.fetchError = new LoginFailedError('rejected'); // shared account password churn
    const heartbeat = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
    const loop = new XtmPollLoop(db, client, cfg({ LOGIN_MAX_RETRY: 3 }), noopLogger, clock, {
      chatSender: okChat,
      heartbeat,
    });
    expect(await loop.runOnce()).toBe(false); // attempt 1
    expect(await loop.runOnce()).toBe(false); // attempt 2
    expect(await loop.runOnce()).toBe(false); // attempt 3 → lockout + alert
    const alerts = db
      .prepare(
        "SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key='login_failed'",
      )
      .all();
    expect(alerts.length).toBe(1);
    // Next cycle is short-circuited by the lockout — no fetch attempted.
    client.fetchJobSnapshot = vi.fn(async () => snap([])); // would succeed, but lockout blocks it
    expect(await loop.runOnce()).toBe(false);
    expect(client.fetchJobSnapshot).not.toHaveBeenCalled();
  });

  // Mode 2 (session expiry mid-read → silent re-login, NO alert) is verified where
  // the recovery actually lives — PlaywrightXtmClient.fetchJobSnapshot — in
  // tests/unit/xtmClient.test.ts. The loop is the wrong layer: it has no
  // SessionExpiredError handling, so a leaked expiry would be a generic transient.
});
