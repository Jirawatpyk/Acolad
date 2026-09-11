/**
 * The one endpoint the Phase 0 probe reads. Nothing here mutates anything on Straker.
 */

import type { StrakerHttpClient } from './httpClient.js';
import type { RawOffer } from './probe.js';

/**
 * Recon §4.2: `job-offers` returns a BARE array while `assigned-jobs` returns an
 * `{ items, total, ... }` envelope. If Straker ever moves this endpoint to an envelope,
 * a permissive cast would quietly read "zero open offers" forever — the same silent-zero
 * failure that cost the XTM bot 38 minutes of missed jobs. So the shape is checked.
 */
export interface ListOffersOptions {
  /**
   * Read through the retrying door (FR-019b). **Opt-in, and default off on purpose**: the
   * capture probe calls this same function and must keep behaving byte-for-byte as it does
   * today while it collects the SC-000 evidence. The bot opts in; the probe never does.
   *
   * This flag is the join FR-019b actually depends on. Implementing the backoff inside the
   * transport and then reading through the other door leaves the requirement satisfied in
   * `httpClient.ts` and absent in the running bot — which is exactly what happened before
   * `tests/integration/straker/sightingCycle.test.ts` started asserting which door was used.
   */
  readonly retry?: boolean;
}

export async function listOpenOffers(
  client: StrakerHttpClient,
  vendorId: string,
  options: ListOffersOptions = {},
): Promise<readonly RawOffer[]> {
  const path = `/api/vendors/${vendorId}/job-offers?status=open`;
  const reply = await (options.retry === true
    ? client.getJsonWithBackoff<unknown>(path)
    : client.getJson<unknown>(path));

  if (!Array.isArray(reply)) {
    throw new Error(
      `Straker job-offers reply is no longer a bare array (got ${typeof reply}) — refusing to read it as zero offers`,
    );
  }

  for (const entry of reply) {
    const objId: unknown = (entry as { obj_id?: unknown } | null)?.obj_id;
    if (typeof objId !== 'string' || objId === '') {
      throw new Error('Straker job-offers entry has no obj_id — offer identity is unusable');
    }
  }

  return reply as readonly RawOffer[];
}
