/**
 * FR-019c / V31 — the backoff of FR-019b applies to READING ONLY. The claim path never
 * retries, at any interval, because the risk there is a duplicate irreversible commitment
 * rather than a wasted request (FR-005, R7). A claim whose outcome is unknown is left
 * unknown and settled by reconciliation (FR-016a).
 *
 * ## Why this asserts against the transport rather than against `claim.ts`
 *
 * `src/straker/claim.ts` is Phase 3 (T035) and does not exist yet. The guarantee is
 * therefore written against the **transport-level claim dispatch** the claim path will
 * use — `postJson`, the one door a POST can go through — so it holds *now* and the Phase 3
 * implementation inherits it instead of having to re-earn it. That is also where the
 * guarantee belongs: FR-030 (DC-4) puts every request-issuing concern in the transport,
 * so "a claim is never retried" is a property of the transport, not of its caller's
 * discipline. A later `claim.ts` that reached for a retry would have to add a new method
 * to the transport to get one — which is exactly the change this file is here to block.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createHttpClient,
  StrakerHttpError,
  StrakerRetryExhaustedError,
} from '../../../src/straker/httpClient.js';
import type { StrakerHttpClient } from '../../../src/straker/httpClient.js';

const OFFERS_PATH = '/api/vendors/v1/job-offers?status=open';

/** A policy deliberately eager to retry, so any leak into the claim path shows up loudly. */
const EAGER_RETRY = { maxAttempts: 5, baseDelayMs: 10, factor: 2, maxDelayMs: 100 };

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': 'application/json' }),
  });
}

/** A fresh failing response per call — one `Response` body cannot be read twice. */
function alwaysFailing(status: number): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(jsonResponse({}, { status })));
}

function sleepRecorder(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
    },
  };
}

/**
 * The dispatch Phase 3's `claim.ts` will make: one offer, one POST, one attempt. The exact
 * endpoint is unconfirmed — contract §4 is NOT YET EXERCISED — and nothing here depends on
 * its shape. What matters is that a claim is a POST, and that a POST has no route into the
 * retry loop.
 */
async function dispatchClaim(client: StrakerHttpClient, objId: string): Promise<unknown> {
  return client.postJson(`/api/vendors/v1/job-offers/${objId}/claim`, { obj_id: objId });
}

/**
 * Compile-time lock. `postJson` takes a path and a body and nothing else — the day someone
 * gives the claim path's only door a retry option, this stops `npm run typecheck` rather
 * than waiting for a duplicate claim to show it in production.
 */
type ClaimDispatchParams = Parameters<StrakerHttpClient['postJson']>;
type _AssertTrue<T extends true> = T;
type _ClaimDispatchTakesNoOptions = _AssertTrue<
  ClaimDispatchParams['length'] extends 2 ? true : false
>;

describe('claim dispatch — the backoff never reaches the claim path (FR-019c, V31)', () => {
  it('attempts a claim that came back a server fault exactly once', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: EAGER_RETRY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await expect(dispatchClaim(client, 'off-1')).rejects.toBeInstanceOf(StrakerHttpError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('attempts a claim whose request never answered exactly once — the outcome stays unknown', async () => {
    // The worst case in the whole feature: the request may or may not have landed on the
    // portal. A second attempt would be the same irreversible commitment made twice, so
    // the unknown is left standing for reconciliation (FR-016a) to settle.
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: EAGER_RETRY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await expect(dispatchClaim(client, 'off-1')).rejects.toThrow(/fetch failed/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits at no interval before a claim — there is no interval at which one is retried', async () => {
    const fetchImpl = alwaysFailing(503);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: EAGER_RETRY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await dispatchClaim(client, 'off-1').catch(() => undefined);

    // V31 is about "no second attempt at any interval", not merely "no fast retry".
    expect(timer.waits).toEqual([]);
  });

  it('backs off on the read and does not on the claim — from one and the same client', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: EAGER_RETRY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);
    const afterRead = fetchImpl.mock.calls.length;
    await dispatchClaim(client, 'off-1').catch(() => undefined);

    // The asymmetry is a property of the transport, not of how it happened to be built:
    // the same instance, the same failure, two different answers.
    expect(afterRead).toBe(EAGER_RETRY.maxAttempts);
    expect(fetchImpl.mock.calls.length - afterRead).toBe(1);
  });

  it('raises no transport exhaustion alert for a failed claim — that outcome is not the transport to judge', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const onAlert = vi.fn();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: EAGER_RETRY,
      sleep: timer.sleep,
      random: () => 1,
      onAlert,
    });

    const error: unknown = await dispatchClaim(client, 'off-1').catch((e: unknown) => e);

    // A failed claim alerts through the claim-outcome model (`alertsOn` in types.ts), keyed
    // by offer identity so FR-019a can de-duplicate it. If the transport alerted too, the
    // same event would page twice from two places with no shared de-duplication.
    expect(onAlert).not.toHaveBeenCalled();
    expect(error).not.toBeInstanceOf(StrakerRetryExhaustedError);
    expect(error).toBeInstanceOf(StrakerHttpError);
  });

  it('issues only reads from inside the retry loop, so no claim can ever be made from it', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: EAGER_RETRY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    // The structural half of the guarantee: the retry loop builds its own GET request and
    // accepts no caller-supplied method or body, so "the claim path must not opt in" is not
    // a rule anyone has to remember — there is nothing to opt in with.
    const methods = fetchImpl.mock.calls.map((call) => call[1]?.method);
    expect(methods).toHaveLength(EAGER_RETRY.maxAttempts);
    expect(new Set(methods)).toEqual(new Set(['GET']));
  });

  it('keeps the compile-time lock on the claim door honest', () => {
    // The type above is the assertion; this test exists so the lock is visible in the run
    // and a reader does not have to know that `npm run typecheck` is what enforces it.
    const lock: _ClaimDispatchTakesNoOptions = true;
    expect(lock).toBe(true);
  });
});
