/**
 * Opening a SQLite state file safely — the sequence both bots depend on and neither
 * should have to remember.
 *
 * A bot that stores its own state has to answer one awkward question at every start: what
 * if the file on disk is not usable? Losing it silently is unacceptable (it is the only
 * record of what has already been done), and so is refusing to start forever. The answer
 * both bots settled on is the same one: move the unusable file aside under a stamped name,
 * start fresh, and tell the caller it happened so it can raise a cold start.
 *
 * The order of the steps carries the safety, which is why they are here rather than copied:
 *
 *  - **Close the handle before renaming.** Windows refuses to rename a file that is still
 *    open (EBUSY), and the realistic corruption is the one that opens fine and fails on the
 *    first real query — so at the moment of the rename the handle is open.
 *  - **Re-throw the caller's own logic error instead of quarantining.** A bug in a migration
 *    is not a corrupt file. The XTM bot learned this the expensive way (PR #23): treating
 *    the two alike renames a perfectly good database and discards its history for what is a
 *    code defect. The caller names its own error type; only it knows which is which.
 *  - **Quarantine only when there is a file to quarantine.** An open that failed before
 *    creating anything has nothing to rename, and reporting a recovery that did not happen
 *    is worse than propagating the real error.
 *
 * What differs between the two callers is passed in, and it is only ever four things: the
 * filename, the migration, which error means "our code is wrong", and the clock reading
 * that stamps the quarantine copy.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface SqliteOpenSpec {
  /** Directory to hold the file; created if absent. */
  readonly dir: string;
  /** The file's name within `dir`. Also the stem of any quarantine copy, so each bot's
   *  quarantined file is filed under its own name. */
  readonly fileName: string;
  /** Caller's clock as an ISO timestamp; stamped into the quarantine name after `:` and
   *  `.` are replaced, both being illegal in a Windows filename. */
  readonly nowIso: string;
  /** Bring the schema up to date. Runs against the opened file, and again against the
   *  fresh one if the first had to be quarantined — so it must work on an empty database. */
  readonly migrate: (db: Database.Database) => void;
  /**
   * True for the caller's own "this is a bug in our code, the file is fine" error. Such an
   * error is re-thrown with the file left exactly as it was, so the bot fails to start
   * loudly rather than quietly discarding history for a defect a deploy can fix.
   */
  readonly isLogicError: (err: unknown) => boolean;
}

export interface OpenedSqlite {
  readonly db: Database.Database;
  /** The file actually opened — returned rather than implied, so a caller (and an
   *  isolation test) can assert which file this store touched. */
  readonly path: string;
  /** True when the previous file was unusable and was moved aside; the caller treats this
   *  as a cold start plus an alert. */
  readonly recoveredFromCorruption: boolean;
  /** Where the unusable file went. The key is **absent**, not present-and-undefined, when
   *  nothing was quarantined — callers whose own result type is stricter than this one
   *  rebuild from it rather than spreading, so their shape is unchanged. */
  readonly corruptCopyPath?: string | undefined;
}

export function openSqliteWithQuarantine(spec: SqliteOpenSpec): OpenedSqlite {
  const { dir, fileName, nowIso, migrate, isLogicError } = spec;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);

  let attempt: Database.Database | undefined;
  try {
    attempt = new Database(path);
    attempt.pragma('journal_mode = WAL');
    migrate(attempt);
    return { db: attempt, path, recoveredFromCorruption: false };
  } catch (err) {
    // Release any handle opened above so the file can be renamed (Windows EBUSY).
    try {
      attempt?.close();
    } catch {
      // ignore — best-effort close before quarantine
    }
    if (isLogicError(err)) throw err;
    if (!existsSync(path)) throw err;
    const stamp = nowIso.replace(/[:.]/g, '-');
    const corruptCopyPath = join(dir, `${fileName}.corrupt-${stamp}`);
    renameSync(path, corruptCopyPath);
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    migrate(db);
    return { db, path, recoveredFromCorruption: true, corruptCopyPath };
  }
}
