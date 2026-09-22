/**
 * Straker's own durable state: offer sightings, outcome rows, and the held work the
 * ledger derives from.
 *
 * ## The bulkhead (R11, FR-024, SC-005)
 *
 * This store shares **no table, no file and no transaction** with the live XTM bot. It
 * opens `straker.db` under Straker's own `STATE_DIR` (`StrakerBotConfig.stateDir`, which
 * the config loader already refuses to let equal the XTM bot's), every table name is
 * Straker's own, and every write runs in this connection's transaction. Nothing here
 * imports `src/state/` or `src/config/` — that absence is asserted by a test, because a
 * bulkhead that exists only in a comment is not a bulkhead.
 *
 * The shape it copies from `src/state/db.ts` is the *discipline*, never the storage: WAL,
 * an idempotent migration, a corrupt file quarantined rather than overwritten, and state
 * committed before anything is reported as done (Constitution VII).
 *
 * ## What is NOT modelled here
 *
 * The portal-native shape of an offer is blocked by SC-000 — zero real payloads have been
 * captured. No column below names a portal field. Identity, sighting timing, effort,
 * deadline, outcome and skip reason are **domain** values; how they are read out of a
 * payload is Track B's problem and lives in `offerParse.ts`.
 *
 * Time is stored as epoch milliseconds throughout, matching the sighting vocabulary the
 * capture probe already established (`firstSeenAtMs`, …). Bangkok-formatted timestamps are
 * a presentation concern and are applied by the reporting layer, not by storage.
 */

import type Database from 'better-sqlite3';
import { basename } from 'node:path';
import { openSqliteWithQuarantine } from '../shared/sqliteOpen.js';
import type { TrackedOffer, TrackerState } from './offerTracker.js';
import { STRAKER_OUTBOX_CHANNELS, STRAKER_OUTBOX_STATUSES } from './outbox.js';
import type { StrakerEnqueueResult, StrakerOutbox } from './outbox.js';
import { CLAIM_OUTCOMES, SKIP_REASONS } from './outcomePolicy.js';
import type { ClaimOutcome, EndedOfferSighting, OfferSighting, SkipReason } from './types.js';
import type { WorkIdentity } from './workKey.js';

export type StrakerDB = Database.Database;

/** Straker's database file. Deliberately NOT `acolad.db`: two bots pointed at one
 *  directory by a bad deploy must still open two different files. */
export const STRAKER_DB_FILENAME = 'straker.db';

const SCHEMA_VERSION = 1;

/** The one `straker_meta` key in use (T073). A literal rather than a bound parameter
 *  because it is interpolated into prepared SQL that takes no user input. */
const BARRED_KEY = 'account_barred_since_ms';

// ---------------------------------------------------------------------------
// Vocabulary (data-model §3 / §4) — the event types an offer can produce
// ---------------------------------------------------------------------------

/**
 * Why rows are keyed on identity **together with** event type (FR-014): one offer
 * legitimately produces a sighting, a claim and possibly a recovery, and identity alone
 * would collapse three real events into one row — which is how "we keep arriving second"
 * becomes indistinguishable from "Straker sends us nothing".
 */
export const OFFER_EVENT_TYPES = ['sighting', 'claim', 'skip', 'recovery'] as const;
export type OfferEventType = (typeof OFFER_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * An entry reached the store without the portal's own identifier. This is a **hard
 * failure, not a skip** (data-model §2): an offer we cannot name is an offer we cannot
 * deduplicate, cannot reconcile and cannot hold against a ceiling, so recording it under
 * a blank or invented key would corrupt every later answer quietly.
 */
export class MissingOfferIdentityError extends Error {
  constructor(what: string) {
    super(`${what} arrived without an offer identity — refusing to guess which offer was meant`);
    this.name = 'MissingOfferIdentityError';
  }
}

/**
 * A recorded outcome was about to be replaced by a different settled one — `won` by
 * `failed`, say.
 *
 * The upsert in `recordEvent` exists so that re-running a cycle converges instead of
 * duplicating rows (Constitution VII), and that is still what it does for everything a
 * re-run legitimately changes: timings, effort, a deadline, a skip reason, and the
 * resolution of an outcome that was left `unknown`. What it must not do is quietly replace
 * an answer with a contradicting one, because the act behind a claim outcome is
 * irreversible: if the portal committed the work to the team, a later `failed` overwriting
 * `won` erases the only record that the team owns it, and leaves no trace that it did.
 *
 * A re-run that produces the same outcome is silent, as it should be. A re-run that
 * produces a different one is not a retry — it is two answers to a question with one
 * answer, and which of them is true cannot be decided here.
 */
export class OutcomeOverwriteError extends Error {
  constructor(
    readonly objId: string,
    readonly eventType: OfferEventType,
    readonly stored: ClaimOutcome,
    readonly incoming: ClaimOutcome | null,
  ) {
    super(
      `offer ${objId}: its ${eventType} already recorded '${stored}' — refusing to overwrite ` +
        `that with '${String(incoming)}'. The claim behind it cannot be taken back, so the ` +
        'two answers must be reconciled by a human rather than by whichever wrote last.',
    );
    this.name = 'OutcomeOverwriteError';
  }
}

/**
 * The database on disk does not match the schema this code expects. Distinct from a
 * corrupt file on purpose — the XTM bot learned (PR #23) that treating a logic error as
 * corruption renames a perfectly good database and discards its history. This one
 * propagates: the bot fails to start, loudly, with the file intact.
 */
export class StrakerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrakerSchemaError';
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Render a SQL string set for a CHECK. Every value is a compile-time literal from the
 *  shared vocabulary in `types.ts`; no runtime input reaches this. */
function sqlSet(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

/**
 * Every CHECK in this schema whose values come from a shared vocabulary, declared once and
 * used twice: `ddl()` renders them into the CREATE TABLE statements, and
 * `assertVocabularyCovered` verifies at open time that the database on disk carries all of
 * them. Both halves read this table, so a value added to a vocabulary can neither reach a
 * fresh schema missing from the CHECK nor sit unnoticed against an older database.
 *
 * The outbox's channels and statuses are listed here for the same reason the event types
 * are, and are imported from `outbox.ts` rather than retyped: a hand-written copy is
 * exactly the disagreement this table exists to make impossible — it type-checks, it
 * passes the coverage check, and then the first enqueue on the new channel throws inside
 * the transaction the outcome shares with the state change that produced it, rolling that
 * back too.
 *
 * A new table with a vocabulary CHECK needs its entry here. `ddl()` renders from this
 * object, so the two cannot drift for a table that is listed; for one that is not, the
 * coverage check simply has nothing to say about it.
 */
const VOCABULARY_CHECKS = {
  offer_events: {
    event_type: OFFER_EVENT_TYPES,
    outcome: CLAIM_OUTCOMES,
    skip_reason: SKIP_REASONS,
  },
  straker_outbox: {
    channel: STRAKER_OUTBOX_CHANNELS,
    status: STRAKER_OUTBOX_STATUSES,
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

/**
 * The CHECK constraints below are generated from the shared vocabulary rather than
 * retyped, so a value added to a vocabulary cannot silently disagree with the schema. An
 * *existing* database still carries the older CHECK — SQLite cannot alter one in place —
 * which is what `assertVocabularyCovered` catches at open time instead of letting it
 * surface as a mysterious insert failure in the middle of a night shift. Widening one
 * means a table rebuild, exactly as `widenLifecycleCheck` does for the XTM bot.
 */
function ddl(): string {
  return `
CREATE TABLE IF NOT EXISTS offer_sightings (
  obj_id TEXT NOT NULL CHECK (obj_id <> ''),
  sighting INTEGER NOT NULL CHECK (sighting >= 1),
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  not_found_at_ms INTEGER,
  PRIMARY KEY (obj_id, sighting)
);

CREATE TABLE IF NOT EXISTS offer_events (
  obj_id TEXT NOT NULL CHECK (obj_id <> ''),
  event_type TEXT NOT NULL CHECK (event_type IN (${sqlSet(VOCABULARY_CHECKS.offer_events.event_type)})),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (${sqlSet(VOCABULARY_CHECKS.offer_events.outcome)})),
  skip_reason TEXT CHECK (skip_reason IS NULL OR skip_reason IN (${sqlSet(VOCABULARY_CHECKS.offer_events.skip_reason)})),
  effort_words INTEGER CHECK (effort_words IS NULL OR effort_words >= 0),
  deadline_ms INTEGER,
  occurred_at_ms INTEGER NOT NULL,
  -- What names the work across its stages (2026-09-22, see workKey.ts). Nullable: older
  -- rows and offers that lack a job reference carry none.
  work_key TEXT,
  job_ref TEXT,
  title TEXT,
  service TEXT,
  PRIMARY KEY (obj_id, event_type),
  -- An outcome belongs to the two event types that produce one, and a skip reason to the
  -- one that produces one. Enforced here so a caller bug fails at the write rather than
  -- turning up later as a row nobody can interpret.
  CHECK ((outcome IS NOT NULL) = (event_type IN ('claim', 'recovery'))),
  CHECK ((skip_reason IS NOT NULL) = (event_type = 'skip'))
);

CREATE TABLE IF NOT EXISTS held_work (
  obj_id TEXT PRIMARY KEY CHECK (obj_id <> ''),
  effort_words INTEGER NOT NULL CHECK (effort_words >= 0),
  deadline_ms INTEGER,
  held_since_ms INTEGER NOT NULL,
  released_at_ms INTEGER,
  -- Which budget this work is charged to (2026-09-17). Translation and DTP preparation are
  -- both counted in words, and a word means something entirely different in each, so they
  -- cannot share a daily ceiling. Defaulted rather than required so the ALTER below can add
  -- it to a database that already holds rows.
  kind TEXT NOT NULL DEFAULT 'translation' CHECK (kind IN ('translation', 'monolingual')),
  -- The key that ties this work to its purchase order and assigned job, whose ids differ
  -- from the offer's (2026-09-22, see workKey.ts), and the fields people read it by.
  work_key TEXT,
  job_ref TEXT,
  title TEXT,
  service TEXT
);

-- Durable flags that must outlive a process, of which there is exactly one today: the
-- barred account (T073, contract §4a). A key-value table rather than a column on some
-- other row because the fact is about the ACCOUNT, not about any offer, and there is no
-- existing row it belongs to. Purely additive, so CREATE TABLE IF NOT EXISTS brings an
-- already-live database up to date on its next open with no version bump.
CREATE TABLE IF NOT EXISTS straker_meta (
  key TEXT PRIMARY KEY CHECK (key <> ''),
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS straker_outbox (
  outbox_id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN (${sqlSet(VOCABULARY_CHECKS.straker_outbox.channel)})),
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (${sqlSet(VOCABULARY_CHECKS.straker_outbox.status)})),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_straker_outbox_dedup
  ON straker_outbox (event_id, channel);
CREATE INDEX IF NOT EXISTS idx_straker_outbox_due
  ON straker_outbox (status, next_attempt_at_ms);
`;
}

/**
 * The outcome of opening Straker's state file. A union for the same reason
 * {@link OpenedSqlite} is one: a quarantine that cannot name the file it moved aside is a
 * state this code has never produced, and modelling it only bought every caller a
 * fallback string to print instead of a path.
 */
export type QuarantineOutcome =
  | { readonly recoveredFromCorruption: false }
  | { readonly recoveredFromCorruption: true; readonly corruptCopyPath: string };

export type OpenStrakerDbResult = {
  readonly db: StrakerDB;
  /** The file actually opened. Returned rather than implied, so a caller — and the
   *  isolation test — can assert which file this store touched. */
  readonly path: string;
} & QuarantineOutcome;

/**
 * Open (and migrate) Straker's SQLite state with WAL, under the state directory it is
 * given and nowhere else. An unusable file is renamed aside as
 * `straker.db.corrupt-<stamp>` — never overwritten — and a fresh database is created. A
 * `StrakerSchemaError` (our own logic, not a broken file) propagates instead.
 *
 * The sequence itself is `shared/sqliteOpen.ts`, which the XTM bot's `openDatabase` also
 * uses. Sharing the *procedure* is not sharing a database: the file below is Straker's,
 * the schema below is Straker's, and nothing about R11 changes. What is passed in is all
 * that ever differed between the two — the filename, the migration, and which error means
 * "our code is wrong".
 */
export function openStrakerDatabase(stateDir: string, nowMs: number): OpenStrakerDbResult {
  return openSqliteWithQuarantine({
    dir: stateDir,
    fileName: STRAKER_DB_FILENAME,
    nowIso: new Date(nowMs).toISOString(),
    migrate,
    isLogicError: (err) => err instanceof StrakerSchemaError,
    isCorruption: isStrakerCorruption,
  });
}

/**
 * Which failures mean this file is genuinely broken — and, the part that earns the
 * function, which ones do not.
 *
 * Straker's daily ceiling is derived entirely from held work: `ledger.ts` sums
 * `heldWork()` on every read and keeps no counter to fall back on. So a database replaced
 * by an empty one does not announce itself as a failure; it reads as *"the team holds
 * nothing today"*, every offer then fits under the ceiling, and the bot claims past
 * capacity all day looking perfectly healthy. Quarantining is therefore not the safe
 * default here that it is for the XTM bot, whose ceiling does not come from its database
 * the same way.
 *
 * Only two answers survive that: the disk image is malformed, or the file is not a SQLite
 * database at all. `SQLITE_CORRUPT` is matched as a prefix because SQLite reports the
 * family through extended codes (`_INDEX`, `_VTAB`, `_SEQUENCE`), and a corrupt index is
 * still corruption.
 *
 * **Deliberately narrower than the list in `src/state/db.ts`**, which also names
 * `SQLITE_CANTOPEN` and the `SQLITE_IOERR` family. That list answers a different question
 * from inside `backfillProjectQualifiedKey` — "is this my own migration bug, or anything
 * else?" — where routing the unknown onward to the quarantine is the cautious move. Here
 * the question is "is this file definitely broken?", and caution points the other way:
 * `SQLITE_CANTOPEN` at open time is a path, a permission or a handle limit, and
 * `SQLITE_IOERR` is a disk that failed a read, neither of which is evidence about the
 * bytes. Refusing to start is recoverable in the time it takes to fix an ACL. Destroying
 * the only record of work the team already owns is not.
 *
 * Reads `err.code`, the string `better-sqlite3` puts on its `SqliteError`, the same way
 * `backfillProjectQualifiedKey` discriminates. Anything that is not an object with a string
 * `code` — a bare throw, a string, null — is not evidence of corruption either, and total:
 * this runs inside a catch block, where throwing would turn a recoverable failure into a
 * crash on the error path itself.
 */
export function isStrakerCorruption(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code } = err as { code?: unknown };
  if (typeof code !== 'string') return false;
  return code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB';
}

/** Just the part of the outbox this needs, so the coordinator can hand over its real one
 *  without this file depending on the whole class — `LedgerStore` in `ledger.ts` is the
 *  same shape for the same reason. */
export type QuarantineAlertSink = Pick<StrakerOutbox, 'enqueue'>;

/**
 * Turn a quarantine into something a human will actually see.
 *
 * A quarantine is the one startup outcome that changes what the bot will *do* for the rest
 * of the day: the held set is gone with the file, so the ledger reads zero committed work
 * and the ceiling stops holding. Reported as a log line that is a single `error` in a file
 * nobody watches while the bot runs over its ceiling looking healthy. Queued here instead,
 * on the operations channel on-call already reads, in the same durable table as every other
 * outcome.
 *
 * Returns `null` on a healthy open so the coordinator can call it unconditionally, and
 * otherwise whatever the outbox made of it — `already_pending` on a repeated start, because
 * the event is keyed on the quarantined copy's stamped name: a bot in a restart loop raises
 * one alert about one file, while a second, genuinely new quarantine gets its own.
 *
 * **Durable is not yet delivered.** Straker has no dispatcher until Phase 4, so this row
 * sits `pending` until one exists to drain it. That is still strictly better than a log
 * line — the alert is in the queue, it is idempotent, and it will go out when the
 * dispatcher lands rather than having to be noticed retrospectively. One caveat worth
 * knowing: it is durable in the *fresh* database, so a subsequent quarantine would move it
 * aside along with everything else.
 */
export function enqueueQuarantineAlert(
  outbox: QuarantineAlertSink,
  opened: QuarantineOutcome,
  nowMs: number,
): StrakerEnqueueResult | null {
  if (!opened.recoveredFromCorruption) return null;
  const { corruptCopyPath } = opened;
  return outbox.enqueue(
    `db_quarantined:${basename(corruptCopyPath)}`,
    'alerts',
    JSON.stringify({
      // A `system` alert, in the notifier's own shape. It was `kind: 'db_quarantined'`
      // with no `condition` and no `occurredAtMs` — which the alerts sender refuses on its
      // first line, so the row was queued, retried and dead-lettered. Silently, and on the
      // one alert that must never be lost.
      kind: 'system',
      condition: 'db_quarantined',
      subsystem: `Straker state file (${basename(corruptCopyPath)})`,
      occurredAtMs: nowMs,
      // A quarantine is one event, not a streak — but the system card carries a count and
      // a span, so it says so honestly rather than leaving the fields to be invented.
      consecutiveFailures: 1,
      failingSinceMs: nowMs,
      corruptCopyPath,
      heldWorkLost: true,
      detail:
        'the Straker state file was unusable and has been moved aside; the record of work ' +
        'the team already holds went with it, so the daily ceiling now reads as zero ' +
        'committed capacity and every offer will fit until reconciliation restores the ' +
        'held set. Check the quarantined copy before restarting.',
    }),
    nowMs,
  );
}

/**
 * Columns added to a table that already exists. `CREATE TABLE IF NOT EXISTS` leaves an older
 * table exactly as it was, so a new column has to be added explicitly — and idempotently,
 * because `migrate` runs on every open.
 *
 * The default is what makes this safe on the live database: every row held before 2026-09-17
 * predates DTP support and was translation work, so `'translation'` is not a guess.
 */
function addMissingColumns(db: StrakerDB): void {
  const columnsOf = (table: string): string[] =>
    (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
  if (!columnsOf('held_work').includes('kind')) {
    db.exec(
      "ALTER TABLE held_work ADD COLUMN kind TEXT NOT NULL DEFAULT 'translation' " +
        "CHECK (kind IN ('translation', 'monolingual'))",
    );
  }
  // The work identity (2026-09-22). Nullable with no default: a row written before it has
  // no job reference to record, and inventing one would join unrelated work.
  for (const table of ['held_work', 'offer_events']) {
    const present = columnsOf(table);
    for (const column of IDENTITY_COLUMNS) {
      if (!present.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_held_work_key ON held_work (work_key)');
}

const IDENTITY_COLUMNS = ['work_key', 'job_ref', 'title', 'service'] as const;

interface IdentityColumns {
  work_key: string | null;
  job_ref: string | null;
  title: string | null;
  service: string | null;
}

/** The identity a row carries, or undefined when it carries none at all. */
function identityOf(r: IdentityColumns): WorkIdentity | undefined {
  if (r.work_key === null && r.job_ref === null && r.title === null && r.service === null) {
    return undefined;
  }
  return { jobRef: r.job_ref, title: r.title, service: r.service, workKey: r.work_key };
}

function withIdentity(r: IdentityColumns): { identity?: WorkIdentity } {
  const identity = identityOf(r);
  return identity === undefined ? {} : { identity };
}

function identityParams(identity: WorkIdentity | undefined): (string | null)[] {
  return [
    identity?.workKey ?? null,
    identity?.jobRef ?? null,
    identity?.title ?? null,
    identity?.service ?? null,
  ];
}

function migrate(db: StrakerDB): void {
  db.exec(ddl());
  addMissingColumns(db);
  assertVocabularyCovered(db);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * Fail loud when the stored CHECK constraints no longer cover the vocabulary this build
 * uses — for **every** table whose CHECKs come from one. `CREATE TABLE IF NOT EXISTS`
 * leaves an older table exactly as it was, so without this check a newly added outcome,
 * skip reason, channel or status would pass every test on a fresh database and then be
 * rejected by the one database that matters. Checking only some of the tables is the same
 * defect with a smaller blast radius, which is why this reads the whole table above.
 */
function assertVocabularyCovered(db: StrakerDB): void {
  const storedSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?");

  for (const [table, columns] of Object.entries(VOCABULARY_CHECKS)) {
    const row = storedSql.get(table) as { sql: string } | undefined;
    if (!row) throw new StrakerSchemaError(`${table} table missing after migration`);

    const vocabulary: readonly string[] = Object.values(columns).flat();
    const missing = vocabulary.filter((value) => !row.sql.includes(`'${value}'`));
    if (missing.length > 0) {
      throw new StrakerSchemaError(
        `${table} was created before the vocabulary gained ${missing.join(', ')} — ` +
          'the stored CHECK constraints would reject those values. Rebuild the table ' +
          '(SQLite cannot alter a CHECK in place) before deploying.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/** A sighting as stored: the shared `OfferSighting` plus the moment it was first missed.
 *  `lifetimeMs` is deliberately NOT a column — it is `lastSeenAtMs − firstSeenAtMs`, and a
 *  stored copy of a derivable number is a copy that can disagree with its source. */
export interface StoredSighting extends OfferSighting {
  /** First check at which the offer was gone; null while it is still listed. The true
   *  disappearance lies in `(lastSeenAtMs, notFoundAtMs]`, one poll interval wide. */
  readonly notFoundAtMs: number | null;
}

/** Every event names its offer and when it happened. Deduplicated on `objId` + `eventType`
 *  (FR-014): one offer legitimately produces several, and identity alone would collapse them. */
interface OfferEventCommon {
  readonly objId: string;
  readonly occurredAtMs: number;
}

/** The two numbers the decision was made on, carried by the events that had a decision to
 *  make. Null when the payload carried none — itself a skip reason that alerts (FR-023a),
 *  never a value to invent. */
interface OfferEventWork {
  readonly effortWords: number | null;
  readonly deadlineMs: number | null;
}

/** A claim, or the reconciliation that later settled one. Both say what it produced. */
export interface ClaimEvent extends OfferEventCommon, OfferEventWork {
  readonly eventType: 'claim' | 'recovery';
  readonly outcome: ClaimOutcome;
  /** What names the work across its stages; optional, and never erased once recorded. */
  readonly identity?: WorkIdentity;
}

/** An offer passed over, and the rule that passed it over (FR-010). */
export interface SkipEvent extends OfferEventCommon {
  readonly eventType: 'skip';
  readonly skipReason: SkipReason;
}

/** The offer was listed. No outcome and no reason — a note that it existed. */
export interface SightingEvent extends OfferEventCommon, OfferEventWork {
  readonly eventType: 'sighting';
}

/**
 * One recorded event about one offer.
 *
 * A union rather than one flat record, because the table has enforced exactly this since
 * the first migration and the type did not:
 *
 * ```sql
 * CHECK ((outcome IS NOT NULL)     = (event_type IN ('claim', 'recovery')))
 * CHECK ((skip_reason IS NOT NULL) = (event_type = 'skip'))
 * ```
 *
 * With `outcome` and `skipReason` nullable on every variant, a skip carrying `won` — or a
 * claim carrying no outcome at all — compiled, and then threw `SQLITE_CONSTRAINT` at the
 * write. That write is the one inside the per-claim transaction, *after* the portal has
 * irreversibly committed the work: the worst possible moment to find out. The union moves
 * the same rule to the compiler, where it costs nothing and fires before the claim.
 */
export type OfferEvent = ClaimEvent | SkipEvent | SightingEvent;

/**
 * The four nullable columns, derived from the variant instead of being carried by all of
 * them. This is the only place the flat row shape is reconstructed, and it is exhaustive:
 * a new event type added to {@link OFFER_EVENT_TYPES} without a variant here fails to
 * compile rather than silently writing nulls.
 */
function eventColumns(event: OfferEvent): {
  readonly outcome: ClaimOutcome | null;
  readonly skipReason: SkipReason | null;
  readonly effortWords: number | null;
  readonly deadlineMs: number | null;
} {
  if (event.eventType === 'skip') {
    return { outcome: null, skipReason: event.skipReason, effortWords: null, deadlineMs: null };
  }
  const work = { effortWords: event.effortWords, deadlineMs: event.deadlineMs };
  if (event.eventType === 'sighting') return { outcome: null, skipReason: null, ...work };
  return { outcome: event.outcome, skipReason: null, ...work };
}

/** Work the team holds on this portal — the ledger's only source (data-model §5). */
/** Which daily budget a piece of held work is charged to. */
export const WORK_KINDS = ['translation', 'monolingual'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export interface HeldWork {
  readonly objId: string;
  readonly effortWords: number;
  /** `monolingual` is DTP preparation and similar: measured in words, but not translation. */
  readonly kind: WorkKind;
  /** Null only when the work was recovered without a readable deadline; such rows cannot
   *  be bucketed and are surfaced by the ledger rather than silently dropped. */
  readonly deadlineMs: number | null;
  readonly heldSinceMs: number;
  readonly releasedAtMs: number | null;
  /**
   * The key tying this work to its purchase order and assigned job, and the fields people
   * read it by (2026-09-22). Absent on rows that never had one.
   */
  readonly identity?: WorkIdentity;
}

export type NewHold = Omit<HeldWork, 'releasedAtMs'>;

/** The claim made on a work key, as `claimEventByWorkKey` finds it. */
export interface ClaimOnWorkKey {
  readonly objId: string;
  readonly outcome: ClaimOutcome;
  readonly effortWords: number | null;
  readonly deadlineMs: number | null;
  readonly occurredAtMs: number;
  readonly identity: WorkIdentity;
}

interface SightingRow {
  obj_id: string;
  sighting: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  not_found_at_ms: number | null;
}

interface EventRow extends IdentityColumns {
  obj_id: string;
  event_type: OfferEventType;
  outcome: ClaimOutcome | null;
  skip_reason: SkipReason | null;
  effort_words: number | null;
  deadline_ms: number | null;
  occurred_at_ms: number;
}

interface HeldRow extends IdentityColumns {
  obj_id: string;
  effort_words: number;
  kind: WorkKind;
  deadline_ms: number | null;
  held_since_ms: number;
  released_at_ms: number | null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class StrakerStore {
  constructor(private readonly db: StrakerDB) {}

  /** Run `fn` inside one Straker transaction. It can never span the XTM database: that is
   *  a different file on a different connection, which is the whole point of R11. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- sightings (data-model §2) -------------------------------------------

  /** Record or refresh the current sighting of an offer. A re-appearance arrives with the
   *  next `sighting` number from the tracker and lands in its own row, so the appearance
   *  history is kept rather than overwritten. */
  recordSighting(offer: OfferSighting): void {
    const objId = requireIdentity(offer.objId, 'a sighting');
    this.db
      .prepare(
        `INSERT INTO offer_sightings (obj_id, sighting, first_seen_at_ms, last_seen_at_ms, not_found_at_ms)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (obj_id, sighting) DO UPDATE SET
           last_seen_at_ms = MAX(last_seen_at_ms, excluded.last_seen_at_ms)`,
      )
      .run(objId, offer.sighting, offer.firstSeenAtMs, offer.lastSeenAtMs);
  }

  /**
   * Close a sighting: the offer was no longer listed at `notFoundAtMs`.
   *
   * Returns whether an appearance was actually closed, as `release` does — but read the
   * false differently. For `release`, false means "nothing left to release", the ordinary
   * result of a second reconciliation pass. Here it means the tracker is ending an
   * appearance the store never recorded: the two have diverged, and the caller is the only
   * thing in a position to alert on that. Updating no rows and returning nothing would
   * leave the divergence with no way at all to be noticed.
   */
  endSighting(offer: EndedOfferSighting): boolean {
    const objId = requireIdentity(offer.objId, 'an ended sighting');
    const res = this.db
      .prepare(
        `UPDATE offer_sightings
            SET not_found_at_ms = ?, last_seen_at_ms = MAX(last_seen_at_ms, ?)
          WHERE obj_id = ? AND sighting = ?`,
      )
      .run(offer.notFoundAtMs, offer.lastSeenAtMs, objId, offer.sighting);
    return res.changes > 0;
  }

  /** Sightings still open — the offers believed to be listed right now. */
  liveSightings(): StoredSighting[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM offer_sightings WHERE not_found_at_ms IS NULL
          ORDER BY first_seen_at_ms, obj_id`,
      )
      .all() as SightingRow[];
    return rows.map(toSighting);
  }

  /**
   * The tracker's state, rebuilt from these rows — what a restarting bot resumes from.
   *
   * The in-memory tracker and this table are twins: every row is keyed `(obj_id, sighting)`
   * and the sighting number is the tracker's own count. Boot the tracker empty and the
   * count restarts at 1 for an offer already stored at 2, so the next `recordSighting`
   * does not open a new appearance — it reaches back into a **closed** one and pushes its
   * `last_seen_at_ms` past the `not_found_at_ms` beside it, a row that cannot be true. The
   * appearance that really was open is then never closed by anything, because the tracker
   * no longer knows it exists. SC-000's whole measurement is these rows, and a restart
   * mid-day is ordinary — a deploy is one.
   *
   * Two queries because the tracker needs two different things: which appearances are open
   * *now*, and how many times each offer has ever appeared. The second must count closed
   * appearances too, or an offer that vanished before the restart and came back after it
   * would be numbered 1 again, straight on top of its own history.
   */
  trackerState(): TrackerState {
    const live = this.liveSightings().map(
      (s): TrackedOffer => ({
        objId: s.objId,
        firstSeenAtMs: s.firstSeenAtMs,
        lastSeenAtMs: s.lastSeenAtMs,
        sighting: s.sighting,
      }),
    );
    const counts = this.db
      .prepare('SELECT obj_id, MAX(sighting) AS n FROM offer_sightings GROUP BY obj_id')
      .all() as { obj_id: string; n: number }[];
    return {
      live,
      sightingsByObjId: counts.map((row): readonly [string, number] => [row.obj_id, row.n]),
    };
  }

  /** Every sighting of one offer, oldest first. */
  sightingsOf(objId: string): StoredSighting[] {
    const rows = this.db
      .prepare('SELECT * FROM offer_sightings WHERE obj_id = ? ORDER BY sighting')
      .all(requireIdentity(objId, 'a sighting lookup')) as SightingRow[];
    return rows.map(toSighting);
  }

  // --- outcome rows (FR-014, data-model §3/§4) ------------------------------

  /**
   * Upsert one event. Re-running a cycle updates the row in place rather than adding a
   * second one (Constitution VII), while a different event type for the same offer is a
   * row of its own.
   *
   * The upsert stops short of one thing: replacing a **settled** claim outcome with a
   * different one throws `OutcomeOverwriteError` rather than writing it. Everything a
   * re-run legitimately revises still goes through — effort, deadline, timing, a skip
   * reason that changed with the hour, and the resolution of an outcome left `unknown`,
   * which is precisely what reconciliation is for (FR-016a/b). What is refused is the one
   * write that destroys the record of an irreversible act.
   */
  recordEvent(event: OfferEvent): void {
    const objId = requireIdentity(event.objId, `a ${event.eventType} event`);
    const cols = eventColumns(event);
    // Read and write in one transaction so the guard cannot be stepped over by a write
    // landing between the two. Nested inside a caller's transaction this becomes a
    // savepoint, so a cycle-wide rollback still takes it with it.
    this.db.transaction(() => {
      const stored = this.db
        .prepare('SELECT outcome FROM offer_events WHERE obj_id = ? AND event_type = ?')
        .get(objId, event.eventType) as { outcome: ClaimOutcome | null } | undefined;

      if (stored !== undefined && isSettled(stored.outcome) && stored.outcome !== cols.outcome) {
        throw new OutcomeOverwriteError(objId, event.eventType, stored.outcome, cols.outcome);
      }

      this.db
        .prepare(
          `INSERT INTO offer_events
             (obj_id, event_type, outcome, skip_reason, effort_words, deadline_ms, occurred_at_ms,
              work_key, job_ref, title, service)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (obj_id, event_type) DO UPDATE SET
             outcome = excluded.outcome,
             skip_reason = excluded.skip_reason,
             effort_words = excluded.effort_words,
             deadline_ms = excluded.deadline_ms,
             occurred_at_ms = excluded.occurred_at_ms,
             work_key = COALESCE(excluded.work_key, offer_events.work_key),
             job_ref = COALESCE(excluded.job_ref, offer_events.job_ref),
             title = COALESCE(excluded.title, offer_events.title),
             service = COALESCE(excluded.service, offer_events.service)`,
        )
        .run(
          objId,
          event.eventType,
          cols.outcome,
          cols.skipReason,
          cols.effortWords,
          cols.deadlineMs,
          event.occurredAtMs,
          ...identityParams(
            event.eventType === 'skip' || event.eventType === 'sighting'
              ? undefined
              : event.identity,
          ),
        );
    })();
  }

  /** Every event recorded about one offer. */
  eventsOf(objId: string): OfferEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM offer_events WHERE obj_id = ? ORDER BY occurred_at_ms, event_type')
      .all(requireIdentity(objId, 'an event lookup')) as EventRow[];
    return rows.map(toEvent);
  }

  /**
   * Every offer identity a claim has already been attempted against, whatever it produced.
   *
   * This is what lets the cycle honour R7 **across** cycles. `claim.ts` refuses to retry
   * within the one call it is given, and a compile-time lock keeps it that way — but FR-019c
   * says a claim is never retried "at all, **at any interval**", and a poll interval is an
   * interval. An offer whose claim came back `unknown` is still listed on the portal
   * precisely because nobody knows whether it landed; re-claiming it is how "we do not know"
   * becomes "we may have committed twice".
   *
   * Outcome is deliberately not filtered. A `failed` claim is not retried either (R7): the
   * blind retry of an irreversible action is the thing being forbidden, not one outcome of
   * it. Reconciliation against the portal settles what actually happened (FR-016a).
   *
   * Returned as a Set and read once per cycle, so the question costs one query rather than
   * one per offer.
   */
  claimedObjIds(): Set<string> {
    const rows = this.db
      .prepare("SELECT obj_id FROM offer_events WHERE event_type = 'claim'")
      .all() as { obj_id: string }[];
    return new Set(rows.map((r) => r.obj_id));
  }

  /** Every event, oldest first — the tracking record's source. */
  listEvents(window?: { readonly fromMs: number; readonly toMs: number }): OfferEvent[] {
    // The window is applied in SQL rather than by the caller, because the caller that needs it
    // runs inside the XTM bot's 09:00 report: `combinedSummary` wants fourteen days and would
    // otherwise build an `OfferEvent` object for every event ever written in order to discard
    // most of them.
    //
    // **The saving is in that object construction, not in the scan.** There is no index on
    // `occurred_at_ms`, so SQLite reads the table either way; claiming otherwise would invite
    // someone to trust a bound that is not enforced by an index. At 2-3 offers a day the real
    // figure is small, which is also why `winRateReport.ts` is left unbounded — a command run by
    // hand wants the whole record anyway.
    //
    // Half-open to match `WinRateWindow`, so two adjacent windows cannot count one event twice.
    const rows =
      window === undefined
        ? (this.db
            .prepare('SELECT * FROM offer_events ORDER BY occurred_at_ms, obj_id, event_type')
            .all() as EventRow[])
        : (this.db
            .prepare(
              `SELECT * FROM offer_events WHERE occurred_at_ms >= ? AND occurred_at_ms < ?
                ORDER BY occurred_at_ms, obj_id, event_type`,
            )
            .all(window.fromMs, window.toMs) as EventRow[]);
    return rows.map(toEvent);
  }

  // --- held work (data-model §5) -------------------------------------------

  /**
   * Hold work against an offer identity. Idempotent: holding the same offer twice leaves
   * one row, which is what makes a re-run after a crash converge instead of double
   * counting the ceiling. Re-holding work that was released (the portal still lists it as
   * ours) re-opens the original row rather than starting a second one.
   */
  hold(work: NewHold): void {
    const objId = requireIdentity(work.objId, 'held work');
    this.db
      .prepare(
        `INSERT INTO held_work
           (obj_id, effort_words, deadline_ms, held_since_ms, released_at_ms, kind,
            work_key, job_ref, title, service)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT (obj_id) DO UPDATE SET
           effort_words = excluded.effort_words,
           deadline_ms = excluded.deadline_ms,
           kind = excluded.kind,
           released_at_ms = NULL,
           work_key = COALESCE(excluded.work_key, held_work.work_key),
           job_ref = COALESCE(excluded.job_ref, held_work.job_ref),
           title = COALESCE(excluded.title, held_work.title),
           service = COALESCE(excluded.service, held_work.service)`,
      )
      .run(
        objId,
        work.effortWords,
        work.deadlineMs,
        work.heldSinceMs,
        work.kind,
        ...identityParams(work.identity),
      );
  }

  /**
   * Fill in the identity of held work that lacks one — work held before identities were
   * recorded, matched later by its own id. Never overwrites a value already there. Answers
   * whether a row was touched.
   */
  backfillHeldIdentity(objId: string, identity: WorkIdentity): boolean {
    const res = this.db
      .prepare(
        `UPDATE held_work SET
           work_key = COALESCE(work_key, ?),
           job_ref = COALESCE(job_ref, ?),
           title = COALESCE(title, ?),
           service = COALESCE(service, ?)
         WHERE obj_id = ?`,
      )
      .run(...identityParams(identity), requireIdentity(objId, 'an identity backfill'));
    return res.changes > 0;
  }

  /**
   * The latest claim made on a work key, or null. How reconciliation settles a claim that
   * came back `unknown` once its purchase order turns up, and learns the effort a purchase
   * order does not carry.
   */
  claimEventByWorkKey(key: string): ClaimOnWorkKey | null {
    const row = this.db
      .prepare(
        `SELECT * FROM offer_events WHERE work_key = ? AND event_type = 'claim'
         ORDER BY occurred_at_ms DESC LIMIT 1`,
      )
      .get(key) as EventRow | undefined;
    if (row === undefined || row.outcome === null) return null;
    return {
      objId: row.obj_id,
      outcome: row.outcome,
      effortWords: row.effort_words,
      deadlineMs: row.deadline_ms,
      occurredAtMs: row.occurred_at_ms,
      identity: identityOf(row) ?? { jobRef: null, title: null, service: null, workKey: key },
    };
  }

  /**
   * The largest effort any claim without a work key was weighed at for this deadline, or null.
   * Only for adopting purchase orders once, for claims won before identities were recorded:
   * a purchase order carries no word count, and the largest is the side that cannot
   * under-count the day.
   */
  legacyClaimEffortByDeadline(deadlineMs: number): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(effort_words) AS effort FROM offer_events
         WHERE event_type = 'claim' AND outcome IN ('won', 'unknown')
           AND work_key IS NULL AND deadline_ms = ?`,
      )
      .get(deadlineMs) as { effort: number | null } | undefined;
    return row?.effort ?? null;
  }

  /** When a one-time step was done, or null while it has not been. */
  metaFlagSetAt(key: string): number | null {
    const row = this.db
      .prepare('SELECT value FROM straker_meta WHERE key = ?')
      .get(requireIdentity(key, 'a meta flag')) as { value: string } | undefined;
    if (row === undefined) return null;
    const ms = Number(row.value);
    return Number.isFinite(ms) ? ms : null;
  }

  /** Mark a one-time step done. True only the first time. */
  setMetaFlag(key: string, atMs: number): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO straker_meta (key, value, updated_at_ms) VALUES (?, ?, ?)
         ON CONFLICT (key) DO NOTHING`,
      )
      .run(requireIdentity(key, 'a meta flag'), String(atMs), atMs);
    return res.changes > 0;
  }

  /**
   * The work is finished (or is no longer ours): drop it out of the held set. Returns
   * false when there was nothing open to release, so a repeated reconciliation pass is a
   * no-op rather than an error. **This is what returns the budget** — the ledger sums the
   * held set on every read, so nothing else has to be told.
   */
  release(objId: string, atMs: number): boolean {
    const res = this.db
      .prepare(
        'UPDATE held_work SET released_at_ms = ? WHERE obj_id = ? AND released_at_ms IS NULL',
      )
      .run(atMs, requireIdentity(objId, 'a release'));
    return res.changes > 0;
  }

  /**
   * When the portal barred this account, or null while it has not (T073, contract §4a).
   *
   * Durable on purpose. The previous flag lived in one `runOnce()`, so "stop claiming"
   * lasted ten seconds and the bot went back to a portal that had already refused — which
   * is how a suspension becomes permanent rather than temporary.
   */
  barredSinceMs(): number | null {
    const row = this.db
      .prepare(`SELECT value FROM straker_meta WHERE key = '${BARRED_KEY}'`)
      .get() as { value: string } | undefined;
    if (row === undefined) return null;
    const ms = Number(row.value);
    return Number.isFinite(ms) ? ms : null;
  }

  /**
   * Record that the portal barred this account. Answers **true only the first time**, so
   * the caller can alert on the discovery rather than on every cycle that finds it still
   * true — a condition that does not self-heal must not page on a ten-second rhythm.
   */
  barAccount(atMs: number): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO straker_meta (key, value, updated_at_ms) VALUES ('${BARRED_KEY}', ?, ?)
         ON CONFLICT (key) DO NOTHING`,
      )
      .run(String(atMs), atMs);
    return res.changes > 0;
  }

  /**
   * Lift the bar. **Nothing in the bot calls this** — it is `npm run straker:unbar`, and
   * that is the decision T073 left open rather than an omission.
   *
   * A successful sign-in is the obvious automatic trigger and is the wrong one: an account
   * can be signed in and barred at the same time, so clearing on sign-in would resume
   * claiming against a portal that never stopped refusing. Every other observable signal
   * has the same defect, because the bot cannot see the thing that actually changed — a
   * human at the other end deciding the account may claim again. So a human clears it.
   */
  clearBar(): boolean {
    const res = this.db.prepare(`DELETE FROM straker_meta WHERE key = '${BARRED_KEY}'`).run();
    return res.changes > 0;
  }

  /** The work the team currently holds. Released rows are excluded by definition. */
  heldWork(): HeldWork[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM held_work WHERE released_at_ms IS NULL ORDER BY held_since_ms, obj_id',
      )
      .all() as HeldRow[];
    return rows.map((r) => ({
      objId: r.obj_id,
      effortWords: r.effort_words,
      kind: r.kind,
      deadlineMs: r.deadline_ms,
      heldSinceMs: r.held_since_ms,
      releasedAtMs: r.released_at_ms,
      ...withIdentity(r),
    }));
  }
}

/**
 * The one place an offer identity becomes a storage key — for reads exactly as much as for
 * writes.
 *
 * That "exactly as much" is the point. A key normalised on the way in and taken raw on the
 * way out is a mismatch that nothing reports: `hold(' abc ')` would store `abc`,
 * `release(' abc ')` would match no row and answer false — which its own docstring defines
 * as "nothing to release, which is normal" — and the work would stay held forever,
 * consuming that deadline day's ceiling with no signal anywhere.
 *
 * Normalising rather than rejecting an untrimmed identifier is deliberate. `hold` and
 * `recordEvent` run **after** the portal has committed the work to the team (FR-003,
 * FR-016d), so a boundary that refused padded input would throw on the one path that
 * cannot afford to fail: the team would own work that appears in no record and counts
 * against no ceiling — the exact failure FR-016a exists to repair, caused by the code
 * meant to prevent it. Whitespace around an opaque identifier carries no meaning worth
 * that price, and two portal identifiers differing only in padding are the same offer by
 * any reading.
 *
 * A **blank** identity is a different matter and stays a hard failure on every path: there
 * is no identity there to normalise, and an offer we cannot name is one we cannot
 * deduplicate, reconcile, or hold against a ceiling.
 */
function requireIdentity(objId: string, what: string): string {
  const trimmed = objId.trim();
  if (trimmed === '') throw new MissingOfferIdentityError(what);
  return trimmed;
}

/**
 * Whether a stored outcome is an answer rather than an open question. `unknown` is the one
 * that is not: the request produced no answer and reconciliation is expected to supply one
 * later (data-model §3), so replacing it loses nothing. Everything else has been decided.
 */
function isSettled(outcome: ClaimOutcome | null): outcome is ClaimOutcome {
  return outcome !== null && outcome !== 'unknown';
}

function toSighting(r: SightingRow): StoredSighting {
  return {
    objId: r.obj_id,
    sighting: r.sighting,
    firstSeenAtMs: r.first_seen_at_ms,
    lastSeenAtMs: r.last_seen_at_ms,
    notFoundAtMs: r.not_found_at_ms,
  };
}

/**
 * One stored row back into the variant it belongs to.
 *
 * The two throws can only fire against a row the table's own CHECKs would have refused —
 * a database written by an older build, or edited by hand. Reading such a row as a valid
 * event of the other kind is how a claim with no recorded outcome becomes indistinguishable
 * from an offer nobody claimed, so it fails loud instead.
 */
function toEvent(r: EventRow): OfferEvent {
  const common = { objId: r.obj_id, occurredAtMs: r.occurred_at_ms };
  if (r.event_type === 'skip') {
    if (r.skip_reason === null) {
      throw new StrakerSchemaError(
        `offer ${r.obj_id}: a stored skip row names no reason — the table's CHECK would have ` +
          'refused it, so this database was not written by this schema',
      );
    }
    return { ...common, eventType: 'skip', skipReason: r.skip_reason };
  }
  const work = { effortWords: r.effort_words, deadlineMs: r.deadline_ms };
  if (r.event_type === 'sighting') return { ...common, eventType: 'sighting', ...work };
  if (r.outcome === null) {
    throw new StrakerSchemaError(
      `offer ${r.obj_id}: a stored ${r.event_type} row carries no outcome — the claim behind ` +
        'it cannot be taken back, and a row that does not say what it produced cannot be read ' +
        'as one that produced nothing',
    );
  }
  return { ...common, eventType: r.event_type, outcome: r.outcome, ...work };
}
