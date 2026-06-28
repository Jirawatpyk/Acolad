import { describe, it, expect } from 'vitest';
import { diffXtm } from '../../src/detection/xtmDiff.js';
import type { XtmRawJob, XtmJobState, XtmJobSnapshot } from '../../src/detection/types.js';

const xraw = (over: Partial<XtmRawJob> = {}): XtmRawJob => ({
  xtmTaskId: 'ID-1001',
  projectName: 'Acme',
  fileName: 'chapter-01.docx',
  sourceLang: 'English (USA)',
  targetLang: 'Malay (Malaysia)',
  dueDate: null,
  dueRaw: '18-Jun-2026 19:25',
  words: 100,
  step: 'Post-Editing (PE) 1',
  role: 'Corrector',
  acceptAvailable: true,
  ...over,
});

const snap = (jobs: XtmRawJob[], cycle = 'c1'): XtmJobSnapshot => ({
  jobs,
  malformed: [],
  capturedAt: '2026-06-19T10:00:00+07:00',
  pollCycleId: cycle,
  emptyListConfirmed: jobs.length === 0,
});

describe('diffXtm (XTM appearance algorithm via generic diff)', () => {
  it('emits first_seen for a new job and builds a new XtmJobState', () => {
    const r = diffXtm(snap([xraw()]), new Map());
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.eventType).toBe('first_seen');
    const state = [...r.nextStates.values()][0];
    expect(state?.projectName).toBe('Acme');
    expect(state?.targetLang).toBe('Malay (Malaysia)');
    expect(state?.lifecycleStatus).toBe('new');
    expect(state?.acceptStatus).toBe('none');
    expect(state?.status).toBe('visible');
  });

  it('emits cold_start during baseline instead of first_seen', () => {
    const r = diffXtm(snap([xraw()]), new Map(), { baseline: true });
    expect(r.events[0]?.eventType).toBe('cold_start');
  });

  it('treats the same file+step+role as the same job across cycles (no re-notify)', () => {
    const first = diffXtm(snap([xraw()], 'c1'), new Map());
    const second = diffXtm(snap([xraw()], 'c2'), first.nextStates);
    expect(second.events).toHaveLength(0); // still visible → no event
  });

  it('does not flip to missing on a single absent poll (flicker)', () => {
    const first = diffXtm(snap([xraw()], 'c1'), new Map());
    const second = diffXtm(snap([], 'c2'), first.nextStates);
    expect(second.events).toHaveLength(0);
    const state = [...second.nextStates.values()][0];
    expect(state?.consecutiveMisses).toBe(1);
    expect(state?.status).toBe('visible');
  });

  it('emits missing after two consecutive absent polls', () => {
    const first = diffXtm(snap([xraw()], 'c1'), new Map());
    const second = diffXtm(snap([], 'c2'), first.nextStates);
    const third = diffXtm(snap([], 'c3'), second.nextStates);
    expect(third.events).toHaveLength(1);
    expect(third.events[0]?.eventType).toBe('missing');
    expect([...third.nextStates.values()][0]?.status).toBe('missing');
  });

  it('emits relisted when a missing job reappears, preserving original first-seen', () => {
    const first = diffXtm(snap([xraw()], 'c1'), new Map());
    const originalFirstSeen = [...first.nextStates.values()][0]?.firstSeenAt;
    const second = diffXtm(snap([], 'c2'), first.nextStates);
    const third = diffXtm(snap([], 'c3'), second.nextStates); // now missing
    const fourth = diffXtm(snap([xraw()], 'c4'), third.nextStates);
    expect(fourth.events[0]?.eventType).toBe('relisted');
    expect(fourth.events[0]?.firstSeenAt).toBe(originalFirstSeen);
  });

  it('preserves business fields (lifecycle/accept) on a still-visible refresh', () => {
    const first = diffXtm(snap([xraw()], 'c1'), new Map());
    // Orchestration mutates business state after diff:
    const prev = new Map<string, XtmJobState>();
    for (const [k, s] of first.nextStates) {
      prev.set(k, { ...s, lifecycleStatus: 'accepted', acceptStatus: 'accepted', eligible: true });
    }
    const second = diffXtm(snap([xraw({ words: 250 })], 'c2'), prev); // a detail changed
    const state = [...second.nextStates.values()][0];
    expect(state?.lifecycleStatus).toBe('accepted'); // diff must NOT reset business fields
    expect(state?.acceptStatus).toBe('accepted');
    expect(state?.eligible).toBe(true);
    expect(state?.words).toBe(250); // but the refreshed display field is updated
    expect(second.detailsChanges).toHaveLength(1);
  });
});

describe('diffXtm — held-job dueDate/words lock (F1, over-accept guard)', () => {
  const DUE = '2026-06-24T18:00:00+07:00'; // TZ-explicit (must pass under TZ=UTC)
  // Mark every state in a diff result as held (accepted) — mirrors what the
  // orchestration does after a successful accept.
  const heldFrom = (states: Map<string, XtmJobState>): Map<string, XtmJobState> => {
    const m = new Map<string, XtmJobState>();
    for (const [k, s] of states)
      m.set(k, { ...s, lifecycleStatus: 'accepted', acceptStatus: 'accepted', eligible: true });
    return m;
  };

  it('(a) keeps a held job committed dueDate/words when the grid re-reads them blank', () => {
    const first = diffXtm(snap([xraw({ dueDate: DUE, words: 800 })], 'c1'), new Map());
    const prev = heldFrom(first.nextStates);
    // Next cycle: the Due/Words cells read blank (transient grid race / late XHR).
    const second = diffXtm(snap([xraw({ dueDate: null, words: null })], 'c2'), prev);
    const s = [...second.nextStates.values()][0];
    expect(s?.dueDate).toBe(DUE); // locked — a null re-sync must NOT erase it
    expect(s?.words).toBe(800);
  });

  it('(a) does not emit a spurious dueDate/words change for the locked held job', () => {
    const first = diffXtm(snap([xraw({ dueDate: DUE, words: 800 })], 'c1'), new Map());
    const prev = heldFrom(first.nextStates);
    const second = diffXtm(snap([xraw({ dueDate: null, words: null })], 'c2'), prev);
    const fields = second.detailsChanges.flatMap((d) => d.changes.map((c) => c.field));
    // The committed values are unchanged (locked), so no Sheet-material re-sync should fire.
    expect(fields).not.toContain('dueDate');
    expect(fields).not.toContain('words');
  });

  it('(a) treats an unparseable (non-null) incoming dueDate as a blank and keeps the committed one', () => {
    const first = diffXtm(snap([xraw({ dueDate: DUE, words: 800 })], 'c1'), new Map());
    const prev = heldFrom(first.nextStates);
    const second = diffXtm(snap([xraw({ dueDate: 'not-a-date', words: 800 })], 'c2'), prev);
    expect([...second.nextStates.values()][0]?.dueDate).toBe(DUE);
  });

  it('(b) still takes a genuine non-null dueDate/words change on a held job (deadline extended)', () => {
    const due2 = '2026-06-26T18:00:00+07:00';
    const first = diffXtm(snap([xraw({ dueDate: DUE, words: 800 })], 'c1'), new Map());
    const prev = heldFrom(first.nextStates);
    const second = diffXtm(snap([xraw({ dueDate: due2, words: 900 })], 'c2'), prev);
    const s = [...second.nextStates.values()][0];
    expect(s?.dueDate).toBe(due2); // legitimate update honored
    expect(s?.words).toBe(900);
  });

  it('(c) does NOT lock for a non-accepted job (a null re-sync still nulls)', () => {
    const first = diffXtm(snap([xraw({ dueDate: DUE, words: 800 })], 'c1'), new Map());
    // stays 'new' / 'none' (never accepted)
    const second = diffXtm(snap([xraw({ dueDate: null, words: null })], 'c2'), first.nextStates);
    const s = [...second.nextStates.values()][0];
    expect(s?.dueDate).toBeNull();
    expect(s?.words).toBeNull();
  });
});
