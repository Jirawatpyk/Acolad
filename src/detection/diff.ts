import { computeJobKey, computeSnapshotHash } from './jobKey.js';
import type {
  AppearanceEventOf,
  BaseJobState,
  DetailsChange,
  DiffAdapter,
  DiffResult,
  DiffResultOf,
  JobSnapshot,
  JobState,
  RawJob,
} from './types.js';

/** A job must be absent for this many consecutive polls before it counts as missing (FR-007). */
export const MISSING_THRESHOLD = 2;

/**
 * Sole owner of job state transitions (data-model.md). Pure and generic over the
 * portal-specific job shape: the appearance algorithm lives here once, while each
 * portal supplies a {@link DiffAdapter} for keys/hashes/state-building. No I/O.
 *
 * Transitions:
 *   unseen        --present-->  visible  : first_seen (or cold_start during baseline)
 *   visible       --absent x2-->  missing : missing  (1 absent poll = flicker, ignored)
 *   missing       --present-->  visible  : relisted
 */
export function diffGeneric<Raw, State extends BaseJobState>(
  jobs: Raw[],
  pollCycleId: string,
  capturedAt: string,
  prev: Map<string, State>,
  adapter: DiffAdapter<Raw, State>,
  opts: { baseline: boolean } = { baseline: false },
): DiffResultOf<State> {
  const events: AppearanceEventOf<State>[] = [];
  const detailsChanges: DetailsChange[] = [];
  const nextStates = new Map<string, State>();
  const at = capturedAt;
  const seenKeys = new Set<string>();

  for (const raw of jobs) {
    const key = adapter.key(raw);
    seenKeys.add(key);
    const existing = prev.get(key);
    const hash = adapter.hash(raw);

    if (!existing) {
      const state = adapter.build(key, raw, at, hash);
      nextStates.set(key, state);
      events.push({
        jobKey: key,
        eventType: opts.baseline ? 'cold_start' : 'first_seen',
        occurredAt: at,
        pollCycleId,
        job: state,
      });
      continue;
    }

    if (existing.status === 'missing') {
      // Relisted: count this appearance as a new event.
      const state: State = {
        ...adapter.apply(existing, raw, hash),
        status: 'visible',
        lastSeenAt: at,
        consecutiveMisses: 0,
      };
      nextStates.set(key, state);
      events.push({
        jobKey: key,
        eventType: 'relisted',
        occurredAt: at,
        pollCycleId,
        job: state,
        firstSeenAt: existing.firstSeenAt,
      });
      continue;
    }

    // Still visible: refresh, detect detail changes (silent — FR-019).
    const state: State = {
      ...adapter.apply(existing, raw, hash),
      status: 'visible',
      lastSeenAt: at,
      consecutiveMisses: 0,
    };
    nextStates.set(key, state);
    if (existing.snapshotHash !== hash) {
      detailsChanges.push({ jobKey: key, changes: adapter.changes(existing, raw) });
    }
  }

  // Jobs in prev but not in the snapshot: increment miss counter, flip when threshold reached.
  for (const [key, existing] of prev) {
    if (seenKeys.has(key)) continue;
    if (existing.status === 'missing') {
      nextStates.set(key, existing);
      continue;
    }
    const misses = existing.consecutiveMisses + 1;
    if (misses >= MISSING_THRESHOLD) {
      const state: State = { ...existing, status: 'missing', consecutiveMisses: misses };
      nextStates.set(key, state);
      events.push({
        jobKey: key,
        eventType: 'missing',
        occurredAt: at,
        pollCycleId,
        job: state,
      });
    } else {
      // Flicker: still visible, just bump the miss counter (persisted, restart-safe).
      nextStates.set(key, { ...existing, consecutiveMisses: misses });
    }
  }

  return { events, nextStates, detailsChanges };
}

/** Partner-portal adapter — preserves the original 001 diff behavior exactly. */
export const partnerAdapter: DiffAdapter<RawJob, JobState> = {
  key: (raw) => computeJobKey(raw),
  hash: (raw) => computeSnapshotHash(raw),
  build: (key, raw, at, hash) => newVisibleState(key, raw, at, hash),
  apply: (existing, raw, hash) => applyRawToState(existing, raw, hash),
  changes: (prev, raw) => fieldChanges(prev, raw),
};

/** Partner-portal diff (001 API, unchanged) — delegates to the generic engine. */
export function diff(
  snapshot: JobSnapshot,
  prev: Map<string, JobState>,
  opts: { baseline: boolean } = { baseline: false },
): DiffResult {
  return diffGeneric(
    snapshot.jobs,
    snapshot.pollCycleId,
    snapshot.capturedAt,
    prev,
    partnerAdapter,
    opts,
  );
}

function newVisibleState(key: string, raw: RawJob, at: string, hash: string): JobState {
  return {
    jobKey: key,
    portalJobId: raw.portalJobId,
    title: raw.title,
    languagePair: raw.languagePair,
    deadline: raw.deadline,
    deadlineRaw: raw.deadlineRaw,
    fee: raw.fee,
    url: raw.url,
    status: 'visible',
    firstSeenAt: at,
    lastSeenAt: at,
    snapshotHash: hash,
    consecutiveMisses: 0,
  };
}

function applyRawToState(existing: JobState, raw: RawJob, hash: string): JobState {
  return {
    ...existing,
    portalJobId: raw.portalJobId,
    title: raw.title,
    languagePair: raw.languagePair,
    deadline: raw.deadline,
    deadlineRaw: raw.deadlineRaw,
    fee: raw.fee,
    url: raw.url,
    snapshotHash: hash,
  };
}

function fieldChanges(prev: JobState, raw: RawJob): DetailsChange['changes'] {
  const fields: { field: string; from: string | null; to: string | null }[] = [];
  const compare: [string, string | null, string | null][] = [
    ['title', prev.title, raw.title],
    ['languagePair', prev.languagePair, raw.languagePair],
    ['deadline', prev.deadline, raw.deadline],
    ['fee', prev.fee, raw.fee],
    ['url', prev.url, raw.url],
  ];
  for (const [field, from, to] of compare) {
    if (from !== to) fields.push({ field, from, to });
  }
  return fields;
}
