import type { DB } from './db.js';
import type { JobState, XtmAcceptStatus, XtmLifecycleStatus } from '../detection/types.js';

/** Canonical accept-status union lives in detection/types.ts — re-exported here. */
export type AcceptStatus = XtmAcceptStatus;
/** Confirmed accept outcome (after the FR-024 re-read), mirrors AcceptResult. */
export type AcceptOutcome = 'accepted' | 'missing' | 'failed';

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

  // ── Accept state machine (FR-008, Constitution VII) ───────────────────────
  // accept_status is separate from the diff's visible/missing status so a
  // concurrent claim or a restart cannot cause a double accept.

  /**
   * Atomically claim a job for accepting. Succeeds ONLY when accept_status is
   * 'none', flipping it to 'accepting' in a single statement — so two cycles
   * racing, or a restart mid-flight, cannot both proceed to click Accept.
   * Returns true iff this caller won the claim and should perform the accept.
   */
  claimForAccept(jobKey: string): boolean {
    const r = this.db
      .prepare("UPDATE jobs SET accept_status='accepting' WHERE job_key=? AND accept_status='none'")
      .run(jobKey);
    return r.changes === 1;
  }

  /**
   * Record the confirmed outcome of an accept attempt (determined by the FR-024
   * re-read of Active), updating accept_status, accepted_at, and lifecycle_status
   * together. `missing` (snatched) resets accept_status to 'none' since the job
   * was never actually accepted.
   */
  recordAcceptOutcome(jobKey: string, outcome: AcceptOutcome, at: string | null): void {
    const map: Record<AcceptOutcome, { accept: AcceptStatus; lifecycle: XtmLifecycleStatus }> = {
      accepted: { accept: 'accepted', lifecycle: 'accepted' },
      missing: { accept: 'none', lifecycle: 'missing' },
      failed: { accept: 'failed', lifecycle: 'accept_failed' },
    };
    const m = map[outcome];
    this.db
      .prepare('UPDATE jobs SET accept_status=?, accepted_at=?, lifecycle_status=? WHERE job_key=?')
      .run(m.accept, outcome === 'accepted' ? at : null, m.lifecycle, jobKey);
  }

  getAcceptStatus(jobKey: string): AcceptStatus | undefined {
    const r = this.db.prepare('SELECT accept_status FROM jobs WHERE job_key=?').get(jobKey) as
      | { accept_status: AcceptStatus }
      | undefined;
    return r?.accept_status;
  }

  /**
   * Recovery: a job left 'accepting' by a crash, whose FR-024 re-read shows it is
   * still acceptable (not owned), is reset to 'none' so it can be retried. Only
   * touches rows still in 'accepting' — never disturbs an 'accepted' job.
   */
  resetAcceptClaim(jobKey: string): void {
    this.db
      .prepare("UPDATE jobs SET accept_status='none' WHERE job_key=? AND accept_status='accepting'")
      .run(jobKey);
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
