import { describe, it, expect } from 'vitest';
import { diff, MISSING_THRESHOLD } from '../../src/detection/diff.js';
import type { JobSnapshot, RawJob } from '../../src/detection/types.js';

const raw = (over: Partial<RawJob> = {}): RawJob => ({
  portalJobId: 'J1',
  title: 'Job 1',
  languagePair: 'EN>TH',
  deadline: null,
  deadlineRaw: null,
  fee: null,
  url: null,
  ...over,
});

const snap = (jobs: RawJob[], over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  jobs,
  malformed: [],
  capturedAt: '2026-06-10T10:00+07:00',
  pollCycleId: 'cycle-1',
  emptyListConfirmed: jobs.length === 0,
  ...over,
});

describe('diff', () => {
  it('emits first_seen for a brand-new job', () => {
    const r = diff(snap([raw()]), new Map());
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.eventType).toBe('first_seen');
    expect(r.nextStates.get('J1')!.status).toBe('visible');
  });

  it('emits cold_start instead of first_seen during baseline', () => {
    const r = diff(snap([raw()]), new Map(), { baseline: true });
    expect(r.events[0]!.eventType).toBe('cold_start');
  });

  it('does not re-notify a job that stays visible', () => {
    const first = diff(snap([raw()]), new Map());
    const second = diff(snap([raw()]), first.nextStates);
    expect(second.events).toHaveLength(0);
  });

  it('ignores a single missing poll (flicker) but bumps the counter', () => {
    const first = diff(snap([raw()]), new Map());
    const gone = diff(snap([]), first.nextStates);
    expect(gone.events).toHaveLength(0);
    expect(gone.nextStates.get('J1')!.status).toBe('visible');
    expect(gone.nextStates.get('J1')!.consecutiveMisses).toBe(1);
  });

  it('emits missing only after MISSING_THRESHOLD consecutive absent polls', () => {
    let state = diff(snap([raw()]), new Map()).nextStates;
    for (let i = 1; i < MISSING_THRESHOLD; i++) {
      state = diff(snap([]), state).nextStates;
    }
    const final = diff(snap([]), state);
    expect(final.events.map((e) => e.eventType)).toContain('missing');
    expect(final.nextStates.get('J1')!.status).toBe('missing');
  });

  it('emits relisted with original firstSeenAt when a missing job returns', () => {
    const t0 = diff(snap([raw()], { capturedAt: '2026-06-10T09:00+07:00' }), new Map());
    // drive to missing
    let s = t0.nextStates;
    for (let i = 0; i < MISSING_THRESHOLD; i++) s = diff(snap([]), s).nextStates;
    const back = diff(snap([raw()]), s);
    const relisted = back.events.find((e) => e.eventType === 'relisted');
    expect(relisted).toBeDefined();
    expect(relisted!.firstSeenAt).toBe('2026-06-10T09:00+07:00');
  });

  it('records a detail change silently (no event) when a visible job is edited', () => {
    const first = diff(snap([raw({ fee: '€100' })]), new Map());
    const edited = diff(snap([raw({ fee: '€200' })]), first.nextStates);
    expect(edited.events).toHaveLength(0);
    expect(edited.detailsChanges).toHaveLength(1);
    expect(edited.detailsChanges[0]!.changes).toContainEqual({
      field: 'fee',
      from: '€100',
      to: '€200',
    });
  });

  it('processes a burst of 25 new jobs with one event each (SC-008)', () => {
    const jobs = Array.from({ length: 25 }, (_, i) =>
      raw({ portalJobId: `J${i}`, title: `Job ${i}` }),
    );
    const r = diff(snap(jobs), new Map());
    expect(r.events).toHaveLength(25);
    expect(new Set(r.events.map((e) => e.jobKey)).size).toBe(25);
    expect(r.events.every((e) => e.eventType === 'first_seen')).toBe(true);
  });
});
