/**
 * Phase 0 probe cycle — READ ONLY.
 *
 * One cycle = read the open-offer list, hand it to the pure tracker, capture the raw
 * payload of anything new, and emit events. It never acts on an offer; the probe exists
 * only to answer "what does an offer payload look like, and how long does one survive?"
 * before feature 003 is specified.
 */

import { StrakerHttpError } from './httpClient.js';
import { applySnapshot } from './offerTracker.js';
import type { TrackerState } from './offerTracker.js';

/** The subset of an offer the probe relies on; everything else is captured verbatim. */
export interface RawOffer {
  readonly obj_id: string;
  readonly [field: string]: unknown;
}

export interface ProbeDeps {
  readonly vendorId: string;
  listOpenOffers(vendorId: string): Promise<readonly RawOffer[]>;
  captureOffer(objId: string, payload: RawOffer, atMs: number): Promise<void>;
  recordEvent(event: ProbeEvent): Promise<void>;
  /** Log in again. Called at most once per cycle, only for a 401 (recon §2). */
  reopenSession(): Promise<void>;
  now(): number;
}

export type ProbeEvent =
  | {
      readonly kind: 'appeared';
      readonly objId: string;
      readonly atMs: number;
      readonly sighting: number;
    }
  | {
      readonly kind: 'vanished';
      readonly objId: string;
      readonly atMs: number;
      readonly lifetimeMs: number;
      readonly upperBoundMs: number;
    }
  | { readonly kind: 'read_failed'; readonly atMs: number; readonly reason: string };

/**
 * A cycle never throws: the probe has to survive a 1-2 week unattended run. A failed read
 * returns `ok: false` with the state UNCHANGED — applying an empty list would tell the
 * tracker that every live offer vanished and stamp fabricated lifetimes on all of them,
 * which is the one way this probe could silently produce wrong answers.
 */
export type CycleOutcome =
  | { readonly ok: true; readonly state: TrackerState }
  | { readonly ok: false; readonly state: TrackerState };

export async function runProbeCycle(deps: ProbeDeps, state: TrackerState): Promise<CycleOutcome> {
  const atMs = deps.now();

  let offers: readonly RawOffer[];
  try {
    offers = await readWithOneReloginOn401(deps);
  } catch (error) {
    await deps.recordEvent({ kind: 'read_failed', atMs, reason: describe(error) });
    return { ok: false, state };
  }

  const byId = new Map(offers.map((offer) => [offer.obj_id, offer]));
  const result = applySnapshot(state, { atMs, offerIds: [...byId.keys()] });

  for (const offer of result.appeared) {
    const payload = byId.get(offer.objId);
    if (payload) await deps.captureOffer(offer.objId, payload, atMs);
    await deps.recordEvent({
      kind: 'appeared',
      objId: offer.objId,
      atMs,
      sighting: offer.sighting,
    });
  }

  for (const offer of result.vanished) {
    await deps.recordEvent({
      kind: 'vanished',
      objId: offer.objId,
      atMs,
      // Lower bound: last time we still saw it, minus first sighting.
      lifetimeMs: offer.lifetimeMs,
      // Upper bound: it was certainly gone by now, so the truth lies in between.
      upperBoundMs: offer.notFoundAtMs - offer.firstSeenAtMs,
    });
  }

  return { ok: true, state: result.state };
}

/**
 * A 401 is Straker's expired-session signal (recon §2), so it earns exactly ONE retry
 * behind a fresh login. Every other status — a 500 is a server fault, not an expired
 * session — is left alone, and the single retry keeps a genuinely rejected credential
 * from turning the probe into a login hammer against the portal.
 */
async function readWithOneReloginOn401(deps: ProbeDeps): Promise<readonly RawOffer[]> {
  try {
    return await deps.listOpenOffers(deps.vendorId);
  } catch (error) {
    if (!(error instanceof StrakerHttpError) || error.status !== 401) throw error;
    await deps.reopenSession();
    return deps.listOpenOffers(deps.vendorId);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
