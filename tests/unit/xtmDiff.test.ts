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
  fileWwc: 50,
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

  it('(#12) preserves rejectReason across a re-sync (a business field, not read from the grid)', () => {
    // applyXtmState carries rejectReason only via the `...existing` spread (it is owned by the
    // orchestration, never read from the grid). This pins that invariant against a future refactor
    // that converts applyXtmState to explicit fields and silently drops rejectReason.
    const first = diffXtm(snap([xraw()], 'c1'), new Map());
    const prev = new Map<string, XtmJobState>();
    for (const [k, s] of first.nextStates) {
      prev.set(k, { ...s, rejectReason: 'group blocked: holiday_calendar_stale' });
    }
    // A genuine grid-field change (words) on a NON-held job → the display change still applies…
    const second = diffXtm(snap([xraw({ words: 250 })], 'c2'), prev);
    const state = [...second.nextStates.values()][0];
    expect(state?.rejectReason).toBe('group blocked: holiday_calendar_stale'); // …while rejectReason survives
    expect(state?.words).toBe(250);
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

  // isHeld is `acceptStatus==='accepted' || lifecycleStatus==='accepted'`. The (a)/(b) cases
  // above set BOTH fields, so they would still pass under an `&&`. These two single-field cases
  // prove the `||`: a job held by EITHER field alone must lock against a blank re-read.
  it('(d) locks when held by lifecycleStatus=accepted ALONE (acceptStatus none) — proves the ||', () => {
    const first = diffXtm(snap([xraw({ dueDate: DUE, words: 800 })], 'c1'), new Map());
    const prev = new Map<string, XtmJobState>();
    for (const [k, s] of first.nextStates)
      prev.set(k, { ...s, lifecycleStatus: 'accepted', acceptStatus: 'none' });
    const second = diffXtm(snap([xraw({ dueDate: null, words: null })], 'c2'), prev);
    const s = [...second.nextStates.values()][0];
    expect(s?.dueDate).toBe(DUE); // held by lifecycle alone → committed deadline kept (not &&)
    expect(s?.words).toBe(800);
  });

  it('(d) locks when held by acceptStatus=accepted ALONE (lifecycle not accepted) — proves the ||', () => {
    const first = diffXtm(snap([xraw({ dueDate: DUE, words: 800 })], 'c1'), new Map());
    const prev = new Map<string, XtmJobState>();
    for (const [k, s] of first.nextStates)
      prev.set(k, { ...s, lifecycleStatus: 'new', acceptStatus: 'accepted' });
    const second = diffXtm(snap([xraw({ dueDate: null, words: null })], 'c2'), prev);
    const s = [...second.nextStates.values()][0];
    expect(s?.dueDate).toBe(DUE); // held by acceptStatus alone → committed deadline kept (not &&)
    expect(s?.words).toBe(800);
  });
});

describe('diffXtm — held-job fileWwc lock (Sheet-committed display field, mirrors words)', () => {
  const heldFrom = (states: Map<string, XtmJobState>): Map<string, XtmJobState> => {
    const m = new Map<string, XtmJobState>();
    for (const [k, s] of states)
      m.set(k, { ...s, lifecycleStatus: 'accepted', acceptStatus: 'accepted', eligible: true });
    return m;
  };

  it('(a) keeps a held job committed fileWwc when the grid re-reads it blank, with no spurious change', () => {
    const first = diffXtm(snap([xraw({ fileWwc: 800 })], 'c1'), new Map());
    const prev = heldFrom(first.nextStates);
    const second = diffXtm(snap([xraw({ fileWwc: null })], 'c2'), prev);
    expect([...second.nextStates.values()][0]?.fileWwc).toBe(800); // locked — null must NOT erase it
    const fields = second.detailsChanges.flatMap((d) => d.changes.map((c) => c.field));
    expect(fields).not.toContain('fileWwc'); // committed value unchanged → no Sheet re-sync
  });

  it('(b) still takes a genuine fileWwc change on a held job (a real re-weight)', () => {
    const first = diffXtm(snap([xraw({ fileWwc: 800 })], 'c1'), new Map());
    const prev = heldFrom(first.nextStates);
    const second = diffXtm(snap([xraw({ fileWwc: 900 })], 'c2'), prev);
    expect([...second.nextStates.values()][0]?.fileWwc).toBe(900);
  });

  it('(b2) keeps a committed value of 0 as a real value (locks only on null/NaN)', () => {
    const first = diffXtm(snap([xraw({ fileWwc: 0 })], 'c1'), new Map());
    const prev = heldFrom(first.nextStates);
    const second = diffXtm(snap([xraw({ fileWwc: null })], 'c2'), prev);
    expect([...second.nextStates.values()][0]?.fileWwc).toBe(0); // 0 preserved, not treated as blank
  });

  it('(c) does NOT lock fileWwc for a non-accepted job (a null re-read still nulls)', () => {
    const first = diffXtm(snap([xraw({ fileWwc: 800 })], 'c1'), new Map());
    const second = diffXtm(snap([xraw({ fileWwc: null })], 'c2'), first.nextStates); // stays new/none
    expect([...second.nextStates.values()][0]?.fileWwc).toBeNull();
  });

  it('(c) a non-held job syncs a changed fileWwc normally and reports it as a material change', () => {
    const first = diffXtm(snap([xraw({ fileWwc: 100 })], 'c1'), new Map());
    const second = diffXtm(snap([xraw({ fileWwc: 250 })], 'c2'), first.nextStates);
    expect([...second.nextStates.values()][0]?.fileWwc).toBe(250);
    const fields = second.detailsChanges.flatMap((d) => d.changes.map((c) => c.field));
    expect(fields).toContain('fileWwc');
  });
});
