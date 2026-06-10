import { createHash } from 'node:crypto';
import type { RawJob } from './types.js';

/**
 * Stable job identity (FR-005). Uses the portal job id when present; otherwise
 * a hash of (title | languagePair | deadline | url). Null fields are serialized
 * as a fixed empty string and every field is pipe-delimited so the hash is
 * deterministic. Values are trimmed and lowercased before hashing. Consequence:
 * if a hash-keyed job's fields change, it is treated as a different job.
 */
export function computeJobKey(job: RawJob): string {
  if (job.portalJobId && job.portalJobId.trim() !== '') {
    return job.portalJobId.trim();
  }
  const norm = (v: string | null): string => (v ?? '').trim().toLowerCase();
  const basis = [norm(job.title), norm(job.languagePair), norm(job.deadline), norm(job.url)].join(
    '|',
  );
  const digest = createHash('sha256').update(basis).digest('hex').slice(0, 16);
  return `h:${digest}`;
}

/** Hash of all displayed fields — detects detail changes on a visible job. */
export function computeSnapshotHash(job: RawJob): string {
  const basis = [
    job.portalJobId ?? '',
    job.title,
    job.languagePair ?? '',
    job.deadline ?? '',
    job.deadlineRaw ?? '',
    job.fee ?? '',
    job.url ?? '',
  ].join('|');
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}
