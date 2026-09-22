/**
 * The one endpoint the Phase 0 probe reads. Nothing here mutates anything on Straker.
 */

import type { StrakerHttpClient } from './httpClient.js';
import type { RawOffer } from './probe.js';

/**
 * Recon §4.2: `job-offers` returns a BARE array while `assigned-jobs` returns an
 * `{ items, total, ... }` envelope. If Straker ever moves this endpoint to an envelope, a
 * permissive cast would quietly read "zero open offers" forever. So the shape is checked.
 *
 * ## The silent zero — and what the XTM precedent actually was
 *
 * This feature cites a 38-minute outage in several places, so it is worth stating once,
 * accurately, here at the read it is really about.
 *
 * The XTM bot spent about 38 minutes and 114 polls reporting no jobs while a real one sat
 * in Active. The mechanism was **not** a fault, an error reply, or an unexpected payload
 * shape: the inbox grid renders its shell and a "0 - 0 of 0" footer immediately and fills
 * the rows from a *later* XHR, so a read that **succeeded** against a DOM the data had not
 * reached yet saw zero rows. Straker is HTTP-only and cannot reproduce that — there is no
 * DOM to race, and the read either returns a list or throws.
 *
 * What carries over is not the mechanism but why it lasted 38 minutes. A zero is the one
 * answer that looks identical whether it is true or a failure to see: no exception, no log
 * line, no failed heartbeat, and — in that case — no way even in principle to tell a
 * loading grid from an empty one. Every "must never be read as zero offers" rule in this
 * feature (FR-023, and the throws in `httpClient.ts` and `pollCycle.ts`) exists to stop a
 * *different* route to that same consequence from being equally quiet.
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
   * `tests/integration/straker/botWiring.test.ts` started asserting which door was used.
   */
  readonly retry?: boolean;
  /**
   * Keep the first entry of any `obj_id` the reply lists more than once, and report the
   * repeats here (2026-09-22). One offer listed twice would otherwise be decided twice and
   * claimed twice in the same cycle — an irreversible double commitment. Opt-in for the same
   * reason as `retry`: the capture probe must keep reading the reply byte-for-byte.
   */
  readonly onDuplicate?: (objIds: readonly string[]) => void;
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

  const offers = reply as readonly RawOffer[];
  if (options.onDuplicate === undefined) return offers;

  const seen = new Set<string>();
  const repeated = new Set<string>();
  const unique: RawOffer[] = [];
  for (const offer of offers) {
    if (seen.has(offer.obj_id)) {
      repeated.add(offer.obj_id);
      continue;
    }
    seen.add(offer.obj_id);
    unique.push(offer);
  }
  if (repeated.size > 0) options.onDuplicate([...repeated]);
  return unique;
}
