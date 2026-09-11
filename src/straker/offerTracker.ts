/**
 * Phase 0 offer-lifetime tracker (read-only probe).
 *
 * Pure state transition, mirroring the role `detection/diff.ts` plays for XTM: it owns
 * the "appeared / still here / vanished" decision so the probe loop only persists what
 * this function decided. The number Phase 0 exists to measure — how long an open offer
 * survives — falls out of `vanished[].lifetimeMs`.
 */

export interface TrackedOffer {
  readonly objId: string;
  readonly firstSeenAtMs: number;
  readonly lastSeenAtMs: number;
  /**
   * 1-based count of how many times THIS obj_id has appeared in the open list. An offer
   * that drops out and returns starts a fresh sighting (the 002 appearance-event model),
   * so distinct-offer counts must be taken over obj_ids, not over sightings — the Phase 0
   * exit criterion is ">= 10 distinct offers", which a single flapping id must not satisfy.
   */
  readonly sighting: number;
}

/** Serialisable so the probe survives a restart without losing sighting history. */
export interface TrackerState {
  readonly live: readonly TrackedOffer[];
  readonly sightingsByObjId: readonly (readonly [objId: string, count: number])[];
}

export interface OfferSnapshot {
  readonly atMs: number;
  readonly offerIds: readonly string[];
}

/**
 * A sighting that ended. The true disappearance happened somewhere inside
 * (`lastSeenAtMs`, `notFoundAtMs`] — one poll interval wide — so `lifetimeMs` is a
 * LOWER BOUND, and `notFoundAtMs - firstSeenAtMs` is the upper one. Both are kept so
 * the Phase 0 report can state that uncertainty instead of hiding it.
 */
export interface VanishedOffer extends TrackedOffer {
  readonly notFoundAtMs: number;
  readonly lifetimeMs: number;
}

export interface SnapshotResult {
  readonly state: TrackerState;
  readonly appeared: readonly TrackedOffer[];
  readonly vanished: readonly VanishedOffer[];
}

export function emptyTrackerState(): TrackerState {
  return { live: [], sightingsByObjId: [] };
}

export function applySnapshot(state: TrackerState, snapshot: OfferSnapshot): SnapshotResult {
  const known = new Map(state.live.map((offer) => [offer.objId, offer]));
  const sightings = new Map(state.sightingsByObjId);
  const stillListed = new Set(snapshot.offerIds);
  const appeared: TrackedOffer[] = [];
  const live: TrackedOffer[] = [];

  for (const objId of snapshot.offerIds) {
    const seenBefore = known.get(objId);
    if (seenBefore) {
      live.push({ ...seenBefore, lastSeenAtMs: snapshot.atMs });
      continue;
    }
    const sighting = (sightings.get(objId) ?? 0) + 1;
    sightings.set(objId, sighting);
    const offer: TrackedOffer = {
      objId,
      firstSeenAtMs: snapshot.atMs,
      lastSeenAtMs: snapshot.atMs,
      sighting,
    };
    live.push(offer);
    appeared.push(offer);
  }

  const vanished: VanishedOffer[] = state.live
    .filter((offer) => !stillListed.has(offer.objId))
    .map((offer) => ({
      ...offer,
      notFoundAtMs: snapshot.atMs,
      lifetimeMs: offer.lastSeenAtMs - offer.firstSeenAtMs,
    }));

  return { state: { live, sightingsByObjId: [...sightings] }, appeared, vanished };
}
