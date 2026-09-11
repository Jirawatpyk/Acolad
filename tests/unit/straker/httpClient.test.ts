import { describe, expect, it, vi } from 'vitest';
import {
  createHttpClient,
  StrakerHttpError,
  StrakerRetryExhaustedError,
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
