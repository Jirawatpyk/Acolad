import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';

const NOW = '2026-06-19T10:00:00.000Z';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acolad-mig-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NEW_COLS = [
  'xtm_task_id',
  'project_name',
  'file_name',
  'source_lang',
  'target_lang',
  'due_date',
  'due_raw',
  'words',
  'step',
  'role',
  'eligible',
  'lifecycle_status',
  'accept_status',
  'accepted_at',
  'sheet_synced_status',
];

function cols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

describe('db migration v2 (fresh db)', () => {
  it('jobs gains all XTM + lifecycle columns', () => {
    const { db } = openDatabase(tmp(), NOW);
    const c = cols(db, 'jobs');
    for (const col of NEW_COLS) expect(c).toContain(col);
    db.close();
  });

  it('stamps schema_version = 2', () => {
    const { db } = openDatabase(tmp(), NOW);
    const v = (
      db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
    ).value;
    expect(v).toBe('2');
    db.close();
  });

  it('outbox accepts the new sheets channel and still rejects unknown channels', () => {
    const { db } = openDatabase(tmp(), NOW);
    const ins = db.prepare(
      'INSERT INTO outbox (event_id, channel, payload_json, next_attempt_at, created_at) VALUES (?,?,?,?,?)',
    );
    expect(() => ins.run('e1', 'sheets', '{}', NOW, NOW)).not.toThrow();
    expect(() => ins.run('e2', 'chat', '{}', NOW, NOW)).not.toThrow();
    expect(() => ins.run('e3', 'email', '{}', NOW, NOW)).toThrow();
    db.close();
  });

  it('accept_status defaults to none; lifecycle_status CHECK rejects invalid', () => {
    const { db } = openDatabase(tmp(), NOW);
    db.prepare(
      'INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash) VALUES (?,?,?,?,?,?)',
    ).run('j1', 't', 'visible', NOW, NOW, 'h');
    const row = db.prepare("SELECT accept_status FROM jobs WHERE job_key='j1'").get() as {
      accept_status: string;
    };
    expect(row.accept_status).toBe('none');
    expect(() =>
      db.prepare("UPDATE jobs SET lifecycle_status='bogus' WHERE job_key='j1'").run(),
    ).toThrow();
    db.close();
  });

  it('migration is idempotent (re-open does not error, stays v2)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    a.db.close();
    const b = openDatabase(dir, NOW);
    const v = (
      b.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
    ).value;
    expect(v).toBe('2');
    expect(cols(b.db, 'jobs')).toContain('lifecycle_status');
    b.db.close();
  });
});

describe('outbox team channel', () => {
  it('outbox accepts the team channel and migration is idempotent', () => {
    const { db } = openDatabase(tmp(), '2026-06-25T00:00:00Z');
    const ob = new Outbox(db, 10, 6);
    expect(ob.enqueue('t1', '{"text":"x"}', '2026-06-25T00:00:00Z', 'team')).toBe(true);
    expect(ob.due('2026-06-25T01:00:00Z').some((r) => r.channel === 'team')).toBe(true);
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name='outbox'").get() as { sql: string }
    ).sql;
    expect(sql).toContain("'team'");
    db.close();
  });
});

describe('jobs.lifecycle_status widened for rejected', () => {
  it('fresh db allows rejected lifecycle_status', () => {
    const { db } = openDatabase(tmp(), NOW);
    db.prepare(
      `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash, lifecycle_status)
       VALUES ('k1', 'Test Job', 'visible', ?, ?, 'h', 'rejected')`,
    ).run(NOW, NOW);
    const row = db.prepare(`SELECT lifecycle_status AS s FROM jobs WHERE job_key='k1'`).get() as {
      s: string;
    };
    expect(row.s).toBe('rejected');
    db.close();
  });

  it('existing db with old lifecycle_status CHECK accepts rejected after migrate()', () => {
    const dir = tmp();
    // Build old-schema db with lifecycle_status WITHOUT 'rejected'
    const old = new Database(join(dir, 'acolad.db'));
    old.exec(`
      CREATE TABLE jobs (
        job_key TEXT PRIMARY KEY,
        portal_job_id TEXT,
        title TEXT NOT NULL,
        language_pair TEXT,
        deadline TEXT,
        deadline_raw TEXT,
        fee TEXT,
        url TEXT,
        status TEXT NOT NULL CHECK (status IN ('visible','missing')),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL,
        consecutive_misses INTEGER NOT NULL DEFAULT 0,
        xtm_task_id TEXT,
        project_name TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL DEFAULT '',
        source_lang TEXT,
        target_lang TEXT,
        due_date TEXT,
        due_raw TEXT,
        words INTEGER,
        step TEXT,
        role TEXT,
        eligible INTEGER NOT NULL DEFAULT 0,
        lifecycle_status TEXT CHECK (lifecycle_status IN ('new','accepted','skipped','missing','accept_failed','closed','removed')),
        accept_status TEXT NOT NULL DEFAULT 'none' CHECK (accept_status IN ('none','accepting','accepted','failed')),
        accepted_at TEXT,
        sheet_synced_status TEXT
      );
      CREATE TABLE outbox (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('chat','sheets','team')),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL, sent_at TEXT
      );
      CREATE UNIQUE INDEX idx_outbox_dedup ON outbox (event_id, channel);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    old
      .prepare(
        `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash, lifecycle_status)
         VALUES ('existing-j', 't', 'visible', ?, ?, 'h', 'accepted')`,
      )
      .run(NOW, NOW);
    old.close();

    const { db } = openDatabase(dir, NOW);
    // 'rejected' must now be accepted
    expect(() =>
      db.prepare("UPDATE jobs SET lifecycle_status='rejected' WHERE job_key='existing-j'").run(),
    ).not.toThrow();
    const row = db
      .prepare("SELECT lifecycle_status AS s FROM jobs WHERE job_key='existing-j'")
      .get() as { s: string };
    expect(row.s).toBe('rejected');
    // Existing row data preserved
    const title = (
      db.prepare("SELECT title FROM jobs WHERE job_key='existing-j'").get() as { title: string }
    ).title;
    expect(title).toBe('t');
    db.close();
  });

  it('cleans up a stale jobs_old left by a crashed prior migration, then widens cleanly (F6)', () => {
    const dir = tmp();
    // Old-shape db: jobs lifecycle CHECK WITHOUT 'rejected', PLUS a leftover jobs_old
    // table (residue from a prior migration that crashed between RENAME and DROP). The
    // DROP TABLE IF EXISTS jobs_old guard must clear it before re-running the rebuild.
    const crashed = new Database(join(dir, 'acolad.db'));
    crashed.exec(`
      CREATE TABLE jobs (
        job_key TEXT PRIMARY KEY, portal_job_id TEXT, title TEXT NOT NULL,
        language_pair TEXT, deadline TEXT, deadline_raw TEXT, fee TEXT, url TEXT,
        status TEXT NOT NULL CHECK (status IN ('visible','missing')),
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL, consecutive_misses INTEGER NOT NULL DEFAULT 0,
        xtm_task_id TEXT, project_name TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '',
        source_lang TEXT, target_lang TEXT, due_date TEXT, due_raw TEXT, words INTEGER,
        step TEXT, role TEXT, eligible INTEGER NOT NULL DEFAULT 0,
        lifecycle_status TEXT CHECK (lifecycle_status IN ('new','accepted','skipped','missing','accept_failed','closed','removed')),
        accept_status TEXT NOT NULL DEFAULT 'none' CHECK (accept_status IN ('none','accepting','accepted','failed')),
        accepted_at TEXT, sheet_synced_status TEXT
      );
      -- Stale residue table from the crashed migration.
      CREATE TABLE jobs_old (job_key TEXT PRIMARY KEY, title TEXT);
      INSERT INTO jobs_old (job_key, title) VALUES ('stale', 'residue');
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    crashed
      .prepare(
        `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash, lifecycle_status)
         VALUES ('keep-j', 't', 'visible', ?, ?, 'h', 'accepted')`,
      )
      .run(NOW, NOW);
    crashed.close();

    const { db } = openDatabase(dir, NOW);

    // The stale jobs_old must be gone after the guarded rebuild.
    const leftover = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs_old'")
      .get();
    expect(leftover).toBeUndefined();

    // The rebuild preserved the real row and widened the CHECK so 'rejected' now writes.
    expect(
      (db.prepare("SELECT title FROM jobs WHERE job_key='keep-j'").get() as { title: string })
        .title,
    ).toBe('t');
    expect(() =>
      db.prepare("UPDATE jobs SET lifecycle_status='rejected' WHERE job_key='keep-j'").run(),
    ).not.toThrow();
    db.close();
  });

  it('widenLifecycleCheck is idempotent (second open does not re-rebuild or error)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    a.db
      .prepare(
        `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash, lifecycle_status)
         VALUES ('j1', 't', 'visible', ?, ?, 'h', 'rejected')`,
      )
      .run(NOW, NOW);
    a.db.close();

    const b = openDatabase(dir, NOW);
    const row = b.db.prepare("SELECT lifecycle_status AS s FROM jobs WHERE job_key='j1'").get() as {
      s: string;
    };
    expect(row.s).toBe('rejected');
    b.db.close();
  });
});

describe('db migration v1 -> v2 (existing production db)', () => {
  it('adds columns, widens outbox channel, preserves existing rows', () => {
    const dir = tmp();
    // Hand-build a v1-shaped db (the 001 production schema).
    const v1 = new Database(join(dir, 'acolad.db'));
    v1.exec(`
      CREATE TABLE jobs (
        job_key TEXT PRIMARY KEY, portal_job_id TEXT, title TEXT NOT NULL,
        language_pair TEXT, deadline TEXT, deadline_raw TEXT, fee TEXT, url TEXT,
        status TEXT NOT NULL CHECK (status IN ('visible','missing')),
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL, consecutive_misses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE outbox (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('chat')), payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL, sent_at TEXT
      );
      CREATE UNIQUE INDEX idx_outbox_dedup ON outbox (event_id, channel);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    v1.prepare(
      "INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash) VALUES ('legacy','old job','visible',?,?,'h')",
    ).run(NOW, NOW);
    v1.prepare(
      "INSERT INTO outbox (event_id, channel, payload_json, next_attempt_at, created_at) VALUES ('ev','chat','{}',?,?)",
    ).run(NOW, NOW);
    v1.prepare("INSERT INTO meta (key, value) VALUES ('schema_version','1')").run();
    v1.close();

    const { db } = openDatabase(dir, NOW);

    const c = cols(db, 'jobs');
    for (const col of NEW_COLS) expect(c).toContain(col);

    // Legacy job row preserved and given safe defaults.
    const j = db
      .prepare("SELECT title, accept_status, eligible FROM jobs WHERE job_key='legacy'")
      .get() as {
      title: string;
      accept_status: string;
      eligible: number;
    };
    expect(j.title).toBe('old job');
    expect(j.accept_status).toBe('none');
    expect(j.eligible).toBe(0);

    // Outbox row preserved and 'sheets' now permitted.
    const o = db.prepare("SELECT event_id FROM outbox WHERE event_id='ev'").get() as {
      event_id: string;
    };
    expect(o.event_id).toBe('ev');
    expect(() =>
      db
        .prepare(
          "INSERT INTO outbox (event_id, channel, payload_json, next_attempt_at, created_at) VALUES ('ev2','sheets','{}',?,?)",
        )
        .run(NOW, NOW),
    ).not.toThrow();

    const v = (
      db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }
    ).value;
    expect(v).toBe('2');
    db.close();
  });
});
