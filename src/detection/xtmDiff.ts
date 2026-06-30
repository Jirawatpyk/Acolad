import { computeXtmJobKey, computeXtmSnapshotHash } from './jobKey.js';
import { diffGeneric } from './diff.js';
import type {
  DetailsChange,
  DiffAdapter,
  DiffResultOf,
  XtmJobSnapshot,
  XtmJobState,
  XtmRawJob,
} from './types.js';

const numStr = (n: number | null): string | null => (n === null ? null : String(n));

/**
 * A job is "held" once accepted — its words sit in the per-deadline-day capacity bucket
 * (`XtmJobStore.wordsDueByDeadline`, keyed off `lifecycle_status='accepted'`) until it
 * finishes. acceptStatus and lifecycleStatus are written together, but check BOTH so the
 * lock holds regardless of which one the orchestration mutates first.
 */
const isHeld = (s: XtmJobState): boolean =>
  s.acceptStatus === 'accepted' || s.lifecycleStatus === 'accepted';

const parseableDate = (v: string | null): boolean => v != null && Number.isFinite(Date.parse(v)); // Date.parse('') is NaN → already caught
const usableNum = (n: number | null): boolean => n != null && Number.isFinite(n);

/**
 * F1 (over-accept guard): the `dueDate`/`words` a still-visible/relisted job commits this
 * cycle. Normally the fresh grid values, BUT a HELD (accepted) job stays visible in Active
 * and the grid re-syncs its cells every cycle — a transient blank/unparseable read must NOT
 * erase the committed deadline/words. Erasing them would drop the job from (or zero it in)
 * its deadline-day capacity bucket, under-counting that day's load and over-accepting a later
 * same-deadline Malay job on the IRREVERSIBLE bulk-claim path. So for a held job a null/empty/
 * unparseable incoming value keeps the existing one; a genuine non-null value is still taken
 * (deadline extensions still apply). Non-held jobs are untouched (their cells are not load-
 * bearing for capacity, and they are re-evaluated by the gate every cycle anyway).
 *
 * `fileWwc` is a committed-display field like `words` (logged to the Sheet's File WWC column): a
 * held job's committed File WWC must survive a transient blank/unparseable re-read the same way —
 * `0` stays a real value, only null/NaN locks. It does NOT affect capacity (the cap uses `words`).
 */
function lockedDisplayFields(
  existing: XtmJobState,
  raw: XtmRawJob,
): { dueDate: string | null; words: number | null; fileWwc: number | null } {
  if (!isHeld(existing)) return { dueDate: raw.dueDate, words: raw.words, fileWwc: raw.fileWwc };
  return {
    dueDate: parseableDate(raw.dueDate) ? raw.dueDate : (existing.dueDate ?? raw.dueDate),
    words: usableNum(raw.words) ? raw.words : (existing.words ?? raw.words),
    fileWwc: usableNum(raw.fileWwc) ? raw.fileWwc : (existing.fileWwc ?? raw.fileWwc),
  };
}

function buildXtmState(key: string, raw: XtmRawJob, at: string, hash: string): XtmJobState {
  return {
    jobKey: key,
    xtmTaskId: raw.xtmTaskId,
    projectName: raw.projectName,
    fileName: raw.fileName,
    sourceLang: raw.sourceLang,
    targetLang: raw.targetLang,
    dueDate: raw.dueDate,
    dueRaw: raw.dueRaw,
    words: raw.words,
    fileWwc: raw.fileWwc,
    step: raw.step,
    role: raw.role,
    // Business fields are owned by the orchestration (eligibility + accept +
    // lifecycle), NOT by diff. A freshly-seen job starts 'new'/'none'.
    eligible: false,
    lifecycleStatus: 'new',
    acceptStatus: 'none',
    acceptedAt: null,
    // Appearance bookkeeping (owned by diff).
    status: 'visible',
    firstSeenAt: at,
    lastSeenAt: at,
    snapshotHash: hash,
    consecutiveMisses: 0,
  };
}

/**
 * Refresh the displayed XTM fields on a still-visible/relisted job WITHOUT
 * touching the business fields (lifecycleStatus/acceptStatus/acceptedAt/eligible)
 * — those are owned by the orchestration, so diff must preserve whatever it set.
 */
function applyXtmState(existing: XtmJobState, raw: XtmRawJob, hash: string): XtmJobState {
  const { dueDate, words, fileWwc } = lockedDisplayFields(existing, raw);
  return {
    ...existing,
    xtmTaskId: raw.xtmTaskId,
    projectName: raw.projectName,
    fileName: raw.fileName,
    sourceLang: raw.sourceLang,
    targetLang: raw.targetLang,
    dueDate,
    dueRaw: raw.dueRaw,
    words,
    fileWwc,
    step: raw.step,
    role: raw.role,
    snapshotHash: hash,
  };
}

function xtmFieldChanges(prev: XtmJobState, raw: XtmRawJob): DetailsChange['changes'] {
  // Compare against the EFFECTIVE (post-lock) dueDate/words so a held job whose grid cell
  // read blank does not report a spurious "dueDate → null" change (which would re-sync the
  // Sheet with the same locked value every cycle). A genuine change still surfaces.
  const { dueDate, words, fileWwc } = lockedDisplayFields(prev, raw);
  const compare: [string, string | null, string | null][] = [
    ['projectName', prev.projectName, raw.projectName],
    ['fileName', prev.fileName, raw.fileName],
    ['sourceLang', prev.sourceLang, raw.sourceLang],
    ['targetLang', prev.targetLang, raw.targetLang],
    ['dueDate', prev.dueDate, dueDate],
    ['step', prev.step, raw.step],
    ['role', prev.role, raw.role],
    ['words', numStr(prev.words), numStr(words)],
    ['fileWwc', numStr(prev.fileWwc), numStr(fileWwc)],
  ];
  const fields: { field: string; from: string | null; to: string | null }[] = [];
  for (const [field, from, to] of compare) {
    if (from !== to) fields.push({ field, from, to });
  }
  return fields;
}

/** XTM appearance adapter (R3 composite key + XTM snapshot hash). */
export const xtmAdapter: DiffAdapter<XtmRawJob, XtmJobState> = {
  key: (raw) => computeXtmJobKey(raw),
  hash: (raw) => computeXtmSnapshotHash(raw),
  build: buildXtmState,
  apply: applyXtmState,
  changes: xtmFieldChanges,
};

/** XTM diff — same appearance algorithm as 001, over the XTM job shape. */
export function diffXtm(
  snapshot: XtmJobSnapshot,
  prev: Map<string, XtmJobState>,
  opts: { baseline: boolean } = { baseline: false },
): DiffResultOf<XtmJobState> {
  return diffGeneric(
    snapshot.jobs,
    snapshot.pollCycleId,
    snapshot.capturedAt,
    prev,
    xtmAdapter,
    opts,
  );
}
