import Database from 'better-sqlite3';
import { mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeXtmJobKey } from '../detection/jobKey.js';

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
 * A migration step failed for a LOGIC reason (a bug in our migration code — e.g. an
 * unexpected PK collision), NOT because the db file is corrupt. `openDatabase` treats this
 * distinctly from a genuine open/corruption failure: it propagates (crash loud) instead of
 * quarantining, so a code bug can never silently rename a valid acolad.db to .corrupt and
 * discard all job history. Carries the underlying error as `cause`.
 */
export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * Open (and migrate) the SQLite state db with WAL. On a corrupt/unopenable file
 * the original is quarantined as acolad.db.corrupt-<ts> (never overwritten) and
 * a fresh db is created — caller treats this as a cold start + alert (FR-017).
 * A `MigrationError` (our own migration logic bug) is re-thrown, NOT quarantined.
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
    // A migration LOGIC error (our code threw) is NOT file corruption. Quarantining here would
    // rename a perfectly valid acolad.db to .corrupt and silently discard all job history for a
    // code bug. Crash loud instead: propagate so the bot fails to start + pages, db preserved.
    if (err instanceof MigrationError) throw err;
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
 * One-time backfill: re-key EVERY real-identity row from the legacy 3-field
 * `file|step|role` key to the project-qualified `project|file|step|role` key, using
 * the ACTUAL `computeXtmJobKey` (the running bot's key function) — NOT a parallel
 * SQL re-implementation of it. Without this, a held/relisting row still carrying the
 * old key would, on the next deploy, fail to match its freshly-computed key —
 * mis-disappearing (a spurious 'first_seen' 🆕 on relist) and losing its history.
 *
 * Re-keys ALL rows with a real identity (`project_name <> '' AND file_name <> ''`),
 * dropping the previous lifecycle/accept predicate entirely — identity, not lifecycle,
 * decides. This closes three gaps the old SQL predicate had:
 *   - #5: the old SET re-implemented normField in SQL (`lower(trim(coalesce(...)))`),
 *     which would silently DRIFT from `computeXtmJobKey` if normField changed, and used
 *     SQLite's ASCII-only `lower()` vs JS's full-Unicode `.toLowerCase()`. Re-keying in
 *     JS via `computeXtmJobKey` removes both the drift and the ASCII gap.
 *   - #4 / B#8: the old predicate's `OR accept_status IN ('accepting','accepted')` also
 *     re-keyed terminal closed/removed+accepted rows, contradicting its own "terminal
 *     keeps old key" comment. Re-key-all treats every row uniformly, so the inconsistency
 *     is gone.
 *   - B#1: the old predicate EXCLUDED `'missing'` — the PRIMARY relisting state — so a job
 *     that was missing at deploy kept its old key and fired a spurious 'first_seen' when it
 *     relisted (losing its accept/lifecycle history). Re-keying all real-identity rows fixes it.
 *
 * One-shot (#6): guarded by a `job_key_backfill_v2` meta flag (read-first, the same
 * self-gating style as the sibling migrations here) so it runs ONCE — not a full table
 * scan on every `openDatabase`. The flag is set after a successful run. Idempotent via
 * BOTH the flag and the `newKey !== oldKey` per-row skip.
 *
 * NULL step/role and trim/lowercase parity are intrinsic to `computeXtmJobKey`
 * (`normField = (v ?? '').trim().toLowerCase()`), so the JS path gets them for free.
 *
 * Real-identity guard: a real XTM job always carries a non-empty project + file
 * (`rawXtmJobSchema` enforces `z.string().trim().min(1)`); legacy feature-001 partner
 * rows carry empty project/file (NOT NULL DEFAULT ''). A row with an empty identity is
 * degenerate — re-keying it to a meaningless `|||`/`proj|||`-style key is pointless and
 * risks a PK collision, so it is skipped.
 *
 * PK-collision safety: two distinct old-key rows have distinct legacy `file|step|role`
 * keys, so their 4-segment `project|file|step|role` new keys are also distinct; and a
 * 4-segment new key can never equal a remaining 3-segment old key — no collision.
 *
 * Runs INSIDE migrate()'s enclosing transaction, AFTER ensureJobColumns /
 * widenLifecycleCheck (which establish the final job column set + widened lifecycle CHECK);
 * ensureOutboxChannel also runs before this but does not touch the jobs table.
 *
 * Any unexpected throw here (e.g. a PK collision from an already-occupied target key) is a
 * migration LOGIC error, not file corruption — it is wrapped as `MigrationError` so
 * `openDatabase` propagates it (crash loud) instead of quarantining the valid db.
 */
function backfillProjectQualifiedKey(db: DB): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'job_key_backfill_v2'").get() as
    | { value: string }
    | undefined;
  if (done) return;

  let reKeyCount = 0;
  try {
    const rows = db
      .prepare('SELECT job_key, project_name, file_name, step, role FROM jobs')
      .all() as {
      job_key: string;
      project_name: string | null;
      file_name: string | null;
      step: string | null;
      role: string | null;
    }[];
    const update = db.prepare('UPDATE jobs SET job_key = ? WHERE job_key = ?');
    for (const row of rows) {
      // Skip degenerate rows (empty/NULL project or file) — a meaningless key + a PK-collision
      // risk. The falsy guard (not `=== ''`) catches a NULL project/file too, and narrows both
      // to `string` for computeXtmJobKey below.
      if (!row.project_name || !row.file_name) continue;
      const newKey = computeXtmJobKey({
        projectName: row.project_name,
        fileName: row.file_name,
        step: row.step,
        role: row.role,
      });
      if (newKey !== row.job_key) {
        update.run(newKey, row.job_key);
        reKeyCount++;
      }
    }
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('job_key_backfill_v2', '1')").run();
  } catch (err) {
    // The enclosing migrate() transaction rolls back the partial re-keys before this propagates.
    // Genuine FILE corruption / IO surfacing during the jobs read or update is NOT a migration
    // logic error — it must still reach openDatabase's quarantine path (FR-017), so let those SQLite
    // codes propagate RAW. Only a non-corruption throw (a PK collision from an already-occupied
    // target key, or a bug in computeXtmJobKey) is a true logic error worth crashing loud while
    // preserving the db.
    const code = (err as { code?: string }).code ?? '';
    if (
      code === 'SQLITE_CORRUPT' ||
      code === 'SQLITE_NOTADB' ||
      code === 'SQLITE_CANTOPEN' ||
      code.startsWith('SQLITE_IOERR')
    ) {
      throw err; // → openDatabase quarantines + starts fresh (FR-017 recovery)
    }
    throw new MigrationError(
      `backfillProjectQualifiedKey failed after ${reKeyCount} re-key(s); the db is NOT corrupt — this is a migration logic error`,
      { cause: err },
    );
  }
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
