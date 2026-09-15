/**
 * Straker transport, deliberately confined to ONE file (brief DC-4, FR-030): the cookie
 * jar, the browser-shaped headers, the rate-limit headers, the JSON plumbing, the
 * per-attempt deadline of Constitution VI and the retry-with-backoff of FR-019b all live
 * here, so a future portal in the same family can copy this file and change the base URL.
 * Nothing that issues or paces a request may live outside it — a separate rate-limiter or
 * retry module would be the first thing to break that rule.
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
 * `StrakerHttpError` on purpose: "the portal has been failing across a whole retry
 * sequence and we have stopped asking" is a different operational event from one rejected
 * request, and the two must not be handled by the same branch. `waitedMs` counts only the
 * backoff — how long the attempts themselves took is bounded by `timeoutMs`, not by this.
 * Carries the last failure as `cause`.
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

/**
 * Thrown when an attempt passed its deadline (Constitution VI: "every network operation
 * MUST have an explicit timeout; no unbounded waits"). Its own type because a portal that
 * accepts the connection and then goes quiet is a different fault from one that refuses
 * it: the request may well have been received, and the retry loop needs to see "slow" as
 * a failure it can act on — the branch of FR-019b that cannot work without a deadline.
 *
 * Raised only when a deadline is configured; a client built without `timeoutMs` cannot
 * produce one, which is what keeps the capture probe's behaviour untouched.
 */
export class StrakerTimeoutError extends Error {
  constructor(
    readonly path: string,
    readonly timeoutMs: number,
    cause: unknown,
  ) {
    super(`Straker ${path} gave no answer within ${timeoutMs}ms`, { cause });
    this.name = 'StrakerTimeoutError';
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
 * race path, so a failing read has to give up while the next poll is still worth making.
 * Three jittered waits — 125-250, 250-500, 500-1000ms — put at most ~1.75s of *waiting*
 * between the first attempt and the alert.
 *
 * **The waits are only half the sequence.** The other half is how long an attempt may take,
 * and this policy does not bound that. Without `timeoutMs` an attempt is bounded only by
 * the platform's socket defaults — around 300s in Node — so four attempts at a portal that
 * accepts the connection and then goes quiet can hold one read for roughly twenty minutes,
 * during which the loop does not poll and the liveness signal neither succeeds nor fails.
 * With a deadline set, the worst case is `maxAttempts × timeoutMs + ~1.75s`: about 9.75s
 * at a 2s deadline, about 17.75s at 4s. Anything that has to stay inside one poll interval
 * must size the two together — the deadline is the term that dominates.
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
  /**
   * Deadline for a single attempt, in milliseconds (Constitution VI). Applied at the one
   * seam every request passes through, so reads, retried reads, sign-in and claims are all
   * bounded by it — a claim that hangs is the worst unbounded wait in the feature, because
   * its outcome stays unknown for as long as it hangs.
   *
   * **Opt-in, and unset by default on purpose.** The capture probe builds its client with
   * `{ baseUrl }` alone while it collects the SC-000 evidence; without this field no abort
   * signal is sent and its behaviour is byte-for-byte what it was. The bot must set it —
   * absent it, an attempt is bounded only by Node's socket defaults (~300s).
   */
  readonly timeoutMs?: number;
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
  /**
   * Raised when the portal's budget reading stops being usable (contract Change-detection:
   * "fall back to the hard ceiling **and warn**"). Warn-level, once per change of state
   * rather than once per reply — the condition can persist for hours.
   *
   * **Not wired to a sink yet.** `createStrakerPortal` in `main.ts` (coordinator-owned)
   * passes `onAlert` and not this, so today the warning has nowhere to go; it needs the
   * matching `onWarning: (w) => report(() => logger.warn({ module: 'httpClient', ...w },
   * w.detail))`. Routed through `onAlert` instead it would arrive as an error labelled
   * "read gave up after exhausting its retry cap", which is a different and untrue event.
   */
  readonly onWarning?: (warning: StrakerTransportWarning) => void;
}

/** Server-reported request budget; recon measured limit=300 per minute. */
export interface RateLimitSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtEpoch: number;
}

/**
 * Why the transport has no usable budget reading. **None of these means "no limit"** —
 * that is the whole reason they are named: the hard per-minute ceiling (FR-019, T065)
 * applies to every one of them.
 */
export type RateLimitUnknownReason =
  /** Nothing has come back yet; there is nothing to have read. */
  | 'no_reply_yet'
  /** The reply carried none of the three headers — contract change, or a portal in trouble. */
  | 'headers_missing'
  /** The headers were there and could not be believed (see `budgetHeader`). */
  | 'headers_nonsensical';

/**
 * The budget as the transport currently understands it — a union rather than
 * `RateLimitSnapshot | null`, so the pacing of T065 has to narrow it before it can pace on
 * anything. A bare `null` reads far too easily as "nothing is limiting us", which is the
 * exact inverse of what a missing header means, and inverting it silently is how an
 * account earns a block.
 */
export type RateLimitBudget =
  | { readonly known: true; readonly snapshot: RateLimitSnapshot }
  | { readonly known: false; readonly reason: RateLimitUnknownReason };

/**
 * Something an operator should see, but which is not a failure: the read succeeded and the
 * bot carries on. Separate from `StrakerTransportAlert` because the two need different
 * volumes — an alert is an incident, a warning is a fact about the portal that changed.
 */
export interface StrakerTransportWarning {
  readonly kind: 'rate_limit_unknown';
  readonly reason: RateLimitUnknownReason;
  readonly path: string;
  /** Plain-language "what happened and what now", ready to be logged as-is. */
  readonly detail: string;
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
  /**
   * Budget seen on the most recent reply, or `null` when there is no usable reading.
   *
   * `null` means **unknown, so the hard ceiling governs** (FR-019) — it never means
   * "unlimited". The reason it is unknown is kept as a `RateLimitBudget` inside the client,
   * where the pacing of T065 lives and has to narrow it; this projection stays nullable
   * only because it is what the recon logger already reads.
   */
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
  const timeoutMs = resolveTimeout(options.timeoutMs);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const jar = new Map<string, string>();
  let budget: RateLimitBudget = { known: false, reason: 'no_reply_yet' };

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

    // Each attempt gets its OWN deadline, not a share of one spanning the retry sequence:
    // a single signal for the loop would abort the last attempt before it could answer.
    const deadline = startDeadline(path, timeoutMs);

    let response: Response;
    try {
      // The single chokepoint through which every Straker request passes — which is also
      // where the per-minute pacing of FR-019/T065 will attach when Phase 6 arrives. Pace
      // on `budget`, the narrowed union: `lastRateLimit()` flattens every unknown to the
      // same `null`, which cannot tell "the portal stopped reporting" from "no limit".
      response = await doFetch(`${options.baseUrl}${path}`, {
        ...init,
        headers,
        ...deadline.fetchInit,
      });
    } catch (error) {
      // Unreachable, refused, the connection died mid-flight, or our own deadline fired:
      // the portal never answered, which is precisely the transient case FR-019b exists
      // for — "slow" included, which is the case nothing could reach before the deadline.
      return { ok: false, error: deadline.name(error), retryable: true };
    }
    storeCookies(jar, response);
    updateBudget(path, response);

    if (!response.ok) {
      const error = new StrakerHttpError(response.status, path, await bodyExcerpt(response));
      return { ok: false, error, retryable: isIndeterminateStatus(response.status) };
    }
    try {
      return { ok: true, value: (await response.json()) as T };
    } catch (error) {
      // Two failures land here looking identical and must be judged oppositely. A body cut
      // off by our own deadline is a stall — the portal never finished its sentence — so
      // it is transient and the loop should ask again.
      if (deadline.expired()) return { ok: false, error: deadline.name(error), retryable: true };
      // A body the portal did finish, and which is not JSON, is a contract violation, not
      // a blip. Retrying it would delay the loud failure FR-023 demands and spend requests
      // doing so.
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

  /**
   * Record what this reply says about the budget, and say so out loud when it stops saying
   * anything usable. The snapshot is replaced either way — a stale reading is worse than
   * none — but replacing it is no longer silent, and what replaces it names its reason
   * instead of being a bare `null` that a pacer could read as "unrestrained".
   *
   * Warned once per change of state, not per reply: at a ten-second rhythm the latter is
   * 8,640 lines a day about one unchanging fact, which is how a real signal gets buried.
   */
  function updateBudget(path: string, response: Response): void {
    const previous = budget;
    budget = readBudget(response);
    if (budget.known || (!previous.known && previous.reason === budget.reason)) return;
    raiseWarning({
      kind: 'rate_limit_unknown',
      reason: budget.reason,
      path,
      detail: BUDGET_UNKNOWN_DETAIL[budget.reason],
    });
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

  function raiseWarning(warning: StrakerTransportWarning): void {
    if (options.onWarning === undefined) return;
    try {
      options.onWarning(warning);
    } catch {
      // This one rides the SUCCESS path: a sink that throws here would turn a good
      // offer-list read into a failed one, which is the one thing an observability hook
      // must never do.
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
    lastRateLimit: () => (budget.known ? budget.snapshot : null),
  };
}

/**
 * Statuses after which we do not know whether the request took effect. 5xx is a server
 * fault and 408 is the portal saying it was too slow — both are FR-019b's "unreachable,
 * slow, or returning a server fault". Everything else, 4xx included, is an answer rather
 * than a failure to answer.
 *
 * **429 is deliberately absent.** It is a budget signal, and the graduated budget response
 * (FR-019, T064/T065) owns it; retrying one here would spend more of the very allowance
 * the portal has just said is running out.
 *
 * Exported because the claim path needs the same question and used to carry its own copy
 * of the answer under a second name. The two draw **opposite conclusions** from it — the
 * read asks again, the claim never does, because a second attempt at a mutation can commit
 * the same work twice (R7) — but the question is one question, and two copies of it are two
 * things to keep in step.
 */
export function isIndeterminateStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

/**
 * The portal saying this session is no longer valid.
 *
 * Here rather than at the call site because DC-1 requires a portal's own codes to be read at
 * the edge and named in our vocabulary before they reach anything that decides — and the
 * transport is the edge, being where {@link StrakerHttpError} is minted. `pollCycle.ts` used
 * to test `err.status === 401` itself, which put an HTTP number in the orchestrator.
 *
 * Narrow on purpose. A 403 is a barred account, and contract §4a exists because the two
 * arrive as the same kind of refusal on the same authenticated request: reading a
 * suspension as an expiry turns it into a sign-in storm against a portal that has already
 * said no. Anything that never became an HTTP reply is not an expiry either.
 */
export function isSessionExpired(error: unknown): boolean {
  return error instanceof StrakerHttpError && error.status === 401;
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

/**
 * Fail fast on a deadline that would make every request impossible: `AbortSignal.timeout(0)`
 * fires before the socket is open, so a zero or negative value does not mean "no deadline",
 * it means "nothing ever succeeds". Refused at construction, like the retry policy.
 */
function resolveTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error(`Straker timeoutMs must be above zero when set (got ${timeoutMs})`);
  }
  return timeoutMs;
}

/** One attempt's deadline: what to put on the wire, and how to read what came back. */
interface Deadline {
  /** Spread into the fetch init — an abort signal, or nothing at all when unset. */
  readonly fetchInit: { readonly signal?: AbortSignal };
  /** Did this attempt run out of time? Asked after a failure, to classify it. */
  expired(): boolean;
  /**
   * Give a failure its real name when the deadline caused it. What the platform raises is
   * `AbortError: This operation was aborted` — or, for a body cut off mid-stream, an
   * indistinguishable `TypeError: terminated`. Neither says how long we waited, and that
   * number is the first thing an operator needs.
   */
  name(error: unknown): unknown;
}

/**
 * `AbortSignal.timeout` rather than a hand-rolled controller: its timer does not hold the
 * event loop open, so there is nothing to clear when a request finishes early and no way
 * to leak one per attempt. The signal also covers the body, not just the headers — undici
 * errors a body that is still streaming when it fires — which matters because "headers
 * arrived, body never did" is exactly how a stalled read looks.
 */
function startDeadline(path: string, timeoutMs: number | undefined): Deadline {
  if (timeoutMs === undefined) {
    return { fetchInit: {}, expired: () => false, name: (error) => error };
  }
  const signal = AbortSignal.timeout(timeoutMs);
  return {
    fetchInit: { signal },
    expired: () => signal.aborted,
    name: (error) => (signal.aborted ? new StrakerTimeoutError(path, timeoutMs, error) : error),
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The body of a rejected reply, or a note saying why there is none.
 *
 * Reading it can fail on its own — a 503 that promises a Content-Length and then has its
 * connection reset is an ordinary shape for a portal in trouble. Outside a `try` that
 * rejection escapes `attempt()` altogether: no retry classification, no backoff, no alert,
 * no `StrakerRetryExhaustedError`, and the status — the one diagnostic worth having —
 * replaced by `TypeError: terminated`. The excerpt is the expendable part here; the status
 * is not, so the read is allowed to fail and the status carries on without it.
 */
async function bodyExcerpt(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch (error) {
    return `<body unreadable: ${describe(error)}>`;
  }
}

/** Operator-facing text for each way the budget can stop being readable. */
const BUDGET_UNKNOWN_DETAIL: Record<RateLimitUnknownReason, string> = {
  no_reply_yet: 'no reply seen yet, so no request budget has been read',
  headers_missing:
    'the portal stopped reporting its request budget (x-ratelimit-*) — the hard per-minute ceiling is now the only restraint',
  headers_nonsensical:
    'the portal reported a request budget that cannot be believed — the hard per-minute ceiling is now the only restraint',
};

/**
 * What this reply says about the budget. Three headers, all or nothing: a partial set is
 * as unusable as none, because pacing needs the remainder AND the moment it resets.
 */
function readBudget(response: Response): RateLimitBudget {
  // Floors, not just finiteness: an allowance of zero is not an allowance, a negative
  // remainder is not a count, and a reset stamp at the epoch is a deadline in 1970.
  const limit = budgetHeader(response, 'x-ratelimit-limit', 1);
  const remaining = budgetHeader(response, 'x-ratelimit-remaining', 0);
  const resetAtEpoch = budgetHeader(response, 'x-ratelimit-reset', 1);

  if (
    typeof limit !== 'number' ||
    typeof remaining !== 'number' ||
    typeof resetAtEpoch !== 'number'
  )
    return {
      known: false,
      reason:
        limit === 'absent' && remaining === 'absent' && resetAtEpoch === 'absent'
          ? 'headers_missing'
          : 'headers_nonsensical',
    };

  return { known: true, snapshot: { limit, remaining, resetAtEpoch } };
}

/** A budget header as it arrived: not sent, sent but unbelievable, or a number to pace on. */
type HeaderReading = 'absent' | 'unusable' | number;

/**
 * `Number.isFinite` alone accepts `-5` and `0`, and the contract is explicit that a
 * nonsensical value must not remove restraint (FR-019, contract §3). The reset stamp is
 * the dangerous one: pacing that waits for the reset would read a stamp in the past as
 * "the budget already refreshed" and poll freely — restraint removed by a bad value,
 * exactly the case the hard ceiling exists to cover. So an implausible reading is treated
 * as no reading, which routes it to that ceiling instead of into arithmetic.
 */
function budgetHeader(response: Response, name: string, floor: number): HeaderReading {
  const raw = response.headers.get(name);
  if (raw === null || raw.trim() === '') return 'absent';
  const value = Number(raw);
  return Number.isFinite(value) && value >= floor ? value : 'unusable';
}

/**
 * Two known gaps here, deliberately left open — **recorded, not fixed** (reviewer finding
 * F6, 2026-09-11):
 *
 * 1. A `Set-Cookie` value this cannot parse is dropped with no trace, so a portal that
 *    changed its session mechanism looks identical to one that sent no cookie.
 * 2. A deletion — `Set-Cookie: session=; Max-Age=0` — is stored as an empty value and kept.
 *    The send site above tests the *joined* string for truthiness, so an empty pair still
 *    goes out as `session=`, which is not the same as sending nothing.
 *
 * Both converge rather than wedge: an empty or stale session cookie earns a 401, and 401 is
 * the one status both callers answer by signing in again (`isSessionExpired` in `main.ts`,
 * `readWithOneReloginOn401` in `probe.ts`), which overwrites the jar. The cost is a wasted
 * round trip, not a stuck bot.
 *
 * Deferred because the fix cannot be made opt-in the way the deadline was: the jar is on
 * every client, so changing it changes the capture probe's behaviour while it is still
 * collecting the SC-000 evidence, which is the one thing this phase may not do. Worth doing
 * with T061's failure-mode suite (session expiry is already on its list), where a clock can
 * be injected and `Expires` handled alongside `Max-Age` rather than half of it now.
 */
function storeCookies(jar: Map<string, string>, response: Response): void {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
}
