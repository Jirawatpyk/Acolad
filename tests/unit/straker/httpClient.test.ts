import { describe, expect, it, vi } from 'vitest';
import {
  createHttpClient,
  StrakerHttpError,
  StrakerRetryExhaustedError,
  StrakerTimeoutError,
} from '../../../src/straker/httpClient.js';
import type { StrakerHttpClient } from '../../../src/straker/httpClient.js';

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

    // FR-023 and the contract's governing rule: the XTM bot lost 38 minutes of work to a
    // failed read that reached the tracker as an empty list. Settled explicitly, because
    // a `rejects.toThrow` assertion would also pass for a promise that resolved to [].
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
