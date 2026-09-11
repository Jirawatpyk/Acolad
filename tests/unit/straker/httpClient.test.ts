import { describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../../../src/straker/httpClient.js';

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
