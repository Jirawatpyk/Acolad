import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { JobStore } from '../../src/state/jobStore.js';

const NOW = '2026-06-19T10:00:00.000Z';
const dirs: string[] = [];
let db: DB;

function freshStore(): JobStore {
  const d = mkdtempSync(join(tmpdir(), 'acolad-jobstore-'));
  dirs.push(d);
  db = openDatabase(d, NOW).db;
  return new JobStore(db);
}

/** Seed a gate-Rejected job row carrying a non-null reject_reason. */
function seedRejected(jobKey: string, reason: string): void {
  db.prepare(
    `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                       lifecycle_status, accept_status, reject_reason)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(jobKey, 't', 'visible', NOW, NOW, 'h', 'rejected', 'none', reason);
}

function rejectReasonOf(jobKey: string): string | null {
  return (
    db.prepare('SELECT reject_reason AS r FROM jobs WHERE job_key=?').get(jobKey) as {
      r: string | null;
    }
  ).r;
}

afterEach(() => {
  db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('JobStore.recordAcceptOutcome — reject_reason clearing (#11, defense-in-depth)', () => {
  it('clears reject_reason at the source when the outcome is accepted', () => {
    const store = freshStore();
    seedRejected('j1', 'group blocked: holiday_calendar_stale');
    store.claimForAccept('j1');
    store.recordAcceptOutcome('j1', 'accepted', '2026-06-19T10:00:05+07:00');
    // The accepted UPDATE must null reject_reason so the "accepted ⇒ reject_reason IS NULL"
    // invariant does not rely solely on the orchestration clearing it before the accept.
    expect(rejectReasonOf('j1')).toBeNull();
    expect(store.getAcceptStatus('j1')).toBe('accepted');
    const lc = (
      db.prepare("SELECT lifecycle_status AS s FROM jobs WHERE job_key='j1'").get() as { s: string }
    ).s;
    expect(lc).toBe('accepted');
  });

  it('keeps reject_reason on a failed outcome (a failed accept must not lose its prior reason)', () => {
    const store = freshStore();
    seedRejected('j2', 'group blocked: infeasible');
    store.claimForAccept('j2');
    store.recordAcceptOutcome('j2', 'failed', null);
    expect(rejectReasonOf('j2')).toBe('group blocked: infeasible');
    expect(store.getAcceptStatus('j2')).toBe('failed');
  });

  it('keeps reject_reason on a missing (snatched) outcome', () => {
    const store = freshStore();
    seedRejected('j3', 'group blocked: infeasible');
    store.claimForAccept('j3');
    store.recordAcceptOutcome('j3', 'missing', null);
    expect(rejectReasonOf('j3')).toBe('group blocked: infeasible');
    expect(store.getAcceptStatus('j3')).toBe('none');
  });
});
