/**
 * Straker transport, deliberately confined to ONE file (brief DC-4): cookie jar,
 * rate-limit headers and JSON plumbing live here so a future portal in the same
 * family can copy this file and change the base URL.
 *
 * Node's global fetch has no cookie jar, and the Straker session is an HttpOnly
 * cookie (recon note §2), so the jar below is not optional.
 */

/**
 * Thrown for any non-2xx reply. Never swallowed: a 500 parsed as data would look like
 * "no open offers" to the tracker, which would then record every live offer as vanished
 * with a fabricated lifetime and quietly corrupt the whole Phase 0 dataset.
 */
export class StrakerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly bodyExcerpt: string,
  ) {
    super(`Straker ${path} replied ${status}: ${bodyExcerpt}`);
    this.name = 'StrakerHttpError';
  }
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

/** Server-reported request budget; recon measured limit=300 per minute. */
export interface RateLimitSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtEpoch: number;
}

export interface StrakerHttpClient {
  getJson<T>(path: string): Promise<T>;
  postJson<T>(path: string, body: unknown): Promise<T>;
  /** Budget seen on the most recent reply, or null when the server sent no headers. */
  lastRateLimit(): RateLimitSnapshot | null;
}

export function createHttpClient(options: HttpClientOptions): StrakerHttpClient {
  const doFetch = options.fetchImpl ?? fetch;
  const jar = new Map<string, string>();
  let rateLimit: RateLimitSnapshot | null = null;

  async function send<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    // The API refuses a request with no Origin ("403 Invalid or missing Origin", seen on
    // the first live probe run). A browser sets these two automatically, which is why the
    // browser-based recon never hit it; a Node client has to set them itself.
    headers.set('origin', options.baseUrl);
    headers.set('referer', `${options.baseUrl}/`);
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookie) headers.set('cookie', cookie);

    const response = await doFetch(`${options.baseUrl}${path}`, { ...init, headers });
    storeCookies(jar, response);
    rateLimit = readRateLimit(response);

    if (!response.ok) {
      throw new StrakerHttpError(response.status, path, (await response.text()).slice(0, 200));
    }
    return (await response.json()) as T;
  }

  return {
    getJson: (path) => send(path, { method: 'GET' }),
    postJson: (path, body) =>
      send(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    lastRateLimit: () => rateLimit,
  };
}

function readRateLimit(response: Response): RateLimitSnapshot | null {
  const limit = numericHeader(response, 'x-ratelimit-limit');
  const remaining = numericHeader(response, 'x-ratelimit-remaining');
  const resetAtEpoch = numericHeader(response, 'x-ratelimit-reset');
  if (limit === null || remaining === null || resetAtEpoch === null) return null;
  return { limit, remaining, resetAtEpoch };
}

function numericHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function storeCookies(jar: Map<string, string>, response: Response): void {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}
