import type { DB } from './db.js';
import type { XtmJobState, XtmLifecycleStatus, XtmAcceptStatus } from '../detection/types.js';
import { deadlineDayOf } from '../schedule/deadlineDay.js';

interface XtmJobRow {
  job_key: string;
  xtm_task_id: string | null;
  project_name: string;
  file_name: string;
  source_lang: string | null;
  target_lang: string | null;
  due_date: string | null;
  due_raw: string | null;
  words: number | null;
  file_wwc: number | null;
  step: string | null;
  role: string | null;
  eligible: number;
  lifecycle_status: XtmLifecycleStatus | null;
  accept_status: XtmAcceptStatus;
  accepted_at: string | null;
  status: 'visible' | 'missing';
  first_seen_at: string;
  last_seen_at: string;
  snapshot_hash: string;
  consecutive_misses: number;
}

/**
 * Persists XTM job state computed by detection/xtmDiff (the XTM columns + the
 * appearance bookkeeping). Shares the `jobs` table with the partner JobStore but
 * only ever reads/writes XTM rows (identified by a non-empty file_name) so legacy
 * partner rows are left untouched. `title` (a partner NOT-NULL leftover, removed
 * with the partner code in T052) is filled with the file name to satisfy the
 * constraint. This layer does NOT decide transitions — it writes what it is given.
 */
export class XtmJobStore {
  constructor(private readonly db: DB) {}

  loadAll(): Map<string, XtmJobState> {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE file_name <> ''").all() as XtmJobRow[];
    const map = new Map<string, XtmJobState>();
    for (const r of rows) map.set(r.job_key, rowToState(r));
    return map;
  }

  listByLifecycle(status: XtmLifecycleStatus): XtmJobState[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs WHERE lifecycle_status = ? AND file_name <> ''")
      .all(status) as XtmJobRow[];
    return rows.map(rowToState);
  }

  /** Σ words of held (lifecycle 'accepted') jobs grouped by Bangkok deadline date.
   *  Null/unparseable deadlines are skipped (never a NaN key). Single source of truth
   *  for the per-deadline-day capacity cap. Read-only to callers (the cycle copies it into
   *  its own mutable bucket map before advancing).
   *
   *  INVARIANT (F1): a held job's committed dueDate/words are locked by `detection/xtmDiff`
   *  against a transient blank grid re-read, so a held job ALWAYS keeps a valid deadline once
   *  accepted. The skip below therefore only ever applies to the gate-OFF path
   *  (`ACCEPT_SCHEDULE_ENABLED=0`), where a null-deadline job can be held without going through
   *  the gate — never to a gate-ON held job. A skip on a gate-ON held job is an anomaly that
   *  would silently under-count the bucket → risk over-accept; it is NOT covered by the §9 audit
   *  trail (`summary.acceptedDueDays`, which only records days a NEW group advanced).
   *  `heldJobsMissingDeadline()` exposes exactly which held jobs were skipped so the cycle can
   *  FAIL LOUD (I1: a deduped warn alert) instead of silently dropping them. */
  wordsDueByDeadline(): ReadonlyMap<string, number> {
    const out = new Map<string, number>();
    for (const s of this.listByLifecycle('accepted')) {
      const d = deadlineDayOf(s.dueDate); // canonical parse + null handling (F8)
      if (d === null) continue;
      out.set(d, (out.get(d) ?? 0) + (s.words ?? 0));
    }
    return out;
  }

  /** Job keys of held (lifecycle 'accepted') jobs whose deadline is null/unparseable — exactly
   *  the jobs `wordsDueByDeadline()` skips (they contribute NOTHING to the per-deadline-day
   *  capacity seed). Normally empty (see the F1 invariant above); a non-empty result is the
   *  over-accept anomaly the cycle alerts on (I1). Reads the same held list as the bucket so the
   *  two can never disagree about which jobs are held. */
  heldJobsMissingDeadline(): string[] {
    const out: string[] = [];
    for (const s of this.listByLifecycle('accepted')) {
      if (deadlineDayOf(s.dueDate) === null) out.push(s.jobKey);
    }
    return out;
  }

  /** Upsert by job_key (no duplicate rows, Constitution VII). Runs in one txn. */
  upsertMany(states: Iterable<XtmJobState>): void {
    const stmt = this.db.prepare(`
      INSERT INTO jobs (job_key, title, xtm_task_id, project_name, file_name, source_lang,
        target_lang, due_date, due_raw, words, file_wwc, step, role, eligible, lifecycle_status,
        accept_status, accepted_at, status, first_seen_at, last_seen_at, snapshot_hash,
        consecutive_misses)
      VALUES (@jobKey, @title, @xtmTaskId, @projectName, @fileName, @sourceLang,
        @targetLang, @dueDate, @dueRaw, @words, @fileWwc, @step, @role, @eligible, @lifecycleStatus,
        @acceptStatus, @acceptedAt, @status, @firstSeenAt, @lastSeenAt, @snapshotHash,
        @consecutiveMisses)
      ON CONFLICT(job_key) DO UPDATE SET
        xtm_task_id=excluded.xtm_task_id, project_name=excluded.project_name,
        file_name=excluded.file_name, source_lang=excluded.source_lang,
        target_lang=excluded.target_lang, due_date=excluded.due_date, due_raw=excluded.due_raw,
        words=excluded.words, file_wwc=excluded.file_wwc, step=excluded.step, role=excluded.role,
        eligible=excluded.eligible, lifecycle_status=excluded.lifecycle_status,
        accept_status=excluded.accept_status, accepted_at=excluded.accepted_at,
        status=excluded.status, last_seen_at=excluded.last_seen_at,
        snapshot_hash=excluded.snapshot_hash, consecutive_misses=excluded.consecutive_misses
    `);
    const tx = this.db.transaction((items: XtmJobState[]) => {
      for (const s of items) {
        stmt.run({
          jobKey: s.jobKey,
          title: s.fileName, // NOT-NULL partner leftover
          xtmTaskId: s.xtmTaskId,
          projectName: s.projectName,
          fileName: s.fileName,
          sourceLang: s.sourceLang,
          targetLang: s.targetLang,
          dueDate: s.dueDate,
          dueRaw: s.dueRaw,
          words: s.words,
          fileWwc: s.fileWwc,
          step: s.step,
          role: s.role,
          eligible: s.eligible ? 1 : 0,
          lifecycleStatus: s.lifecycleStatus,
          acceptStatus: s.acceptStatus,
          acceptedAt: s.acceptedAt,
          status: s.status,
          firstSeenAt: s.firstSeenAt,
          lastSeenAt: s.lastSeenAt,
          snapshotHash: s.snapshotHash,
          consecutiveMisses: s.consecutiveMisses,
        });
      }
    });
    tx([...states]);
  }
}

function rowToState(r: XtmJobRow): XtmJobState {
  return {
    jobKey: r.job_key,
    xtmTaskId: r.xtm_task_id,
    projectName: r.project_name,
    fileName: r.file_name,
    sourceLang: r.source_lang,
    targetLang: r.target_lang,
    dueDate: r.due_date,
    dueRaw: r.due_raw,
    words: r.words,
    fileWwc: r.file_wwc,
    step: r.step,
    role: r.role,
    eligible: r.eligible === 1,
    lifecycleStatus: r.lifecycle_status ?? 'new',
    acceptStatus: r.accept_status,
    acceptedAt: r.accepted_at,
    status: r.status,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    snapshotHash: r.snapshot_hash,
    consecutiveMisses: r.consecutive_misses,
  };
}
