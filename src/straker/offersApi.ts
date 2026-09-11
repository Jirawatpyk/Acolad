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
export async function listOpenOffers(
  client: StrakerHttpClient,
  vendorId: string,
): Promise<readonly RawOffer[]> {
  const reply = await client.getJson<unknown>(`/api/vendors/${vendorId}/job-offers?status=open`);

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
