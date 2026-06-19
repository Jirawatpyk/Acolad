import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { XtmPollCycle } from '../../src/runtime/xtmPollCycle.js';
import { XtmJobStore } from '../../src/state/xtmJobStore.js';
import { MetaStore } from '../../src/state/meta.js';
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
