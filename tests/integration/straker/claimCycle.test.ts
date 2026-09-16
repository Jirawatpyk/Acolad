/**
 * The claim path — the one irreversible action in feature 003, and the guarantees that
 * keep it from being made twice or slowed down.
 *
 * ## The two halves
 *
 * **The transport half** (first `describe` below) asserts FR-019c / V31 against `postJson`,
 * the one door a POST can go through:
 *
 * - **`postJson`'s arity**, held by a compile-time lock: it takes a path and a body and
 *   nothing else, so the transport offers the claim path no retry option to reach for.
 * - **`postJson`'s behaviour**: one attempt, no second attempt at any interval, no
 *   exhaustion alert — including from a client whose read path is retrying eagerly.
 *
 * On its own that half does **not** stop a caller writing its own loop: nothing in it
 * prevents a `claim.ts` from calling `postJson` three times with a backoff of its own.
 *
 * **The caller half** (the rest of the file) closes that gap now that `src/straker/claim.ts`
 * exists — T035/T036 for the action and its translation, T024/T025/T030 for the three
 * properties that are easy to lose and expensive to lose quietly:
 *
 * | Property | Task | Why it hides |
 * |---|---|---|
 * | A lost race alerts nobody and stops nothing | T024 | It is the most common non-win outcome; a bot that paged on it would be muted, and a muted bot misses the faults too |
 * | An unknown outcome is never retried | T025 | A second attempt is the same irreversible commitment made twice, and looks like diligence |
 * | Nothing is asked about an offer between noticing and claiming | T030 | It costs a round trip on the one path where a round trip decides the outcome, and nothing else about the system looks wrong |
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createHttpClient,
  StrakerHttpError,
  StrakerRetryExhaustedError,
} from '../../../src/straker/httpClient.js';
import type { StrakerHttpClient } from '../../../src/straker/httpClient.js';
import {
  CLAIM_REQUEST_BODY,
  claimOffer,
  claimRequestPath,
  type ClaimDoor,
  type ClaimTarget,
} from '../../../src/straker/claim.js';
import { classifyClaim } from '../../../src/straker/claimOutcome.js';
import { alertsOn } from '../../../src/straker/outcomePolicy.js';

const OFFERS_PATH = '/api/vendors/v1/job-offers?status=open';

/** A policy deliberately eager to retry, so any leak into the claim path shows up loudly. */
const EAGER_RETRY = { maxAttempts: 5, baseDelayMs: 10, factor: 2, maxDelayMs: 100 };

const TARGET: ClaimTarget = { vendorId: 'vendor-1', offerId: 'off-1' };
const SECOND_TARGET: ClaimTarget = { vendorId: 'vendor-1', offerId: 'off-2' };

/**
 * Stands in for the lost-race signal RP-4 will confirm against a real offer.
 *
 * `CONFIRMED_LOST_RACE_SIGNALS` is empty on purpose and must stay empty until that
 * confirmation, so the recognised path is exercised by passing a list in — never by
 * hard-coding a guess into the module and calling it confirmed.
 */
const SIGNALS_AS_IF_CONFIRMED = ['http_409'];

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

/** A fresh 2xx per call, so a test can claim more than one offer from one stub. */
function alwaysAccepting(): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse({})));
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

interface Harness {
  readonly client: StrakerHttpClient;
  readonly fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  /** Every interval the client waited. Empty is the claim path's whole point. */
  readonly waits: number[];
  /** The TRANSPORT's alert sink — distinct from the outcome model's `alertsOn`. */
  readonly onAlert: ReturnType<typeof vi.fn>;
}

/**
 * A client built to make a leak loud: the read path retries eagerly, waits are recorded
 * rather than served, and the transport has somewhere to alert. The claim path is asserted
 * against this one deliberately — a guarantee that only holds on a placid client is not a
 * guarantee.
 */
function harness(
  fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>,
  options: { timeoutMs?: number } = {},
): Harness {
  const timer = sleepRecorder();
  const onAlert = vi.fn();
  const client = createHttpClient({
    baseUrl: 'https://portal.test',
    fetchImpl,
    retry: EAGER_RETRY,
    sleep: timer.sleep,
    random: () => 1,
    onAlert,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { client, fetchImpl, waits: timer.waits, onAlert };
}

/** The methods the client was actually asked for, in order. */
function methodsUsed(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): (string | undefined)[] {
  return fetchImpl.mock.calls.map((call) => call[1]?.method);
}

/**
 * The claim dispatch at the TRANSPORT level, built from the same single definition of the
 * request that `claim.ts` uses — so the guess about the endpoint lives in exactly one place
 * and RP-4 corrects it once, rather than here and there diverging quietly.
 */
async function dispatchClaim(client: StrakerHttpClient, target: ClaimTarget): Promise<unknown> {
  return client.postJson(claimRequestPath(target), CLAIM_REQUEST_BODY);
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

/**
 * The same lock one level up (T030). `claim.ts` depends on a door with exactly ONE method,
 * so the module cannot fetch an offer's detail or list its files even if someone later
 * decided it should: there is no method on its dependency to do it with. The runtime tests
 * below prove it does not; this proves it could not.
 */
type _ClaimDoorIsPostOnly = _AssertTrue<keyof ClaimDoor extends 'postJson' ? true : false>;

describe('claim dispatch — the backoff never reaches the claim path (FR-019c, V31)', () => {
  it('attempts a claim that came back a server fault exactly once', async () => {
    const fetchImpl = alwaysFailing(500);
    const { client } = harness(fetchImpl);

    await expect(dispatchClaim(client, TARGET)).rejects.toBeInstanceOf(StrakerHttpError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('attempts a claim whose request never answered exactly once — the outcome stays unknown', async () => {
    // The worst case in the whole feature: the request may or may not have landed on the
    // portal. A second attempt would be the same irreversible commitment made twice, so
    // the unknown is left standing for reconciliation (FR-016a) to settle.
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const { client } = harness(fetchImpl);

    await expect(dispatchClaim(client, TARGET)).rejects.toThrow(/fetch failed/);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('waits at no interval before a claim — there is no interval at which one is retried', async () => {
    const fetchImpl = alwaysFailing(503);
    const { client, waits } = harness(fetchImpl);

    await dispatchClaim(client, TARGET).catch(() => undefined);

    // V31 is about "no second attempt at any interval", not merely "no fast retry".
    expect(waits).toEqual([]);
  });

  it('backs off on the read and does not on the claim — from one and the same client', async () => {
    const fetchImpl = alwaysFailing(500);
    const { client } = harness(fetchImpl);

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);
    const afterRead = fetchImpl.mock.calls.length;
    await dispatchClaim(client, TARGET).catch(() => undefined);

    // The asymmetry is a property of the transport, not of how it happened to be built:
    // the same instance, the same failure, two different answers.
    expect(afterRead).toBe(EAGER_RETRY.maxAttempts);
    expect(fetchImpl.mock.calls.length - afterRead).toBe(1);
  });

  it('raises no transport exhaustion alert for a failed claim — that outcome is not the transport to judge', async () => {
    const fetchImpl = alwaysFailing(500);
    const { client, onAlert } = harness(fetchImpl);

    const error: unknown = await dispatchClaim(client, TARGET).catch((e: unknown) => e);

    // A failed claim alerts through the claim-outcome model (`alertsOn`), keyed by offer
    // identity so FR-019a can de-duplicate it. If the transport alerted too, the same event
    // would page twice from two places with no shared de-duplication.
    expect(onAlert).not.toHaveBeenCalled();
    expect(error).not.toBeInstanceOf(StrakerRetryExhaustedError);
    expect(error).toBeInstanceOf(StrakerHttpError);
  });

  it('issues only reads from inside the retry loop, so no claim can ever be made from it', async () => {
    const fetchImpl = alwaysFailing(500);
    const { client } = harness(fetchImpl);

    await client.getJsonWithBackoff(OFFERS_PATH).catch(() => undefined);

    // The structural half of the guarantee: the retry loop builds its own GET request and
    // accepts no caller-supplied method or body, so "the claim path must not opt in" is not
    // a rule anyone has to remember — there is nothing to opt in with.
    expect(methodsUsed(fetchImpl)).toHaveLength(EAGER_RETRY.maxAttempts);
    expect(new Set(methodsUsed(fetchImpl))).toEqual(new Set(['GET']));
  });

  it('keeps the compile-time lock on the claim door honest', () => {
    // The types above are the assertion; this test exists so the locks are visible in the
    // run and a reader does not have to know that `npm run typecheck` is what enforces them.
    const doorLock: _ClaimDispatchTakesNoOptions = true;
    const actionLock: _ClaimDoorIsPostOnly = true;
    expect([doorLock, actionLock]).toEqual([true, true]);
  });
});

describe('claim.ts — nothing is asked about an offer before it is claimed (FR-002, T030, V32)', () => {
  it('issues exactly one request, and it is the claim', async () => {
    // Handed a client that CAN read — `getJson` and `getJsonWithBackoff` are both sitting
    // there — the action still makes one POST and nothing else. Kills the mutation where a
    // detail fetch or a file listing is added "just to check something first": that request
    // would show up here as a second call, and as a GET.
    const fetchImpl = alwaysAccepting();
    const { client } = harness(fetchImpl);

    await claimOffer(client, TARGET);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(methodsUsed(fetchImpl)).toEqual(['POST']);
  });

  it('asks nothing extra after a refusal either', async () => {
    // The tempting place to add an enquiry is the failure branch — "find out why we lost".
    // It costs a round trip on the race path all the same, and the answer changes nothing:
    // the claim is over. Kills a diagnostic GET added to the catch branch.
    const fetchImpl = alwaysFailing(409);
    const { client } = harness(fetchImpl);

    await claimOffer(client, TARGET);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(methodsUsed(fetchImpl)).toEqual(['POST']);
  });

  it('sends the offer identity it was given, without reading it off a payload', async () => {
    // SC-000 is still closed, so no field of an offer may be named. The action takes the
    // identifier as a value and puts it in the request; parsing a payload is T042's.
    const fetchImpl = alwaysAccepting();
    const { client } = harness(fetchImpl);

    await claimOffer(client, TARGET);

    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain(TARGET.offerId);
    expect(url).toContain(TARGET.vendorId);
  });

  it('refuses an unusable identity before anything is sent — either half of it', async () => {
    // Fail loud, and fail BEFORE the POST: a blank identifier would otherwise address some
    // other resource on an irreversible endpoint. Both halves are checked because a guard
    // that covers only the offer id is the easy one to write and the one that lets a claim
    // go to `/api/vendors//job-offers/...`. Kills a mutation that drops either check, and
    // one that moves the guard after the request.
    const unusable = [
      { vendorId: 'vendor-1', offerId: '  ' },
      { vendorId: '', offerId: 'off-1' },
    ];

    for (const target of unusable) {
      const fetchImpl = alwaysAccepting();
      const { client } = harness(fetchImpl);

      await expect(claimOffer(client, target)).rejects.toThrow(/identity/i);

      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe('claim.ts — one offer at a time, and never a second attempt (FR-004, FR-019c, R7, T025, T035)', () => {
  it('claims one offer per call — two offers are two separate single claims', async () => {
    // FR-004: there is no group action here, unlike XTM's bulk accept. Kills a mutation that
    // batches offers into one request — which on this portal would be a group commitment
    // nobody asked for.
    const fetchImpl = alwaysAccepting();
    const { client } = harness(fetchImpl);

    await claimOffer(client, TARGET);
    await claimOffer(client, SECOND_TARGET);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain(TARGET.offerId);
    expect(urls[0]).not.toContain(SECOND_TARGET.offerId);
    expect(urls[1]).toContain(SECOND_TARGET.offerId);
    expect(urls[1]).not.toContain(TARGET.offerId);
  });

  it('attempts a claim that came back a server fault exactly once, and waits at no interval', async () => {
    // The mutation this kills is the obvious one: a retry loop inside `claim.ts`. The client
    // underneath retries eagerly on reads, so a loop that reached for it would be visible as
    // extra calls; a hand-rolled one would be visible as extra calls too.
    const fetchImpl = alwaysFailing(500);
    const { client, waits } = harness(fetchImpl);

    await claimOffer(client, TARGET);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('leaves a claim that never answered UNKNOWN, and does not attempt it again', async () => {
    // V9 / R7. The request may or may not have landed; reconciliation settles it (FR-016a).
    // Kills two mutations at once: a retry on the unknown path, and classifying a
    // no-answer as a lost race — which would close the question wrongly AND silently,
    // since `lost` is the one outcome that never alerts.
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const { client, waits } = harness(fetchImpl);

    const attempt = await claimOffer(client, TARGET);

    expect(attempt.response.kind).toBe('no_answer');
    expect(classifyClaim(attempt.response, SIGNALS_AS_IF_CONFIRMED)).toBe('unknown');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('treats a claim that ran out of time as unknown, not as a failure to be retried', async () => {
    // A portal that accepts the connection and then goes quiet is the shape most likely to
    // tempt a retry: it looks transient. It is the one case where the claim may already be
    // committed, so it is the one case where a retry is worst. Kills a mutation that reads a
    // timeout as "definitely did not happen".
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );
    const { client, waits } = harness(fetchImpl, { timeoutMs: 10 });

    const attempt = await claimOffer(client, TARGET);

    expect(attempt.response.kind).toBe('no_answer');
    expect(classifyClaim(attempt.response, SIGNALS_AS_IF_CONFIRMED)).toBe('unknown');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('describes a failure that is not an Error, rather than alerting about [object Object]', async () => {
    // A rejection need not be an `Error` — a stub, a platform edge, or a library that throws
    // a bare value all land here. The outcome is still unknown and still unretried; what this
    // pins is that the reason stays READABLE, because it is the text an operator gets at 03:00
    // about a claim that may already be committed. Kills a mutation that interpolates the
    // failure straight into a template and yields "[object Object]".
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue({ code: 'ECONNRESET' });
    const { client } = harness(fetchImpl);

    const attempt = await claimOffer(client, TARGET);

    expect(classifyClaim(attempt.response, SIGNALS_AS_IF_CONFIRMED)).toBe('unknown');
    expect(attempt.detail).not.toContain('[object Object]');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still reports the outcome when the diagnostic text cannot be built', async () => {
    // Rendering a failure must never become a second failure. A value that refuses to
    // serialise would otherwise throw out of the translation, out of `claimOffer`, and into
    // the poll cycle — losing an UNKNOWN claim, the one outcome that most needs recording,
    // over the log line describing it. Kills a mutation that drops the guard around it.
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(circular);
    const { client } = harness(fetchImpl);

    const attempt = await claimOffer(client, TARGET);

    expect(classifyClaim(attempt.response, SIGNALS_AS_IF_CONFIRMED)).toBe('unknown');
    expect(typeof attempt.detail).toBe('string');
  });

  it('never throws for anything the portal does — the loop is not interrupted by a claim', async () => {
    // FR-006/SC-007 for the lost race, and the same property for every other answer: a throw
    // here would skip the recording that FR-003 defers until after the claim resolves, and
    // could take the poll cycle down with it. Kills a mutation that rethrows the transport
    // error instead of translating it.
    const conditions = [200, 401, 403, 409, 429, 500, 503];

    for (const status of conditions) {
      const fetchImpl = status === 200 ? alwaysAccepting() : alwaysFailing(status);
      const { client } = harness(fetchImpl);

      await expect(claimOffer(client, TARGET)).resolves.toBeDefined();
    }
  });
});

describe('claim.ts — the portal is translated at the edge (FR-027, DC-1, T036)', () => {
  it('reports a 2xx as accepted — the one outcome that counts as a win', async () => {
    const fetchImpl = alwaysAccepting();
    const { client } = harness(fetchImpl);

    const attempt = await claimOffer(client, TARGET);

    expect(attempt.response).toEqual({ kind: 'accepted' });
    expect(classifyClaim(attempt.response)).toBe('won');
    expect(attempt.followUp).toBe('none');
  });

  it('hands the decision a response it can read WITHOUT knowing anything about the portal', async () => {
    // DC-1: no portal-specific result code may reach the decision or orchestration layers.
    // What comes back is one of our three kinds plus an opaque token — no status number, no
    // transport error, nothing the caller has to interpret. Kills a mutation that returns
    // the `StrakerHttpError`, or a numeric status, for the caller to branch on.
    const fetchImpl = alwaysFailing(409);
    const { client } = harness(fetchImpl);

    const attempt = await claimOffer(client, TARGET);

    expect(attempt.response).not.toBeInstanceOf(StrakerHttpError);
    expect(Object.keys(attempt.response).sort()).toEqual(['kind', 'signal']);
    for (const value of Object.values(attempt.response)) {
      expect(typeof value).toBe('string');
    }
  });

  it('records a CONFIRMED lost-race signal as lost, and alerts nobody (FR-006, SC-007, V2, T024)', async () => {
    const fetchImpl = alwaysFailing(409);
    const { client, onAlert } = harness(fetchImpl);

    const attempt = await claimOffer(client, TARGET);
    const outcome = classifyClaim(attempt.response, SIGNALS_AS_IF_CONFIRMED);

    expect(outcome).toBe('lost');
    // The load-bearing pair: the outcome model does not alert on it, and the transport did
    // not alert underneath it either. Kills a mutation flipping `alertsOn('lost')`, and one
    // that routes a refused claim through the transport's alert sink.
    expect(alertsOn(outcome)).toBe(false);
    expect(onAlert).not.toHaveBeenCalled();
    expect(attempt.followUp).toBe('none');
  });

  it('carries on to the next offer after losing a race (FR-006, T024)', async () => {
    // "Does not interrupt the loop" is a property of a SEQUENCE, not of one call — a single
    // resolved promise would not show it. Kills a mutation that stops claiming after a loss,
    // which is the same shape as the account-blocked stop and must not be confused with it.
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({}, { status: 409 })))
      .mockImplementationOnce(() => Promise.resolve(jsonResponse({})));
    const { client, onAlert } = harness(fetchImpl);

    const lostAttempt = await claimOffer(client, TARGET);
    const wonAttempt = await claimOffer(client, SECOND_TARGET);

    expect(classifyClaim(lostAttempt.response, SIGNALS_AS_IF_CONFIRMED)).toBe('lost');
    expect(classifyClaim(wonAttempt.response, SIGNALS_AS_IF_CONFIRMED)).toBe('won');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onAlert).not.toHaveBeenCalled();
  });

  it('treats an UNRECOGNISED refusal as a fault, never as a lost race (FR-005a)', async () => {
    // The most important asymmetry in the feature. With no signal confirmed — which is where
    // the system stands until RP-4 — every refusal is a fault that alerts. Kills the
    // mutation that makes an unrecognised refusal `lost`: that outcome never alerts, so a
    // broken claim path would look exactly like a bot that keeps arriving second.
    const fetchImpl = alwaysFailing(422);
    const { client } = harness(fetchImpl);

    const attempt = await claimOffer(client, TARGET);

    expect(classifyClaim(attempt.response, SIGNALS_AS_IF_CONFIRMED)).toBe('failed');
    expect(classifyClaim(attempt.response)).toBe('failed');
    expect(alertsOn('failed')).toBe(true);
  });

  it('gives distinguishable signals to distinguishable refusals', async () => {
    // Two refusals that differ on the portal must differ to us, or the single confirmation
    // RP-4 makes would silently cover both. Kills a mutation that collapses every refusal
    // onto one signal — which would compile, pass every other test here, and make the
    // confirmed lost-race signal match faults as well.
    const first = await claimOffer(harness(alwaysFailing(409)).client, TARGET);
    const second = await claimOffer(harness(alwaysFailing(422)).client, TARGET);

    expect(first.response).not.toEqual(second.response);
  });
});

describe('claim.ts — a barred account is not an expired session (contract §4a)', () => {
  it('stops claiming, loudly, when the account itself is refused', async () => {
    // §4a: alert immediately and stop claiming; never retry around it as though it were
    // transient. Kills a mutation that treats it as an ordinary fault and carries on
    // POSTing claims at a portal that has already said no — which is how a block becomes
    // permanent.
    const fetchImpl = alwaysFailing(403);
    const { client } = harness(fetchImpl);

    const attempt = await claimOffer(client, TARGET);

    expect(attempt.followUp).toBe('stop_claiming');
    expect(alertsOn(classifyClaim(attempt.response, SIGNALS_AS_IF_CONFIRMED))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks for a new session — not a stop — when the session expired', async () => {
    // The conflation §4a warns about, in both directions. A 401 self-heals by signing in
    // again (the precedent `main.ts` already set); a block does not. Kills a mutation that
    // widens the block to every authentication refusal, which would halt the bot on an
    // ordinary session expiry.
    const fetchImpl = alwaysFailing(401);
    const { client } = harness(fetchImpl);

    const attempt = await claimOffer(client, TARGET);

    expect(attempt.followUp).toBe('re_authenticate');
  });

  it('leaves an ordinary fault alone — it is neither a block nor a session problem', async () => {
    // Kills a mutation that widens either follow-up to cover every refusal, which would turn
    // one bad afternoon at the portal into a stopped bot or a sign-in loop.
    for (const status of [409, 422, 429, 500]) {
      const { client } = harness(alwaysFailing(status));

      const attempt = await claimOffer(client, TARGET);

      expect(attempt.followUp).toBe('none');
    }
  });

  it('never re-authenticates its way into a second claim', async () => {
    // The follow-up is advice to the ORCHESTRATOR, not an action this module takes. A module
    // that signed in and claimed again would satisfy every "is it a 401" assertion above
    // while making the commitment twice. Kills that mutation: one call in, one request out,
    // whatever the follow-up says.
    const fetchImpl = alwaysFailing(401);
    const { client, waits } = harness(fetchImpl);

    await claimOffer(client, TARGET);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(methodsUsed(fetchImpl)).toEqual(['POST']);
    expect(waits).toEqual([]);
  });
});
