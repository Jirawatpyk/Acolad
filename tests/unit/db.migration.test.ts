import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, MigrationError } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';
import { computeXtmJobKey } from '../../src/detection/jobKey.js';

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
  'file_wwc',
  'step',
  'role',
  'eligible',
  'lifecycle_status',
  'accept_status',
  'accepted_at',
  'reject_reason',
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

  it('adds file_wwc to an existing jobs table that predates it, idempotently', () => {
    const dir = tmp();
    // A db whose jobs table has the v2 columns EXCEPT file_wwc (an earlier deploy). The ADD COLUMN
    // migration must add it without error, and a second open must not re-add/throw.
    const old = new Database(join(dir, 'acolad.db'));
    old.exec(`
      CREATE TABLE jobs (
        job_key TEXT PRIMARY KEY, portal_job_id TEXT, title TEXT NOT NULL,
        language_pair TEXT, deadline TEXT, deadline_raw TEXT, fee TEXT, url TEXT,
        status TEXT NOT NULL CHECK (status IN ('visible','missing')),
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        snapshot_hash TEXT NOT NULL, consecutive_misses INTEGER NOT NULL DEFAULT 0,
        xtm_task_id TEXT, project_name TEXT NOT NULL DEFAULT '', file_name TEXT NOT NULL DEFAULT '',
        source_lang TEXT, target_lang TEXT, due_date TEXT, due_raw TEXT, words INTEGER,
        step TEXT, role TEXT, eligible INTEGER NOT NULL DEFAULT 0,
        lifecycle_status TEXT CHECK (lifecycle_status IN ('new','accepted','skipped','missing','accept_failed','closed','removed','rejected')),
        accept_status TEXT NOT NULL DEFAULT 'none' CHECK (accept_status IN ('none','accepting','accepted','failed')),
        accepted_at TEXT, sheet_synced_status TEXT
      );
      CREATE TABLE outbox (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('chat','sheets','team')), payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL, sent_at TEXT
      );
      CREATE UNIQUE INDEX idx_outbox_dedup ON outbox (event_id, channel);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    old
      .prepare(
        "INSERT INTO jobs (job_key, title, file_name, status, first_seen_at, last_seen_at, snapshot_hash, words) VALUES ('j','t','j.docx','visible',?,?,'h',500)",
      )
      .run(NOW, NOW);
    old.close();

    const a = openDatabase(dir, NOW);
    expect(cols(a.db, 'jobs')).toContain('file_wwc');
    // Existing row preserved; new column is NULL for it.
    const r = a.db.prepare("SELECT words, file_wwc FROM jobs WHERE job_key='j'").get() as {
      words: number;
      file_wwc: number | null;
    };
    expect(r.words).toBe(500);
    expect(r.file_wwc).toBeNull();
    a.db.close();

    // Idempotent: a second open does not error or duplicate the column.
    const b = openDatabase(dir, NOW);
    expect(cols(b.db, 'jobs').filter((c) => c === 'file_wwc')).toHaveLength(1);
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

  it('migrates an OLD db missing BOTH file_wwc AND the rejected lifecycle value (guards column-add-before-rebuild order)', () => {
    const dir = tmp();
    // The riskiest combined migration path: a jobs table that BOTH predates the
    // file_wwc column AND whose lifecycle_status CHECK lacks 'rejected'. The
    // lifecycle-CHECK widener rebuilds the table with
    // `SELECT ... file_wwc ... FROM jobs_old`, which throws if ensureJobColumns has
    // NOT already added file_wwc. This test pins the call-order invariant
    // (ensureJobColumns BEFORE widenLifecycleCheck) against a future reorder.
    const old = new Database(join(dir, 'acolad.db'));
    old.exec(`
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
      CREATE TABLE outbox (
        outbox_id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('chat','sheets','team')), payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL, sent_at TEXT
      );
      CREATE UNIQUE INDEX idx_outbox_dedup ON outbox (event_id, channel);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // A real pre-existing row that must survive the table rebuild intact.
    old
      .prepare(
        `INSERT INTO jobs (job_key, title, file_name, status, first_seen_at, last_seen_at, snapshot_hash, words, lifecycle_status)
         VALUES ('combo-j', 'real job', 'captions.json', 'visible', ?, ?, 'h', 1234, 'accepted')`,
      )
      .run(NOW, NOW);
    old.close();

    // (a) Migration must not throw despite BOTH gaps.
    let opened: ReturnType<typeof openDatabase> | undefined;
    expect(() => {
      opened = openDatabase(dir, NOW);
    }).not.toThrow();
    const db = opened!.db;

    // (b) file_wwc AND reject_reason were added (by ensureJobColumns, before the rebuild's SELECT).
    // The old DDL above seeds NEITHER column, so both must be carried through the widen rebuild
    // (their names come from the same source-of-truth arrays the rebuild's column list is built from).
    expect(cols(db, 'jobs')).toContain('file_wwc');
    expect(cols(db, 'jobs')).toContain('reject_reason');

    // (c) lifecycle CHECK widened: 'rejected' now writes without a CHECK violation.
    expect(() =>
      db.prepare("UPDATE jobs SET lifecycle_status='rejected' WHERE job_key='combo-j'").run(),
    ).not.toThrow();

    // (d) the pre-existing row survived the rebuild with its data intact (newly-added
    // columns it never had — file_wwc, reject_reason — default to NULL for it).
    const r = db
      .prepare(
        "SELECT title, file_name, words, file_wwc, reject_reason, lifecycle_status FROM jobs WHERE job_key='combo-j'",
      )
      .get() as {
      title: string;
      file_name: string;
      words: number;
      file_wwc: number | null;
      reject_reason: string | null;
      lifecycle_status: string;
    };
    expect(r.title).toBe('real job');
    expect(r.file_name).toBe('captions.json');
    expect(r.words).toBe(1234);
    expect(r.file_wwc).toBeNull();
    expect(r.reject_reason).toBeNull();
    expect(r.lifecycle_status).toBe('rejected');
    db.close();
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

describe('backfill job_key to the project-qualified key (re-key-all real-identity rows)', () => {
  // The backfill is one-shot: the FIRST openDatabase on a fresh dir runs it over an empty table
  // and sets the `job_key_backfill_v2` meta flag. To exercise it over actual old-key rows (a real
  // pre-deploy db has old-key rows but not yet the v2 flag), seed the rows, then clear the flag so
  // the next open's backfill runs — `clearBackfillFlag` reproduces that pre-deploy state.
  //
  // Raw (un-normalized) XTM fields: leading/trailing spaces + mixed case exercise BOTH halves of
  // normField (trim AND lower). The JS computeXtmJobKey path must reproduce NEW_KEY exactly.
  const RAW = {
    projectName: '  ProjAlpha  ',
    fileName: ' File.DOCX ',
    step: ' Translate ',
    role: ' Translator ',
  };
  // The legacy 3-field key the row carried BEFORE projectName joined the key.
  const OLD_KEY = 'file.docx|translate|translator';
  // Source-of-truth target: the backfill must reproduce this byte-for-byte via computeXtmJobKey.
  const NEW_KEY = computeXtmJobKey(RAW);

  /** Seed one jobs row with the RAW fields, a chosen old key, and a lifecycle/accept state. */
  function seedJob(
    db: Database.Database,
    jobKey: string,
    titleHandle: string,
    lifecycle: string | null,
    acceptStatus = 'none',
  ): void {
    db.prepare(
      `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                         project_name, file_name, step, role, lifecycle_status, accept_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      jobKey,
      titleHandle,
      'visible',
      NOW,
      NOW,
      'h',
      RAW.projectName,
      RAW.fileName,
      RAW.step,
      RAW.role,
      lifecycle,
      acceptStatus,
    );
  }

  /** Clear the one-shot flag so the NEXT openDatabase actually runs the backfill over seeded rows. */
  function clearBackfillFlag(db: Database.Database): void {
    db.prepare("DELETE FROM meta WHERE key='job_key_backfill_v2'").run();
  }

  /** Read a row's current job_key via a stable non-key handle (job_key changes under us). */
  function keyByTitle(db: Database.Database, titleHandle: string): string {
    return (
      db.prepare('SELECT job_key AS k FROM jobs WHERE title=?').get(titleHandle) as { k: string }
    ).k;
  }

  it('re-keys an accepted row to the project-qualified key (trim + lower)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    seedJob(a.db, OLD_KEY, 'accepted', 'accepted');
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW); // re-open runs migrate() -> backfill
    expect(keyByTitle(b.db, 'accepted')).toBe(NEW_KEY);
    b.db.close();
  });

  it('re-keys a TERMINAL (closed) row too — re-key-all drops the old lifecycle predicate (#4/B#8)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    // The old predicate left closed/removed rows on their legacy key; re-key-all treats every
    // real-identity row uniformly so a relisting closed row still matches its freshly-computed key.
    seedJob(a.db, OLD_KEY, 'terminal', 'closed');
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW);
    expect(keyByTitle(b.db, 'terminal')).toBe(NEW_KEY);
    b.db.close();
  });

  it('re-keys a MISSING row — the primary relisting state must match its new key (B#1)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    // B#1: the old lifecycle predicate EXCLUDED 'missing', so a job that was missing at deploy kept
    // its old key and fired a spurious 'first_seen' (🆕) when it relisted, losing its history.
    seedJob(a.db, OLD_KEY, 'missing', 'missing');
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW);
    expect(keyByTitle(b.db, 'missing')).toBe(NEW_KEY);
    b.db.close();
  });

  it('re-keys a NULL-lifecycle row with a real identity (re-key-all, no lifecycle predicate)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    // A row with a real project+file identity but NULL lifecycle/none accept is still re-keyed:
    // identity, not lifecycle, decides. (Genuine legacy partner rows are excluded by EMPTY identity,
    // not by this predicate — see the degenerate-skip test below.)
    seedJob(a.db, OLD_KEY, 'null-lifecycle', null, 'none');
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW);
    expect(keyByTitle(b.db, 'null-lifecycle')).toBe(NEW_KEY);
    b.db.close();
  });

  it('SKIPS a degenerate empty-project/file row (no |||-style key, no PK collision)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    // A degenerate row (empty project + file — a real XTM job never has these blank). Re-keying it
    // would produce a meaningless `|||` key and risk a PK collision, so it is left untouched.
    a.db
      .prepare(
        `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                           project_name, file_name, step, role, lifecycle_status, accept_status)
         VALUES ('degenerate-key','degenerate','visible',?,?,'h','','',NULL,NULL,'accepted','none')`,
      )
      .run(NOW, NOW);
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW);
    expect(keyByTitle(b.db, 'degenerate')).toBe('degenerate-key'); // unchanged
    // No row was re-keyed to a meaningless empty-segment key.
    const bogus = b.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE job_key LIKE '|%' OR job_key='|||'")
      .get() as { n: number };
    expect(bogus.n).toBe(0);
    b.db.close();
  });

  it('computes the new key via computeXtmJobKey, NOT a SQL lower() — a non-ASCII uppercase project re-keys to the JS-folded value (#5 ASCII gap)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    // SQLite lower() folds only ASCII A–Z; JS .toLowerCase() folds full Unicode. A project name with
    // a non-ASCII uppercase letter (É, U+00C9) proves the JS path is used: computeXtmJobKey folds it
    // to é, while the removed SQL lower() would have left É uppercase (a silent drift).
    const RAW_U = { projectName: 'CAFÉ', fileName: 'f.docx', step: 's', role: 'r' };
    const U_OLD_KEY = 'f.docx|s|r'; // legacy 3-field
    a.db
      .prepare(
        `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                           project_name, file_name, step, role, lifecycle_status, accept_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        U_OLD_KEY,
        'unicode',
        'visible',
        NOW,
        NOW,
        'h',
        RAW_U.projectName,
        RAW_U.fileName,
        RAW_U.step,
        RAW_U.role,
        'accepted',
        'none',
      );
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW);
    expect(keyByTitle(b.db, 'unicode')).toBe(computeXtmJobKey(RAW_U)); // JS path → 'café|f.docx|s|r'
    expect(keyByTitle(b.db, 'unicode')).not.toBe('cafÉ|f.docx|s|r'); // the SQL-lower would-be value
    b.db.close();
  });

  it('re-keys a row whose step is NULL to proj|file||role (normField NULL parity)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    // computeXtmJobKey's normField treats NULL as '' → the key is proj|file||role. A null-step row
    // with a real project+file is still re-keyed correctly (the coalesce-to-'' parity that the prior
    // SQL backfill needed is intrinsic to computeXtmJobKey, so the JS path gets it for free).
    const NULL_STEP_OLD_KEY = 'file.docx||translator'; // legacy 3-field, empty step segment
    a.db
      .prepare(
        `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                           project_name, file_name, step, role, lifecycle_status, accept_status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        NULL_STEP_OLD_KEY,
        'nullstep',
        'visible',
        NOW,
        NOW,
        'h',
        RAW.projectName,
        RAW.fileName,
        null, // step IS NULL
        RAW.role,
        'accepted',
        'none',
      );
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW);
    const expected = computeXtmJobKey({
      projectName: RAW.projectName,
      fileName: RAW.fileName,
      step: null,
      role: RAW.role,
    });
    expect(keyByTitle(b.db, 'nullstep')).toBe(expected);
    b.db.close();
  });

  it('leaves a row already at its new key untouched (the newKey !== oldKey skip)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    seedJob(a.db, NEW_KEY, 'already-new', 'accepted'); // already project-qualified
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW);
    expect(keyByTitle(b.db, 'already-new')).toBe(NEW_KEY); // no spurious update
    b.db.close();
  });

  it('is one-shot via the meta flag: an old-key row inserted AFTER the flag is set is NOT re-keyed (#6)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW); // fresh open sets job_key_backfill_v2 (empty table)
    // Inserted AFTER the flag, WITHOUT clearing it — the one-shot guard must short-circuit, so the
    // backfill is NOT a full table scan on every open (unlike the old per-row `<>` predicate, which
    // would have re-keyed this row on the next open).
    seedJob(a.db, OLD_KEY, 'late', 'accepted');
    a.db.close();

    const b = openDatabase(dir, NOW);
    expect(keyByTitle(b.db, 'late')).toBe(OLD_KEY); // untouched — flag short-circuited the backfill
    b.db.close();
  });

  it('is idempotent — a second open after a real backfill is a no-op (flag set)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    seedJob(a.db, OLD_KEY, 'idem', 'accepted');
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW); // first real backfill: re-keys + sets flag
    const k1 = keyByTitle(b.db, 'idem');
    b.db.close();

    const c = openDatabase(dir, NOW); // second open: flag present → no-op
    const k2 = keyByTitle(c.db, 'idem');
    c.db.close();

    expect(k1).toBe(NEW_KEY);
    expect(k2).toBe(NEW_KEY);
  });

  it('SKIPS an asymmetric degenerate row (empty project OR empty file — the guard is an OR)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    // The skip guard is falsy-OR (`!project || !file`): a row with a real file but an EMPTY project
    // — or the reverse — is still degenerate and left untouched. Only the both-empty case was
    // covered before; these two halves lock the OR so a future tightening to AND is caught.
    const insert = a.db.prepare(
      `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                         project_name, file_name, step, role, lifecycle_status, accept_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    insert.run('empty-proj-key', 'empty-proj', 'visible', NOW, NOW, 'h', '', 'real.docx', 's', 'r', 'accepted', 'none'); // prettier-ignore
    insert.run('empty-file-key', 'empty-file', 'visible', NOW, NOW, 'h', 'RealProj', '', 's', 'r', 'accepted', 'none'); // prettier-ignore
    clearBackfillFlag(a.db);
    a.db.close();

    const b = openDatabase(dir, NOW);
    expect(keyByTitle(b.db, 'empty-proj')).toBe('empty-proj-key'); // unchanged (empty project)
    expect(keyByTitle(b.db, 'empty-file')).toBe('empty-file-key'); // unchanged (empty file)
    b.db.close();
  });

  it('propagates a backfill PK collision as MigrationError WITHOUT quarantining the db (a code bug must not destroy history)', () => {
    const dir = tmp();
    const a = openDatabase(dir, NOW);
    const P = { projectName: 'EMAIL', fileName: 'f', step: 's', role: 'r' };
    const target = computeXtmJobKey(P); // the 4-field key row X will re-key TO
    const insert = a.db.prepare(
      `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                         project_name, file_name, step, role, lifecycle_status, accept_status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    // Row X still on its legacy 3-field key; its re-key target is `target`.
    insert.run('f|s|r', 'x', 'visible', NOW, NOW, 'h', P.projectName, P.fileName, P.step, P.role, 'accepted', 'none'); // prettier-ignore
    // Row Y ALREADY occupies `target` (a prior partial migration / manual op) → X's UPDATE collides
    // on the job_key PRIMARY KEY.
    insert.run(target, 'y', 'visible', NOW, NOW, 'h', P.projectName, P.fileName, P.step, P.role, 'accepted', 'none'); // prettier-ignore
    clearBackfillFlag(a.db);
    a.db.close();

    // The backfill UPDATE hits a UNIQUE(job_key) violation — a migration LOGIC error, NOT file
    // corruption. openDatabase must propagate it (crash loud) and leave the valid db in place; the
    // old quarantine-on-any-throw path would have renamed acolad.db to .corrupt and silently
    // discarded all job history for what is a code bug.
    expect(() => openDatabase(dir, NOW)).toThrow(MigrationError);
    const corruptCopies = readdirSync(dir).filter((f) => f.startsWith('acolad.db.corrupt-'));
    expect(corruptCopies).toEqual([]);
  });
});
