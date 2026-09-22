/**
 * The identity that survives every stage of one piece of work.
 *
 * On this portal a single job wears three ids in turn (2026-09-22):
 *
 * | Stage | Where | id | What it shares |
 * |---|---|---|---|
 * | offer | `/job-offers` | offer `obj_id` | `job_ref`, `target_lang`, `service` |
 * | purchase order, waiting for a person | `/api/hitl/vendor/purchase-orders` | `po_obj_id` | `job_ref`, `target_language_code`, `po_type` |
 * | assigned job | `/assigned-jobs` | a new `obj_id` | `external_job_id`, `target_lang`, `service` |
 *
 * Matching on `obj_id` alone is what released every won claim within one reconcile pass —
 * the job was sitting in the purchase-order stage, absent from the assigned list — and then
 * recorded it again as "found by reconciliation" once it moved on under its new id. The
 * shared triple is what ties the stages together; across 27 purchase orders it never
 * repeated.
 *
 * The source language is left out on purpose: a DTP purchase order carries empty language
 * codes, and one job has one source anyway. A target that is missing, empty or the same as
 * the source is one value — the DTP job is `target null` on the offer, `''` on the purchase
 * order and `ja>ja` on the assigned job.
 */

/** The reference fields a record carries, and the key they make. Every field is optional. */
export interface WorkIdentity {
  readonly jobRef: string | null;
  /** The file name, as the portal titles the job. For people, never for matching. */
  readonly title: string | null;
  readonly service: string | null;
  /** Null when the job reference or the service is missing: a guess would join unrelated work. */
  readonly workKey: string | null;
}

export const NO_WORK_IDENTITY: WorkIdentity = Object.freeze({
  jobRef: null,
  title: null,
  service: null,
  workKey: null,
});

/** A trimmed non-empty string, or null for anything else. */
export function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * One key part, spelled one way: Unicode NFKC (full-width letters and dashes fold to ASCII),
 * format characters removed (zero-width spaces and joiners, BOMs — `\p{Cf}`), trimmed,
 * lower-cased. Null when nothing is left.
 *
 * A key that differs by an invisible character is a match silently missed, and a missed match
 * is held work the restart guard cannot see and reconciliation cannot settle (2026-09-22).
 */
function keyPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const folded = value.normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLowerCase();
  return folded === '' ? null : folded;
}

/**
 * A language code as a key part: {@link keyPart}, and `_` read as `-` (`MS_MY` is `ms-my`).
 * Languages only — a service such as `dtp_prep` keeps its underscore, since the offer and the
 * purchase order are both observed to spell it that way and a rewrite could only split them.
 */
function languagePart(value: unknown): string {
  return keyPart(value)?.replace(/_/g, '-') ?? '';
}

/** The shared key, or null when it cannot be made honestly. */
export function workKey(
  jobRef: unknown,
  sourceLang: unknown,
  targetLang: unknown,
  service: unknown,
): string | null {
  const ref = keyPart(jobRef);
  const kind = keyPart(service);
  if (ref === null || kind === null) return null;
  const source = languagePart(sourceLang);
  const target = languagePart(targetLang);
  return `${ref}|${target === source ? '' : target}|${kind}`;
}

export function workIdentity(
  jobRef: unknown,
  sourceLang: unknown,
  targetLang: unknown,
  service: unknown,
  title: unknown,
): WorkIdentity {
  return {
    jobRef: optionalText(jobRef),
    title: optionalText(title),
    service: optionalText(service),
    workKey: workKey(jobRef, sourceLang, targetLang, service),
  };
}

/**
 * The fields a card or a sheet row shows, present only where known. Absent rather than null
 * so `exactOptionalPropertyTypes` payloads can spread it and a card renders "unknown".
 */
export function workLabels(identity: WorkIdentity | undefined): {
  title?: string;
  jobRef?: string;
  service?: string;
} {
  return {
    ...(identity?.title == null ? {} : { title: identity.title }),
    ...(identity?.jobRef == null ? {} : { jobRef: identity.jobRef }),
    ...(identity?.service == null ? {} : { service: identity.service }),
  };
}
