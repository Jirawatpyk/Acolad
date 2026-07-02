import { describe, it, expect, afterEach, vi } from 'vitest';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { XtmPollCycle } from '../../src/runtime/xtmPollCycle.js';
import { XtmJobStore } from '../../src/state/xtmJobStore.js';
import { Outbox } from '../../src/state/outbox.js';
import { MetaStore } from '../../src/state/meta.js';
import { computeXtmJobKey } from '../../src/detection/jobKey.js';
import { bangkokDateString } from '../../src/schedule/bangkokCalendar.js';
import { LayoutChangedError } from '../../src/portal/errors.js';
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
  fileWwc: 17,
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
const only = (fileName?: string): XtmJobState => {
  const all = [...new XtmJobStore(db).loadAll().values()];
  return (fileName === undefined ? all[0] : all.find((s) => s.fileName === fileName))!;
};
afterEach(() => {
  db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Held-job seed + lifecycle helpers for the deadline-day capacity tests (Task 6). A held
// job (lifecycle 'accepted') is what effortDueByDeadline() buckets; finishJob moves it out
// of 'accepted' (freeing its deadline-day quota); acceptedKeys/jobKeyFor read the result.
const accepted = (over: {
  jobKey: string;
  dueDate: string | null;
  words: number | null;
  fileName?: string;
  fileWwc?: number | null;
}): XtmJobState => ({
  jobKey: over.jobKey,
  xtmTaskId: null,
  projectName: 'P',
  fileName: over.fileName ?? `${over.jobKey}.seed.docx`,
  sourceLang: 'English (USA)',
  targetLang: 'Malay (Malaysia)',
  dueDate: over.dueDate,
  dueRaw: null,
  words: over.words,
  fileWwc: over.fileWwc ?? null,
  step: 'PE 1',
  role: 'Corrector',
  eligible: true,
  lifecycleStatus: 'accepted',
  acceptStatus: 'accepted',
  acceptedAt: NOW,
  rejectReason: null,
  status: 'visible',
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  snapshotHash: 'seed',
  consecutiveMisses: 0,
});
const finishJob = (database: DB, jobKey: string): void => {
  database.prepare("UPDATE jobs SET lifecycle_status='closed' WHERE job_key = ?").run(jobKey);
};
const acceptedKeys = (database: DB): string[] =>
  (
    database.prepare("SELECT job_key FROM jobs WHERE lifecycle_status='accepted'").all() as {
      job_key: string;
    }[]
  ).map((r) => r.job_key);
const jobKeyFor = (fileName: string): string => computeXtmJobKey(xraw({ fileName }));

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
  row?: { status: string; fileWwc?: number | null; words?: number | null };
  cardsV2?: Array<{ cardId: string; card: { header: { title: string } } }>;
}> {
  return (
    db.prepare('SELECT payload_json FROM outbox WHERE channel = ?').all(channel) as {
      payload_json: string;
    }[]
  ).map(
    (r) =>
      JSON.parse(r.payload_json) as {
        row?: { status: string; fileWwc?: number | null; words?: number | null };
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

  it('reverted #2b: a disappeared accepted job ABSENT from a NON-empty Closed grid is Removed — no throw, no activeKeys forwarded, cycle still accepts a co-present job', async () => {
    fresh();
    // The routine "cancelled → Removed" case (V10b): the Closed tab still holds OTHER
    // previously-finished rows (≥1 candidate) but NOT this job's key. Zero cross-key match is
    // NORMAL here, NOT drift — so the reader must be called with NO activeKeys (the #2b cross-key
    // escalation was reverted) and the cycle must classify 'removed' without throwing/aborting.
    let argCount = -1;
    const reader = {
      async readClosedKeys(...args: unknown[]): Promise<Set<string>> {
        argCount = args.length;
        return new Set(['OtherProject|other.docx|PE 1|Corrector']); // ≥1 unrelated finished row
      },
    };
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, cfg(), acc, reader);
    await cycle.run(snap([xraw()], 'c1')); // accept job A
    await cycle.run(snap([], 'c2')); // A absent once (flicker)
    // A absent twice → Closed check (≥1 unrelated row) → Removed; a fresh job B in the SAME cycle
    // must STILL be accepted, proving the cycle reached upsertMany + the accept block (no abort).
    const jobB = xraw({ xtmTaskId: 'ID-2', fileName: 'b.docx' });
    const summary = await cycle.run(snap([jobB], 'c3'));
    expect(summary.removed).toBe(1);
    expect(argCount).toBe(0); // reverted: the cross-key activeKeys arg is no longer forwarded
    expect(only('a.docx').lifecycleStatus).toBe('removed'); // upsertMany ran
    expect(only('b.docx').lifecycleStatus).toBe('accepted'); // accept block ran — no abort
  });

  it('a LayoutChangedError from the Closed read (e.g. a #8 header drift) still propagates LOUD — never swallowed into a silent Removed', async () => {
    fresh();
    // The cross-key escalation is gone, but the Closed read can STILL throw on a real structural
    // drift (the #8 header guard). Such a throw must propagate out of run() to the loop's
    // handleError (layout_changed alert + heartbeat.fail), NOT be swallowed into 'removed'.
    const reader = {
      async readClosedKeys(): Promise<Set<string>> {
        throw new LayoutChangedError('Closed grid header layout drifted');
      },
    };
    const cycle = new XtmPollCycle(db, cfg(), new StubAcceptor(), reader);
    await cycle.run(snap([xraw()], 'c1')); // accept
    await cycle.run(snap([], 'c2')); // absent once (flicker)
    await expect(cycle.run(snap([], 'c3'))).rejects.toBeInstanceOf(LayoutChangedError);
    // The throw aborted before persisting any reclassification → the job is NOT silently Removed.
    expect(only().lifecycleStatus).toBe('accepted');
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

  it('carries the scraped File WWC through to the Sheet payload', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    await new XtmPollCycle(db, cfg(), new StubAcceptor()).run(snap([xraw({ fileWwc: 427 })]));
    const sheets = outboxPayloads('sheets');
    expect(sheets).toHaveLength(1);
    expect(sheets[0]?.row?.fileWwc).toBe(427); // File WWC reaches the Sheet row payload
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

  it('F10: a crash between the recovery record and its outbox enqueue is atomic (stays accepting)', async () => {
    fresh();
    const key = computeXtmJobKey(xraw());
    const cycle = new XtmPollCycle(db, cfg(), new StubAcceptor());
    await cycle.run(snap([xraw()], 'c1')); // accepted
    // Strand it (a prior cycle claimed but crashed before recording the outcome).
    db.prepare("UPDATE jobs SET accept_status='accepting' WHERE job_key = ?").run(key);
    // Simulate a crash mid-recovery: the first outbox write (raiseAlert's enqueue) throws AFTER
    // recordAcceptOutcome has run. Without the recovery transaction the DB would commit
    // 'accept_failed' while Chat/Sheet never report it (the at-least-once gap, F10).
    const spy = vi.spyOn(Outbox.prototype, 'enqueue').mockImplementationOnce(() => {
      throw new Error('crash mid-enqueue');
    });
    try {
      await expect(cycle.run(snap([xraw()], 'c2'))).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    // All-or-nothing: the record rolled back with the failed enqueue, so the job is STILL
    // 'accepting' (it will be recovered cleanly next cycle), not silently stranded as failed.
    expect(only().acceptStatus).toBe('accepting');
  });
});

// --- Task 12: accept-schedule gate helpers ---------------------------------
// Derived schedule fields (Task 9 computes these in loadConfig; the test cfg() is a
// loose cast, so we supply them explicitly here). 09:00–18:00 Mon–Fri, cap 1000,
// throughput derived = 1000 / 9h ≈ 111.1 words/h.
const SCHED_FIELDS = {
  ACCEPT_SCHEDULE_ENABLED: true,
  ACCEPT_MAX_WORDS_PER_DAY: 1000,
  ACCEPT_EFFORT_METRIC: 'words' as const,
  hoursStartMin: 9 * 60,
  hoursEndMin: 18 * 60,
  workdays: new Set([1, 2, 3, 4, 5]),
  // Task 6: derived active-metric fields (mirrors what loadConfig.transform computes in
  // production; must be supplied explicitly here since cfg() is a bare cast, not a transform).
  activeMaxPerDay: 1000,
  throughputPerHour: 1000 / 9,
  unit: { adj: 'word', noun: 'words' },
  capVar: 'ACCEPT_MAX_WORDS_PER_DAY' as const,
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
  // Task 6: job 4721900 — 861 raw words, 169 File WWC, deadline Mon 15:24.
  // Words mode: need ceil(861/(1000/9)*60)=466min≈7.8h, have 324min≈5.4h → REJECTED.
  // WWC mode:   need ceil(169/(1000/9)*60)=92min≈1.5h,  have 324min≈5.4h → ACCEPTED.
  const dueMon1524 = '2026-06-22T15:24:00+07:00';
  const j4721900 = () => xraw({ words: 861, fileWwc: 169, dueDate: dueMon1524 });
  const dueWed18 = '2026-06-24T18:00:00+07:00'; // Wed 18:00 — far, finishable for small jobs
  const dueTue18 = '2026-06-23T18:00:00+07:00'; // Tue 18:00 — far, finishable for small jobs
  const dueMon12 = '2026-06-22T12:00:00+07:00'; // same Monday noon — tight (120 working min)
  const MON_10b = '2026-06-22T11:00:00+07:00'; // later same Monday — re-attempt via robustness pass

  const sheetRows = (): Array<{ status: string; note: string | null; file: string }> =>
    (
      db.prepare("SELECT payload_json FROM outbox WHERE channel='sheets'").all() as {
        payload_json: string;
      }[]
    ).map((r) => {
      const row = (
        JSON.parse(r.payload_json) as {
          row: { status: string; note: string | null; fileName: string };
        }
      ).row;
      return { status: row.status, note: row.note, file: row.fileName };
    });
  const chatText = (): string => JSON.stringify(outboxPayloads('chat'));

  it('accepts a finishable in-hours Malay job and advances its deadline-day bucket (gate ALLOW)', async () => {
    fresh();
    const acc = new StubAcceptor();
    const summary = await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10),
    );
    expect(acc.calls.flat()).toHaveLength(1); // clicked
    expect(only().lifecycleStatus).toBe('accepted');
    expect(summary.scheduleBlocked).toBe(0);
    // The held list (the single source of truth for capacity) now carries the accepted
    // job's words under its DEADLINE day — not a meta accept-day counter.
    expect(
      new XtmJobStore(db).effortDueByDeadline().get(bangkokDateString(Date.parse(dueWed18))),
    ).toBe(100);
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
    expect(new XtmJobStore(db).effortDueByDeadline().size).toBe(0); // nothing held → no bucket
  });

  it('B#2/B#6: a gate-Rejected job that later becomes feasible but FAILS to accept shows Accept failed, not stale Rejected', async () => {
    fresh();
    new MetaStore(db).markBaselineDone(); // past baseline → per-job sheets fire each cycle
    const acc = new StubAcceptor();
    // c1: too tight → the schedule gate REJECTS it (lifecycle 'rejected' + persisted reason, accept
    // untouched at 'none'). The acceptor is never called.
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c1'),
    );
    expect(only().lifecycleStatus).toBe('rejected');
    expect(sheetRows().at(-1)?.status).toBe('Rejected');

    // c2: SAME job (identity is project|file|step|role — due/words are not keyed), now finishable, so
    // the gate ALLOWs and the robustness pass attempts accept — but the portal click FAILS.
    acc.outcome = 'failed';
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10b, 'c2'),
    );
    const s = only();
    expect(s.lifecycleStatus).toBe('accept_failed');
    expect(s.acceptStatus).toBe('failed');
    // The accept-machine terminal must win: the Sheet shows the true 'Accept failed', never the
    // stale gate 'Rejected' (applyPresentDecision cleared the reason before the ALLOW; the
    // resolveSheetStatusAndNote accept_failed guard is the belt-and-suspenders behind it).
    expect(sheetRows().at(-1)?.status).toBe('Accept failed');
  });

  it('I1: a schedule-blocked job surfaces reason/words/dueDate via summary.scheduleRejects', async () => {
    fresh();
    const acc = new StubAcceptor();
    const summary = await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10),
    );
    expect(summary.scheduleRejects).toHaveLength(1);
    const r = summary.scheduleRejects[0]!;
    expect(r.jobKey).toBe(computeXtmJobKey(xraw({ dueDate: dueMon12, words: 5000 })));
    expect(r.reason).toContain('cannot finish in time'); // the binding reject reason, not just a count
    expect(r.words).toBe(5000);
    expect(r.dueDate).toBe(dueMon12);
  });

  it('I1: an ALLOWed cycle carries an empty scheduleRejects', async () => {
    fresh();
    const acc = new StubAcceptor();
    const summary = await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10),
    );
    expect(summary.scheduleRejects).toHaveLength(0);
  });

  // I1 (real data): drive the cycle with deadlines that fall on REAL in-lieu (วันหยุดชดเชย)
  // days from src/schedule/thaiHolidaysData.ts — exercising resolveHolidaysForSpan end-to-end
  // with the curated PR #11 data, NOT a synthetic holiday map. Each `now` precedes its
  // in-lieu deadline and stays inside the curated 2026 calendar.
  const inLieuCases: Array<{ label: string; now: string; due: string; holiday: string }> = [
    {
      label: 'Visakha Bucha (in lieu) 2026-06-01',
      now: '2026-05-29T10:00:00+07:00', // Fri before the Mon in-lieu day
      due: '2026-06-01T12:00:00+07:00', // Mon — '2026-06-01' is a real in-lieu holiday
      holiday: 'Visakha Bucha Day (in lieu)',
    },
    {
      label: "King Bhumibol's Birthday (in lieu) 2026-12-07",
      now: '2026-12-04T10:00:00+07:00', // Fri before the Mon in-lieu day
      due: '2026-12-07T12:00:00+07:00', // Mon — '2026-12-07' is a real in-lieu holiday
      holiday: "King Bhumibol's Birthday / Father's Day (in lieu)",
    },
  ];
  for (const c of inLieuCases) {
    it(`I1 (real data): rejects a Malay job whose deadline lands on a real in-lieu holiday — ${c.label}`, async () => {
      fresh();
      const acc = new StubAcceptor();
      const summary = await new XtmPollCycle(db, schedCfg(), acc).run(
        snapAt([xraw({ dueDate: c.due, words: 100 })], c.now),
      );
      expect(acc.calls.flat()).toHaveLength(0); // never clicked — blocked by the real holiday
      expect(only().lifecycleStatus).toBe('rejected');
      expect(summary.scheduleBlocked).toBe(1);
      const note = sheetRows().at(-1)?.note ?? '';
      expect(note).toContain('non-working day'); // the binding reason is a holiday block
      expect(note).toContain(c.holiday); // the exact curated in-lieu name flowed through
    });
  }

  // I2: the record transaction is all-or-nothing. Two same-language Malay jobs form one
  // bulk group, both feasible → both claimed & attempted. The acceptor confirms job A (its
  // recordAcceptOutcome flips it to lifecycle 'accepted' mid-txn), then returns a MALFORMED
  // outcome for job B that makes recordAcceptOutcome throw INSIDE the record transaction.
  // The whole txn must roll back — so job A is NOT left committed as 'accepted', and the
  // held list (the capacity source of truth) shows no held words for an uncommitted accept.
  it('I2: a mid-txn throw leaves NO job committed as accepted (record txn is atomic)', async () => {
    fresh();
    const acc = {
      async acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]> {
        return [
          // results[0] confirmed → recordAcceptOutcome flips job A to 'accepted' first…
          { jobKey: targets[0]!.jobKey, outcome: 'accepted', at: NOW } as AcceptResult,
          // …then results[1] carries an outcome outside the lifecycle map → recordAcceptOutcome
          // dereferences `undefined` and throws, aborting the record transaction.
          {
            jobKey: targets[1]!.jobKey,
            outcome: 'kaboom' as AcceptResult['outcome'],
            at: NOW,
          } as AcceptResult,
        ];
      },
    };
    await expect(
      new XtmPollCycle(db, schedCfg(), acc).run(
        snapAt(
          [
            xraw({ fileName: 'one.docx', projectName: 'P1', dueDate: dueWed18, words: 100 }),
            xraw({ fileName: 'two.docx', projectName: 'P2', dueDate: dueWed18, words: 100 }),
          ],
          MON_10,
        ),
      ),
    ).rejects.toThrow();
    // The record txn rolled back → job A's 'accepted' write was undone, so nothing is held.
    expect(new XtmJobStore(db).effortDueByDeadline().size).toBe(0);
  });

  it('I3a: a single group whose OWN words exceed the daily cap → "exceed" message (accept manually)', async () => {
    fresh();
    const acc = new StubAcceptor();
    // 1500 words is feasible by Wed but its own size (1500) > the 1000-word daily cap → can
    // never auto-accept on any day. The message must not read like a budget already spent.
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 1500 })], MON_10), // counter 0
    );
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only().lifecycleStatus).toBe('rejected');
    const note = sheetRows().at(-1)?.note ?? '';
    expect(note).toContain('exceed the daily cap');
    expect(note).toContain('accept manually');
  });

  it('I3a: a group that fits alone but exhausts the remaining deadline-day budget → "cap reached" message', async () => {
    fresh();
    // Held seed: 900 words already due Wed (under the 1000 cap, 100 left for that day).
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'seed', dueDate: dueWed18, words: 900 })]);
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 300 })], MON_10), // 300 ≤ cap, but 900+300 > 1000 on Wed
    );
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only('a.docx').lifecycleStatus).toBe('rejected');
    const note = sheetRows().find((r) => r.file === 'a.docx')?.note ?? '';
    expect(note).toContain('daily word cap reached');
    expect(note).toContain(bangkokDateString(Date.parse(dueWed18))); // names the deadline day
    expect(note).not.toContain('exceed the daily cap'); // distinct from the over-cap case
  });

  it('I5: feasibility binds BEFORE capacity — an infeasible job on a near-cap day reads "cannot finish", not "cap reached"', async () => {
    fresh();
    // Held seed near the Mon cap (950 of 1000 due 2026-06-22). The new job is due the SAME day but
    // its deadline is too tight to finish — so if capacity ran first it would read "cap reached"
    // (950 + 100 > 1000). Feasibility runs FIRST, so the binding reason must be the infeasibility,
    // and no daily_cap_reached alert may fire (capacity was never evaluated). Guards the runbook
    // reason precedence (§3).
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'seed', dueDate: dueMon12, words: 950 })]);
    const tightDue = '2026-06-22T10:05:00+07:00'; // 5 working-min after now → infeasible for 100w
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: tightDue, words: 100 })], MON_10),
    );
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only('a.docx').lifecycleStatus).toBe('rejected');
    const note = sheetRows().find((r) => r.file === 'a.docx')?.note ?? '';
    expect(note).toContain('cannot finish in time'); // feasibility's reason binds first
    expect(note).not.toContain('cap reached'); // NOT the capacity reason (capacity never ran)
    const capAlerts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key LIKE 'daily_cap_reached%'",
      )
      .get() as { n: number };
    expect(capAlerts.n).toBe(0); // no daily_cap_reached row exists
  });

  it('I3b: a genuine cap-reached block raises daily_cap_reached once per DEADLINE day (deduped)', async () => {
    fresh();
    // Held seed: 900 words already due Wed (100 left for that deadline day).
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'seed', dueDate: dueWed18, words: 900 })]);
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, schedCfg(), acc);
    const wedDay = bangkokDateString(Date.parse(dueWed18)); // '2026-06-24'
    const activeCapAlert = (): number =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key=? AND resolved_at IS NULL",
          )
          .get(`daily_cap_reached:${wedDay}`) as { n: number }
      ).n;
    await cycle.run(
      snapAt([xraw({ fileName: 'a.docx', dueDate: dueWed18, words: 300 })], MON_10, 'c1'),
    );
    expect(activeCapAlert()).toBe(1); // raised once when that deadline day's budget is exhausted
    await cycle.run(
      snapAt([xraw({ fileName: 'b.docx', dueDate: dueWed18, words: 300 })], MON_10, 'c2'),
    );
    expect(activeCapAlert()).toBe(1); // deduped — at most one cap alert per deadline day
  });

  it('I3b: overflowing TWO different deadline days raises TWO distinct daily_cap_reached alerts (per-day, not global)', async () => {
    fresh();
    // Two held seeds, one near-full on each deadline day (Tue 900, Wed 900).
    new XtmJobStore(db).upsertMany([
      accepted({ jobKey: 'seedTue', dueDate: dueTue18, words: 900 }),
      accepted({ jobKey: 'seedWed', dueDate: dueWed18, words: 900 }),
    ]);
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, schedCfg(), acc);
    // c1 overflows Tue (900 + 300 > 1000); c2 overflows Wed (900 + 300 > 1000).
    await cycle.run(
      snapAt([xraw({ fileName: 'tue.docx', dueDate: dueTue18, words: 300 })], MON_10, 'c1'),
    );
    await cycle.run(
      snapAt([xraw({ fileName: 'wed.docx', dueDate: dueWed18, words: 300 })], MON_10, 'c2'),
    );
    const keys = (
      db
        .prepare(
          "SELECT DISTINCT dedup_key FROM system_events WHERE event_type='system_alert' AND dedup_key LIKE 'daily_cap_reached:%' AND resolved_at IS NULL",
        )
        .all() as { dedup_key: string }[]
    )
      .map((k) => k.dedup_key)
      .sort();
    // Two DISTINCT alerts — the dedup key is per deadline day, not a single global cap alert.
    expect(keys).toEqual([
      `daily_cap_reached:${bangkokDateString(Date.parse(dueTue18))}`,
      `daily_cap_reached:${bangkokDateString(Date.parse(dueWed18))}`,
    ]);
  });

  it('I3b: a single-job-over-cap block does NOT raise daily_cap_reached', async () => {
    fresh();
    const acc = new StubAcceptor();
    // 1500 > cap → "exceed" case, NOT a budget-exhausted day → no daily_cap_reached alert.
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 1500 })], MON_10),
    );
    const alerts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key LIKE 'daily_cap_reached%'",
      )
      .get() as { n: number };
    expect(alerts.n).toBe(0);
  });

  it('I3b: the cap alert is guarded behind scheduleEnabled (gate OFF never raises it)', async () => {
    fresh();
    // Held seed that would exhaust Wed's budget IF the gate ran — but the gate is OFF.
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'seed', dueDate: dueWed18, words: 900 })]);
    const acc = new StubAcceptor();
    // Gate OFF → every would-accept job is accepted byte-for-byte; the cap alert must not fire.
    await new XtmPollCycle(db, cfg({ ACCEPT_SCHEDULE_ENABLED: false }), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 300 })], MON_10),
    );
    // I5 (non-vacuous): prove gate-OFF actually ACCEPTS even though the Wed bucket would overflow
    // (held 900 + 300 > the 1000 cap). The kill-switch must bypass capacity byte-for-byte, not
    // merely skip the alert.
    expect(acc.calls.flat()).toHaveLength(1); // clicked despite the would-be overflow
    expect(only('a.docx').lifecycleStatus).toBe('accepted'); // and recorded accepted
    const alerts = db
      .prepare(
        "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key LIKE 'daily_cap_reached%'",
      )
      .get() as { n: number };
    expect(alerts.n).toBe(0);
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
    expect(new XtmJobStore(db).effortDueByDeadline().size).toBe(0); // nothing accepted → no held words
  });

  it('capacity: a group whose combined words would exceed the remaining deadline-day cap is rejected', async () => {
    fresh();
    // Held seed: 950 words already due Wed (50 left under the 1000 cap for that day).
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'seed', dueDate: dueWed18, words: 950 })]);
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10), // 950 + 100 = 1050 > 1000 on Wed
    );
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only('a.docx').lifecycleStatus).toBe('rejected');
    expect(
      new XtmJobStore(db).effortDueByDeadline().get(bangkokDateString(Date.parse(dueWed18))),
    ).toBe(950); // unchanged — the rejected job is not held
  });

  it('capacity: a group that fits the remaining deadline-day cap is accepted and advances its bucket', async () => {
    fresh();
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'seed', dueDate: dueWed18, words: 950 })]);
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ dueDate: dueWed18, words: 50 })], MON_10), // 950 + 50 = 1000 ≤ 1000 on Wed
    );
    expect(acc.calls.flat()).toHaveLength(1);
    expect(only('a.docx').lifecycleStatus).toBe('accepted');
    expect(
      new XtmJobStore(db).effortDueByDeadline().get(bangkokDateString(Date.parse(dueWed18))),
    ).toBe(1000); // 950 held + 50 newly accepted, both due Wed
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

  it('sticky Rejected: a gate-rejected job stays Rejected with a "(left Active …)" suffix after it disappears — never Missing (Task 7)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    const tight = { dueDate: dueMon12, words: 5000 }; // infeasible → schedule-rejected
    // c1: present + rejected → Sheet 'Rejected', reason in note, NOT yet "left Active".
    await cycle.run(snapAt([xraw(tight)], MON_10, 'c1'));
    const c1Row = sheetRows().at(-1)!;
    expect(c1Row.status).toBe('Rejected');
    expect(c1Row.note).toContain('cannot finish in time');
    expect(c1Row.note).not.toContain('left Active');
    // c2 flicker (1 absent poll), c3 missing (2 absent polls → 'missing' transition).
    await cycle.run(snapAt([], MON_10, 'c2'));
    await cycle.run(snapAt([], MON_10, 'c3'));
    expect(only().lifecycleStatus).toBe('missing'); // internal lifecycle flips to missing…
    const lastRow = sheetRows().at(-1)!;
    expect(lastRow.status).toBe('Rejected'); // …but the Sheet status stays sticky Rejected
    expect(lastRow.note).toContain('cannot finish in time'); // the binding reason is preserved
    expect(lastRow.note).toContain('left Active'); // a "left Active …" suffix is appended
  });

  it('clear/upgrade: a previously-rejected job that becomes accepted → Sheet Accepted + DB reject_reason cleared (Task 7)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, schedCfg(), acc);
    // c1: too-tight → schedule-rejected, reject reason persisted.
    await cycle.run(snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c1'));
    expect(only().lifecycleStatus).toBe('rejected');
    expect(only().rejectReason).not.toBeNull();
    // c2: SAME job, now feasible (deadline extended + small) → accepted via the robustness pass.
    await cycle.run(snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10, 'c2'));
    expect(acc.calls.flat()).toHaveLength(1); // clicked
    expect(only().lifecycleStatus).toBe('accepted');
    expect(only().rejectReason).toBeNull(); // DB reject_reason cleared on the upgrade
    expect(sheetRows().at(-1)?.status).toBe('Accepted'); // not stale 'Rejected'
  });

  it('clear on skip: a previously-rejected job that returns over ACCEPT_MAX_WORDS → Sheet Skipped, not stale Rejected (Task 7)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, schedCfg({ ACCEPT_MAX_WORDS: 4000 }), acc);
    // c1: 3000w ≤ the 4000 per-job cap (so decideAccept→accept) but too tight for noon → rejected.
    await cycle.run(snapAt([xraw({ dueDate: dueMon12, words: 3000 })], MON_10, 'c1'));
    expect(only().lifecycleStatus).toBe('rejected');
    expect(only().rejectReason).not.toBeNull();
    // disappear (flicker → missing), then return relisted with words OVER the per-job cap → skip.
    await cycle.run(snapAt([], MON_10, 'c2')); // flicker
    await cycle.run(snapAt([], MON_10, 'c3')); // missing
    await cycle.run(snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c4')); // 5000 > 4000 → skip
    expect(acc.calls.flat()).toHaveLength(0); // never accepted
    expect(only().lifecycleStatus).toBe('skipped');
    expect(only().rejectReason).toBeNull(); // reason cleared on the event pass before the skip
    expect(sheetRows().at(-1)?.status).toBe('Skipped'); // NOT a stale sticky 'Rejected'
  });

  it('idempotent: a still-absent rejected job does NOT re-enqueue a Sheet row after the missing transition (Task 7)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    const tight = { dueDate: dueMon12, words: 5000 };
    await cycle.run(snapAt([xraw(tight)], MON_10, 'c1')); // rejected
    await cycle.run(snapAt([], MON_10, 'c2')); // flicker (no row)
    await cycle.run(snapAt([], MON_10, 'c3')); // missing transition → one sticky-Rejected row
    const countAfterMissing = sheetRows().length;
    await cycle.run(snapAt([], MON_10, 'c4')); // still absent → must NOT re-enqueue
    expect(sheetRows().length).toBe(countAfterMissing);
  });

  // --- Finding #1/#7: robustness-pass symmetry (the sticky-Rejected break) ----
  it('Finding #1: a still-present rejected job with ACCEPT_ENABLED=0 flips to new (not stale rejected) → Sheet Missing on disappear', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const tight = { dueDate: dueMon12, words: 5000 }; // infeasible → schedule-rejected
    // c1: ACCEPT on, too tight → rejected (reason persisted).
    await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(
      snapAt([xraw(tight)], MON_10, 'c1'),
    );
    expect(only().lifecycleStatus).toBe('rejected');
    expect(only().rejectReason).not.toBeNull();
    // c2: SAME job still present, ACCEPT now OFF → the robustness pass decides 'disabled' →
    // lifecycle 'new'. Before the symmetric helper the robustness pass ignored 'disabled', leaving
    // a STALE 'rejected' lifecycle with its reason cleared — a bare 'Rejected' (note=null).
    const offCycle = new XtmPollCycle(db, schedCfg({ ACCEPT_ENABLED: false }), new StubAcceptor());
    await offCycle.run(snapAt([xraw(tight)], MON_10, 'c2'));
    expect(only().lifecycleStatus).toBe('new'); // NOT stale 'rejected'
    expect(only().rejectReason).toBeNull(); // reason cleared AND the lifecycle followed
    // c3 flicker, c4 missing → the Sheet shows Missing, never a bare 'Rejected'.
    await offCycle.run(snapAt([], MON_10, 'c3'));
    await offCycle.run(snapAt([], MON_10, 'c4'));
    expect(only().lifecycleStatus).toBe('missing');
    expect(sheetRows().at(-1)?.status).toBe('Missing');
  });

  it('Finding #1: a still-present rejected job whose words jump over ACCEPT_MAX_WORDS flips to skipped with the skip reason (not stale rejected)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    // cap 4000 per-job. c1: 3000w ≤ cap (decideAccept→accept) but too tight for noon → rejected.
    const cycle = new XtmPollCycle(db, schedCfg({ ACCEPT_MAX_WORDS: 4000 }), new StubAcceptor());
    await cycle.run(snapAt([xraw({ dueDate: dueMon12, words: 3000 })], MON_10, 'c1'));
    expect(only().lifecycleStatus).toBe('rejected');
    expect(only().rejectReason).not.toBeNull();
    // c2: SAME job still present, words now 5000 > the 4000 cap → the robustness pass decides 'skip'.
    await cycle.run(snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c2'));
    expect(only().lifecycleStatus).toBe('skipped'); // NOT stale 'rejected'
    expect(only().rejectReason).toBeNull();
    const last = sheetRows().at(-1)!;
    expect(last.status).toBe('Skipped');
    expect(last.note).toContain('exceeds max words'); // the skip reason surfaced, not a stale reject note
  });

  it('Finding #1 regression: a still-present rejected job the gate re-blocks STAYS sticky Rejected (common case unbroken)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const tight = { dueDate: dueMon12, words: 5000 };
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    await cycle.run(snapAt([xraw(tight)], MON_10, 'c1'));
    expect(only().lifecycleStatus).toBe('rejected');
    // c2: SAME job still present, still infeasible → robustness pass → gate re-blocks → rejected.
    await cycle.run(snapAt([xraw(tight)], MON_10, 'c2'));
    expect(only().lifecycleStatus).toBe('rejected'); // re-blocked, stays rejected
    expect(only().rejectReason).not.toBeNull(); // reason re-set by the gate (not left cleared)
    // disappears → sticky 'Rejected' with a "(left Active …)" suffix (not flipped to Missing).
    await cycle.run(snapAt([], MON_10, 'c3'));
    await cycle.run(snapAt([], MON_10, 'c4'));
    expect(only().lifecycleStatus).toBe('missing'); // internal lifecycle flips…
    const last = sheetRows().at(-1)!;
    expect(last.status).toBe('Rejected'); // …but the Sheet stays sticky Rejected
    expect(last.note).toContain('cannot finish in time');
  });

  it('Finding #9: the "(left Active …)" suffix renders lastSeenAt (last present cycle), not the missing-detection capturedAt', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    const tight = { dueDate: dueMon12, words: 5000 }; // infeasible → schedule-rejected
    const PRESENT_AT = '2026-06-22T10:00:00+07:00'; // last cycle the job is actually present
    const MISSING_AT = '2026-06-22T11:00:00+07:00'; // ~1h later — when the missing transition fires
    // c1: present + rejected → lastSeenAt pinned to 10:00.
    await cycle.run(snapAt([xraw(tight)], PRESENT_AT, 'c1'));
    // c2 flicker, c3 missing — both detected at 11:00 (AFTER the last present cycle). The job left
    // Active ~MISSING_THRESHOLD × interval before 11:00, so the real "left Active" time is 10:00.
    await cycle.run(snapAt([], MISSING_AT, 'c2'));
    await cycle.run(snapAt([], MISSING_AT, 'c3'));
    expect(only().lifecycleStatus).toBe('missing');
    const note = sheetRows().at(-1)?.note ?? '';
    expect(note).toContain('left Active 22/06/2026 10:00'); // lastSeenAt — the real last-present time
    expect(note).not.toContain('11:00'); // NOT the later missing-detection capturedAt
  });

  it('#15: a still-rejected job whose reject REASON changes (no field change) re-enqueues the Sheet row; an unchanged reason does not', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    // 1500w (> the 1000 cap) but FEASIBLE by Wed from Monday (multi-day) → capacity reason A.
    // Fields are FIXED across all cycles (dueWed18, 1500) so there is NO detailsChange/field-sync —
    // the ONLY path that can refresh the Sheet is the blockNotes re-announce.
    const job = { dueDate: dueWed18, words: 1500 };
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    const aRows = (): Array<{ status: string; note: string | null }> =>
      sheetRows().filter((r) => r.file === 'a.docx');
    // cN (Mon 10:00): feasible but its own size > cap → reason A ("exceed the daily cap").
    await cycle.run(snapAt([xraw(job)], MON_10, 'cN'));
    expect(only('a.docx').lifecycleStatus).toBe('rejected');
    expect(aRows().at(-1)?.note).toContain('exceed the daily cap'); // reason A
    const afterN = aRows().length;
    // cN1 (Wed 10:00): SAME fields, later now → too little time left → reason B ("cannot finish").
    await cycle.run(snapAt([xraw(job)], '2026-06-24T10:00:00+07:00', 'cN1'));
    expect(only('a.docx').lifecycleStatus).toBe('rejected'); // still rejected…
    expect(aRows().length).toBeGreaterThan(afterN); // …a NEW row was enqueued on the reason change
    expect(aRows().at(-1)?.note).toContain('cannot finish in time'); // reason B now on the Sheet
    const afterN1 = aRows().length;
    // cN2 (same now + fields): reason UNCHANGED (still B) → NO new row (dedup intact, no spam).
    await cycle.run(snapAt([xraw(job)], '2026-06-24T10:00:00+07:00', 'cN2'));
    expect(aRows().length).toBe(afterN1);
  });

  it('B#7 regression: accepting a previously-rejected Malay job clears the PERSISTED reject_reason to null (Sheet Accepted)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, schedCfg(), acc);
    const jobKey = computeXtmJobKey(xraw());
    const persistedReason = (): string | null =>
      (
        db.prepare('SELECT reject_reason AS r FROM jobs WHERE job_key = ?').get(jobKey) as {
          r: string | null;
        }
      ).r;
    // c1: too-tight → schedule-rejected, reject_reason persisted non-null.
    await cycle.run(snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c1'));
    expect(persistedReason()).not.toBeNull(); // precondition: a real reason was stored
    // c2: SAME job, now feasible (deadline extended + small) → accepted via the robustness pass.
    await cycle.run(snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10, 'c2'));
    expect(acc.calls.flat()).toHaveLength(1);
    expect(only().lifecycleStatus).toBe('accepted');
    // Locks the clear-before-accept: a refactor dropping `s.rejectReason = null` would fail here.
    expect(persistedReason()).toBeNull();
    expect(sheetRows().at(-1)?.status).toBe('Accepted'); // not stale 'Rejected'
  });

  it('F1: a still-rejected job whose dueDate changes keeps its reject reason on the field-sync note (I3 — never wiped to null)', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const acc = new StubAcceptor();
    const cycle = new XtmPollCycle(db, schedCfg(), acc);
    const jobKey = computeXtmJobKey(xraw());
    // c1: too-tight Malay job → schedule-rejected (lifecycle 'rejected', note recorded).
    await cycle.run(snapAt([xraw({ dueDate: dueMon12, words: 5000 })], MON_10, 'c1'));
    expect(only().lifecycleStatus).toBe('rejected');
    // c2: SAME job still present, dueDate changes to another still-infeasible value — NO new
    // appearance event, but the material field change fires detailsChanges. The job stays
    // rejected, so the silent field re-sync must PRESERVE the binding reject reason, never
    // overwrite the Sheet note with null (the I3 invariant — previously untested).
    const due2 = '2026-06-22T13:00:00+07:00';
    await cycle.run(snapAt([xraw({ dueDate: due2, words: 5000 })], MON_10, 'c2'));
    expect(acc.calls.flat()).toHaveLength(0); // never accepted
    expect(only().lifecycleStatus).toBe('rejected');
    const syncRow = db
      .prepare('SELECT payload_json FROM outbox WHERE event_id = ?')
      .get(`sheet:fieldsync:${jobKey}|c2`) as { payload_json: string } | undefined;
    expect(syncRow, 'sheet:fieldsync row for c2 must exist').toBeDefined();
    const row = (
      JSON.parse(syncRow!.payload_json) as {
        row: { status: string; dueDate: string | null; note: string | null };
      }
    ).row;
    expect(row.status).toBe('Rejected'); // the persisted-reason path keeps the Sheet status sticky
    expect(row.dueDate).toBe(due2); // carries the updated dueDate
    expect(row.note).not.toBeNull(); // reject reason preserved (not wiped)...
    expect(row.note).toContain('group blocked'); // ...specifically the binding reject reason
  });

  it('C1: an uncurated current-year cycle sets summary.holidayCalendarStale (the total-outage page signal)', async () => {
    fresh();
    const acc = new StubAcceptor();
    // capturedAt in 2099 (uncurated current Bangkok year) → auto-accept is 100% dead → page.
    const summary = await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([], '2099-06-22T10:00:00+07:00'),
    );
    expect(summary.holidayCalendarStale).toBe(true);
  });

  it('C1: a curated current-year cycle leaves summary.holidayCalendarStale false', async () => {
    fresh();
    const acc = new StubAcceptor();
    const summary = await new XtmPollCycle(db, schedCfg(), acc).run(snapAt([], MON_10)); // 2026 curated
    expect(summary.holidayCalendarStale).toBe(false);
  });

  it('C1: a DISABLED gate never flags holidayCalendarStale even in an uncurated current year', async () => {
    fresh();
    const acc = new StubAcceptor();
    // Gate off → the holiday block is skipped entirely; the kill-switch must not page.
    const summary = await new XtmPollCycle(db, cfg({ ACCEPT_SCHEDULE_ENABLED: false }), acc).run(
      snapAt([], '2099-06-22T10:00:00+07:00'),
    );
    expect(summary.holidayCalendarStale).toBe(false);
  });

  it('F3: an uncurated current-year cycle raises holiday_calendar_stale; a later curated-year cycle RESOLVES it', async () => {
    fresh();
    new MetaStore(db).markBaselineDone();
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    const activeStale = (): number =>
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key='holiday_calendar_stale' AND resolved_at IS NULL",
          )
          .get() as { n: number }
      ).n;
    // c1: capturedAt in 2099 (uncurated current year) → raise.
    await cycle.run(snapAt([], '2099-06-22T10:00:00+07:00', 'c1'));
    expect(activeStale()).toBe(1);
    // c2: capturedAt back in 2026 (curated current year) → the resolve path (currently
    // unexercised) clears the alert and enqueues a recovered event.
    await cycle.run(snapAt([], '2026-06-22T10:00:00+07:00', 'c2'));
    expect(activeStale()).toBe(0); // resolved_at set → no longer active
    const recovered = db
      .prepare(
        "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_recovered' AND dedup_key LIKE 'holiday_calendar_stale%'",
      )
      .get() as { n: number };
    expect(recovered.n).toBe(1); // a recovered event was enqueued
  });

  // --- Component A: cap by DEADLINE day, held-derived (Task 6) ---------------
  it('multi-deadline ALLOW: two feasible Malay jobs > cap combined but ≤ cap each day → both accepted', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt(
        [
          xraw({ fileName: 'tue.docx', projectName: 'P', dueDate: dueTue18, words: 800 }),
          xraw({ fileName: 'wed.docx', projectName: 'P', dueDate: dueWed18, words: 800 }),
        ],
        MON_10,
      ),
    );
    // 800 + 800 = 1600 > the 1000 cap, but each DEADLINE day holds only 800 → both accepted
    // (the old per-accept-day cap would have rejected the pair).
    expect(acc.calls.flat()).toHaveLength(2);
    const m = new XtmJobStore(db).effortDueByDeadline();
    expect(m.get(bangkokDateString(Date.parse(dueTue18)))).toBe(800);
    expect(m.get(bangkokDateString(Date.parse(dueWed18)))).toBe(800);
  });

  it('finished returns quota (A3) with a negative control', async () => {
    fresh();
    // negative control: Tue bucket already 800 (a held accepted job) → a new 800w-due-Tue is rejected
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'old', dueDate: dueTue18, words: 800 })]);
    await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(
      snapAt([xraw({ fileName: 'new.docx', dueDate: dueTue18, words: 800 })], MON_10),
    );
    expect(only('new.docx').lifecycleStatus).toBe('rejected'); // 800+800 > 1000
    // free the quota: the old job finishes (leaves 'accepted')
    finishJob(db, 'old'); // set lifecycle_status='closed'
    await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(
      snapAt([xraw({ fileName: 'new.docx', dueDate: dueTue18, words: 800 })], MON_10b),
    );
    expect(acceptedKeys(db)).toContain(jobKeyFor('new.docx')); // now accepted
  });

  it('cross-deadline all-or-nothing: a Wed-overflow blocks the whole Malay group incl the fitting Tue job', async () => {
    fresh();
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'w', dueDate: dueWed18, words: 900 })]); // Wed near full
    await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(
      snapAt(
        [
          xraw({ fileName: 'tue.docx', dueDate: dueTue18, words: 100 }),
          xraw({ fileName: 'wed.docx', dueDate: dueWed18, words: 200 }), // 900+200 > 1000
        ],
        MON_10,
      ),
    );
    expect(only('tue.docx').lifecycleStatus).toBe('rejected');
    expect(only('wed.docx').lifecycleStatus).toBe('rejected');
    const note = sheetRows().find((r) => r.file === 'tue.docx')?.note ?? '';
    expect(note).toContain(bangkokDateString(Date.parse(dueWed18))); // names the overflowing DAY
    // F6: a capacity block is day-level — it must NOT prefix an arbitrary file name (blaming a
    // file that is not even on the overflowing day).
    expect(note).not.toContain('.docx');
  });

  it('F1: a held job whose grid cell later reads blank keeps its deadline-day bucket (no over-accept)', async () => {
    fresh();
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    // c1: accept a 600w Malay job due Wed → held (Wed bucket = 600).
    await cycle.run(
      snapAt([xraw({ fileName: 'held.docx', dueDate: dueWed18, words: 600 })], MON_10, 'c1'),
    );
    expect(only('held.docx').lifecycleStatus).toBe('accepted');
    // c2: the held job is STILL in Active but its Due/Words cells read blank (grid race). Without
    // the F1 lock this would persist dueDate=null/words=null, dropping it from the Wed bucket.
    await cycle.run(
      snapAt([xraw({ fileName: 'held.docx', dueDate: null, words: null })], MON_10, 'c2'),
    );
    const held = only('held.docx');
    expect(held.dueDate).toBe(dueWed18); // committed deadline survived the blank re-read
    expect(held.words).toBe(600);
    // c3: a NEW 600w Malay job due Wed appears. The Wed bucket must still hold the held 600, so
    // 600 + 600 > the 1000 cap → reject. Without F1 the bucket would be 0 → over-accept (irreversible).
    await cycle.run(
      snapAt(
        [
          xraw({ fileName: 'held.docx', dueDate: null, words: null }),
          xraw({ fileName: 'new.docx', dueDate: dueWed18, words: 600 }),
        ],
        MON_10,
        'c3',
      ),
    );
    expect(only('new.docx').lifecycleStatus).toBe('rejected');
  });

  it('capacity seed skips a null-deadline held job without crashing', async () => {
    fresh();
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'nul', dueDate: null, words: 999 })]);
    await expect(
      new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(
        snapAt([xraw({ fileName: 'ok.docx', dueDate: dueTue18, words: 100 })], MON_10),
      ),
    ).resolves.toBeDefined();
  });

  const activeHeldNoDeadlineAlerts = (): number =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key LIKE 'held_job_no_deadline:%' AND resolved_at IS NULL",
        )
        .get() as { n: number }
    ).n;

  it('I1: a held job with a null deadline raises a deduped held_job_no_deadline warn alert (fail loud)', async () => {
    fresh();
    // A held (accepted) job with no parseable deadline drops out of the per-deadline-day seed —
    // it must FAIL LOUD (deduped warn), never silently under-count the bucket → over-accept.
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'nul', dueDate: null, words: 999 })]);
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    await cycle.run(
      snapAt([xraw({ fileName: 'ok.docx', dueDate: dueTue18, words: 100 })], MON_10, 'c1'),
    );
    expect(activeHeldNoDeadlineAlerts()).toBe(1); // raised for the deadline-less held job
    await cycle.run(
      snapAt([xraw({ fileName: 'ok.docx', dueDate: dueTue18, words: 100 })], MON_10, 'c2'),
    );
    expect(activeHeldNoDeadlineAlerts()).toBe(1); // deduped — at most once per Bangkok day
  });

  it('I1: no held_job_no_deadline alert when every held job has a parseable deadline', async () => {
    fresh();
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'ok', dueDate: dueWed18, words: 100 })]);
    await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(snapAt([], MON_10));
    expect(activeHeldNoDeadlineAlerts()).toBe(0);
  });

  it('I1: the held_job_no_deadline alert is guarded behind scheduleEnabled (gate OFF never raises it)', async () => {
    fresh();
    // Gate OFF = no cap enforced = a missing deadline cannot over-accept, so no alert.
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'nul', dueDate: null, words: 999 })]);
    await new XtmPollCycle(db, cfg({ ACCEPT_SCHEDULE_ENABLED: false }), new StubAcceptor()).run(
      snapAt([xraw({ fileName: 'ok.docx', dueDate: dueTue18, words: 100 })], MON_10),
    );
    expect(activeHeldNoDeadlineAlerts()).toBe(0);
  });

  // I-1b: null-effort companion alert
  const activeHeldNoEffortAlerts = (): number =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key LIKE 'held_job_no_effort:%' AND resolved_at IS NULL",
        )
        .get() as { n: number }
    ).n;

  it('I-1: a held job with null effort raises a deduped held_job_no_effort warn alert', async () => {
    fresh();
    // A held job with words=null → effortOf(words)=null → seeds 0 → under-count.
    // schedCfg() uses words mode (SCHED_FIELDS.ACCEPT_EFFORT_METRIC='words'), so null words triggers it.
    new XtmJobStore(db).upsertMany([
      accepted({ jobKey: 'null-eff', dueDate: dueWed18, words: null }),
    ]);
    const cycle = new XtmPollCycle(db, schedCfg(), new StubAcceptor());
    await cycle.run(snapAt([], MON_10, 'c1'));
    expect(activeHeldNoEffortAlerts()).toBe(1);
    // deduped — second cycle same Bangkok day should not add a second alert
    await cycle.run(snapAt([], MON_10, 'c2'));
    expect(activeHeldNoEffortAlerts()).toBe(1);
  });

  it('I-1: no held_job_no_effort alert when every held job has non-null effort', async () => {
    fresh();
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'ok', dueDate: dueWed18, words: 100 })]);
    await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(snapAt([], MON_10));
    expect(activeHeldNoEffortAlerts()).toBe(0);
  });

  it('I-1: the held_job_no_effort alert is guarded behind scheduleEnabled (gate OFF never raises it)', async () => {
    fresh();
    new XtmJobStore(db).upsertMany([
      accepted({ jobKey: 'null-eff', dueDate: dueWed18, words: null }),
    ]);
    await new XtmPollCycle(db, cfg({ ACCEPT_SCHEDULE_ENABLED: false }), new StubAcceptor()).run(
      snapAt([], MON_10),
    );
    expect(activeHeldNoEffortAlerts()).toBe(0);
  });

  it('§9 audit trail: an accepted Malay job surfaces {day, wordsDueOn(day)} in summary.acceptedDueDays', async () => {
    fresh();
    // Held seed 200 due Wed, then accept a 100w-due-Wed job → the resulting Wed bucket is 300.
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'seed', dueDate: dueWed18, words: 200 })]);
    const acc = new StubAcceptor();
    const summary = await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ fileName: 'a.docx', dueDate: dueWed18, words: 100 })], MON_10),
    );
    expect(only('a.docx').lifecycleStatus).toBe('accepted');
    // The audit entry records the resulting Wed bucket the accept decision used (held + advance).
    expect(summary.acceptedDueDays).toEqual([
      { day: bangkokDateString(Date.parse(dueWed18)), resultingBucketEffort: 300 },
    ]);
  });

  it('§9 audit trail: a rejected (capacity-blocked) cycle carries an empty acceptedDueDays', async () => {
    fresh();
    new XtmJobStore(db).upsertMany([accepted({ jobKey: 'seed', dueDate: dueWed18, words: 950 })]);
    const summary = await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(
      snapAt([xraw({ dueDate: dueWed18, words: 100 })], MON_10), // 950 + 100 > 1000 → blocked
    );
    expect(summary.acceptedDueDays).toEqual([]); // nothing advanced → no audit entries
  });

  // --- effective-deadline-day cutoff (the live 2026-06-30 regression) ---------
  // A deadline whose Bangkok time is BEFORE the 09:00 work-start cannot be worked that
  // calendar day — its work lands the PREVIOUS working day, so the cap must bucket it there.
  const NOW_TUE = '2026-06-30T12:00:00+07:00'; // Bangkok Tuesday, working hours
  const dueTue2251 = '2026-06-30T22:51:00+07:00'; // after-hours, same day → effective 2026-06-30
  const dueWed0633 = '2026-07-01T06:33:00+07:00'; // before 09:00 → effective 2026-06-30 (prior day)
  const dueWed1400 = '2026-07-01T14:00:00+07:00'; // after 09:00 → effective 2026-07-01 (its own day)
  const TUE_DAY = bangkokDateString(Date.parse(dueTue2251)); // '2026-06-30'

  it('cutoff: a before-09:00 deadline buckets to the prior working day → second group over-cap rejected', async () => {
    fresh();
    // Group A already held: 858w due Tue 22:51 (after-hours, same day) → effective day 30/06.
    new XtmJobStore(db).upsertMany([
      accepted({ jobKey: 'A', fileName: 'A.docx', dueDate: dueTue2251, words: 858 }),
    ]);
    const acc = new StubAcceptor();
    // Group B: 377w due Wed 06:33 — BEFORE the 09:00 work-start, so its work lands the previous
    // working day (Tue 30/06), sharing A's bucket: 858 + 377 = 1235 > the 1000 cap → REJECTED.
    // Pre-fix it bucketed by the raw date (01/07, an empty bucket) and was wrongly accepted.
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ fileName: 'B.docx', dueDate: dueWed0633, words: 377 })], NOW_TUE),
    );
    expect(acc.calls.flat()).toHaveLength(0); // never clicked — correctly blocked
    expect(only('B.docx').lifecycleStatus).toBe('rejected');
    const note = sheetRows().find((r) => r.file === 'B.docx')?.note ?? '';
    expect(note).toContain('daily word cap reached');
    expect(note).toContain(TUE_DAY); // names the WORKING day the work lands on, not 01/07
  });

  it('cutoff inverse: a genuine next-working-day deadline (14:00) buckets to its own day → accepted', async () => {
    fresh();
    // Same held 858w on Tue 30/06, but the new job is due Wed 14:00 (AFTER 09:00) → effective
    // day 01/07, its OWN (empty) bucket → 377 ≤ cap → accepted (the cutoff only rolls back
    // deadlines BEFORE the work-start, never a genuine next-day-afternoon deadline).
    new XtmJobStore(db).upsertMany([
      accepted({ jobKey: 'A', fileName: 'A.docx', dueDate: dueTue2251, words: 858 }),
    ]);
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg(), acc).run(
      snapAt([xraw({ fileName: 'C.docx', dueDate: dueWed1400, words: 377 })], NOW_TUE),
    );
    expect(acc.calls.flat()).toHaveLength(1); // clicked — its own day is under cap
    expect(only('C.docx').lifecycleStatus).toBe('accepted');
  });

  // --- Task 6: effort-metric wiring (4721900 lock + D1 guards + capacity + D9 telemetry) ----
  // The real job 4721900 (861 raw words, 169 File WWC) pinned this regression: words mode
  // rejects it (need ~7.8h / have ~5.4h Mon 10:00→15:24), wwc mode accepts it (169 WWC, ~1.5h).

  it('4721900: metric=words rejects (feasibility keys off raw words)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(db, schedCfg({ ACCEPT_EFFORT_METRIC: 'words' }), acc).run(
      snapAt([j4721900()], MON_10),
    );
    expect(acc.calls.flat()).toHaveLength(0);
    const s = only();
    expect(s.lifecycleStatus).toBe('rejected');
    expect(s.rejectReason).toContain('cannot finish in time');
    expect(s.rejectReason).toContain('need ~7.8h');
    expect(s.rejectReason).toContain('have ~5.4h');
  });

  it('4721900: metric=wwc accepts the same job (effort=169 WWC)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(
      db,
      schedCfg({ ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: 1000 } as Partial<AppConfig>),
      acc,
    ).run(snapAt([j4721900()], MON_10));
    expect(acc.calls.flat()).toHaveLength(1);
    expect(only().lifecycleStatus).toBe('accepted');
  });

  it('D1 null-fallback: metric=wwc + fileWwc=null → rejected via raw words 861 (not accepted as 0)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(
      db,
      schedCfg({ ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: 1000 } as Partial<AppConfig>),
      acc,
    ).run(snapAt([xraw({ words: 861, fileWwc: null, dueDate: dueMon1524 })], MON_10));
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only().rejectReason).toContain('cannot finish in time');
  });

  it('D1 zero-guard: metric=wwc + fileWwc=0 → rejected (falls back to raw words, not treated as 0)', async () => {
    fresh();
    const acc = new StubAcceptor();
    await new XtmPollCycle(
      db,
      schedCfg({ ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: 1000 } as Partial<AppConfig>),
      acc,
    ).run(snapAt([xraw({ words: 861, fileWwc: 0, dueDate: dueMon1524 })], MON_10));
    expect(acc.calls.flat()).toHaveLength(0);
  });

  it('capacity keys off effort: WWC fits cap while raw words exceed it', async () => {
    fresh();
    const acc = new StubAcceptor();
    // words=1500 > cap=1000 (old code would reject); fileWwc=800 ≤ 1000 + far deadline → accepted
    await new XtmPollCycle(
      db,
      schedCfg({ ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: 1000 } as Partial<AppConfig>),
      acc,
    ).run(snapAt([xraw({ words: 1500, fileWwc: 800, dueDate: dueWed18 })], MON_10));
    expect(acc.calls.flat()).toHaveLength(1); // accepted (effort=800 ≤ cap=1000)
    expect(only().lifecycleStatus).toBe('accepted');
  });

  it('malformed job: metric=wwc + words=null + fileWwc=null → rejected "WWC count unknown"', async () => {
    fresh();
    const acc = new StubAcceptor();
    // Must supply unit so the rejection reason uses the active metric's label.
    await new XtmPollCycle(
      db,
      schedCfg({
        ACCEPT_EFFORT_METRIC: 'wwc',
        ACCEPT_MAX_WWC_PER_DAY: 1000,
        unit: { adj: 'WWC', noun: 'WWC' },
        capVar: 'ACCEPT_MAX_WWC_PER_DAY' as const,
      } as Partial<AppConfig>),
      acc,
    ).run(snapAt([xraw({ words: null, fileWwc: null, dueDate: dueWed18 })], MON_10));
    expect(acc.calls.flat()).toHaveLength(0);
    expect(only().rejectReason).toContain('WWC count unknown');
  });

  it('D9 telemetry: a words-mode reject carries raw words + effort + metric in scheduleRejects', async () => {
    fresh();
    const summary = await new XtmPollCycle(
      db,
      schedCfg({ ACCEPT_EFFORT_METRIC: 'words' }),
      new StubAcceptor(),
    ).run(snapAt([j4721900()], MON_10));
    const r = summary.scheduleRejects[0]!;
    expect(r.words).toBe(861);
    expect(r.effort).toBe(861); // words mode: effort === words
    expect(r.metric).toBe('words');
  });

  it('D9-wwc telemetry: a wwc-mode reject carries fileWwc as effort (not raw words)', async () => {
    fresh();
    // Tight deadline Mon 11:30 = 90 working minutes from MON_10 (10:00).
    // wwc=169, throughput=1000/9≈111/h: need ceil(169/111*60)=92 min > 90 → feasibility REJECTED.
    // Pins: effort in scheduleRejects must be fileWwc=169, NOT raw words=861.
    const summary = await new XtmPollCycle(
      db,
      schedCfg({
        ACCEPT_EFFORT_METRIC: 'wwc',
        ACCEPT_MAX_WWC_PER_DAY: 1000,
        activeMaxPerDay: 1000,
        unit: { adj: 'WWC', noun: 'WWC' },
        capVar: 'ACCEPT_MAX_WWC_PER_DAY' as const,
      } as Partial<AppConfig>),
      new StubAcceptor(),
    ).run(
      snapAt([xraw({ words: 861, fileWwc: 169, dueDate: '2026-06-22T11:30:00+07:00' })], MON_10),
    );
    const r = summary.scheduleRejects[0]!;
    expect(r.words).toBe(861);
    expect(r.effort).toBe(169); // wwc mode: effort = fileWwc, NOT raw words
    expect(r.metric).toBe('wwc');
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

// ---------------------------------------------------------------------------
// Task 8: live-regression lock — incident 4721900 (EMAIL vs EMAIL_1)
// Two XTM projects share the identical file name '4721900-1-6 (ID-91e1bdd17f80)_Proof.html'.
// On the OLD 3-field key (fileName|step|role, no projectName) both collapsed to the same
// DB entry: EMAIL_1 was treated as EMAIL "still visible", producing zero new Sheet rows and
// a relisted (🔁) card instead of a new-job (🆕) card.
// After Task 1 added projectName to the key this test must pass GREEN; it would FAIL on the
// old 3-field key at the first `toHaveLength(2)` assertion.
// ---------------------------------------------------------------------------
describe('XtmPollCycle regression: EMAIL vs EMAIL_1 project collision (incident 4721900, Task 8)', () => {
  const EMAIL_PROJECT = 'PR Newswire Release 4721900-1-3 (Basecamp Research) Affiliate EMAIL';
  const EMAIL1_PROJECT = 'PR Newswire Release 4721900-1-3 (Basecamp Research) Affiliate EMAIL_1';
  const FILE_NAME = '4721900-1-6 (ID-91e1bdd17f80)_Proof.html';

  // TZ-explicit deadlines (+07:00) — CI runs in TZ=UTC, these remain unambiguous.
  const EMAIL_DUE = '2026-06-30T22:51:00+07:00'; // Tue — EMAIL's deadline
  const EMAIL1_DUE = '2026-07-01T14:21:00+07:00'; // Wed — EMAIL_1's deadline (distinct day)

  // Cycle timestamps from the live incident (TZ-explicit for TZ=UTC safety in CI).
  const CYCLE_A_AT = '2026-06-29T19:51:00+07:00'; // Mon evening — cycle that saw EMAIL
  const CYCLE_B_AT = '2026-06-30T18:21:00+07:00'; // Tue evening — cycle that saw EMAIL_1

  // Accept timestamps deliberately differ so acceptedAt assertions are non-vacuous.
  const ACCEPT_A = '2026-06-29T12:51:00.000Z'; // UTC — EMAIL accepted in cycle A
  const ACCEPT_B = '2026-06-30T11:21:00.000Z'; // UTC — EMAIL_1 accepted in cycle B

  const emailJob = (): XtmRawJob =>
    xraw({ projectName: EMAIL_PROJECT, fileName: FILE_NAME, dueDate: EMAIL_DUE, words: 100 });
  const email1Job = (): XtmRawJob =>
    xraw({ projectName: EMAIL1_PROJECT, fileName: FILE_NAME, dueDate: EMAIL1_DUE, words: 100 });

  it(
    'same file name, different project → distinct keys, two Sheet rows, ' +
      'EMAIL_1 is 🆕 not 🔁, acceptedAt distinct, each has its own deadline',
    async () => {
      fresh();
      new MetaStore(db).markBaselineDone();

      // Acceptor records distinct at-timestamps per cycle so acceptedAt assertions are testable.
      let nextAcceptAt = ACCEPT_A;
      const acc = {
        async acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]> {
          const at = nextAcceptAt;
          return targets.map((t): AcceptResult => ({ jobKey: t.jobKey, outcome: 'accepted', at }));
        },
      };

      const cycle = new XtmPollCycle(db, cfg(), acc);

      // Cycle A: EMAIL project appears → accepted.
      await cycle.run(snapAt([emailJob()], CYCLE_A_AT, 'cA'));
      nextAcceptAt = ACCEPT_B; // advance before cycle B

      // Cycle B: SAME file name, DIFFERENT project → must be a wholly distinct new job.
      await cycle.run(snapAt([email1Job()], CYCLE_B_AT, 'cB'));

      const emailKey = computeXtmJobKey(emailJob());
      const email1Key = computeXtmJobKey(email1Job());

      // ── T8 core: keys MUST differ (on the old key they were identical) ──
      expect(emailKey, 'job keys must differ when only projectName changes').not.toBe(email1Key);

      // ── Two wholly separate DB records ──
      const allStates = [...new XtmJobStore(db).loadAll().values()];
      expect(allStates).toHaveLength(2); // old key → 1 (EMAIL_1 merged into EMAIL)

      const emailState = allStates.find((s) => s.jobKey === emailKey);
      const email1State = allStates.find((s) => s.jobKey === email1Key);
      expect(emailState, 'EMAIL job must be in DB').toBeDefined();
      expect(email1State, 'EMAIL_1 job must be in DB').toBeDefined();
      // Narrow for the property accesses below — a regression now yields a readable
      // toBeDefined() failure above instead of a TypeError on a non-null-asserted undefined.
      assert(emailState);
      assert(email1State);

      // ── Both accepted independently ──
      expect(emailState.lifecycleStatus).toBe('accepted');
      expect(email1State.lifecycleStatus).toBe('accepted');

      // ── acceptedAt is per-job: cycle A vs cycle B ──
      expect(emailState.acceptedAt).toBe(ACCEPT_A);
      expect(email1State.acceptedAt).toBe(ACCEPT_B);
      expect(email1State.acceptedAt).not.toBe(emailState.acceptedAt);

      // ── EMAIL_1 is a new job, not a relisted EMAIL ──
      // Accepted Malay jobs produce a ✅ card. On the OLD key EMAIL_1 was seen as EMAIL "still
      // visible, already accepted" → zero new chat events in cycle B. With the new key both
      // cycle A (EMAIL) and cycle B (EMAIL_1) each emit their own ✅ card.
      const allChat = outboxPayloads('chat');
      const acceptedCards = allChat.filter((c) => c.cardsV2?.[0]?.card.header.title.includes('✅'));
      // old key → 1 card (EMAIL_1 merged into EMAIL → cycle B emits nothing new)
      expect(acceptedCards, 'each accepted job must produce its own ✅ card').toHaveLength(2);
      // No 🔁 card: EMAIL_1 is never a "relisted" appearance of EMAIL (separate job entirely).
      const hasRelisted = allChat.some((c) => c.cardsV2?.[0]?.card.header.title.includes('🔁'));
      expect(hasRelisted, '🔁 card must NOT be emitted (EMAIL_1 is not a relisted EMAIL)').toBe(
        false,
      );

      // ── Two Sheet rows (one per distinct job) ──
      // old key → only 1 row because EMAIL_1 was seen as EMAIL "still visible" → no new outbox entry
      const sheets = outboxPayloads('sheets');
      expect(sheets).toHaveLength(2);

      // ── Each job carries its own deadline (deadline isolation, not sharing EMAIL's) ──
      expect(emailState.dueDate).toBe(EMAIL_DUE); // Tue 2026-06-30T22:51:00+07:00
      expect(email1State.dueDate).toBe(EMAIL1_DUE); // Wed 2026-07-01T14:21:00+07:00
    },
  );
});
