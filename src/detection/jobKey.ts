import { createHash } from 'node:crypto';
import type { RawJob, XtmRawJob } from './types.js';

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

const normField = (v: string | null): string => (v ?? '').trim().toLowerCase();

/**
 * Stable XTM business identity (R3): the same file may appear as several tasks
 * (different workflow step / role), so identity is the `fileId|step|role`
 * composite — NOT the volatile `xtm_task_id` (an "ID-xxxx" that can churn). The
 * composite is normalized (trim + lowercase) and pipe-delimited so it is
 * deterministic across sessions.
 *
 * `fileName` stands in for the file identity until recon (D2) confirms whether
 * XTM exposes a distinct file id and whether project disambiguation is needed;
 * the selector/parse layer fails loud if the file column is missing rather than
 * letting two files collide silently.
 */
export function computeXtmJobKey(job: Pick<XtmRawJob, 'fileName' | 'step' | 'role'>): string {
  return [normField(job.fileName), normField(job.step), normField(job.role)].join('|');
}

/** Hash of displayed XTM fields — detects detail changes on a visible job. */
export function computeXtmSnapshotHash(job: XtmRawJob): string {
  const basis = [
    job.xtmTaskId ?? '',
    job.projectName,
    job.fileName,
    job.sourceLang ?? '',
    job.targetLang ?? '',
    job.dueDate ?? '',
    job.dueRaw ?? '',
    job.words === null ? '' : String(job.words),
    job.fileWwc === null ? '' : String(job.fileWwc),
    job.step ?? '',
    job.role ?? '',
    job.acceptAvailable ? '1' : '0',
  ].join('|');
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}
