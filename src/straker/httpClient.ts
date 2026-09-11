/**
 * Straker transport, deliberately confined to ONE file (brief DC-4, FR-030): the cookie
 * jar, the browser-shaped headers, the rate-limit headers, the JSON plumbing and the
 * retry-with-backoff of FR-019b all live here, so a future portal in the same family can
 * copy this file and change the base URL. Nothing that issues or paces a request may live
 * outside it — a separate rate-limiter or retry module would be the first thing to break
 * that rule.
 *
 * Node's global fetch has no cookie jar, and the Straker session is an HttpOnly cookie
 * (recon note §2), so the jar below is not optional.
 *
 * ## The read/claim asymmetry (FR-019b vs FR-019c)
 *
 * Retrying is **opted into per call**, never applied to a whole verb:
 *
 * - `getJsonWithBackoff` — the offer-list read, and only it. Its loop builds its own GET
 *   and accepts no caller-supplied method or body, so there is no way to send a claim
 *   through it.
 * - `getJson` / `postJson` — exactly one attempt, exactly as before. The reconciliation
 *   read keeps its own 15-minute cadence (FR-016c) by coming through `getJson`, and the
 *   claim path has `postJson` as its only door. A claim whose outcome is unknown is left
 *   unknown and settled by reconciliation (FR-016a), because a second attempt would be the
 *   same irreversible commitment made twice (FR-005, R7).
 *
 * The default is therefore today's behaviour: a client built without a retry policy, and
 * every call that is not `getJsonWithBackoff`, behaves byte-for-byte as it did before this
 * was added — which is what keeps the running capture probe untouched.
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

/**
 * Thrown when the read backoff runs out of attempts (FR-019b). A separate type from
 * `StrakerHttpError` on purpose: "the portal has been failing for several seconds and we
 * have stopped asking" is a different operational event from one rejected request, and the
 * two must not be handled by the same branch. Carries the last failure as `cause`.
 */
export class StrakerRetryExhaustedError extends Error {
  constructor(
    readonly path: string,
    readonly attempts: number,
    readonly waitedMs: number,
    cause: unknown,
  ) {
    super(`Straker ${path} still failing after ${attempts} attempts (${waitedMs}ms of backoff)`, {
      cause,
    });
    this.name = 'StrakerRetryExhaustedError';
  }
}

/** What the transport asks an operator to look at. Today it raises exactly one kind. */
export interface StrakerTransportAlert {
  readonly kind: 'read_retries_exhausted';
  readonly path: string;
  readonly attempts: number;
  readonly waitedMs: number;
  readonly reason: string;
}

/**
 * The shape of FR-019b's "exponential backoff plus jitter, up to a defined cap". Two caps,
 * because they fail differently: `maxAttempts` bounds how long a failing read blocks the
 * poll cycle, `maxDelayMs` bounds how long any single wait can grow to.
 */
export interface RetryPolicy {
  /** Total attempts including the first. The cap whose exhaustion raises the alert. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  /** Ceiling on any one wait, before jitter. */
  readonly maxDelayMs: number;
}

/**
 * Sized against the poll rhythm rather than against a generic HTTP client: the read is the
 * race path, so the whole retry sequence has to stay inside a couple of seconds or the bot
 * stops reading while it waits. 250/500/1000ms of jittered backoff, then the alert.
 */
export const DEFAULT_READ_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 4_000,
};

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Overrides for the READ backoff (FR-019b). Absent fields keep the defaults above. */
  readonly retry?: Partial<RetryPolicy>;
  /** Injected by tests so intervals are asserted without waiting; real callers omit it. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source, injectable for the same reason. Defaults to `Math.random`. */
  readonly random?: () => number;
  /**
   * Raised when the read cap is exhausted (FR-019b, Constitution IV). A hook rather than a
   * notifier because the transport has none in this phase; the caller decides where an
   * alert goes. De-duplication is the caller's too — FR-019a keys on offer identity, which
   * the transport does not know.
   */
  readonly onAlert?: (alert: StrakerTransportAlert) => void;
}

/** Server-reported request budget; recon measured limit=300 per minute. */
export interface RateLimitSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtEpoch: number;
}

export interface StrakerHttpClient {
  /** One attempt. No retry — this is the door the reconciliation read comes through. */
  getJson<T>(path: string): Promise<T>;
  /**
   * The offer-list read, and only it (FR-019b): retried with exponential backoff plus
   * jitter up to the policy's cap, after which it alerts and throws
   * `StrakerRetryExhaustedError`. It never resolves to an empty list on failure (FR-023).
   */
  getJsonWithBackoff<T>(path: string): Promise<T>;
  /** One attempt. No retry, ever — the claim path's only door (FR-019c). */
  postJson<T>(path: string, body: unknown): Promise<T>;
  /** Budget seen on the most recent reply, or null when the server sent no headers. */
  lastRateLimit(): RateLimitSnapshot | null;
}

/**
 * The outcome of one attempt. A result rather than an exception so the retry loop can tell
 * a transient failure from a permanent one *without* having to inspect, wrap or re-tag the
 * error — which is what lets `getJson` and `postJson` keep throwing the exact same error
 * objects they threw before the backoff existed.
 */
type AttemptResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown; readonly retryable: boolean };

export function createHttpClient(options: HttpClientOptions): StrakerHttpClient {
  const doFetch = options.fetchImpl ?? fetch;
  const retryPolicy = resolveRetryPolicy(options.retry);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const jar = new Map<string, string>();
  let rateLimit: RateLimitSnapshot | null = null;

  async function attempt<T>(path: string, init: RequestInit): Promise<AttemptResult<T>> {
    const headers = new Headers(init.headers);
    // The API refuses a request with no Origin ("403 Invalid or missing Origin", seen on
    // the first live probe run). A browser sets these two automatically, which is why the
    // browser-based recon never hit it; a Node client has to set them itself. Every
    // attempt is built here, retries included — a retry that dropped these would turn a
    // transient fault into a certain one.
    headers.set('origin', options.baseUrl);
    headers.set('referer', `${options.baseUrl}/`);
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (cookie) headers.set('cookie', cookie);

    let response: Response;
    try {
      // The single chokepoint through which every Straker request passes — which is also
      // where the per-minute pacing of FR-019/T065 will attach when Phase 6 arrives.
      response = await doFetch(`${options.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      // Unreachable, refused, or the connection died mid-flight: the portal never
      // answered, which is precisely the transient case FR-019b exists for.
      return { ok: false, error, retryable: true };
    }
    storeCookies(jar, response);
    rateLimit = readRateLimit(response);

    if (!response.ok) {
      const error = new StrakerHttpError(
        response.status,
        path,
        (await response.text()).slice(0, 200),
      );
      return { ok: false, error, retryable: isTransientStatus(response.status) };
    }
    try {
      return { ok: true, value: (await response.json()) as T };
    } catch (error) {
      // A 2xx whose body is not JSON is a contract violation, not a blip. Retrying it
      // would delay the loud failure FR-023 demands and spend requests doing so.
      return { ok: false, error, retryable: false };
    }
  }

  /** One attempt, failure surfaced unchanged. The behaviour that predates FR-019b. */
  async function send<T>(path: string, init: RequestInit): Promise<T> {
    const result = await attempt<T>(path, init);
    if (result.ok) return result.value;
    throw result.error;
  }

  async function sendWithBackoff<T>(path: string): Promise<T> {
    let waitedMs = 0;
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      // GET-only by construction (FR-019c): this loop writes its own request line and
      // accepts no method or body from the caller, so no claim can be issued from inside
      // it. "The claim path must not opt into backoff" is therefore not a rule anyone has
      // to remember — there is nothing here to opt in with.
      const result = await attempt<T>(path, { method: 'GET' });
      if (result.ok) return result.value;

      // A 401 is an expired session for the caller to re-open, a 403 means the portal
      // changed its rules, a malformed body is a contract violation: none of them gets
      // better by waiting, and all of them must surface as themselves.
      if (!result.retryable) throw result.error;

      if (attemptNumber >= retryPolicy.maxAttempts) {
        const reason = describe(result.error);
        raiseAlert({
          kind: 'read_retries_exhausted',
          path,
          attempts: attemptNumber,
          waitedMs,
          reason,
        });
        // Throwing is the other half of FR-023: an exhausted read must never be readable
        // as "no offers available". The XTM bot lost 38 minutes of work to exactly that.
        throw new StrakerRetryExhaustedError(path, attemptNumber, waitedMs, result.error);
      }

      const delayMs = nextDelayMs(retryPolicy, attemptNumber, random);
      waitedMs += delayMs;
      await sleep(delayMs);
    }
  }

  function raiseAlert(alert: StrakerTransportAlert): void {
    if (options.onAlert === undefined) return;
    try {
      options.onAlert(alert);
    } catch {
      // A broken alert sink must not replace the read failure with its own: the throw that
      // follows this call is the signal that has to reach the caller intact.
    }
  }

  return {
    getJson: (path) => send(path, { method: 'GET' }),
    getJsonWithBackoff: (path) => sendWithBackoff(path),
    postJson: (path, body) =>
      send(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    lastRateLimit: () => rateLimit,
  };
}

/**
 * Which statuses are worth asking again about. 5xx is a server fault and 408 is the portal
 * saying it was too slow — both are FR-019b's "unreachable, slow, or returning a server
 * fault". Everything else, 4xx included, is an answer rather than a failure to answer.
 *
 * **429 is deliberately absent.** It is a budget signal, and the graduated budget response
 * (FR-019, T064/T065) owns it; retrying one here would spend more of the very allowance
 * the portal has just said is running out.
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

/**
 * Equal jitter — half the step fixed, half of it random — rather than full jitter. Full
 * jitter can draw a near-zero wait, and a client that comes back immediately has not
 * backed off at all; this way every interval still grows however the dice fall, which is
 * the property that keeps a struggling portal from being hammered.
 */
function nextDelayMs(policy: RetryPolicy, retryNumber: number, random: () => number): number {
  const step = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.factor ** (retryNumber - 1));
  return Math.round(step / 2 + random() * (step / 2));
}

/**
 * Fail fast on a policy that would misbehave in the dark: a cap of zero would retry
 * forever-ish or not at all, a factor below 1 would shrink each interval instead of
 * growing it, and a ceiling below the first step would silently discard the whole curve.
 * Cheaper to refuse at construction than to discover at 3am.
 */
function resolveRetryPolicy(overrides: Partial<RetryPolicy> | undefined): RetryPolicy {
  const policy: RetryPolicy = { ...DEFAULT_READ_RETRY_POLICY, ...overrides };
  const faults: string[] = [];
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    faults.push(`maxAttempts must be a positive integer (got ${policy.maxAttempts})`);
  }
  if (!(policy.baseDelayMs > 0)) {
    faults.push(`baseDelayMs must be above zero (got ${policy.baseDelayMs})`);
  }
  if (!(policy.factor >= 1)) {
    faults.push(`factor must be at least 1 or the backoff shrinks (got ${policy.factor})`);
  }
  if (!(policy.maxDelayMs >= policy.baseDelayMs)) {
    faults.push(
      `maxDelayMs must be at least baseDelayMs (got ${policy.maxDelayMs} < ${policy.baseDelayMs})`,
    );
  }
  if (faults.length > 0) throw new Error(`Straker retry policy invalid — ${faults.join('; ')}`);
  return policy;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
