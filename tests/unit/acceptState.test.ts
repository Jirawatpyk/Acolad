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
  const d = mkdtempSync(join(tmpdir(), 'acolad-accept-'));
  dirs.push(d);
  db = openDatabase(d, NOW).db;
  return new JobStore(db);
}

/** Insert a bare job row (accept_status defaults to 'none'). */
function seedJob(jobKey: string): void {
  db.prepare(
    'INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash) VALUES (?,?,?,?,?,?)',
  ).run(jobKey, 't', 'visible', NOW, NOW, 'h');
}

afterEach(() => {
  db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('accept_status state machine (FR-008, Constitution VII)', () => {
  it('claims a fresh job exactly once (none -> accepting)', () => {
    const store = freshStore();
    seedJob('j1');
    expect(store.claimForAccept('j1')).toBe(true);
    expect(store.getAcceptStatus('j1')).toBe('accepting');
  });

  it('refuses a second concurrent claim (at-most-once)', () => {
    const store = freshStore();
    seedJob('j1');
    expect(store.claimForAccept('j1')).toBe(true);
    expect(store.claimForAccept('j1')).toBe(false); // already 'accepting'
  });

  it('never re-claims an already-accepted job (no double-accept across restart)', () => {
    const store = freshStore();
    seedJob('j1');
    store.claimForAccept('j1');
    store.recordAcceptOutcome('j1', 'accepted', '2026-06-19T10:00:05+07:00');
    // Simulate a restart: a brand-new store over the same db.
    const store2 = new JobStore(db);
    expect(store2.claimForAccept('j1')).toBe(false);
    expect(store2.getAcceptStatus('j1')).toBe('accepted');
  });

  it('records an accepted outcome (status + accepted_at + lifecycle)', () => {
    const store = freshStore();
    seedJob('j1');
    store.claimForAccept('j1');
    store.recordAcceptOutcome('j1', 'accepted', '2026-06-19T10:00:05+07:00');
    expect(store.getAcceptStatus('j1')).toBe('accepted');
    const row = db
      .prepare("SELECT accepted_at, lifecycle_status FROM jobs WHERE job_key='j1'")
      .get() as { accepted_at: string; lifecycle_status: string };
    expect(row.accepted_at).toBe('2026-06-19T10:00:05+07:00');
    expect(row.lifecycle_status).toBe('accepted');
  });

  it('records a missing outcome (snatched) as lifecycle missing, accept reset to none', () => {
    const store = freshStore();
    seedJob('j1');
    store.claimForAccept('j1');
    store.recordAcceptOutcome('j1', 'missing', null);
    expect(store.getAcceptStatus('j1')).toBe('none');
    const row = db
      .prepare("SELECT lifecycle_status, accepted_at FROM jobs WHERE job_key='j1'")
      .get() as { lifecycle_status: string; accepted_at: string | null };
    expect(row.lifecycle_status).toBe('missing');
    expect(row.accepted_at).toBeNull();
  });

  it('records a failed outcome as accept_failed + accept_status failed', () => {
    const store = freshStore();
    seedJob('j1');
    store.claimForAccept('j1');
    store.recordAcceptOutcome('j1', 'failed', null);
    expect(store.getAcceptStatus('j1')).toBe('failed');
    expect(
      (
        db.prepare("SELECT lifecycle_status FROM jobs WHERE job_key='j1'").get() as {
          lifecycle_status: string;
        }
      ).lifecycle_status,
    ).toBe('accept_failed');
  });

  it('resetAcceptClaim recovers a crash-stranded accepting job to none (only from accepting)', () => {
    const store = freshStore();
    seedJob('j1');
    store.claimForAccept('j1'); // 'accepting'
    store.resetAcceptClaim('j1');
    expect(store.getAcceptStatus('j1')).toBe('none');
    // does NOT disturb an accepted job
    seedJob('j2');
    store.claimForAccept('j2');
    store.recordAcceptOutcome('j2', 'accepted', NOW);
    store.resetAcceptClaim('j2');
    expect(store.getAcceptStatus('j2')).toBe('accepted');
  });

  it('does not claim a job that does not exist', () => {
    const store = freshStore();
    expect(store.claimForAccept('ghost')).toBe(false);
  });
});
