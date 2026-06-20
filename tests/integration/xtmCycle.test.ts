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
    await cycle.run(snap([xraw()], 'c2')); // still visible → no new event, no re-accept
    expect(acc.calls).toHaveLength(1); // accept invoked only once
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

function outboxPayloads(
  channel: 'chat' | 'sheets',
): Array<{ row?: { status: string }; text?: string }> {
  return (
    db.prepare('SELECT payload_json FROM outbox WHERE channel = ?').all(channel) as {
      payload_json: string;
    }[]
  ).map((r) => JSON.parse(r.payload_json) as { row?: { status: string }; text?: string });
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
    expect(outboxPayloads('chat').some((c) => c.text?.includes('✅'))).toBe(true);
  });

  it('enqueues a Skipped sheets row + a 🆕 chat for a non-Malay job', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    await new XtmPollCycle(db, cfg(), new StubAcceptor()).run(snap([xraw({ targetLang: 'Thai' })]));
    expect(outboxPayloads('sheets')[0]?.row?.status).toBe('Skipped');
    expect(outboxPayloads('chat').some((c) => c.text?.includes('🆕'))).toBe(true);
  });

  it('posts ONE cold-start summary (not per-job chat) during baseline, logs all to Sheets', async () => {
    fresh();
    await new XtmPollCycle(db, cfg(), new StubAcceptor()).run(
      snap([xraw({ fileName: 'a.docx' }), xraw({ fileName: 'b.docx', targetLang: 'Thai' })]),
    );
    const chat = outboxPayloads('chat');
    expect(chat).toHaveLength(1);
    expect(chat[0]?.text).toContain('📋');
    expect(outboxPayloads('sheets')).toHaveLength(2);
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
    expect(outboxPayloads('chat').some((c) => c.text?.includes('🔁'))).toBe(true);
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
