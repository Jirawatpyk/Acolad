import Database from 'better-sqlite3';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type DB = Database.Database;

const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS jobs (
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
  consecutive_misses INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS appearance_events (
  event_id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('first_seen','relisted','missing','cold_start')),
  occurred_at TEXT NOT NULL,
  poll_cycle_id TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_appearance_dedup
  ON appearance_events (job_key, event_type, poll_cycle_id);

CREATE TABLE IF NOT EXISTS system_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('system_alert','system_recovered','cold_start_summary')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','critical')),
  dedup_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_system_active_alert
  ON system_events (dedup_key)
  WHERE resolved_at IS NULL AND event_type = 'system_alert';

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('chat','sheets')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedup ON outbox (event_id, channel);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface OpenResult {
  db: DB;
  /** True when the previous db file was corrupt and quarantined (FR-017). */
  recoveredFromCorruption: boolean;
  corruptCopyPath?: string;
}

/**
 * Open (and migrate) the SQLite state db with WAL. On a corrupt/unopenable file
 * the original is quarantined as acolad.db.corrupt-<ts> (never overwritten) and
 * a fresh db is created — caller treats this as a cold start + alert (FR-017).
 */
export function openDatabase(stateDir: string, nowIso: string): OpenResult {
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, 'acolad.db');

  let attempt: DB | undefined;
  try {
    attempt = new Database(dbPath);
    attempt.pragma('journal_mode = WAL');
    migrate(attempt);
    return { db: attempt, recoveredFromCorruption: false };
  } catch (err) {
    // Release any handle opened above so the file can be renamed (Windows EBUSY).
    try {
      attempt?.close();
    } catch {
      // ignore — best-effort close before quarantine
    }
    if (!existsSync(dbPath)) throw err;
    const stamp = nowIso.replace(/[:.]/g, '-');
    const corruptCopyPath = join(stateDir, `acolad.db.corrupt-${stamp}`);
    renameSync(dbPath, corruptCopyPath);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    migrate(db);
    return { db, recoveredFromCorruption: true, corruptCopyPath };
  }
}

/**
 * Columns added to `jobs` in schema v2 (XTM fields + lifecycle/accept state,
 * data-model.md). Applied idempotently via ADD COLUMN so a fresh db (built from
 * the v1 DDL above) and an existing 001 production db converge on the same
 * shape — no drift between the two create paths. NOT NULL columns carry a
 * constant default so legacy rows migrate cleanly.
 */
const JOB_V2_COLUMNS: { name: string; ddl: string }[] = [
  { name: 'xtm_task_id', ddl: 'xtm_task_id TEXT' },
  { name: 'project_name', ddl: "project_name TEXT NOT NULL DEFAULT ''" },
  { name: 'file_name', ddl: "file_name TEXT NOT NULL DEFAULT ''" },
  { name: 'source_lang', ddl: 'source_lang TEXT' },
  { name: 'target_lang', ddl: 'target_lang TEXT' },
  { name: 'due_date', ddl: 'due_date TEXT' },
  { name: 'due_raw', ddl: 'due_raw TEXT' },
  { name: 'words', ddl: 'words INTEGER' },
  { name: 'step', ddl: 'step TEXT' },
  { name: 'role', ddl: 'role TEXT' },
  { name: 'eligible', ddl: 'eligible INTEGER NOT NULL DEFAULT 0' },
  {
    name: 'lifecycle_status',
    ddl: "lifecycle_status TEXT CHECK (lifecycle_status IN ('new','accepted','skipped','missing','accept_failed','closed','removed'))",
  },
  {
    name: 'accept_status',
    ddl: "accept_status TEXT NOT NULL DEFAULT 'none' CHECK (accept_status IN ('none','accepting','accepted','failed'))",
  },
  { name: 'accepted_at', ddl: 'accepted_at TEXT' },
  { name: 'sheet_synced_status', ddl: 'sheet_synced_status TEXT' },
];

function migrate(db: DB): void {
  db.exec(DDL);
  const tx = db.transaction(() => {
    ensureJobColumns(db);
    ensureOutboxChannel(db);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  });
  tx();
}

/** Add any missing v2 columns to `jobs` (idempotent — guarded by table_info). */
function ensureJobColumns(db: DB): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((r) => r.name),
  );
  for (const col of JOB_V2_COLUMNS) {
    if (!existing.has(col.name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${col.ddl}`);
  }
}

/**
 * Widen the outbox channel CHECK to include 'sheets'. SQLite cannot ALTER a
 * CHECK in place, so an existing v1 outbox (chat-only) is rebuilt preserving
 * its rows. A fresh db already has the v2 CHECK (from DDL) and is skipped. The
 * unique index is recreated AFTER dropping the old table so its name never
 * clashes with the renamed copy.
 */
function ensureOutboxChannel(db: DB): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='outbox'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'sheets'")) return;
  db.exec('ALTER TABLE outbox RENAME TO outbox_old');
  db.exec(`
CREATE TABLE outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('chat','sheets')),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);`);
  db.exec(
    `INSERT INTO outbox (outbox_id, event_id, channel, payload_json, status, attempts, next_attempt_at, created_at, sent_at)
     SELECT outbox_id, event_id, channel, payload_json, status, attempts, next_attempt_at, created_at, sent_at FROM outbox_old`,
  );
  db.exec('DROP TABLE outbox_old');
  db.exec('CREATE UNIQUE INDEX idx_outbox_dedup ON outbox (event_id, channel)');
}
