import type { DB } from './db.js';
import type { JobState } from '../detection/types.js';

interface JobRow {
  job_key: string;
  portal_job_id: string | null;
  title: string;
  language_pair: string | null;
  deadline: string | null;
  deadline_raw: string | null;
  fee: string | null;
  url: string | null;
  status: 'visible' | 'missing';
  first_seen_at: string;
  last_seen_at: string;
  snapshot_hash: string;
  consecutive_misses: number;
}

/**
 * Persists job state computed by detection/diff. This layer does NOT decide
 * transitions — it only writes the next states diff produced (data-model.md).
 */
export class JobStore {
  constructor(private readonly db: DB) {}

  loadAll(): Map<string, JobState> {
    const rows = this.db.prepare('SELECT * FROM jobs').all() as JobRow[];
    const map = new Map<string, JobState>();
    for (const r of rows) map.set(r.job_key, rowToState(r));
    return map;
  }

  /** Replace the persisted state of the given jobs (called inside a txn). */
  upsertMany(states: Iterable<JobState>): void {
    const stmt = this.db.prepare(`
      INSERT INTO jobs (job_key, portal_job_id, title, language_pair, deadline, deadline_raw,
        fee, url, status, first_seen_at, last_seen_at, snapshot_hash, consecutive_misses)
      VALUES (@jobKey, @portalJobId, @title, @languagePair, @deadline, @deadlineRaw,
        @fee, @url, @status, @firstSeenAt, @lastSeenAt, @snapshotHash, @consecutiveMisses)
      ON CONFLICT(job_key) DO UPDATE SET
        portal_job_id=excluded.portal_job_id, title=excluded.title,
        language_pair=excluded.language_pair, deadline=excluded.deadline,
        deadline_raw=excluded.deadline_raw, fee=excluded.fee, url=excluded.url,
        status=excluded.status, last_seen_at=excluded.last_seen_at,
        snapshot_hash=excluded.snapshot_hash, consecutive_misses=excluded.consecutive_misses
    `);
    for (const s of states) stmt.run(s);
  }
}

function rowToState(r: JobRow): JobState {
  return {
    jobKey: r.job_key,
    portalJobId: r.portal_job_id,
    title: r.title,
    languagePair: r.language_pair,
    deadline: r.deadline,
    deadlineRaw: r.deadline_raw,
    fee: r.fee,
    url: r.url,
    status: r.status,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    snapshotHash: r.snapshot_hash,
    consecutiveMisses: r.consecutive_misses,
  };
}
