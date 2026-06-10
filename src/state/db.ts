import Database from 'better-sqlite3';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type DB = Database.Database;

const SCHEMA_VERSION = 1;

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
  channel TEXT NOT NULL CHECK (channel IN ('chat')),
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

function migrate(db: DB): void {
  db.exec(DDL);
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
}
