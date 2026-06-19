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

const wordsStr = (w: number | null): string | null => (w === null ? null : String(w));

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
  return {
    ...existing,
    xtmTaskId: raw.xtmTaskId,
    projectName: raw.projectName,
    fileName: raw.fileName,
    sourceLang: raw.sourceLang,
    targetLang: raw.targetLang,
    dueDate: raw.dueDate,
    dueRaw: raw.dueRaw,
    words: raw.words,
    step: raw.step,
    role: raw.role,
    snapshotHash: hash,
  };
}

function xtmFieldChanges(prev: XtmJobState, raw: XtmRawJob): DetailsChange['changes'] {
  const compare: [string, string | null, string | null][] = [
    ['projectName', prev.projectName, raw.projectName],
    ['fileName', prev.fileName, raw.fileName],
    ['sourceLang', prev.sourceLang, raw.sourceLang],
    ['targetLang', prev.targetLang, raw.targetLang],
    ['dueDate', prev.dueDate, raw.dueDate],
    ['step', prev.step, raw.step],
    ['role', prev.role, raw.role],
    ['words', wordsStr(prev.words), wordsStr(raw.words)],
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
