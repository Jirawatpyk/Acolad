/**
 * Open-with-quarantine, tested once for both bots.
 *
 * `src/state/db.ts` and `src/straker/strakerStore.ts` each carried this dance verbatim —
 * make the directory, open, WAL, migrate, and on failure close the handle before Windows
 * refuses the rename, re-throw our own logic errors instead of quarantining, stamp a name,
 * rename aside, reopen. The steps are not decoration: PR #23 exists because getting one of
 * them wrong (quarantining a migration bug) renames a perfectly good database and discards
 * its history. One implementation, one place to get it right.
 *
 * Real SQLite files in a real temp directory throughout. The thing under test is what
 * happens to a file on disk, and a mocked filesystem cannot fail the way Windows does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteWithQuarantine, type SqliteOpenSpec } from '../../../src/shared/sqliteOpen.js';

const NOW_ISO = '2026-09-11T10:30:45.123Z';
const FILE = 'probe.db';

const dirs: string[] = [];
const openDbs: Database.Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shared-sqlite-'));
  dirs.push(dir);
  return dir;
}

/** A migration that leaves a mark, so "did it run?" is answerable from the file. */
const stampMigration = (db: Database.Database): void => {
  db.exec('CREATE TABLE IF NOT EXISTS marker (k TEXT PRIMARY KEY)');
  db.prepare("INSERT OR IGNORE INTO marker (k) VALUES ('migrated')").run();
};

/** The caller's own "our code is wrong, the file is fine" error. */
class LogicError extends Error {}

function spec(dir: string, over: Partial<SqliteOpenSpec> = {}): SqliteOpenSpec {
  return {
    dir,
    fileName: FILE,
    nowIso: NOW_ISO,
    migrate: stampMigration,
    isLogicError: (err) => err instanceof LogicError,
    ...over,
  };
}

function open(s: SqliteOpenSpec): ReturnType<typeof openSqliteWithQuarantine> {
  const opened = openSqliteWithQuarantine(s);
  openDbs.push(opened.db);
  return opened;
}

/** Seed a real, openable database whose stored shape the migration below will reject. */
function seedRejectableFile(dir: string): void {
  const seeded = new Database(join(dir, FILE));
  seeded.exec("CREATE TABLE marker (k TEXT PRIMARY KEY); INSERT INTO marker VALUES ('history')");
  seeded.close();
}

/** Succeeds against a fresh file, throws against the seeded one — an unusable STORED shape,
 *  which is the realistic failure: SQLite opens the header happily and only fails later. */
const rejectSeededShape = (db: Database.Database): void => {
  db.exec('CREATE TABLE IF NOT EXISTS marker (k TEXT PRIMARY KEY)');
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM marker').get() as { n: number };
  if (n > 0) throw new Error('the stored schema cannot be used by this build');
};

describe('opening a healthy database', () => {
  it('creates the directory, opens the named file, and migrates it', () => {
    const dir = join(tempDir(), 'not', 'yet', 'there');
    const opened = open(spec(dir));

    expect(opened.path).toBe(join(dir, FILE));
    expect(existsSync(opened.path)).toBe(true);
    expect(opened.recoveredFromCorruption).toBe(false);
    expect(opened.corruptCopyPath).toBeUndefined();
    expect(opened.db.prepare('SELECT k FROM marker').get()).toEqual({ k: 'migrated' });
  });

  it('puts the database in WAL, which is what makes a crash mid-write survivable', () => {
    const opened = open(spec(tempDir()));
    expect(String(opened.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
  });

  it('reopens an existing database in place, keeping its rows and quarantining nothing', () => {
    const dir = tempDir();
    const first = openSqliteWithQuarantine(spec(dir));
    first.db.prepare("INSERT OR IGNORE INTO marker (k) VALUES ('from-the-first-open')").run();
    first.db.close();

    const second = open(spec(dir));

    expect(second.recoveredFromCorruption).toBe(false);
    expect(second.db.prepare('SELECT COUNT(*) AS n FROM marker').get()).toEqual({ n: 2 });
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
  });
});

describe('quarantining a file that cannot be used', () => {
  it('renames the unusable file aside, starts fresh, and says that it did', () => {
    const dir = tempDir();
    writeFileSync(join(dir, FILE), 'this is not a database', 'utf8');

    const opened = open(spec(dir));

    expect(opened.recoveredFromCorruption).toBe(true);
    // Moved, never overwritten: it is the only copy of whatever state was in there, and the
    // stamp comes from the caller's clock so a second corruption cannot land on the first.
    expect(opened.corruptCopyPath).toBe(join(dir, `${FILE}.corrupt-2026-09-11T10-30-45-123Z`));
    expect(existsSync(opened.corruptCopyPath ?? '')).toBe(true);
    expect(opened.db.prepare('SELECT k FROM marker').get()).toEqual({ k: 'migrated' });
  });

  it('names the copy from the file it quarantined, not from a hard-coded one', () => {
    // Two bots share this helper and open differently named files; a hard-coded stem here
    // would file Straker's quarantine under the XTM bot's name.
    const dir = tempDir();
    writeFileSync(join(dir, 'other.db'), 'not a database', 'utf8');

    const opened = open(spec(dir, { fileName: 'other.db' }));

    expect(opened.corruptCopyPath).toMatch(/other\.db\.corrupt-/);
  });

  it('quarantines when the file opens but the migration rejects what is stored', () => {
    // The handle is OPEN when the rename happens here, which is the case Windows refuses
    // with EBUSY unless it is closed first — this test passing on Windows is the evidence
    // that the best-effort close before the rename is still there.
    const dir = tempDir();
    seedRejectableFile(dir);

    const opened = open(spec(dir, { migrate: rejectSeededShape }));

    expect(opened.recoveredFromCorruption).toBe(true);
    expect(existsSync(opened.corruptCopyPath ?? '')).toBe(true);
    // Genuinely fresh: the seeded row is in the quarantined copy, not in the one handed back.
    expect(opened.db.prepare('SELECT COUNT(*) AS n FROM marker').get()).toEqual({ n: 0 });
    const quarantined = new Database(opened.corruptCopyPath ?? '');
    openDbs.push(quarantined);
    expect(quarantined.prepare('SELECT k FROM marker').get()).toEqual({ k: 'history' });
  });

  it('migrates the fresh file too, so the caller never receives an empty schema', () => {
    const dir = tempDir();
    writeFileSync(join(dir, FILE), 'not a database', 'utf8');

    const opened = open(spec(dir));

    expect(String(opened.db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(opened.db.prepare('SELECT k FROM marker').get()).toEqual({ k: 'migrated' });
  });
});

describe('failures that must NOT be treated as corruption', () => {
  it("re-throws the caller's own logic error and leaves the database untouched", () => {
    // The lesson of PR #23. A bug in our migration code is not a corrupt file, and
    // quarantining on one renames a valid database and silently discards its history.
    const dir = tempDir();
    seedRejectableFile(dir);

    expect(() =>
      openSqliteWithQuarantine(
        spec(dir, {
          migrate: () => {
            throw new LogicError('the migration itself is wrong');
          },
        }),
      ),
    ).toThrow(LogicError);

    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
    const survivor = new Database(join(dir, FILE));
    openDbs.push(survivor);
    expect(survivor.prepare('SELECT k FROM marker').get()).toEqual({ k: 'history' });
  });

  it('re-throws when the open failed with no file to quarantine', () => {
    // Nothing was created, so there is nothing to rename aside — inventing a quarantine
    // here would report a corruption recovery that never happened. The nested name makes
    // the open fail for a reason that is not the file's content.
    const dir = tempDir();

    expect(() =>
      openSqliteWithQuarantine(spec(dir, { fileName: join('missing-subdir', 'x.db') })),
    ).toThrow();
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
  });
});

describe('which failures count as corruption — narrowed by the caller, never by default', () => {
  /** A `better-sqlite3` failure as a caller actually receives one: an Error carrying a
   *  `code` string. That string is the only thing separating "the bytes are wrong" from
   *  "someone else has the file open", so it is what a predicate reads. */
  const sqliteError = (code: string): Error =>
    Object.assign(new Error(`simulated ${code}`), { code });

  /** Fails the FIRST migration and succeeds after, which is the real shape: whatever was
   *  wrong with the stored file is not wrong with the fresh one. A migration that failed
   *  every time would make every test here pass for the wrong reason — the second
   *  `migrate` in the quarantine path would throw and nothing would be proven. */
  const failsFirstWith = (err: Error): ((db: Database.Database) => void) => {
    let failed = false;
    return (db) => {
      if (!failed) {
        failed = true;
        throw err;
      }
      stampMigration(db);
    };
  };

  /** An arbitrary caller's idea of corruption. Arbitrary on purpose: the shared helper
   *  must hold no opinion of its own about which codes mean a broken file. */
  const onlyMalformed = (err: unknown): boolean =>
    (err as { code?: string }).code === 'SQLITE_NOTADB';

  /** Call it expecting a throw, and keep any handle it returned instead so a failing
   *  assertion reads as the assertion rather than as EBUSY in the cleanup. */
  function errorFrom(s: SqliteOpenSpec): unknown {
    try {
      openDbs.push(openSqliteWithQuarantine(s).db);
      return null;
    } catch (err) {
      return err;
    }
  }

  it('quarantines every non-logic failure when the caller names no predicate', () => {
    // SC-005: `src/state/db.ts` passes no predicate, and the live XTM bot has run on this
    // behaviour for 18 days with 0 restarts. Narrowing by DEFAULT would change it silently,
    // which is the one thing this opt-in must not do. Mutating the implementation to apply
    // a strict rule unconditionally fails here.
    const dir = tempDir();
    seedRejectableFile(dir);

    const opened = open(spec(dir, { migrate: failsFirstWith(sqliteError('SQLITE_BUSY')) }));

    expect(opened.recoveredFromCorruption).toBe(true);
    expect(existsSync(opened.corruptCopyPath ?? '')).toBe(true);
  });

  it('propagates a failure the caller does not call corruption, leaving the file untouched', () => {
    // The Critical finding itself. A locked file, a full disk, an ACL change after a
    // Windows update — none of them says the bytes are wrong, and renaming a good database
    // away on one destroys the only record of what has already been done. Failing to start
    // is recoverable; that is not. Deleting the `isCorruption` guard fails here.
    const dir = tempDir();
    seedRejectableFile(dir);

    const err = errorFrom(
      spec(dir, {
        migrate: failsFirstWith(sqliteError('SQLITE_BUSY')),
        isCorruption: onlyMalformed,
      }),
    );

    expect(err).toMatchObject({ code: 'SQLITE_BUSY' });
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
    const survivor = new Database(join(dir, FILE));
    openDbs.push(survivor);
    expect(survivor.prepare('SELECT k FROM marker').get()).toEqual({ k: 'history' });
  });

  it('still quarantines the failures the caller DOES call corruption', () => {
    // The other half of the same switch: narrowing must not become refusing. A predicate
    // wired so that nothing is ever corruption fails here — and the bot would then refuse
    // to start, forever, on a file that genuinely is broken.
    const dir = tempDir();
    seedRejectableFile(dir);

    const opened = open(
      spec(dir, {
        migrate: failsFirstWith(sqliteError('SQLITE_NOTADB')),
        isCorruption: onlyMalformed,
      }),
    );

    expect(opened.recoveredFromCorruption).toBe(true);
    // Genuinely fresh — it carries the migration's own stamp and nothing else. The seeded
    // history went to the quarantined copy, which is where it must still be readable.
    expect(opened.db.prepare('SELECT k FROM marker').all()).toEqual([{ k: 'migrated' }]);
    const quarantined = new Database(opened.corruptCopyPath ?? '');
    openDbs.push(quarantined);
    expect(quarantined.prepare('SELECT k FROM marker').get()).toEqual({ k: 'history' });
  });

  it('asks isLogicError first, so our own bug is never re-read as a broken file', () => {
    // Both predicates can say yes about one error, and then the ORDER is the entire answer.
    // PR #23's lesson outranks the new one: a logic error keeps the database whatever code
    // rode along with it. Swapping the two guards fails here.
    const dir = tempDir();
    seedRejectableFile(dir);

    const err = errorFrom(
      spec(dir, {
        migrate: failsFirstWith(
          Object.assign(new LogicError('our migration is wrong'), { code: 'SQLITE_NOTADB' }),
        ),
        isCorruption: onlyMalformed,
      }),
    );

    expect(err).toBeInstanceOf(LogicError);
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
  });
});
