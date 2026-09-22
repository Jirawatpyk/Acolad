import { describe, expect, it, vi } from 'vitest';
import {
  createHttpClient,
  DEFAULT_PACING_POLICY,
  isBudgetSuspended,
  isCredentialRefusal,
  isIndeterminateStatus,
  isSessionExpired,
  StrakerBudgetSuspendedError,
  StrakerHttpError,
  StrakerRetryExhaustedError,
  StrakerTimeoutError,
} from '../../../src/straker/httpClient.js';
import type {
  PacingPolicy,
  StrakerHttpClient,
  StrakerPacedHttpClient,
  StrakerPacingEvent,
} from '../../../src/straker/httpClient.js';

function jsonResponse(body: unknown, init: { status?: number; headers?: Headers } = {}): Response {
  const headers = init.headers ?? new Headers();
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

describe('createHttpClient — cookie jar', () => {
  it('replays a cookie captured from an earlier response on the next request', async () => {
    const withCookie = new Headers();
    withCookie.append('set-cookie', 'session=abc123; Path=/; HttpOnly');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true }, { headers: withCookie }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await client.postJson('/api/vendor/auth/login', { login_id: 'x' });
    await client.getJson('/api/vendor/auth/me');

    const secondInit = fetchImpl.mock.calls[1]?.[1];
    expect(new Headers(secondInit?.headers).get('cookie')).toBe('session=abc123');
  });
});

describe('createHttpClient — failure is loud', () => {
  it('throws on a non-2xx response instead of handing the body back as data', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ detail: 'boom' }, { status: 500 }));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await expect(client.getJson('/api/vendors/v1/job-offers?status=open')).rejects.toThrow(/500/);
  });

  it('reports the status on the error so a 401 can be told apart from a 500', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, { status: 401 }));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await expect(client.getJson('/api/vendor/auth/me')).rejects.toMatchObject({ status: 401 });
  });
});

describe('createHttpClient — rate-limit budget', () => {
  it('exposes the x-ratelimit headers from the most recent response', async () => {
    const headers = new Headers({
      'x-ratelimit-limit': '300',
      'x-ratelimit-remaining': '294',
      'x-ratelimit-reset': '1788000060',
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([], { headers }));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await client.getJson('/api/vendors/v1/job-offers?status=open');

    expect(client.lastRateLimit()).toEqual({
      limit: 300,
      remaining: 294,
      resetAtEpoch: 1788000060,
    });
  });

  it('reports null rather than zeros when the server sends no rate-limit headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await client.getJson('/api/vendors/v1/job-offers?status=open');

    expect(client.lastRateLimit()).toBeNull();
  });
});

describe('createHttpClient — browser-shaped request headers', () => {
  it('sends an Origin matching the base URL, which the API rejects requests without', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await client.getJson('/api/vendors/v1/job-offers?status=open');

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get('origin')).toBe('https://portal.test');
  });

  it('sends a Referer from the same origin, as the portal SPA does', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await client.getJson('/api/vendor/auth/me');

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get('referer')).toBe('https://portal.test/');
  });
});

/**
 * FR-019b / V30 / Constitution IV — backoff on the READING path.
 *
 * The timer and the jitter source are injected, so these assert the intervals themselves
 * without a millisecond of wall-clock waiting. Every client below is built with a retry
 * policy on purpose: part of what these assert is that configuring one still leaves
 * everything except the explicit backoff read on a single attempt.
 */
const OFFERS_PATH = '/api/vendors/v1/job-offers?status=open';
const TEST_POLICY = { maxAttempts: 4, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 };

/**
 * A fetch stub that answers every call with a FRESH failing response. A `Response` body
 * can only be read once, so a stub that hands back one shared instance breaks the moment
 * a retry reads it again — an artefact of the harness, not of the client.
 */
function alwaysFailing(status: number): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(jsonResponse({}, { status })));
}

/** Records what the client asked to wait for, and returns immediately. */
function sleepRecorder(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
    },
  };
}

function strictlyIncreasing(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? 0));
}

describe('createHttpClient — backoff on the reading path (FR-019b)', () => {
  it('retries a server fault on the offer-list read instead of surfacing the first one', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ detail: 'boom' }, { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ detail: 'boom' }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse([{ obj_id: 'off-1' }]));
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await expect(client.getJsonWithBackoff(OFFERS_PATH)).resolves.toEqual([{ obj_id: 'off-1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('waits a growing interval between attempts, so a struggling portal is not hammered', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await expect(client.getJsonWithBackoff(OFFERS_PATH)).rejects.toBeInstanceOf(
      StrakerRetryExhaustedError,
    );
    expect(timer.waits).toEqual([100, 200, 400]);
  });

  it('jitters each interval, so two clients failing together do not retry in lockstep', async () => {
    async function waitsFor(random: () => number): Promise<number[]> {
      const fetchImpl = alwaysFailing(500);
      const timer = sleepRecorder();
      const client = createHttpClient({
        baseUrl: 'https://portal.test',
        fetchImpl,
        retry: TEST_POLICY,
        sleep: timer.sleep,
        random,
      });
      await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);
      return timer.waits;
    }

    const early = await waitsFor(() => 0.25);
    const late = await waitsFor(() => 0.75);

    expect(early).not.toEqual(late);
    // Jitter moves an interval within its own step, never outside it: a client back before
    // half the step has not meaningfully backed off at all.
    for (const waits of [early, late]) {
      waits.forEach((wait, index) => {
        const step = TEST_POLICY.baseDelayMs * TEST_POLICY.factor ** index;
        expect(wait).toBeGreaterThanOrEqual(step / 2);
        expect(wait).toBeLessThanOrEqual(step);
      });
    }
  });

  it('never lets jitter collapse an interval to no wait at all', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      // The worst case for jitter: a source pinned at its floor. Even there the intervals
      // must still grow, or "backoff with jitter" degenerates into hammering.
      random: () => 0,
    });

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    expect(timer.waits).toHaveLength(3);
    expect(Math.min(...timer.waits)).toBeGreaterThan(0);
    expect(strictlyIncreasing(timer.waits)).toBe(true);
  });

  it('holds every wait under the ceiling, so a long outage cannot stretch one into minutes', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: { maxAttempts: 6, baseDelayMs: 100, factor: 2, maxDelayMs: 250 },
      sleep: timer.sleep,
      random: () => 1,
    });

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    expect(timer.waits).toEqual([100, 200, 250, 250, 250]);
  });

  it('stops at the defined cap rather than retrying forever', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    expect(fetchImpl).toHaveBeenCalledTimes(TEST_POLICY.maxAttempts);
  });

  it('raises an alert when the cap is exhausted, rather than giving up quietly', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const onAlert = vi.fn();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
      onAlert,
    });

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]?.[0]).toMatchObject({
      kind: 'read_retries_exhausted',
      path: OFFERS_PATH,
      attempts: TEST_POLICY.maxAttempts,
    });
  });

  it('does not alert when a retry succeeds — a blip that recovered is not an incident', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse([]));
    const timer = sleepRecorder();
    const onAlert = vi.fn();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
      onAlert,
    });

    await client.getJsonWithBackoff(OFFERS_PATH);

    expect(onAlert).not.toHaveBeenCalled();
  });

  it('throws an exhaustion error distinguishable from an ordinary StrakerHttpError', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    const error: unknown = await client.getJsonWithBackoff(OFFERS_PATH).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StrakerRetryExhaustedError);
    // Distinguishable both ways: an exhausted read is a different operational event from a
    // single rejected request, and must not be caught by the same branch.
    expect(error).not.toBeInstanceOf(StrakerHttpError);
    expect(error).toMatchObject({ path: OFFERS_PATH, attempts: TEST_POLICY.maxAttempts });
  });

  it('rejects once the cap is exhausted — an exhausted read never reads as "no offers"', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    // FR-023 and the contract's governing rule: an exhausted read must not reach the
    // tracker as an empty list. That is the silent-zero family the XTM bot's 38-minute
    // outage belongs to — its mechanism was a different one, recorded in `offersApi.ts`,
    // but a zero believed as fact is invisible whichever route produced it. Settled
    // explicitly, because `rejects.toThrow` would also pass for a promise resolving to [].
    const settled = await client.getJsonWithBackoff<unknown[]>(OFFERS_PATH).then(
      (value) => ({ outcome: 'resolved' as const, value: value as unknown }),
      (error: unknown) => ({ outcome: 'rejected' as const, value: error }),
    );

    expect(settled.outcome).toBe('rejected');
  });

  it('retries a portal that cannot be reached at all, not only one that answers with a fault', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse([]));
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await expect(client.getJsonWithBackoff(OFFERS_PATH)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 401: an expired session is re-opened by the caller, not waited out', async () => {
    const fetchImpl = alwaysFailing(401);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await expect(client.getJsonWithBackoff(OFFERS_PATH)).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timer.waits).toEqual([]);
  });

  it('does not retry a 403 Origin rejection: it means the portal changed its rules', async () => {
    const fetchImpl = alwaysFailing(403);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await expect(client.getJsonWithBackoff(OFFERS_PATH)).rejects.toBeInstanceOf(StrakerHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('leaves the plain read on a single attempt, so the running capture probe is unchanged', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      // Configured, and still not applied: retry is opted into per call, never blanket-on-GET.
      // The reconciliation read (FR-016c) keeps its own 15-minute cadence by coming through here.
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await expect(client.getJson(OFFERS_PATH)).rejects.toBeInstanceOf(StrakerHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timer.waits).toEqual([]);
  });

  it('keeps the Origin header and the cookie jar on every retried attempt', async () => {
    const withCookie = new Headers();
    withCookie.append('set-cookie', 'session=abc123; Path=/; HttpOnly');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 500, headers: withCookie }))
      .mockResolvedValueOnce(jsonResponse([]));
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await client.getJsonWithBackoff(OFFERS_PATH);

    // Without Origin the portal refuses outright (confirmed live), so a retry that dropped
    // it would turn a transient fault into a guaranteed one.
    const retried = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(retried.get('origin')).toBe('https://portal.test');
    expect(retried.get('cookie')).toBe('session=abc123');
  });
});

/**
 * Guards that survived mutation until this point: each `it` below fails if the one line of
 * restraint it names is deleted or inverted. They are grouped by the decision they protect
 * rather than by the function they touch, because that is how the decision reads to
 * whoever is about to change it.
 */

/** A reply whose body dies while it is being read — a failing portal, cut off mid-sentence. */
function bodyDiesResponse(status: number): Response {
  const dying = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(dying, {
    status,
    // Content-Length promises a body that never arrives, which is what makes the read fail
    // rather than come back empty: the shape of a 503 whose connection resets behind it.
    headers: { 'content-type': 'application/json', 'content-length': '120' },
  });
}

const SANE_BUDGET = {
  'x-ratelimit-limit': '300',
  'x-ratelimit-remaining': '294',
  'x-ratelimit-reset': '1788000060',
};

describe('createHttpClient — a retry policy that would misbehave is refused at construction', () => {
  const build = (retry: Partial<Record<string, number>>): (() => unknown) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    return () => createHttpClient({ baseUrl: 'https://portal.test', fetchImpl, retry });
  };

  it('refuses a policy with no attempts in it', () => {
    expect(build({ maxAttempts: 0 })).toThrow(/maxAttempts/);
  });

  it('refuses a factor below 1 — the only thing making "the intervals grow" true for a custom policy', () => {
    // Every interval assertion in this file uses factor 2, so a shrinking factor sails past
    // all of them: at 0.5 the waits would be 100, 50, 25 and the client would come back
    // FASTER the longer the portal stayed broken.
    expect(build({ maxAttempts: 4, baseDelayMs: 100, factor: 0.5, maxDelayMs: 1_000 })).toThrow(
      /factor/,
    );
  });

  it('refuses a ceiling below the first step, which would silently discard the whole curve', () => {
    expect(build({ baseDelayMs: 250, maxDelayMs: 100 })).toThrow(/maxDelayMs/);
  });

  it('refuses a base delay of zero — an immediate retry has not backed off at all', () => {
    expect(build({ baseDelayMs: 0 })).toThrow(/baseDelayMs/);
  });

  it('accepts factor 1, the boundary, and holds the intervals steady rather than shrinking them', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: { maxAttempts: 4, baseDelayMs: 100, factor: 1, maxDelayMs: 1_000 },
      sleep: timer.sleep,
      random: () => 1,
    });

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    // A flat policy is a legitimate choice; a shrinking one is not. This pins where the
    // line sits, so the guard cannot be "tidied" into `factor > 1` either.
    expect(timer.waits).toEqual([100, 100, 100]);
  });
});

describe('createHttpClient — what is, and is not, worth asking again about', () => {
  it('does not retry a 2xx whose body is not JSON — a contract violation is not a blip', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        new Response('<html>scheduled maintenance</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    const error: unknown = await client.getJsonWithBackoff(OFFERS_PATH).catch((e: unknown) => e);

    // Retrying it would spend three more requests to reach the same verdict, and delay by
    // seconds the loud failure FR-023 asks for.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timer.waits).toEqual([]);
    expect(error).not.toBeInstanceOf(StrakerRetryExhaustedError);
  });

  it('does not retry a 429 — waiting it out spends the very allowance it reports is running low', async () => {
    const fetchImpl = alwaysFailing(429);
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    const error: unknown = await client.getJsonWithBackoff(OFFERS_PATH).catch((e: unknown) => e);

    // 429 belongs to the graduated budget response (FR-019, T064/T065), not to the backoff.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(timer.waits).toEqual([]);
    expect(error).toMatchObject({ status: 429 });
  });

  it('retries a 408 — the portal saying it was too slow is exactly the "slow" of FR-019b', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 408 }))
      .mockResolvedValueOnce(jsonResponse([{ obj_id: 'off-1' }]));
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
    });

    await expect(client.getJsonWithBackoff(OFFERS_PATH)).resolves.toEqual([{ obj_id: 'off-1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('createHttpClient — a reply whose body dies mid-read', () => {
  it('keeps the status, which is the diagnostic, when a rejected reply body dies', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(bodyDiesResponse(503)));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    const error: unknown = await client.getJson(OFFERS_PATH).catch((e: unknown) => e);

    // Left unguarded, the stream rejection escapes the attempt entirely and the caller is
    // told `TypeError: terminated` — true, useless, and with the 503 thrown away.
    expect(error).toBeInstanceOf(StrakerHttpError);
    expect(error).toMatchObject({ status: 503 });
  });

  it('still backs off on it: the verdict comes from the status, not from the body', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(bodyDiesResponse(503)));
    const timer = sleepRecorder();
    const onAlert = vi.fn();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
      onAlert,
    });

    const error: unknown = await client.getJsonWithBackoff(OFFERS_PATH).catch((e: unknown) => e);

    // An escaping rejection bypasses all of this at once: no backoff, no alert, and an
    // exhaustion error that never arrives.
    expect(fetchImpl).toHaveBeenCalledTimes(TEST_POLICY.maxAttempts);
    expect(error).toBeInstanceOf(StrakerRetryExhaustedError);
    expect((error as StrakerRetryExhaustedError).cause).toMatchObject({ status: 503 });
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});

describe('createHttpClient — a nonsensical budget reading is no reading at all', () => {
  const unusable: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ['an allowance of zero', { ...SANE_BUDGET, 'x-ratelimit-limit': '0' }],
    ['a negative remainder', { ...SANE_BUDGET, 'x-ratelimit-remaining': '-5' }],
    [
      'a reset stamp of zero, which reads as "the budget refreshed in 1970" and lifts all restraint',
      { ...SANE_BUDGET, 'x-ratelimit-reset': '0' },
    ],
    ['a word where a number belongs', { ...SANE_BUDGET, 'x-ratelimit-limit': 'unlimited' }],
  ];

  for (const [name, headers] of unusable) {
    it(`reports no budget for ${name}`, async () => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse([], { headers: new Headers(headers) }));
      const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

      await client.getJson(OFFERS_PATH);

      // FR-019 and contract section 3: a missing or nonsensical value must leave the hard
      // ceiling in charge. Handing a pacer a number it can do arithmetic on is how
      // restraint gets lost — `Number.isFinite` alone lets every one of these through.
      expect(client.lastRateLimit()).toBeNull();
    });
  }

  it('keeps a remainder of zero — a real reading, and the most restrictive one there is', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse([], {
        headers: new Headers({ ...SANE_BUDGET, 'x-ratelimit-remaining': '0' }),
      }),
    );
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await client.getJson(OFFERS_PATH);

    // The guard above must not swallow this one: "you have none left" is the single most
    // important budget reading the portal ever sends.
    expect(client.lastRateLimit()).toEqual({
      limit: 300,
      remaining: 0,
      resetAtEpoch: 1788000060,
    });
  });
});

describe('createHttpClient — the budget going unreadable is warned about, not silently forgotten', () => {
  /**
   * Replies are built per call, never shared: one `Response` body can only be read once,
   * so a reused instance fails on the second request for a reason that has nothing to do
   * with the budget. The last entry repeats, which is how "and it stays that way" is said.
   */
  function clientWithWarnings(replies: ReadonlyArray<() => Response>): {
    client: StrakerHttpClient;
    warnings: ReturnType<typeof vi.fn>;
  } {
    let index = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      const reply = replies[Math.min(index, replies.length - 1)] as () => Response;
      index += 1;
      return Promise.resolve(reply());
    });
    const warnings = vi.fn();
    return {
      client: createHttpClient({ baseUrl: 'https://portal.test', fetchImpl, onWarning: warnings }),
      warnings,
    };
  }

  it('warns when the budget headers disappear from a reply that used to carry them', async () => {
    const { client, warnings } = clientWithWarnings([
      () => jsonResponse([], { headers: new Headers(SANE_BUDGET) }),
      () => jsonResponse([]),
    ]);

    await client.getJson(OFFERS_PATH);
    await client.getJson(OFFERS_PATH);

    // Change-detection table: budget headers disappearing must fall back to the hard
    // ceiling AND warn. Overwriting the snapshot with null does the forgetting silently.
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0]?.[0]).toMatchObject({
      kind: 'rate_limit_unknown',
      reason: 'headers_missing',
    });
  });

  it('warns once while they stay missing, rather than on every reply', async () => {
    const { client, warnings } = clientWithWarnings([() => jsonResponse([])]);

    await client.getJson(OFFERS_PATH);
    await client.getJson(OFFERS_PATH);
    await client.getJson(OFFERS_PATH);

    // At a ten-second rhythm, one warning per reply is 8,640 lines a day about one fact.
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  it('tells a nonsensical reading apart from a missing one — they are different faults', async () => {
    const { client, warnings } = clientWithWarnings([
      () =>
        jsonResponse([], { headers: new Headers({ ...SANE_BUDGET, 'x-ratelimit-reset': '-1' }) }),
    ]);

    await client.getJson(OFFERS_PATH);

    expect(warnings.mock.calls[0]?.[0]).toMatchObject({ reason: 'headers_nonsensical' });
  });

  it('stays quiet while the budget keeps reading normally', async () => {
    const { client, warnings } = clientWithWarnings([
      () => jsonResponse([], { headers: new Headers(SANE_BUDGET) }),
    ]);

    await client.getJson(OFFERS_PATH);
    await client.getJson(OFFERS_PATH);

    expect(warnings).not.toHaveBeenCalled();
  });

  it('keeps a good read alive when the warning sink itself throws', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(jsonResponse([{ obj_id: 'off-1' }])));
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      onWarning: () => {
        throw new Error('log transport is down');
      },
    });

    // The warning rides the SUCCESS path, so a sink that throws would turn a perfectly good
    // offer-list read into a failed one — the failure an observability hook must never add.
    await expect(client.getJson(OFFERS_PATH)).resolves.toEqual([{ obj_id: 'off-1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createHttpClient — the alert sink cannot replace the failure it reports', () => {
  it('lets the read failure through when the alert sink itself throws', async () => {
    const fetchImpl = alwaysFailing(500);
    const timer = sleepRecorder();
    const onAlert = vi.fn(() => {
      throw new Error('chat webhook is down');
    });
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
      onAlert,
    });

    const error: unknown = await client.getJsonWithBackoff(OFFERS_PATH).catch((e: unknown) => e);

    // Without the try/catch the caller is told the webhook is down — true, and not the
    // thing that just happened. The read failure is the signal that has to survive.
    expect(error).toBeInstanceOf(StrakerRetryExhaustedError);
    expect(onAlert).toHaveBeenCalledTimes(1);
  });
});

/**
 * Constitution VI — "every network operation MUST have an explicit timeout; no unbounded
 * waits" — and the **slow** branch of FR-019b, which cannot exist without one.
 *
 * A portal that accepts the connection and then goes quiet is bounded by nothing but
 * Node's socket defaults (~300s), so four attempts can hold one read for twenty minutes
 * while the loop stops polling and the liveness signal neither succeeds nor fails.
 *
 * The deadlines below are milliseconds: what is under test is the wiring and the
 * classification, never the clock.
 */
const DEADLINE_MS = 5;

/**
 * A portal that accepts the connection and then goes quiet: it settles only when the
 * request is aborted. With no signal nothing would ever settle — which is the bug — so the
 * stub says so at once rather than hanging the suite for a minute to make the same point.
 */
const goesQuiet: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error('STUB: no AbortSignal was sent, so nothing would ever stop this request'));
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as Error));
  });

/**
 * Headers arrive; the body dies when the deadline fires. This is what undici does to a
 * body still streaming when the signal aborts, and the failure lands on `response.json()`
 * — the branch that must not mistake it for a malformed payload.
 *
 * `delivered()` counts the replies that actually reached that branch, so a test can tell
 * this path apart from a plain `fetch` rejection instead of assuming which one it got.
 */
function quietUntilBodyDies(): { impl: typeof fetch; delivered: () => number } {
  let delivered = 0;
  return {
    delivered: () => delivered,
    impl: (_input, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(
            new Error('STUB: no AbortSignal was sent, so nothing would ever stop this request'),
          );
          return;
        }
        signal.addEventListener('abort', () => {
          delivered += 1;
          resolve(bodyDiesResponse(200));
        });
      }),
  };
}

describe('createHttpClient — every request carries a deadline (Constitution VI)', () => {
  it('gives up on a portal that goes quiet, instead of waiting out the platform default', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(goesQuiet);
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      timeoutMs: DEADLINE_MS,
    });

    const error: unknown = await client.getJson(OFFERS_PATH).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StrakerTimeoutError);
    expect(error).toMatchObject({ path: OFFERS_PATH, timeoutMs: DEADLINE_MS });
  });

  it('gives a POST its own, longer deadline — the claim creates a purchase order and is slower (2026-09-22)', async () => {
    // 4 of 20 real claims ran past the 2 s read deadline and were recorded `unknown`, though
    // the portal had given us the work. Reads keep the short deadline.
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(goesQuiet);
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      timeoutMs: DEADLINE_MS,
      postTimeoutMs: DEADLINE_MS * 3,
    });

    const post: unknown = await client
      .postJson('/api/x/accept', undefined)
      .catch((e: unknown) => e);
    const read: unknown = await client.getJson(OFFERS_PATH).catch((e: unknown) => e);

    expect(post).toMatchObject({ timeoutMs: DEADLINE_MS * 3 });
    expect(read).toMatchObject({ timeoutMs: DEADLINE_MS });
  });

  it('sends no signal at all when no deadline is configured, so the capture probe is unchanged', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await client.getJson(OFFERS_PATH);

    // The probe builds its client with `{ baseUrl }` and nothing else. A default deadline
    // here would change a run that is collecting the SC-000 evidence right now.
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeUndefined();
  });

  it('counts a stalled attempt as transient, which is what makes the "slow" branch of FR-019b work', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(goesQuiet)
      .mockResolvedValue(jsonResponse([{ obj_id: 'off-1' }]));
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
      timeoutMs: DEADLINE_MS,
    });

    // Before the deadline existed there was nothing to turn "slow" into a failure the
    // retry loop could see: the first attempt simply never came back.
    await expect(client.getJsonWithBackoff(OFFERS_PATH)).resolves.toEqual([{ obj_id: 'off-1' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The stalled attempt was stopped by us, not by the stub giving up: without a signal
    // on the wire there is no deadline and this whole scenario cannot happen.
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives every attempt its own deadline, so a quiet portal cannot hold the read open', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(goesQuiet);
    const timer = sleepRecorder();
    const onAlert = vi.fn();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
      timeoutMs: DEADLINE_MS,
      onAlert,
    });

    const error: unknown = await client.getJsonWithBackoff(OFFERS_PATH).catch((e: unknown) => e);

    expect(fetchImpl).toHaveBeenCalledTimes(TEST_POLICY.maxAttempts);
    // One signal per attempt, not one shared across the sequence: a single deadline for
    // the whole loop would abort attempt four before it had a chance to answer.
    expect(new Set(fetchImpl.mock.calls.map((call) => call[1]?.signal)).size).toBe(
      TEST_POLICY.maxAttempts,
    );
    expect(error).toBeInstanceOf(StrakerRetryExhaustedError);
    expect((error as StrakerRetryExhaustedError).cause).toBeInstanceOf(StrakerTimeoutError);
    // The operator reads this line, not the stack: "gave no answer within 5ms" says what
    // happened, where `AbortError: This operation was aborted` would not.
    expect(onAlert.mock.calls[0]?.[0]).toMatchObject({
      reason: expect.stringContaining(`${DEADLINE_MS}ms`) as unknown as string,
    });
  });

  it('reads a body killed by its own deadline as a stall, not as a malformed payload', async () => {
    const stalledBody = quietUntilBodyDies();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(stalledBody.impl)
      .mockResolvedValue(jsonResponse([]));
    const timer = sleepRecorder();
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: TEST_POLICY,
      sleep: timer.sleep,
      random: () => 1,
      timeoutMs: DEADLINE_MS,
    });

    // The two 2xx-body failures look identical at the catch and must be classified
    // oppositely: JSON the portal never finished sending is transient, JSON it sent and
    // meant is a contract violation (asserted a few describes above).
    await expect(client.getJsonWithBackoff(OFFERS_PATH)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Proof that the retry followed a dead BODY and not a rejected `fetch`: the reply was
    // handed over, headers and all, and died on the way to being parsed.
    expect(stalledBody.delivered()).toBe(1);
  });

  it('refuses a deadline of zero at construction rather than aborting every request at 3am', () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));

    expect(() =>
      createHttpClient({ baseUrl: 'https://portal.test', fetchImpl, timeoutMs: 0 }),
    ).toThrow(/timeoutMs/);
  });
});

describe('reading the portal status codes — translated here, at the edge (DC-1, FR-027)', () => {
  /**
   * DC-1: a portal's own vocabulary is read at the boundary and never travels inward. Two
   * places were reading raw HTTP numbers past that boundary — `pollCycle.ts` branched on
   * `err.status === 401` to decide the session had expired, and `claim.ts` carried its own
   * copy of the 5xx/408 test under a second name. Both now ask these.
   */
  it('names a 401 as an expired session, which is the only status that means re-signing in', () => {
    expect(isSessionExpired(new StrakerHttpError(401, '/offers', 'expired'))).toBe(true);
  });

  it('does not read a barred account as an expired session', () => {
    // Contract 4a: the two arrive as the same kind of refusal on the same authenticated
    // request, and conflating them turns a suspension into a sign-in storm.
    expect(isSessionExpired(new StrakerHttpError(403, '/offers', 'blocked'))).toBe(false);
  });

  it('is false for anything that never became an HTTP reply, rather than throwing on it', () => {
    expect(isSessionExpired(new Error('socket closed'))).toBe(false);
    expect(isSessionExpired(undefined)).toBe(false);
  });

  /**
   * The sign-in backoff escalates to an hour on a credential refusal. On 2026-09-21 an eight
   * hour outage — the portal answering HTML and 405 during its domain move — was read as a
   * refused password and backed off for exactly that long. Only 401/403 are refusals.
   */
  it('names only 401 and 403 as a credential refusal', () => {
    expect(isCredentialRefusal(new StrakerHttpError(401, '/login', 'bad'))).toBe(true);
    expect(isCredentialRefusal(new StrakerHttpError(403, '/login', 'barred'))).toBe(true);
  });

  it('does not read an outage as a credential refusal', () => {
    expect(isCredentialRefusal(new StrakerHttpError(405, '/login', 'method'))).toBe(false);
    expect(isCredentialRefusal(new StrakerHttpError(500, '/login', 'down'))).toBe(false);
    expect(isCredentialRefusal(new StrakerHttpError(503, '/login', 'down'))).toBe(false);
    expect(isCredentialRefusal(new StrakerTimeoutError('/login', 10_000, null))).toBe(false);
    expect(isCredentialRefusal(new SyntaxError('Unexpected token <'))).toBe(false);
    expect(isCredentialRefusal(undefined)).toBe(false);
  });

  it('calls 5xx and 408 indeterminate — the portal answered with "no answer"', () => {
    for (const status of [500, 502, 503, 504, 408]) {
      expect(isIndeterminateStatus(status)).toBe(true);
    }
  });

  it('calls every deliberate refusal determinate, 429 included', () => {
    // 429 is a budget signal owned by the graduated response (FR-019), not a failure to
    // answer; reading it as indeterminate would spend more of the allowance just refused.
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(isIndeterminateStatus(status)).toBe(false);
    }
  });
});

// =========================================================================================
// T064 — the graduated budget response (FR-019, SC-003, quickstart V15 and V29)
// =========================================================================================

/**
 * FR-019 asks for **steps**, not a single cliff, and SC-003 is the outer bound on all of
 * them: never more than 300 requests in a minute, and never a reported remainder below 60.
 *
 * Three things are pinned below, and they fail differently:
 *
 * 1. **Opt-in.** A client built the way the capture probe builds one — `{ baseUrl }` and
 *    nothing else — must issue requests exactly as it does today. The probe is running
 *    against the live portal while these tests exist.
 * 2. **The steps themselves.** Below 120 remaining, deferrable work stops; below 60,
 *    reading pauses until the budget resets.
 * 3. **The hard ceiling**, which holds when the headers are missing or unbelievable —
 *    because an unreadable budget means *unknown*, and unknown must be governed rather
 *    than read as unlimited.
 *
 * The clock is injected, so a minute of pacing is asserted in a millisecond.
 */

/** A real reset stamp off the live probe log: epoch SECONDS, on a whole-minute boundary. */
const RESET_AT_SEC = 1789522440;
const MINUTE_MS = 60_000;
/** Ten seconds into the minute that stamp closes, so "until the reset" is 50 seconds. */
const NOW_MS = (RESET_AT_SEC - 60) * 1_000 + 10_000;

const ME_PATH = '/api/vendor/auth/me';
const ASSIGNED_PATH = '/api/vendors/v1/assigned-jobs?limit=100&offset=0';
const CLAIM_PATH = '/api/vendors/v1/job-offers/off-1/accept';

/**
 * A clock the test drives, whose `sleep` advances it by exactly what it was asked to wait.
 * That is the property the whole suite rests on: the pacer's own waits are what move time
 * forward, so the sliding window ages exactly as it would in production and a test that
 * would otherwise take a minute takes none.
 */
interface FakeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  advance(ms: number): void;
  readonly waits: number[];
}

function fakeClock(startMs: number = NOW_MS): FakeClock {
  let t = startMs;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
      t += ms;
    },
  };
}

/** A reply carrying the budget recon measured: 300 a minute, resetting on the minute. */
function budgetReply(remaining: number, resetAtSec: number = RESET_AT_SEC): Response {
  return jsonResponse([], {
    headers: new Headers({
      'x-ratelimit-limit': '300',
      'x-ratelimit-remaining': String(remaining),
      'x-ratelimit-reset': String(resetAtSec),
    }),
  });
}

interface PacedHarness {
  readonly client: StrakerPacedHttpClient;
  readonly clock: FakeClock;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  readonly events: StrakerPacingEvent[];
}

/**
 * Small numbers where the thresholds are not what is under test: a ceiling of five makes
 * "the sixth request waits" three lines long instead of two hundred and forty-one.
 */
const TEST_PACING: PacingPolicy = {
  maxRequestsPerWindow: 5,
  windowMs: MINUTE_MS,
  suspendDeferrableBelow: 120,
  pauseReadingBelow: 60,
};

function paced(
  reply: () => Response,
  pacing: Partial<PacingPolicy> = TEST_PACING,
  clock: FakeClock = fakeClock(),
): PacedHarness {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(reply()));
  const events: StrakerPacingEvent[] = [];
  const client = createHttpClient({
    baseUrl: 'https://portal.test',
    fetchImpl,
    pacing,
    now: clock.now,
    sleep: clock.sleep,
    onPacing: (event) => events.push(event),
  });
  return { client, clock, fetchImpl, events };
}

describe('createHttpClient — pacing is opt-in, so the running capture probe is unchanged', () => {
  it('holds nothing back when no pacing policy is configured, however alarming the budget', async () => {
    // One remaining is the most alarming reading the portal can send, and four hundred
    // requests is far past any ceiling. With no policy configured none of it applies: the
    // probe collecting the SC-000 evidence must behave as it did before T065 existed.
    const clock = fakeClock();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(budgetReply(1)));
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    for (let i = 0; i < 400; i += 1) await client.getJson(OFFERS_PATH);

    expect(fetchImpl).toHaveBeenCalledTimes(400);
    expect(clock.waits).toEqual([]);
  });

  it('does not even read the clock when pacing is off, so there is no pacer to misbehave', async () => {
    const now = vi.fn(() => NOW_MS);
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(budgetReply(5)));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl, now, sleep });

    await client.getJson(OFFERS_PATH);
    await client.postJson(CLAIM_PATH, {});
    await client.getJsonWithBackoff(OFFERS_PATH);

    // A pacer that quietly keeps a window while claiming to be off is one edit away from
    // acting on it. Off means inert: no clock, no waits, no state.
    expect(now).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('adds no scheduling tick when pacing is off — an await on an inert path is not inert', async () => {
    const order: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      order.push('fetch');
      return Promise.resolve(jsonResponse([]));
    });
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    const call = client.getJson(OFFERS_PATH);
    await Promise.resolve();
    order.push('tick');
    await call;

    // Written as a bare `await pace(...)`, a pacer that does nothing still costs a
    // microtask, the request slips behind one turn of the loop, and two ordering
    // assertions in `failureModes.test.ts` fail — which is how this was found. Unchanged
    // has to mean the scheduling too, not only the bytes.
    expect(order).toEqual(['fetch', 'tick']);
  });

  it('sends the probe-shaped request unchanged — same method, same headers, nothing added', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    const client = createHttpClient({ baseUrl: 'https://portal.test', fetchImpl });

    await client.getJson(OFFERS_PATH);

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`https://portal.test${OFFERS_PATH}`);
    // Byte-for-byte: the init the probe's transport puts on the wire carries a method and
    // headers and nothing else — no signal, and nothing pacing might have wanted to add.
    expect(Object.keys(init ?? {}).sort()).toEqual(['headers', 'method']);
    expect(new Headers(init?.headers).get('origin')).toBe('https://portal.test');
  });
});

describe('createHttpClient — below 120 remaining, deferrable work stops (FR-019, V29)', () => {
  it('refuses a deferrable request once the reported remainder is below 120', async () => {
    const h = paced(() => budgetReply(119));

    await h.client.essential.getJson(ME_PATH);
    const error: unknown = await h.client.getJson(ASSIGNED_PATH).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StrakerBudgetSuspendedError);
    // Suspended means not sent. A request that goes out and is thrown away afterwards has
    // spent exactly the thing the step exists to preserve.
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lets deferrable work through at exactly 120 — the step is "below", not "at"', async () => {
    const h = paced(() => budgetReply(120));

    await h.client.essential.getJson(ME_PATH);

    await expect(h.client.getJson(ASSIGNED_PATH)).resolves.toEqual([]);
  });

  it('keeps reading and claiming going while deferrable work is suspended', async () => {
    const h = paced(() => budgetReply(100));

    await h.client.essential.getJson(ME_PATH);

    // FR-019's own words: below 120 it suspends deferrable work "and continues only
    // reading and claiming". A step that stopped everything would lose the race the bot
    // exists to run, at the moment it is most likely to be running one.
    await expect(h.client.getJsonWithBackoff(OFFERS_PATH)).resolves.toEqual([]);
    await expect(h.client.postJson(CLAIM_PATH, {})).resolves.toEqual([]);
    expect(h.clock.waits).toEqual([]);
  });

  it('names the suspension as its own failure, never as something the portal said', async () => {
    const h = paced(() => budgetReply(50));

    await h.client.essential.getJson(ME_PATH);
    const error: unknown = await h.client.getJson(ASSIGNED_PATH).catch((e: unknown) => e);

    // Caught as a StrakerHttpError it would read as a portal refusal, and reconciliation's
    // "three consecutive failures" would eventually alert about a portal that is fine.
    expect(error).not.toBeInstanceOf(StrakerHttpError);
    expect(isBudgetSuspended(error)).toBe(true);
    expect(error).toMatchObject({ path: ASSIGNED_PATH, reason: 'budget_low', remaining: 50 });
  });

  it('is false for anything that is not a suspension, rather than throwing on it', () => {
    expect(isBudgetSuspended(new StrakerHttpError(429, '/offers', 'slow down'))).toBe(false);
    expect(isBudgetSuspended(undefined)).toBe(false);
  });

  it('says out loud that it shed deferrable work, which is otherwise invisible', async () => {
    const h = paced(() => budgetReply(90));

    await h.client.essential.getJson(ME_PATH);
    await h.client.getJson(ASSIGNED_PATH).catch(() => undefined);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: 'deferrable_suspended',
      cause: 'budget_low',
      path: ASSIGNED_PATH,
      remaining: 90,
      waitedMs: 0,
    });
  });
});

describe('createHttpClient — below 60 remaining, reading pauses until the budget resets', () => {
  it('pauses the offer read until the reported reset, then reads', async () => {
    const h = paced(() => budgetReply(59));

    await h.client.essential.getJson(ME_PATH);
    await h.client.getJsonWithBackoff(OFFERS_PATH);

    // Ten seconds into the minute the stamp closes, so the wait is the fifty that are left
    // of it — not a guessed interval, and not nothing.
    expect(h.clock.waits).toEqual([50_000]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not pause at exactly 60 — the floor is the number it must not go below', async () => {
    const h = paced(() => budgetReply(60));

    await h.client.essential.getJson(ME_PATH);
    await h.client.getJsonWithBackoff(OFFERS_PATH);

    expect(h.clock.waits).toEqual([]);
  });

  it('does not pause a claim: an offer forfeited to save a request cannot be reclaimed', async () => {
    const h = paced(() => budgetReply(3));

    await h.client.essential.getJson(ME_PATH);
    await h.client.postJson(CLAIM_PATH, {});

    // FR-019 pauses *reading*. Pausing the claim would spend the only irreversible thing
    // the bot has — a race it already won by seeing the offer first.
    expect(h.clock.waits).toEqual([]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caps the pause at one window, so a reset stamp far in the future cannot park the bot', async () => {
    const h = paced(() => budgetReply(10, RESET_AT_SEC + 3_600));

    await h.client.essential.getJson(ME_PATH);
    await h.client.getJsonWithBackoff(OFFERS_PATH);

    // An hour-long sleep inside the transport is indistinguishable from a hung bot, and a
    // budget window is a minute: nothing the portal can say justifies waiting longer.
    expect(h.clock.waits).toEqual([MINUTE_MS]);
  });

  it('does not wait on a reset stamp that has already passed', async () => {
    const h = paced(() => budgetReply(10, RESET_AT_SEC - 600));

    await h.client.essential.getJson(ME_PATH);
    await h.client.getJsonWithBackoff(OFFERS_PATH);

    // A stale or skewed stamp must not become a negative wait, and must not wedge the read
    // either: one pause per request, never a loop waiting for a reading that only a reply
    // can refresh.
    expect(h.clock.waits).toEqual([]);
  });

  it('still refuses deferrable work below 60 — the lower step does not undo the higher one', async () => {
    const h = paced(() => budgetReply(10));

    await h.client.essential.getJson(ME_PATH);

    await expect(h.client.getJson(ASSIGNED_PATH)).rejects.toBeInstanceOf(
      StrakerBudgetSuspendedError,
    );
  });

  it('says how long it paused, so a slow cycle is explainable afterwards', async () => {
    const h = paced(() => budgetReply(59));

    await h.client.essential.getJson(ME_PATH);
    await h.client.getJsonWithBackoff(OFFERS_PATH);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      kind: 'request_delayed',
      cause: 'budget_low',
      waitedMs: 50_000,
      remaining: 59,
    });
  });
});

describe('createHttpClient — the hard ceiling holds when the budget cannot be read', () => {
  it('delays the request that would breach the ceiling until the oldest slot ages out', async () => {
    // No budget headers at all: the portal has stopped saying, which is the case the
    // ceiling exists for. Unknown is not unlimited.
    const h = paced(() => jsonResponse([]));

    for (let i = 0; i < 5; i += 1) await h.client.getJsonWithBackoff(OFFERS_PATH);
    expect(h.clock.waits).toEqual([]);

    await h.client.getJsonWithBackoff(OFFERS_PATH);

    expect(h.clock.waits).toEqual([MINUTE_MS]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('applies the ceiling to a budget that arrived and could not be believed', async () => {
    const h = paced(
      () =>
        jsonResponse([], {
          headers: new Headers({ ...SANE_BUDGET, 'x-ratelimit-remaining': '-5' }),
        }),
      { ...TEST_PACING, maxRequestsPerWindow: 1 },
    );

    await h.client.getJsonWithBackoff(OFFERS_PATH);
    await h.client.getJsonWithBackoff(OFFERS_PATH);

    expect(h.clock.waits).toEqual([MINUTE_MS]);
  });

  it('lets the window slide rather than counting for ever', async () => {
    const h = paced(() => jsonResponse([]));

    for (let i = 0; i < 5; i += 1) await h.client.getJsonWithBackoff(OFFERS_PATH);
    h.clock.advance(MINUTE_MS + 1);
    await h.client.getJsonWithBackoff(OFFERS_PATH);

    expect(h.clock.waits).toEqual([]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('counts every attempt that reaches the wire, retries included', async () => {
    const clock = fakeClock();
    const fetchImpl = alwaysFailing(500);
    const events: StrakerPacingEvent[] = [];
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 100, factor: 2, maxDelayMs: 1_000 },
      pacing: { ...TEST_PACING, maxRequestsPerWindow: 2 },
      now: clock.now,
      sleep: clock.sleep,
      random: () => 1,
      onPacing: (event) => events.push(event),
    });

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    // A pacer attached to the call rather than to the attempt counts one request where the
    // portal saw three — which is how a retry storm walks straight through a ceiling. The
    // first two waits are the backoff's; the third is the ceiling holding the third attempt
    // back until the first slot, taken 300ms ago, ages out.
    expect(clock.waits).toEqual([100, 200, MINUTE_MS - 300]);
    expect(events.map((event) => event.cause)).toEqual(['ceiling_reached']);
  });

  it('refuses, rather than delays, a deferrable request at the ceiling', async () => {
    const h = paced(() => jsonResponse([]), { ...TEST_PACING, maxRequestsPerWindow: 2 });

    await h.client.essential.getJson(ME_PATH);
    await h.client.essential.getJson(ME_PATH);
    const error: unknown = await h.client.getJson(ASSIGNED_PATH).catch((e: unknown) => e);

    // Reconciliation runs on a fifteen-minute cadence of its own: holding the process for a
    // minute to make a request whose next chance is a quarter of an hour away buys nothing
    // and blocks the cycle that is racing.
    expect(error).toBeInstanceOf(StrakerBudgetSuspendedError);
    expect(error).toMatchObject({ reason: 'ceiling_reached' });
    expect(h.clock.waits).toEqual([]);
  });

  it('keeps deferrable work running while the budget is merely unknown', async () => {
    const h = paced(() => jsonResponse([]));

    // The contract's answer for a portal that stopped reporting is "fall back to the hard
    // ceiling and warn" — not "assume the worst and shed reconciliation for ever". Unknown
    // governs by the ceiling; it is not evidence of being below 120.
    await expect(h.client.getJson(ASSIGNED_PATH)).resolves.toEqual([]);
  });

  it('defaults the ceiling to the allowance minus the floor SC-003 forbids crossing', () => {
    // 300 measured, minus the 60 the remainder must never fall below, leaves 240. That
    // arithmetic is the whole reason a blind client still satisfies both halves of SC-003.
    expect(DEFAULT_PACING_POLICY).toEqual({
      maxRequestsPerWindow: 240,
      windowMs: MINUTE_MS,
      suspendDeferrableBelow: 120,
      pauseReadingBelow: 60,
    });
  });
});

describe('createHttpClient — a 429 is the portal saying the ceiling was wrong', () => {
  it('parks reading for a window after a 429 that carries no budget headers', async () => {
    const h = paced(() => jsonResponse({ detail: 'too many requests' }, { status: 429 }), {
      ...TEST_PACING,
      maxRequestsPerWindow: 100,
    });

    await h.client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);
    await h.client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    // Without this, a 429 carrying no headers leaves the budget "unknown" and the client
    // reads on at the ceiling — arguing with a portal that has just said no.
    expect(h.clock.waits).toEqual([MINUTE_MS]);
  });

  it('suspends deferrable work while parked', async () => {
    const h = paced(() => jsonResponse({ detail: 'too many requests' }, { status: 429 }), {
      ...TEST_PACING,
      maxRequestsPerWindow: 100,
    });

    await h.client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    await expect(h.client.getJson(ASSIGNED_PATH)).rejects.toBeInstanceOf(
      StrakerBudgetSuspendedError,
    );
  });
});

describe('createHttpClient — the essential door, so shedding load cannot lock the bot out', () => {
  it('re-opens a session while deferrable work is suspended', async () => {
    const h = paced(() => budgetReply(70));

    await h.client.getJsonWithBackoff(OFFERS_PATH);

    // `/auth/me` comes through the plain GET door, which is deferrable by default — and a
    // bot that cannot sign in can neither read nor claim, which is precisely what FR-019
    // says must continue. The essential door is how a caller says so.
    await expect(h.client.essential.getJson(ME_PATH)).resolves.toEqual([]);
    await expect(h.client.essential.postJson('/api/vendor/auth/login', {})).resolves.toEqual([]);
  });

  it('is still counted by the hard ceiling — essential is not exempt from the account', async () => {
    const h = paced(() => jsonResponse([]), { ...TEST_PACING, maxRequestsPerWindow: 1 });

    await h.client.essential.getJson(ME_PATH);
    await h.client.essential.getJson(ME_PATH);

    expect(h.clock.waits).toEqual([MINUTE_MS]);
  });

  it('is one attempt, like the plain door it re-labels', async () => {
    const h = paced(() => jsonResponse({}, { status: 500 }));

    await expect(h.client.essential.getJson(ME_PATH)).rejects.toBeInstanceOf(StrakerHttpError);

    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createHttpClient — a pacing policy that would misbehave is refused at construction', () => {
  const build = (pacing: Partial<PacingPolicy>): (() => unknown) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse([]));
    return () => createHttpClient({ baseUrl: 'https://portal.test', fetchImpl, pacing });
  };

  it('refuses a ceiling of zero, which would stop every request for ever', () => {
    expect(build({ maxRequestsPerWindow: 0 })).toThrow(/maxRequestsPerWindow/);
  });

  it('refuses a window of zero, in which no request can ever age out', () => {
    expect(build({ windowMs: 0 })).toThrow(/windowMs/);
  });

  it('refuses steps in the wrong order, where the pause would fire before the suspension', () => {
    // Inverted, the graduated response stops being graduated: reading would pause while
    // deferrable work carried on, which is the opposite of what FR-019 asks for.
    expect(build({ suspendDeferrableBelow: 60, pauseReadingBelow: 120 })).toThrow(
      /pauseReadingBelow/,
    );
  });

  it('refuses a negative threshold, which no remainder can ever fall below', () => {
    expect(build({ pauseReadingBelow: -1 })).toThrow(/pauseReadingBelow/);
  });
});

describe('createHttpClient — the pacing sink cannot break the request it reports on', () => {
  it('keeps a good read alive when the pacing sink throws', async () => {
    const clock = fakeClock();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(budgetReply(59)));
    const client = createHttpClient({
      baseUrl: 'https://portal.test',
      fetchImpl,
      pacing: TEST_PACING,
      now: clock.now,
      sleep: clock.sleep,
      onPacing: () => {
        throw new Error('log transport is down');
      },
    });

    await client.essential.getJson(ME_PATH);

    // Same rule as the budget warning: an observability hook rides the success path and
    // must never be able to turn a good read into a failed one.
    await expect(client.getJsonWithBackoff(OFFERS_PATH)).resolves.toEqual([]);
    expect(clock.waits).toEqual([50_000]);
  });
});

/**
 * SC-003 / V15 end to end: a simulated portal keeping the budget recon measured — 300 a
 * minute, resetting on the minute — read as hard as the client will allow for several
 * simulated minutes.
 */
function simulatedPortal(
  clock: FakeClock,
  allowance: number,
): { impl: typeof fetch; perMinute: Map<number, number> } {
  const perMinute = new Map<number, number>();
  let windowStartSec = Math.floor(clock.now() / MINUTE_MS) * 60;
  let used = 0;
  return {
    perMinute,
    impl: () => {
      const minuteSec = Math.floor(clock.now() / MINUTE_MS) * 60;
      if (minuteSec !== windowStartSec) {
        windowStartSec = minuteSec;
        used = 0;
      }
      used += 1;
      perMinute.set(minuteSec, (perMinute.get(minuteSec) ?? 0) + 1);
      const remaining = allowance - used;
      if (remaining < 0) {
        return Promise.resolve(jsonResponse({ detail: 'rate limited' }, { status: 429 }));
      }
      return Promise.resolve(budgetReply(remaining, windowStartSec + 60));
    },
  };
}

async function sustainedRead(
  maxRequestsPerWindow: number,
  reads: number,
): Promise<{ remainders: number[]; perMinute: Map<number, number> }> {
  const clock = fakeClock();
  const portal = simulatedPortal(clock, 300);
  const client = createHttpClient({
    baseUrl: 'https://portal.test',
    fetchImpl: portal.impl,
    pacing: { maxRequestsPerWindow },
    now: clock.now,
    sleep: clock.sleep,
  });

  const remainders: number[] = [];
  for (let i = 0; i < reads; i += 1) {
    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);
    const seen = client.lastRateLimit();
    if (seen !== null) remainders.push(seen.remaining);
  }
  return { remainders, perMinute: portal.perMinute };
}

describe('createHttpClient — SC-003 over a sustained run (V15)', () => {
  it('never exceeds 300 in a minute and never drives the remainder below 60', async () => {
    const { remainders, perMinute } = await sustainedRead(
      DEFAULT_PACING_POLICY.maxRequestsPerWindow,
      1_000,
    );

    expect(Math.max(...perMinute.values())).toBeLessThanOrEqual(300);
    expect(Math.min(...remainders)).toBeGreaterThanOrEqual(60);
  });

  it('shows why the ceiling is 240: the pause alone cannot keep the remainder above 60', async () => {
    const { remainders } = await sustainedRead(300, 1_000);

    // The remainder is learnt only from a reply, so a client ceilinged at the full
    // allowance discovers it is at 59 by having already spent it. The pause is a floor the
    // client stops AT, never one it cannot cross — only a ceiling set below the allowance
    // makes SC-003's second half structurally true. This test exists so that raising the
    // default back to 300 fails here rather than in production.
    expect(Math.min(...remainders)).toBeLessThan(60);
  });
});
