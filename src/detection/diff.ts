import { computeJobKey, computeSnapshotHash } from './jobKey.js';
import type {
  AppearanceEvent,
  DetailsChange,
  DiffResult,
  JobSnapshot,
  JobState,
  RawJob,
} from './types.js';

/** A job must be absent for this many consecutive polls before it counts as missing (FR-007). */
export const MISSING_THRESHOLD = 2;

/**
 * Sole owner of job state transitions (data-model.md). Pure function: given the
 * current snapshot and previous states (including consecutiveMisses), returns
 * the appearance events, detail changes, and next states. No I/O.
 *
 * Transitions:
 *   unseen        --present-->  visible  : first_seen (or cold_start during baseline)
 *   visible       --absent x2-->  missing : missing  (1 absent poll = flicker, ignored)
 *   missing       --present-->  visible  : relisted
 */
export function diff(
  snapshot: JobSnapshot,
  prev: Map<string, JobState>,
  opts: { baseline: boolean } = { baseline: false },
): DiffResult {
  const events: AppearanceEvent[] = [];
  const detailsChanges: DetailsChange[] = [];
  const nextStates = new Map<string, JobState>();
  const at = snapshot.capturedAt;

  const seenKeys = new Set<string>();

  for (const raw of snapshot.jobs) {
    const key = computeJobKey(raw);
    seenKeys.add(key);
    const existing = prev.get(key);
    const hash = computeSnapshotHash(raw);

    if (!existing) {
      const state = newVisibleState(key, raw, at, hash);
      nextStates.set(key, state);
      events.push({
        jobKey: key,
        eventType: opts.baseline ? 'cold_start' : 'first_seen',
        occurredAt: at,
        pollCycleId: snapshot.pollCycleId,
        job: state,
      });
      continue;
    }

    if (existing.status === 'missing') {
      // Relisted: count this appearance as a new event.
      const state: JobState = {
        ...applyRawToState(existing, raw, hash),
        status: 'visible',
        lastSeenAt: at,
        consecutiveMisses: 0,
      };
      nextStates.set(key, state);
      events.push({
        jobKey: key,
        eventType: 'relisted',
        occurredAt: at,
        pollCycleId: snapshot.pollCycleId,
        job: state,
        firstSeenAt: existing.firstSeenAt,
      });
      continue;
    }

    // Still visible: refresh, detect detail changes (silent — FR-019).
    const state: JobState = {
      ...applyRawToState(existing, raw, hash),
      status: 'visible',
      lastSeenAt: at,
      consecutiveMisses: 0,
    };
    nextStates.set(key, state);
    if (existing.snapshotHash !== hash) {
      detailsChanges.push({ jobKey: key, changes: fieldChanges(existing, raw) });
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
      const state: JobState = { ...existing, status: 'missing', consecutiveMisses: misses };
      nextStates.set(key, state);
      events.push({
        jobKey: key,
        eventType: 'missing',
        occurredAt: at,
        pollCycleId: snapshot.pollCycleId,
        job: state,
      });
    } else {
      // Flicker: still visible, just bump the miss counter (persisted, restart-safe).
      nextStates.set(key, { ...existing, consecutiveMisses: misses });
    }
  }

  return { events, nextStates, detailsChanges };
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
