import { describe, expect, it } from 'vitest';
import { applySnapshot, emptyTrackerState } from '../../../src/straker/offerTracker.js';

describe('applySnapshot (Straker offer lifetime tracker)', () => {
  it('reports an offer id never seen before as appeared, stamped with the snapshot time', () => {
    const { state, appeared } = applySnapshot(emptyTrackerState(), {
      atMs: 1_000,
      offerIds: ['offer-a'],
    });

    const sighting = { objId: 'offer-a', firstSeenAtMs: 1_000, lastSeenAtMs: 1_000, sighting: 1 };
    expect(appeared).toEqual([sighting]);
    expect(state.live).toEqual([sighting]);
  });
});

describe('applySnapshot — an offer that is still listed', () => {
  it('keeps the original firstSeenAtMs and advances lastSeenAtMs without re-reporting it', () => {
    const first = applySnapshot(emptyTrackerState(), { atMs: 1_000, offerIds: ['offer-a'] });

    const { state, appeared } = applySnapshot(first.state, {
      atMs: 11_000,
      offerIds: ['offer-a'],
    });

    expect(appeared).toEqual([]);
    expect(state.live).toEqual([
      { objId: 'offer-a', firstSeenAtMs: 1_000, lastSeenAtMs: 11_000, sighting: 1 },
    ]);
  });
});

describe('applySnapshot — an offer that drops out of the open list', () => {
  it('reports it as vanished with the lifetime measured between first and last sighting', () => {
    const first = applySnapshot(emptyTrackerState(), { atMs: 1_000, offerIds: ['offer-a'] });
    const second = applySnapshot(first.state, { atMs: 31_000, offerIds: ['offer-a'] });

    const { state, vanished } = applySnapshot(second.state, { atMs: 41_000, offerIds: [] });

    expect(vanished).toEqual([
      {
        objId: 'offer-a',
        firstSeenAtMs: 1_000,
        lastSeenAtMs: 31_000,
        sighting: 1,
        notFoundAtMs: 41_000,
        lifetimeMs: 30_000,
      },
    ]);
    expect(state.live).toEqual([]);
  });
});

describe('applySnapshot — an offer that drops out and is listed again', () => {
  it('starts a fresh sighting but numbers it so a flapping id is not counted as a distinct offer', () => {
    const s1 = applySnapshot(emptyTrackerState(), { atMs: 1_000, offerIds: ['offer-a'] });
    const s2 = applySnapshot(s1.state, { atMs: 41_000, offerIds: [] });

    const { appeared } = applySnapshot(s2.state, { atMs: 61_000, offerIds: ['offer-a'] });

    expect(appeared).toEqual([
      { objId: 'offer-a', firstSeenAtMs: 61_000, lastSeenAtMs: 61_000, sighting: 2 },
    ]);
  });

  it('numbers the very first sighting of an id as 1', () => {
    const { appeared } = applySnapshot(emptyTrackerState(), {
      atMs: 1_000,
      offerIds: ['offer-b'],
    });

    expect(appeared[0]?.sighting).toBe(1);
  });
});
