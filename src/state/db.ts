import Database from 'better-sqlite3';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type DB = Database.Database;

const SCHEMA_VERSION = 2;

interface ColumnDef {
  name: string;
  ddl: string;
}

/**
 * The v1 base `jobs` columns (the 001 production shape). Source-of-truth shared by
 * BOTH the fresh-db DDL and the lifecycle-CHECK rebuild (F13) so neither can drift.
 */
const JOB_BASE_COLUMNS: ColumnDef[] = [
  { name: 'job_key', ddl: 'job_key TEXT PRIMARY KEY' },
  { name: 'portal_job_id', ddl: 'portal_job_id TEXT' },
  { name: 'title', ddl: 'title TEXT NOT NULL' },
  { name: 'language_pair', ddl: 'language_pair TEXT' },
  { name: 'deadline', ddl: 'deadline TEXT' },
  { name: 'deadline_raw', ddl: 'deadline_raw TEXT' },
  { name: 'fee', ddl: 'fee TEXT' },
  { name: 'url', ddl: 'url TEXT' },
  { name: 'status', ddl: "status TEXT NOT NULL CHECK (status IN ('visible','missing'))" },
  { name: 'first_seen_at', ddl: 'first_seen_at TEXT NOT NULL' },
  { name: 'last_seen_at', ddl: 'last_seen_at TEXT NOT NULL' },
  { name: 'snapshot_hash', ddl: 'snapshot_hash TEXT NOT NULL' },
  { name: 'consecutive_misses', ddl: 'consecutive_misses INTEGER NOT NULL DEFAULT 0' },
];

/** Render a `CREATE TABLE jobs (...)` from a column list (F13 — one generator, no drift). */
function createJobsTableSql(columns: ColumnDef[], ifNotExists: boolean): string {
  const head = ifNotExists ? 'CREATE TABLE IF NOT EXISTS jobs' : 'CREATE TABLE jobs';
  return `${head} (\n${columns.map((c) => `  ${c.ddl}`).join(',\n')}\n)`;
}

const DDL = `
${createJobsTableSql(JOB_BASE_COLUMNS, true)};

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
  channel TEXT NOT NULL CHECK (channel IN ('chat','sheets','team')),
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
const JOB_V2_COLUMNS: ColumnDef[] = [
  { name: 'xtm_task_id', ddl: 'xtm_task_id TEXT' },
  { name: 'project_name', ddl: "project_name TEXT NOT NULL DEFAULT ''" },
  { name: 'file_name', ddl: "file_name TEXT NOT NULL DEFAULT ''" },
  { name: 'source_lang', ddl: 'source_lang TEXT' },
  { name: 'target_lang', ddl: 'target_lang TEXT' },
  { name: 'due_date', ddl: 'due_date TEXT' },
  { name: 'due_raw', ddl: 'due_raw TEXT' },
  { name: 'words', ddl: 'words INTEGER' },
  { name: 'file_wwc', ddl: 'file_wwc INTEGER' },
  { name: 'step', ddl: 'step TEXT' },
  { name: 'role', ddl: 'role TEXT' },
  { name: 'eligible', ddl: 'eligible INTEGER NOT NULL DEFAULT 0' },
  {
    name: 'lifecycle_status',
    ddl: "lifecycle_status TEXT CHECK (lifecycle_status IN ('new','accepted','skipped','missing','accept_failed','closed','removed','rejected'))",
  },
  {
    name: 'accept_status',
    ddl: "accept_status TEXT NOT NULL DEFAULT 'none' CHECK (accept_status IN ('none','accepting','accepted','failed'))",
  },
  { name: 'accepted_at', ddl: 'accepted_at TEXT' },
  { name: 'reject_reason', ddl: 'reject_reason TEXT' },
  { name: 'sheet_synced_status', ddl: 'sheet_synced_status TEXT' },
];

function migrate(db: DB): void {
  db.exec(DDL);
  const tx = db.transaction(() => {
    ensureJobColumns(db);
    ensureOutboxChannel(db);
    widenLifecycleCheck(db);
    backfillProjectQualifiedKey(db);
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
 * Widen the jobs lifecycle_status CHECK to include 'rejected'. SQLite cannot
 * ALTER a CHECK in place, so an existing jobs table (without 'rejected') is
 * rebuilt preserving all rows and columns. A fresh db already has the widened
 * CHECK (from JOB_V2_COLUMNS via ensureJobColumns) and is skipped.
 *
 * Guard: check whether `sqlite_master.sql` for `jobs` contains `'rejected'`;
 * if yes, skip. After the rebuild it will contain it, so a second open is
 * a no-op (idempotent).
 *
 * `DROP TABLE IF EXISTS jobs_old` runs first for idempotency: if a previous
 * migration crashed between RENAME and DROP, the next open cleans up the stale
 * jobs_old before re-running the rebuild.
 *
 * Must be called AFTER ensureJobColumns so that jobs_old already carries all
 * v2 columns — the column list copied below is DERIVED from the same source-of-truth
 * arrays (F13), so a future column added to JOB_BASE_COLUMNS/JOB_V2_COLUMNS is
 * automatically carried through the rebuild instead of being silently dropped.
 */
function widenLifecycleCheck(db: DB): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'rejected'")) return;
  const allColumns = [...JOB_BASE_COLUMNS, ...JOB_V2_COLUMNS];
  const colNames = allColumns.map((c) => c.name).join(', ');
  db.exec('DROP TABLE IF EXISTS jobs_old');
  db.exec('ALTER TABLE jobs RENAME TO jobs_old');
  // The widened lifecycle_status CHECK (with 'rejected') lives in JOB_V2_COLUMNS, so the
  // generated table carries it automatically.
  db.exec(createJobsTableSql(allColumns, false));
  db.exec(`INSERT INTO jobs (${colNames}) SELECT ${colNames} FROM jobs_old`);
  db.exec('DROP TABLE jobs_old');
}

/**
 * One-time backfill: re-key NON-TERMINAL rows from the legacy 3-field
 * `file|step|role` key to the project-qualified `project|file|step|role` key
 * (the new `computeXtmJobKey` shape — collision fix). Without this, a held row
 * still carrying the old key would, on the next deploy, fail to match its
 * freshly-computed key — mis-disappearing and then re-accepting itself.
 *
 * Runs INSIDE migrate()'s enclosing transaction, AFTER ensureJobColumns /
 * widenLifecycleCheck so the column set (and the widened lifecycle CHECK) is
 * final.
 *
 * The SQL `lower(trim(...))` MUST mirror `computeXtmJobKey`'s normField
 * (`(v ?? '').trim().toLowerCase()`) — a divergence means the re-keyed value
 * would not match the value the running bot computes. `newKeyExpr` is shared by
 * the SET and the `<>` guard so the two can never drift.
 *
 * Predicate uses the EXPLICIT non-terminal enum, NOT `NOT IN
 * ('closed','missing','removed')`: legacy feature-001 rows carry
 * lifecycle_status = NULL and must be left untouched — a NOT IN test would
 * wrongly pull them in (NULL is not in the excluded set). Terminal rows
 * (closed/missing/removed, and not mid-accept) keep their old keys.
 *
 * Idempotent: the `job_key <> <new key>` guard makes a second run a no-op, so
 * no separate version flag is needed (the same self-gating style as the other
 * migration helpers here). Edge case: if step/role were NULL the expr would be
 * NULL, the `<>` guard would be NULL (false), and the row would be skipped — no
 * PK-NULL write, no crash; non-terminal XTM rows always populate step/role.
 */
function backfillProjectQualifiedKey(db: DB): void {
  const newKeyExpr =
    "lower(trim(project_name)) || '|' || lower(trim(file_name)) || '|' || lower(trim(step)) || '|' || lower(trim(role))";
  db.exec(`
UPDATE jobs
SET job_key = ${newKeyExpr}
WHERE (lifecycle_status IN ('new','accepted','skipped','accept_failed','rejected')
       OR accept_status IN ('accepting','accepted'))
  AND project_name IS NOT NULL
  AND job_key <> ${newKeyExpr}`);
}

/**
 * Widen the outbox channel CHECK to include 'team'. SQLite cannot ALTER a
 * CHECK in place, so an existing outbox (chat/sheets-only) is rebuilt preserving
 * its rows. A fresh db already has the v2 CHECK (from DDL) and is skipped. The
 * guard (`SELECT sql … includes("'team'")`) is a cheap read that runs INSIDE
 * migrate()'s enclosing transaction; atomicity of the rebuild is guaranteed by
 * that enclosing transaction — no inner transaction is needed here.
 *
 * `DROP TABLE IF EXISTS outbox_old` runs first for idempotency: if a previous
 * migration crashed between RENAME and DROP (leaving a stale outbox_old), the
 * next open cleans it up before re-running the rebuild.
 */
function ensureOutboxChannel(db: DB): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='outbox'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'team'")) return;
  db.exec('DROP TABLE IF EXISTS outbox_old');
  db.exec('ALTER TABLE outbox RENAME TO outbox_old');
  db.exec(`
CREATE TABLE outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('chat','sheets','team')),
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
