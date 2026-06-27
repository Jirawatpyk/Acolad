import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { XtmPollCycle } from '../../src/runtime/xtmPollCycle.js';
import { XtmJobStore } from '../../src/state/xtmJobStore.js';
import { MetaStore } from '../../src/state/meta.js';
import { computeXtmJobKey } from '../../src/detection/jobKey.js';
import type { AppConfig } from '../../src/config/index.js';
import type { XtmRawJob, XtmJobSnapshot, XtmJobState } from '../../src/detection/types.js';
import type { AcceptTarget, AcceptResult } from '../../src/portal/errors.js';

const NOW = '2026-06-19T10:00:00.000Z';

const cfg = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    ACCEPT_ENABLED: true,
    ACCEPT_LANGUAGES: ['Malay (Malaysia)'],
    ACCEPT_MAX_WORDS: 0,
    ACCEPT_MAX_PER_CYCLE: 0,
    OUTBOX_RETRY_CAP: 10,
    OUTBOX_DEAD_AFTER_HOURS: 6,
    XTM_ACOLAD_OFFERS_URL: 'https://xtm.example/inbox',
    ...over,
  }) as AppConfig;

class StubAcceptor {
  calls: AcceptTarget[][] = [];
  outcome: AcceptResult['outcome'] = 'accepted';
  async acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]> {
    this.calls.push(targets);
    return targets.map((t): AcceptResult => {
      if (this.outcome === 'accepted') return { jobKey: t.jobKey, outcome: 'accepted', at: NOW };
      if (this.outcome === 'missing') return { jobKey: t.jobKey, outcome: 'missing' };
      return { jobKey: t.jobKey, outcome: 'failed', reason: 'unconfirmed' };
    });
  }
}

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

const snap = (jobs: XtmRawJob[], cycle = 'c1'): XtmJobSnapshot => ({
  jobs,
  malformed: [],
  capturedAt: NOW,
  pollCycleId: cycle,
  emptyListConfirmed: jobs.length === 0,
});

let db: DB;
const dirs: string[] = [];
function fresh(): DB {
  const d = mkdtempSync(join(tmpdir(), 'acolad-cycle-'));
  dirs.push(d);
  db = openDatabase(d, NOW).db;
  return db;
}
const only = (): XtmJobState => [...new XtmJobStore(db).loadAll().values()][0]!;
afterEach(() => {
  db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('XtmPollCycle (US1 — detect, accept, record)', () => {
  it('accepts a new Malay job and records accepted state (FR-006)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    expect(acc.calls[0]).toHaveLength(1);
    const s = only();
    expect(s.eligible).toBe(true);
    expect(s.acceptStatus).toBe('accepted');
    expect(s.lifecycleStatus).toBe('accepted');
  });

  it('records the accept latency split from detection (T050 / V16 + V16b)', async () => {
    fresh();
    // capturedAt = NOW (detection). clicked +2s, FR-024 outcome confirmed +8s.
    const clickedAt = new Date(Date.parse(NOW) + 2_000).toISOString();
    const confirmedAt = new Date(Date.parse(NOW) + 8_000).toISOString();
    const acc = {
      async acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]> {
        return targets.map(
          (t) =>
            ({ jobKey: t.jobKey, outcome: 'accepted', at: confirmedAt, clickedAt }) as AcceptResult,
        );
      },
    };
    const summary = await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    expect(summary.acceptLatencies).toHaveLength(1);
    expect(summary.acceptLatencies[0]?.clickLatencyMs).toBe(2_000); // ≤ 5 s budget (V16)
    expect(summary.acceptLatencies[0]?.outcomeLatencyMs).toBe(8_000); // ≤ 60 s budget (V16b)
  });

  it('drops the latency sample (no NaN) when an accept timestamp is unparseable (T050 guard)', async () => {
    fresh();
    const acc = {
      async acceptEligibleTasks(t: AcceptTarget[]): Promise<AcceptResult[]> {
        return t.map(
          (x) => ({ jobKey: x.jobKey, outcome: 'accepted', at: 'not-a-date' }) as AcceptResult,
        );
      },
    };
    const summary = await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    expect(only().lifecycleStatus).toBe('accepted'); // accept still recorded
    expect(summary.acceptLatencies).toHaveLength(0); // but no NaN sample emitted
  });

  it('collects reconEligible for an eligible job when ACCEPT_RECON is on + accept off', async () => {
    fresh();
    const summary = await new XtmPollCycle(
      db,
      cfg({ ACCEPT_ENABLED: false, ACCEPT_RECON: true }),
      new StubAcceptor(),
    ).run(snap([xraw()]));
    expect(summary.reconEligible).toHaveLength(1);
    expect(summary.reconEligible[0]?.targetLang).toBe('Malay (Malaysia)');
    expect(summary.eligibleDisabled).toBe(1); // detected only — never accepted
  });

  it('collects no reconEligible when ACCEPT_RECON is off', async () => {
    fresh();
    const summary = await new XtmPollCycle(
      db,
      cfg({ ACCEPT_ENABLED: false }),
      new StubAcceptor(),
    ).run(snap([xraw()]));
    expect(summary.reconEligible).toHaveLength(0);
  });

  it('skips a non-Malay job and never calls accept for it (FR-007)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw({ targetLang: 'Thai' })]));
    expect(acc.calls.flat()).toHaveLength(0);
    const s = only();
    expect(s.eligible).toBe(false);
    expect(s.lifecycleStatus).toBe('skipped');
  });

  it('does not accept when ACCEPT_ENABLED is off, but still records the job (FR-012)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: false }), acc).run(snap([xraw()]));
    expect(acc.calls.flat()).toHaveLength(0);
    const s = only();
    expect(s.eligible).toBe(true);
    expect(s.acceptStatus).toBe('none');
    expect(s.lifecycleStatus).toBe('new'); // detected, eligible, but not accepted
  });

  it('skips an eligible job that exceeds the max-words cap (FR-025)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, cfg({ ACCEPT_MAX_WORDS: 50 }), acc).run(
      snap([xraw({ words: 100 })]),
    );
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only().lifecycleStatus).toBe('skipped');
  });

  it('honors the per-cycle accept cap through the orchestrator (FR-025)', async () => {
    fresh();
    const acc = new StubAcceptor();
    const summary = await new XtmPollCycle(db, cfg({ ACCEPT_MAX_PER_CYCLE: 2 }), acc).run(
      snap([
        xraw({ fileName: 'a.docx' }),
        xraw({ fileName: 'b.docx' }),
        xraw({ fileName: 'c.docx' }),
      ]),
    );
    expect(summary.accepted).toBe(2);
    expect(summary.skipped).toBe(1); // third eligible job over the cap
    expect(acc.calls[0]).toHaveLength(2); // only two claimed/attempted this cycle
  });

  it('writes the skip reason to the Sheet note for a skipped job (S4)', async () => {
    fresh();
    await new XtmPollCycle(db, cfg(), new StubAcceptor()).run(snap([xraw({ targetLang: 'Thai' })]));
    const rows = db.prepare("SELECT payload_json FROM outbox WHERE channel='sheets'").all() as {
      payload_json: string;
    }[];
    const note = (JSON.parse(rows[0]!.payload_json) as { row: { note: string | null } }).row.note;
    expect(note).toContain('not eligible'); // the reason is no longer silently dropped
  });

  const lastSheetNote = (): string | null => {
    const rows = db.prepare("SELECT payload_json FROM outbox WHERE channel='sheets'").all() as {
      payload_json: string;
    }[];
    return (JSON.parse(rows.at(-1)!.payload_json) as { row: { note: string | null } }).row.note;
  };

  it('records the failure reason on the Sheet note for a failed accept', async () => {
    fresh();
    const acc = new StubAcceptor();
    acc.outcome = 'failed';
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    expect(lastSheetNote()).toBe('unconfirmed'); // StubAcceptor's failed reason, not silently dropped
  });

  it('records snatched on the Sheet note for a missing accept outcome', async () => {
    fresh();
    const acc = new StubAcceptor();
    acc.outcome = 'missing';
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    expect(lastSheetNote()).toBe('snatched');
  });

  it('keeps accept_failed (not missing) when a stranded-accepting job also disappears', async () => {
    fresh();
    const cycle = new XtmPollCycle(db, cfg(), new StubAcceptor());
    await cycle.run(snap([xraw()], 'c1')); // accepted
    // Simulate a crash mid-accept: accept_status stuck 'accepting' (lifecycle stays
    // a valid value — 'accepting' is an accept_status, not a lifecycle_status).
    db.prepare("UPDATE jobs SET accept_status='accepting' WHERE file_name='a.docx'").run();
    await cycle.run(snap([], 'c2')); // job gone from Active this cycle
    const s = only();
    expect(s.acceptStatus).toBe('failed');
    expect(s.lifecycleStatus).toBe('accept_failed'); // recovered, NOT relabeled the softer 'missing'
  });

  it('records a snatched outcome as missing (FR-010)', async () => {
    fresh();
    const acc = new StubAcceptor();
    acc.outcome = 'missing';
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    const s = only();
    expect(s.lifecycleStatus).toBe('missing');
    expect(s.acceptStatus).toBe('none');
  });

  it('records an unconfirmed accept as accept_failed (FR-011)', async () => {
    fresh();
    const acc = new StubAcceptor();
    acc.outcome = 'failed';
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    const s = only();
    expect(s.lifecycleStatus).toBe('accept_failed');
    expect(s.acceptStatus).toBe('failed');
  });

  it('raises a system alert (not silent) when an accept fails (T032/Constitution V)', async () => {
    fresh();
    const acc = new StubAcceptor();
    acc.outcome = 'failed';
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    const alerts = db
      .prepare(
        "SELECT dedup_key FROM system_events WHERE event_type='system_alert' AND dedup_key LIKE 'accept_failed:%'",
      )
      .all();
    expect(alerts).toHaveLength(1);
    const out = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel='chat'").get() as {
      n: number;
    };
    expect(out.n).toBeGreaterThanOrEqual(1);
  });

  it('never accepts the same job twice across cycles (FR-008/SC-005)', async () => {
    fresh();
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, cfg(), acc);
    await cycle.run(snap([xraw()], 'c1')); // first_seen → accept
    await cycle.run(snap([xraw()], 'c2')); // still visible → already 'accepted', no re-accept
    expect(acc.calls).toHaveLength(1); // accept invoked only once
  });

  it('accepts a still-visible eligible job that was never accepted (enabled mid-life) — robustness', async () => {
    fresh();
    const acc = new StubAcceptor();
    // c1: accept OFF → detected + eligible, but accept_status stays 'none' (not grabbed).
    await new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: false }), acc).run(snap([xraw()], 'c1'));
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only().acceptStatus).toBe('none');
    // c2: accept ON, SAME job still visible (NO fresh first_seen event) → must be grabbed
    // now, not left sitting (the snatch model must not depend on accept being on at the
    // exact moment the job first appeared).
    await new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: true }), acc).run(snap([xraw()], 'c2'));
    expect(acc.calls.flat()).toHaveLength(1); // attempted despite no new appearance event
    expect(only().lifecycleStatus).toBe('accepted');
  });

  it('does NOT re-attempt a job already failed/accepted via the no-event pass', async () => {
    fresh();
    const acc = new StubAcceptor();
    acc.outcome = 'failed';
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()], 'c1')); // first_seen → failed
    expect(only().acceptStatus).toBe('failed');
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()], 'c2')); // still visible, but 'failed'
    expect(acc.calls.flat()).toHaveLength(1); // not retried — only 'none' jobs are picked up
  });

  it('cold start accepts a still-acceptable pre-existing Malay job and marks baseline (FR-005)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    expect(acc.calls.flat()).toHaveLength(1);
    expect(only().lifecycleStatus).toBe('accepted');
    expect(new MetaStore(db).baselineDone).toBe(true);
  });

  it('marks a never-accepted job that disappears from Active as missing (FR-014)', async () => {
    fresh();
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: false }), acc);
    await cycle.run(snap([xraw()], 'c1')); // seen
    await cycle.run(snap([], 'c2')); // absent once (flicker)
    await cycle.run(snap([], 'c3')); // absent twice → missing
    expect(only().lifecycleStatus).toBe('missing');
  });
});

function outboxPayloads(channel: 'chat' | 'sheets'): Array<{
  row?: { status: string };
  cardsV2?: Array<{ cardId: string; card: { header: { title: string } } }>;
}> {
  return (
    db.prepare('SELECT payload_json FROM outbox WHERE channel = ?').all(channel) as {
      payload_json: string;
    }[]
  ).map(
    (r) =>
      JSON.parse(r.payload_json) as {
        row?: { status: string };
        cardsV2?: Array<{ cardId: string; card: { header: { title: string } } }>;
      },
  );
}

/** Returns true if any chat payload card header title contains the given substring. */
function chatHasTitle(sub: string): boolean {
  return outboxPayloads('chat').some((c) => c.cardsV2?.[0]?.card.header.title.includes(sub));
}

describe('XtmPollCycle Closed/Removed (FR-014, T042)', () => {
  async function acceptThenDisappear(closedKeys: Set<string>): Promise<void> {
    const reader = {
      async readClosedKeys(): Promise<Set<string>> {
        return closedKeys;
      },
    };
    const cycle = new XtmPollCycle(db, cfg(), new StubAcceptor(), reader);
    await cycle.run(snap([xraw()], 'c1')); // accept
    await cycle.run(snap([], 'c2')); // absent once (flicker)
    await cycle.run(snap([], 'c3')); // absent twice → missing → Closed check
  }

  it('an accepted job found in the Closed tab becomes Closed', async () => {
    fresh();
    await acceptThenDisappear(new Set([computeXtmJobKey(xraw())]));
    expect(only().lifecycleStatus).toBe('closed');
  });

  it('an accepted job NOT in the Closed tab becomes Removed (cancelled/reassigned)', async () => {
    fresh();
    await acceptThenDisappear(new Set<string>());
    expect(only().lifecycleStatus).toBe('removed');
  });
});

describe('XtmPollCycle enqueue (US2 Sheets + US3 Chat, T041/T048)', () => {
  it('enqueues an Accepted sheets row + a ✅ chat for an accepted Malay job', async () => {
    fresh();
    new MetaStore(db).markBaselineDone(); // past baseline → per-job chat fires
    await new XtmPollCycle(db, cfg(), new StubAcceptor()).run(snap([xraw()]));
    const sheets = outboxPayloads('sheets');
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.row?.status).toBe('Accepted');
    expect(chatHasTitle('✅')).toBe(true);
  });

  it('enqueues a Skipped sheets row + a 🆕 chat for a non-Malay job', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    await new XtmPollCycle(db, cfg(), new StubAcceptor()).run(snap([xraw({ targetLang: 'Thai' })]));
    expect(outboxPayloads('sheets')[0]?.row?.status).toBe('Skipped');
    expect(chatHasTitle('🆕')).toBe(true);
  });

  it('posts ONE cold-start summary (not per-job chat) during baseline, logs all to Sheets', async () => {
    fresh();
    await new XtmPollCycle(db, cfg(), new StubAcceptor()).run(
      snap([xraw({ fileName: 'a.docx' }), xraw({ fileName: 'b.docx', targetLang: 'Thai' })]),
    );
    const chat = outboxPayloads('chat');
    expect(chat).toHaveLength(1);
    expect(chat[0]?.cardsV2?.[0]?.card.header.title).toContain('📋');
    expect(outboxPayloads('sheets')).toHaveLength(2);
  });

  it('reports a grabbed still-visible job that had no fresh event — Accepted sheet + ✅ chat', async () => {
    fresh();
    new MetaStore(db).markBaselineDone(); // past baseline → per-job chat fires
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: false }), acc).run(snap([xraw()], 'c1'));
    await new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: true }), acc).run(snap([xraw()], 'c2'));
    expect(outboxPayloads('sheets').at(-1)?.row?.status).toBe('Accepted'); // not silently accepted
    expect(chatHasTitle('✅')).toBe(true);
  });

  it('a no-event robustness accept that FAILS raises an alert + ⚠️ Accept Failed chat (never silent)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: false }), acc).run(snap([xraw()], 'c1')); // seat as 'none'
    acc.outcome = 'failed';
    await new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: true }), acc).run(snap([xraw()], 'c2')); // robustness attempt → failed
    const key = computeXtmJobKey(xraw());
    const alerts = db
      .prepare("SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key = ?")
      .all(`accept_failed:${key}`);
    expect(alerts.length).toBeGreaterThanOrEqual(1); // failed accept with no appearance event is NOT silent
    expect(outboxPayloads('sheets').at(-1)?.row?.status).toBe('Accept failed');
    expect(chatHasTitle('Accept Failed')).toBe(true); // distinct from 'Job Snatched' (both carry ⚠️)
  });

  it('enqueues a New sheets row when auto-accept is disabled', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    await new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: false }), new StubAcceptor()).run(
      snap([xraw()]),
    );
    expect(outboxPayloads('sheets')[0]?.row?.status).toBe('New');
  });

  it('announces a relisted job with 🔁, not 🆕 (review #7)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const cycle = new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: false }), new StubAcceptor());
    await cycle.run(snap([xraw({ targetLang: 'Thai' })], 'c1')); // 🆕
    await cycle.run(snap([], 'c2')); // absent (flicker)
    await cycle.run(snap([], 'c3')); // absent twice → missing
    await cycle.run(snap([xraw({ targetLang: 'Thai' })], 'c4')); // returns → relisted
    expect(chatHasTitle('🔁')).toBe(true);
  });

  it('accepted job enqueues BOTH a chat row AND a team row with the same card (Task 9)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone(); // past baseline → per-job chat fires
    await new XtmPollCycle(db, cfg(), new StubAcceptor()).run(snap([xraw()]));

    const rows = db
      .prepare(
        "SELECT event_id, channel, payload_json FROM outbox WHERE channel IN ('chat','team')",
      )
      .all() as { event_id: string; channel: string; payload_json: string }[];

    const chatRow = rows.find((r) => r.channel === 'chat');
    const teamRow = rows.find((r) => r.channel === 'team');

    expect(chatRow, 'chat row must exist for accepted job').toBeDefined();
    expect(teamRow, 'team row must exist for accepted job').toBeDefined();

    // event_ids must be distinct (outbox dedup is (event_id, channel) unique)
    expect(chatRow!.event_id).not.toBe(teamRow!.event_id);

    // both carry the ✅ accepted card — payloads are byte-equal
    expect(teamRow!.payload_json).toBe(chatRow!.payload_json);

    // channels prefixed correctly
    expect(chatRow!.event_id).toMatch(/^chat:/);
    expect(teamRow!.event_id).toMatch(/^team:/);
  });

  it('non-accepted outcomes produce NO team row (only chat)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    // new job with accept disabled → lifecycleStatus = 'new', no accept outcome
    await new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: false }), new StubAcceptor()).run(
      snap([xraw()]),
    );
    const teamCount = (
      db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel = 'team'").get() as { n: number }
    ).n;
    expect(teamCount).toBe(0);
  });

  it('accept_failed outcome produces NO team row', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const acc = new StubAcceptor();
    acc.outcome = 'failed';
    await new XtmPollCycle(db, cfg(), acc).run(snap([xraw()]));
    const teamCount = (
      db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE channel = 'team'").get() as { n: number }
    ).n;
    expect(teamCount).toBe(0);
  });
});

describe('XtmPollCycle crash recovery (review #1/#2)', () => {
  it('recovers a job stranded in accepting as accept_failed + alert', async () => {
    fresh();
    const key = computeXtmJobKey(xraw());
    const cycle = new XtmPollCycle(db, cfg(), new StubAcceptor());
    await cycle.run(snap([xraw()], 'c1')); // accepted
    // Simulate a prior crash after the claim but before recording: stuck in 'accepting'.
    db.prepare("UPDATE jobs SET accept_status='accepting' WHERE job_key = ?").run(key);
    await cycle.run(snap([xraw()], 'c2')); // start-of-cycle reconciliation
    const s = only();
    expect(s.acceptStatus).toBe('failed');
    expect(s.lifecycleStatus).toBe('accept_failed');
    const alerts = db
      .prepare("SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key = ?")
      .all(`accept_failed:${key}`);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Task 12: accept-schedule gate helpers ---------------------------------
// Derived schedule fields (Task 9 computes these in loadConfig; the test cfg() is a
// loose cast, so we supply them explicitly here). 09:00–18:00 Mon–Fri, cap 1000,
// throughput derived = 1000 / 9h ≈ 111.1 words/h.
const SCHED_FIELDS = {
  ACCEPT_SCHEDULE_ENABLED: true,
  ACCEPT_MAX_WORDS_PER_DAY: 1000,
  hoursStartMin: 9 * 60,
  hoursEndMin: 18 * 60,
  workdays: new Set([1, 2, 3, 4, 5]),
  throughputWordsPerHour: 1000 / 9,
};
const schedCfg = (over: Partial<AppConfig> = {}): AppConfig =>
  cfg({ ...SCHED_FIELDS, ...over } as Partial<AppConfig>);

// TZ-explicit snapshot (capturedAt carries +07:00 — never a TZ-naive local Date, so the
// Bangkok date/weekday is identical under TZ=UTC in CI).
const snapAt = (jobs: XtmRawJob[], capturedAt: string, cycle = 'c1'): XtmJobSnapshot => ({
  jobs,
  malformed: [],
  capturedAt,
  pollCycleId: cycle,
  emptyListConfirmed: jobs.length === 0,
});

describe('XtmPollCycle accept-schedule gate (Task 12 — C1/C4/I1/I3)', () => {
  const MON_10 = '2026-06-22T10:00:00+07:00'; // Bangkok Monday 10:00 (working hours)
  const TODAY = '2026-06-22'; // bangkokDateString(MON_10)
  const dueWed18 = '2026-06-24T18:00:00+07:00'; // Wed 18:00 — far, finishable for small jobs
  const dueMon12 = '2026-06-22T12:00:00+07:00'; // same Monday noon — tight (120 working min)

  const sheetRows = (): Array<{ status: string; note: string | null }> =>
    (
      db.prepare("SELECT payload_json FROM outbox WHERE channel='sheets'").all() as {
        payload_json: string;
      }[]
    ).map(
      (r) => (JSON.parse(r.payload_json) as { row: { status: string; note: string | null } }).row,
    );
  const chatText = (): string => JSON.stringify(outboxPayloads('chat'));

  it('accepts a finishable in-hours Malay job and counts its words in the txn (gate ALLOW + I1)', async () => {
    fresh();
    const acc = new StubAcceptor();
    const summary = await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10),
    );
    expect(acc.calls.flat()).toHaveLength(1); // clicked
    expect(only().lifecycleStatus).toBe('accepted');
    expect(summary.scheduleBlocked).toBe(0);
    expect(new MetaStore(db).acceptedWordsToday(TODAY)).toBe(100); // counter advanced
  });

  it('rejects a too-tight job — Sheet Rejected + reason in Note + Chat; accept untouched; counter 0', async () => {
    fresh();
    new MetaStore(db).markBaselineDone(); // past baseline → per-job chat fires
    const acc = new StubAcceptor();
    const summary = await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10),
    );
    expect(acc.calls.flat()).toHaveLength(0); // never clicked
    const s = only();
    expect(s.lifecycleStatus).toBe('rejected');
    expect(s.acceptStatus).toBe('none'); // re-evaluable next cycle
    expect(summary.scheduleBlocked).toBe(1);
    expect(sheetRows().at(-1)?.status).toBe('Rejected');
    expect(sheetRows().at(-1)?.note).toContain('cannot finish in time'); // reason surfaced
    expect(chatHasTitle('🆕')).toBe(true); // rendered as a new-job card
    expect(chatText()).toContain('Rejected —'); // reason threaded into Chat (I3)
    expect(new MetaStore(db).acceptedWordsToday(TODAY)).toBe(0); // not counted
  });

  it('C1: one infeasible member rejects the WHOLE bulk group (no member left accepted)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt(
        [
          xraw({ fileName: 'g1.docx', projectName: 'GroupA', dueDate: dueWed18, words: 100 }), // finishable alone
          xraw({ fileName: 'g2.docx', projectName: 'GroupA', dueDate: dueMon12, words: 5000 }), // infeasible
        ],
        MON_10,
      ),
    );
    expect(acc.calls.flat()).toHaveLength(0); // group not accepted at all
    const states = [...new XtmJobStore(db).loadAll().values()];
    expect(states).toHaveLength(2);
    expect(states.every((s) => s.lifecycleStatus === 'rejected')).toBe(true);
    expect(states.every((s) => s.acceptStatus === 'none')).toBe(true);
  });

  it('C1: an infeasible Malay job in project A ALSO rejects a finishable Malay job in project B (one language = one bulk group)', async () => {
    fresh();
    const acc = new StubAcceptor();
    // bulkGroupKey is LANGUAGE-ONLY (the acceptor's real claim unit): two projects of the
    // SAME language are ONE bulk group. So an infeasible sibling rejects the whole group —
    // the conservative all-or-nothing that prevents a cross-project owned-but-Rejected leak.
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt(
        [
          xraw({ fileName: 'a.docx', projectName: 'ProjA', dueDate: dueMon12, words: 5000 }), // infeasible
          xraw({ fileName: 'b.docx', projectName: 'ProjB', dueDate: dueWed18, words: 100 }), // finishable alone
        ],
        MON_10,
      ),
    );
    expect(acc.calls.flat()).toHaveLength(0); // acceptor NOT called for EITHER (whole group rejected)
    const byFile = new Map(
      [...new XtmJobStore(db).loadAll().values()].map((s) => [s.fileName, s.lifecycleStatus]),
    );
    expect(byFile.get('a.docx')).toBe('rejected');
    expect(byFile.get('b.docx')).toBe('rejected'); // also rejected — same language, one bulk unit
  });

  it('capacity: two finishable Malay jobs whose COMBINED words exceed the cap are rejected as one group (running total, not per-job)', async () => {
    fresh();
    const acc = new StubAcceptor();
    // cap 1000, no seed. Each job fits alone (600 ≤ 1000) but 600 + 600 = 1200 > 1000. A stale
    // per-job check would accept both; the group-combined (running) total must reject both.
    // Different projects, same language → one bulk group, so the combined total is checked.
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt(
        [
          xraw({ fileName: 'p1.docx', projectName: 'ProjOne', dueDate: dueWed18, words: 600 }),
          xraw({ fileName: 'p2.docx', projectName: 'ProjTwo', dueDate: dueWed18, words: 600 }),
        ],
        MON_10,
      ),
    );
    expect(acc.calls.flat()).toHaveLength(0); // group rejected as a unit (combined > cap)
    const states = [...new XtmJobStore(db).loadAll().values()];
    expect(states.every((s) => s.lifecycleStatus === 'rejected')).toBe(true);
    expect(new MetaStore(db).acceptedWordsToday(TODAY)).toBe(0); // nothing accepted → counter untouched
  });

  it('capacity: a group whose combined words would exceed the remaining cap is rejected', async () => {
    fresh();
    new MetaStore(db).addAcceptedWords(TODAY, 950); // 50 left under the 1000 cap
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10), // 950 + 100 = 1050 > 1000
    );
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only().lifecycleStatus).toBe('rejected');
    expect(new MetaStore(db).acceptedWordsToday(TODAY)).toBe(950); // unchanged
  });

  it('capacity: a group that fits the remaining cap is accepted and increments the counter', async () => {
    fresh();
    new MetaStore(db).addAcceptedWords(TODAY, 950);
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 50 })], MON_10), // 950 + 50 = 1000 ≤ 1000
    );
    expect(acc.calls.flat()).toHaveLength(1);
    expect(only().lifecycleStatus).toBe('accepted');
    expect(new MetaStore(db).acceptedWordsToday(TODAY)).toBe(1000);
  });

  it('does NOT re-announce a still-present rejected job the second cycle (no duplicate Sheet/Chat)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, schedCfg(), acc);
    await cycle.run(snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c1'));
    const sheets1 = sheetRows().length;
    const chat1 = outboxPayloads('chat').length;
    expect(sheets1).toBe(1);
    expect(chat1).toBe(1);
    await cycle.run(snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c2'));
    expect(sheetRows().length).toBe(sheets1); // no new Sheet row
    expect(outboxPayloads('chat').length).toBe(chat1); // no new Chat row
    expect(only().lifecycleStatus).toBe('rejected');
  });

  it('C4: a robustness-pass schedule block is reported (Sheet Rejected), not silently dropped', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    // c1: schedule on but ACCEPT off → detected 'new', accept_status 'none', no future event.
    await new XtmPollCycle(db, schedCfg({ ACCEPT_ENABLED: false }), new StubAcceptor()).run(
      snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c1'),
    );
    expect(only().lifecycleStatus).toBe('new');
    // c2: ACCEPT on, SAME job still present (no fresh event) → robustness pass → schedule BLOCK.
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg({ ACCEPT_ENABLED: true }), acc).run(
      snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c2'),
    );
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only().lifecycleStatus).toBe('rejected');
    expect(sheetRows().at(-1)?.status).toBe('Rejected'); // not silent
  });

  it('ACCEPT_SCHEDULE_ENABLED=0 accepts even with dueDate null (byte-for-byte pre-feature)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, cfg({ ACCEPT_SCHEDULE_ENABLED: false }), acc).run(
      snapAt([xraw({ dueDate: null, words: 100 })], MON_10),
    );
    expect(acc.calls.flat()).toHaveLength(1);
    expect(only().lifecycleStatus).toBe('accepted'); // gate bypassed
  });

  it('rejects a far-deadline job whose span year is uncurated (per-job fail-closed) but does NOT raise holiday_calendar_stale while the current year is curated (F2)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const acc = new StubAcceptor();
    // now (MON_10) is 2026 — a CURATED year. The 2099 deadline is uncurated, so the
    // PER-JOB gate still fail-closes (Rejected + reason). But the SYSTEM alert is now
    // data-driven on the CURRENT year only, so a far-future deadline no longer pages.
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: '2099-06-24T18:00:00+07:00', words: 100 })], MON_10),
    );
    expect(acc.calls.flat()).toHaveLength(0); // never clicked
    expect(only().lifecycleStatus).toBe('rejected'); // per-job fail-closed still blocks
    expect(sheetRows().at(-1)?.note).toContain('holiday calendar not confirmed'); // reason on the Sheet
    const alerts = db
      .prepare(
        "SELECT 1 FROM system_events WHERE event_type='system_alert' AND dedup_key='holiday_calendar_stale'",
      )
      .all();
    expect(alerts).toHaveLength(0); // NOT raised — the current year (2026) is curated
  });

  it('raises holiday_calendar_stale when the CURRENT Bangkok year is uncurated — independent of jobs (F1)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const acc = new StubAcceptor();
    // capturedAt in 2099 (uncurated current year) with NO jobs present → the alert is
    // driven purely by the current year's curation, not by any would-accept job.
    await new XtmPollCycle(db, schedCfg(), acc).run(snapAt([], '2099-06-22T10:00:00+07:00'));
    const active = db
      .prepare(
        "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key='holiday_calendar_stale' AND resolved_at IS NULL",
      )
      .get() as { n: number };
    expect(active.n).toBe(1); // raised even with zero jobs present
  });

  it('does NOT resolve holiday_calendar_stale after the triggering job leaves while the current year stays uncurated (F1 — persistent, no flap)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    // c1: uncurated current year (2099) + a job → raise.
    await cycle.run(
      snapAt(
        [xraw({ dueDate: '2099-08-20T18:00:00+07:00', words: 100 })],
        '2099-06-22T10:00:00+07:00',
        'c1',
      ),
    );
    // c2: same uncurated year, the job is gone → the alert must STAY active (the old
    // per-job logic would flap it to resolved the moment no present job was uncurated).
    await cycle.run(snapAt([], '2099-06-22T10:00:00+07:00', 'c2'));
    const active = db
      .prepare(
        "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key='holiday_calendar_stale' AND resolved_at IS NULL",
      )
      .get() as { n: number };
    expect(active.n).toBe(1); // still active — current year still uncurated
    const recovered = db
      .prepare(
        "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_recovered' AND dedup_key LIKE 'holiday_calendar_stale%'",
      )
      .get() as { n: number };
    expect(recovered.n).toBe(0); // never emitted a spurious recovery
  });

  it('renders a RELISTED schedule-rejected job as the 🔁 relisted card, not 🆕 (F3)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    const tight = { dueDate: dueMon12, words: 5000 }; // infeasible → schedule-rejected
    await cycle.run(snapAt([xraw(tight)], MON_10, 'c1')); // 🆕 rejected
    await cycle.run(snapAt([], MON_10, 'c2')); // absent once (flicker)
    await cycle.run(snapAt([], MON_10, 'c3')); // absent twice → missing
    await cycle.run(snapAt([xraw(tight)], MON_10, 'c4')); // returns → relisted + still rejected
    expect(chatHasTitle('🔁')).toBe(true); // relisted context preserved (not a 🆕 new-job card)
    expect(only().lifecycleStatus).toBe('rejected');
    expect(chatText()).toContain('Rejected —'); // the reject reason is still surfaced
  });

  it('counts accepted words even when the schedule gate is DISABLED (F9 — no transition-day undercount)', async () => {
    fresh();
    const acc = new StubAcceptor();
    // Schedule OFF but a real accept happens → its words MUST still be counted, so that
    // enabling the gate later in the same Bangkok day reads the real running total
    // (otherwise the transition day could over-accept by up to ~1.7× the cap).
    await new XtmPollCycle(db, cfg({ ACCEPT_SCHEDULE_ENABLED: false }), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10),
    );
    expect(only().lifecycleStatus).toBe('accepted'); // gate disabled → accepted as before
    expect(new MetaStore(db).acceptedWordsToday(TODAY)).toBe(100); // counter advanced even while disabled
  });
});

describe('XtmPollCycle field-change re-sync / Bug B (sheet:fieldsync)', () => {
  it('enqueues a sheet:fieldsync event (no chat) when dueDate arrives after first_seen', async () => {
    fresh();
    new MetaStore(db).markBaselineDone(); // past baseline so per-job chat is enabled
    const jobKey = computeXtmJobKey(xraw());
    const cycle = new XtmPollCycle(db, cfg({ ACCEPT_ENABLED: false }), new StubAcceptor());

    // Cycle 1: job appears with dueDate=null (first_seen — Sheet row + Chat emitted).
    await cycle.run(snap([xraw({ dueDate: null })], 'c1'));

    // Cycle 2: same job still visible, XTM now sets dueDate — no new appearance event,
    // but detailsChanges fires. Assert Sheet re-sync enqueued, no Chat for this job.
    await cycle.run(snap([xraw({ dueDate: '2026-07-15' })], 'c2'));

    const sheetEventId = `sheet:fieldsync:${jobKey}|c2`;
    const sheetRows = db
      .prepare('SELECT event_id, payload_json FROM outbox WHERE channel = ?')
      .all('sheets') as { event_id: string; payload_json: string }[];
    const syncRow = sheetRows.find((r) => r.event_id === sheetEventId);
    expect(syncRow, 'sheet:fieldsync event must be enqueued').toBeDefined();

    // The re-synced row must carry the updated dueDate.
    const payload = JSON.parse(syncRow!.payload_json) as { row: { dueDate: string | null } };
    expect(payload.row.dueDate).toBe('2026-07-15');

    // No chat: event for this jobKey in cycle 2 (field-sync is Sheet-only / silent).
    const chatRows = db.prepare('SELECT event_id FROM outbox WHERE channel = ?').all('chat') as {
      event_id: string;
    }[];
    const c2ChatForJob = chatRows.filter(
      (r) => r.event_id.includes(jobKey) && r.event_id.includes('c2'),
    );
    expect(c2ChatForJob).toHaveLength(0);
  });
});
