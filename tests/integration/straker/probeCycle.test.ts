import { describe, expect, it, vi } from 'vitest';
import { StrakerHttpError } from '../../../src/straker/httpClient.js';
import { emptyTrackerState } from '../../../src/straker/offerTracker.js';
import { runProbeCycle } from '../../../src/straker/probe.js';
import type { ProbeDeps } from '../../../src/straker/probe.js';

const OFFER = {
  obj_id: 'off-1',
  job_ref: 'JR-1',
  listing_type: 'direct_po',
  source_lang: 'en-gb',
  target_lang: 'ms-my',
  due_at: '2026-09-20T05:59:59.999Z',
  weighted_words: 812,
  words: 1000,
  budget: '35.00',
  currency: 'USD',
};

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    vendorId: 'vendor-1',
    listOpenOffers: vi.fn().mockResolvedValue([OFFER]),
    captureOffer: vi.fn().mockResolvedValue(undefined),
    recordEvent: vi.fn().mockResolvedValue(undefined),
    reopenSession: vi.fn().mockResolvedValue(undefined),
    now: () => 1_000,
    ...overrides,
  };
}

describe('runProbeCycle', () => {
  it('captures the raw payload of an offer the probe has never seen before', async () => {
    const d = deps();

    await runProbeCycle(d, emptyTrackerState());

    expect(d.captureOffer).toHaveBeenCalledWith('off-1', OFFER, 1_000);
  });
});

describe('runProbeCycle — a read that fails', () => {
  it('keeps the previous tracker state instead of recording every live offer as vanished', async () => {
    const seeded = await runProbeCycle(deps(), emptyTrackerState());
    const failing = deps({
      listOpenOffers: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
      now: () => 11_000,
    });

    const outcome = await runProbeCycle(failing, seeded.state);

    expect(outcome.ok).toBe(false);
    expect(outcome.state.live).toEqual(seeded.state.live);
  });

  it('records a failure event so a silent outage cannot hide in the dataset', async () => {
    const failing = deps({
      listOpenOffers: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
      now: () => 11_000,
    });

    await runProbeCycle(failing, emptyTrackerState());

    expect(failing.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'read_failed', atMs: 11_000 }),
    );
  });
});

describe('runProbeCycle — events', () => {
  it('emits an appeared event carrying the sighting number for a newly listed offer', async () => {
    const d = deps();

    await runProbeCycle(d, emptyTrackerState());

    expect(d.recordEvent).toHaveBeenCalledWith({
      kind: 'appeared',
      objId: 'off-1',
      atMs: 1_000,
      sighting: 1,
    });
  });

  it('emits a vanished event with both lifetime bounds when the offer leaves the list', async () => {
    const seeded = await runProbeCycle(deps(), emptyTrackerState());
    const gone = deps({ listOpenOffers: vi.fn().mockResolvedValue([]), now: () => 31_000 });

    await runProbeCycle(gone, seeded.state);

    expect(gone.recordEvent).toHaveBeenCalledWith({
      kind: 'vanished',
      objId: 'off-1',
      atMs: 31_000,
      lifetimeMs: 0,
      upperBoundMs: 30_000,
    });
  });
});

describe('runProbeCycle — session expiry (Constitution failure-mode suite)', () => {
  it('re-opens the session and retries once when the read is rejected with 401', async () => {
    const listOpenOffers = vi
      .fn()
      .mockRejectedValueOnce(new StrakerHttpError(401, '/api/vendors/vendor-1/job-offers', ''))
      .mockResolvedValueOnce([OFFER]);
    const reopenSession = vi.fn().mockResolvedValue(undefined);
    const d = deps({ listOpenOffers, reopenSession });

    const outcome = await runProbeCycle(d, emptyTrackerState());

    expect(reopenSession).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(true);
    expect(outcome.state.live.map((o) => o.objId)).toEqual(['off-1']);
  });

  it('does not re-login on a 500, which is a server fault rather than an expired session', async () => {
    const listOpenOffers = vi
      .fn()
      .mockRejectedValue(new StrakerHttpError(500, '/api/vendors/vendor-1/job-offers', ''));
    const reopenSession = vi.fn().mockResolvedValue(undefined);
    const d = deps({ listOpenOffers, reopenSession });

    const outcome = await runProbeCycle(d, emptyTrackerState());

    expect(reopenSession).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
  });

  it('gives up after one re-login so an expired-credential loop cannot hammer the portal', async () => {
    const listOpenOffers = vi
      .fn()
      .mockRejectedValue(new StrakerHttpError(401, '/api/vendors/vendor-1/job-offers', ''));
    const reopenSession = vi.fn().mockResolvedValue(undefined);
    const d = deps({ listOpenOffers, reopenSession });

    const outcome = await runProbeCycle(d, emptyTrackerState());

    expect(reopenSession).toHaveBeenCalledTimes(1);
    expect(listOpenOffers).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(false);
  });
});
