/**
 * Claiming one offer — the single irreversible action in this feature (T035, T036).
 *
 * A claim cannot be undone, and a duplicate claim commits the team to the same work twice.
 * Everything below follows from that one fact:
 *
 * - **One offer per call** (FR-004). There is no group action on this portal, unlike XTM's
 *   bulk accept, so there is no all-or-nothing group rule here and no way to commit a
 *   neighbour by accident.
 * - **One request, ever** (FR-019c, R7). No loop, no second call, no interval at which one
 *   would happen. An outcome this module cannot determine is returned as undetermined and
 *   settled later by reconciliation against the portal (FR-016a) — never by asking again.
 * - **Nothing else is asked first** (FR-002). The decision is made from the offer list
 *   alone; this module's dependency has exactly one method, so it could not enquire further
 *   even if someone later wanted it to.
 * - **The portal's vocabulary stops here** (FR-027 / DC-1). What leaves this file is a
 *   `ClaimResponse` in our own words plus a follow-up instruction. No status code, no
 *   transport error and no portal result code reaches the decision or orchestration layers.
 *
 * ## What this module does NOT do
 *
 * It does not decide, record, announce, or log. `classifyClaim` turns the response into a
 * `ClaimOutcome`, and the poll cycle records and announces afterwards (FR-003 keeps that
 * work off the race path deliberately). This module also never acts on its own follow-up
 * advice: re-opening a session is the orchestrator's to do, and a module that signed in and
 * claimed again would be making the irreversible commitment twice while looking careful.
 *
 * Per the spec's non-goals and FR-007, there is no code here for refusing an offer on the
 * portal. Unwanted offers are left to expire.
 *
 * ## Where the request comes from
 *
 * Contract §4, confirmed 2026-09-18 from the portal's own web app: its Accept button POSTs
 * `/api/vendors/{vendorId}/job-offers/{obj_id}/accept`. The path had been a guess by analogy
 * (`/claim`), and the first real claim proved the guess wrong with a 404 — single-sourcing
 * it here is what made correcting it one edit. Still unobserved: a *won* claim's reply.
 */

import type { ClaimResponse } from './claimOutcome.js';
import { isIndeterminateStatus, StrakerHttpError } from './httpClient.js';

/**
 * The only capability this module has: one POST, no options.
 *
 * Narrower than `StrakerHttpClient` on purpose, and the narrowing is the guarantee behind
 * FR-002/V32 — a detail fetch or a file listing is not something this module chose not to
 * do, it is something it has no method to do. `tests/integration/straker/claimCycle.test.ts`
 * locks the shape at compile time so widening it fails the typecheck.
 */
export interface ClaimDoor {
  postJson<T>(path: string, body: unknown): Promise<T>;
}

/** Which offer, on whose behalf. Values, never fields read off a payload (SC-000, T042). */
export interface ClaimTarget {
  readonly vendorId: string;
  readonly offerId: string;
}

/**
 * What the orchestrator must do next, translated out of the portal's vocabulary.
 *
 * Deliberately three mutually exclusive values rather than a pair of flags: an expired
 * session and a barred account arrive as the same kind of refusal on the same authenticated
 * request, and contract §4a exists because conflating them turns a suspension into a
 * sign-in loop against a portal that has already said no.
 */
export type ClaimFollowUp =
  /** Nothing special. Carry on with the next offer, including after a lost race (FR-006). */
  | 'none'
  /** The session expired. Sign in again; it self-heals (the precedent `main.ts` set). */
  | 're_authenticate'
  /** The account is barred (contract §4a). Alert now and make no further claim. */
  | 'stop_claiming';

/** One claim attempt, over. Everything the caller needs to decide, record and log. */
export interface ClaimAttempt {
  /** Echoed back so a result can be matched to its offer without holding the target. */
  readonly offerId: string;
  /** The portal's answer in our words. Feed it to `classifyClaim`. */
  readonly response: ClaimResponse;
  /** What to do about the session or the account — never about this offer. */
  readonly followUp: ClaimFollowUp;
  /**
   * Human-readable diagnostics for the log line: the status and a body excerpt, or the
   * failure's own description. **Never a decision input** — nothing should branch on it.
   */
  readonly detail: string;
}

/**
 * The body of a claim request: none.
 *
 * The identity travels in the path, and the portal's web app sends its Accept with
 * `body: undefined` — no payload and no JSON content type. `undefined` tells the POST door to
 * send exactly that. (It had been `{}`, a guess that the endpoint would ignore an empty
 * object; matching the real client leaves nothing to guess.) Exported so the transport-level
 * tests build the same request this module does.
 */
export const CLAIM_REQUEST_BODY: undefined = undefined;

/**
 * Where a claim is sent: `POST /api/vendors/{vendorId}/job-offers/{obj_id}/accept`.
 *
 * Confirmed 2026-09-18 from the portal's own web app, whose Accept button calls exactly this.
 * An earlier guess, `/claim`, was the first real claim ever sent and got `404 Not Found` — the
 * route does not exist — while the offer stayed open for two more minutes. Both segments are
 * percent-encoded: the ids
 * are opaque portal strings, and a `/` arriving inside one would otherwise address a
 * different resource entirely — on an endpoint whose action cannot be undone. Encoding turns
 * that into a loud 404 instead of a quiet claim on the wrong thing.
 */
export function claimRequestPath(target: ClaimTarget): string {
  const vendor = encodeURIComponent(target.vendorId);
  const offer = encodeURIComponent(target.offerId);
  return `/api/vendors/${vendor}/job-offers/${offer}/accept`;
}

/**
 * Attempt to claim one offer. Resolves for every answer the portal can give, including
 * none: a throw here would skip the recording FR-003 defers until after the claim resolves,
 * and could take the poll cycle down over an outcome that is ordinary (FR-006, SC-007).
 *
 * The one exception is an unusable identity, which throws **before** anything is sent —
 * it is a programming fault rather than a portal condition, and letting it through would
 * address an unknown resource on an irreversible endpoint.
 */
export async function claimOffer(door: ClaimDoor, target: ClaimTarget): Promise<ClaimAttempt> {
  requireIdentity(target);

  try {
    // The single request. There is no loop around it, and deliberately no `catch` that
    // leads back to it: R7's "never retried, at any interval" is kept by there being
    // nowhere for a second attempt to be written.
    await door.postJson<unknown>(claimRequestPath(target), CLAIM_REQUEST_BODY);
    return {
      offerId: target.offerId,
      response: { kind: 'accepted' },
      followUp: 'none',
      detail: 'the portal accepted the claim',
    };
  } catch (error) {
    return translate(target, error);
  }
}

/**
 * The edge (FR-027 / DC-1): the portal's answer, in our words, and nothing of the portal's
 * own left in it.
 *
 * Three destinations, and the line between the last two is the careful one:
 *
 * - An HTTP refusal the portal chose to send is a **rejection** — it decided, and the claim
 *   did not land.
 * - A server fault or a request that timed out is **no answer**: the portal may have
 *   committed the work before failing to say so. Calling that a rejection would assert
 *   something we cannot know, in the direction where being wrong means the team owns work
 *   that reached no record.
 * - Anything that never became an HTTP reply at all — unreachable, connection dropped, our
 *   own deadline, a body that was not JSON — is **no answer** for the same reason.
 */
function translate(target: ClaimTarget, error: unknown): ClaimAttempt {
  // The transport's own predicate, not a second copy of it. The read path draws the
  // opposite conclusion from the same question — it asks again, this never does — because a
  // second attempt at a mutation can commit the same work twice (R7). So an indeterminate
  // status is routed to `unknown` and left to reconciliation (FR-016a): the outcome that
  // alerts once and is repaired, rather than one that closes a question nobody can answer.
  if (error instanceof StrakerHttpError && !isIndeterminateStatus(error.status)) {
    return {
      offerId: target.offerId,
      response: { kind: 'rejected', signal: rejectionSignal(error.status) },
      followUp: followUpFor(error.status),
      detail: `${error.status}: ${error.bodyExcerpt}`,
    };
  }

  const reason =
    error instanceof StrakerHttpError ? rejectionSignal(error.status) : describeError(error);
  return {
    offerId: target.offerId,
    response: { kind: 'no_answer', reason },
    followUp: 'none',
    detail: describeError(error),
  };
}

/**
 * The portal's refusal as an opaque token in OUR namespace.
 *
 * Derived from the status rather than from a code in the body because no field of a claim
 * reply has been observed either (§4 is unexercised). The token's content is diagnostic,
 * never decisional: `classifyClaim` compares it against the confirmed-signal list by exact
 * string match and knows nothing about HTTP — which is what keeps FR-027 true even though
 * the string is portal-derived. Distinct refusals must stay distinct here, or the single
 * confirmation RP-4 makes would silently cover faults as well.
 *
 * If RP-4 finds the lost-race signal lives in the reply body rather than in the status,
 * this function is where it is read from, and nothing above it changes.
 */
function rejectionSignal(status: number): string {
  return `http_${status}`;
}

/**
 * What the refusal says about the SESSION or the ACCOUNT — never about this offer.
 *
 * `401` follows the precedent `main.ts` set: exactly one status means "sign in again", and
 * a barred account, a server fault and a broken contract are deliberately not session
 * problems.
 *
 * `403` is read as the account being barred, and the asymmetry of harm is why. Contract §4a
 * is NOT OBSERVED, so this is a judgement, not an observation: if it is wrong, the bot stops
 * claiming and alerts a human, which is loud, visible and recoverable. The opposite error —
 * reading a real suspension as an ordinary fault — keeps POSTing claims at a portal that has
 * already refused the account, every cycle, which is how a block becomes permanent.
 * **RP-4 must confirm this on the first real claim**, since a portal that answered a lost
 * race with 403 would stop the bot on the most ordinary outcome there is.
 */
function followUpFor(status: number): ClaimFollowUp {
  if (status === 401) return 're_authenticate';
  // A redirect on the accept POST (never followed — see the transport's `postInit`) is most
  // likely a bounce to a login page: the session is gone. The claim itself stays `failed`
  // and alerts — a redirect is not the portal saying "taken" — and is never retried; only
  // the NEXT cycle signs in again.
  if (status >= 300 && status < 400) return 're_authenticate';
  if (status === 403) return 'stop_claiming';
  return 'none';
}

/** Fail loud, and fail before the request: a blank id would address something else. */
function requireIdentity(target: ClaimTarget): void {
  const missing: string[] = [];
  if (target.vendorId.trim() === '') missing.push('vendorId');
  if (target.offerId.trim() === '') missing.push('offerId');
  if (missing.length > 0) {
    throw new Error(
      `Straker claim has unusable identity (${missing.join(', ')} blank) — refusing to send it`,
    );
  }
}

/**
 * A failure, in words an operator can act on.
 *
 * The `[object Object]` guard is not cosmetic: this text is the whole of what a human gets
 * about a claim whose outcome is unknown — a claim that may already be committed — and a
 * rejection that is not an `Error` (a bare object carrying `code`, say) renders as
 * `[object Object]` under a plain `String()`. That is an alert with the diagnosis removed.
 * Capped at the same 200 characters the transport uses for a body excerpt.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;

  const rendered = String(error);
  if (rendered !== '[object Object]') return rendered;
  try {
    return JSON.stringify(error)?.slice(0, 200) ?? rendered;
  } catch {
    // Circular, or a value that refuses to serialise. Nothing better is available, and
    // failing to build a log line must never replace the outcome being reported.
    return rendered;
  }
}
