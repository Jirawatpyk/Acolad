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
import { openSqliteWithQuarantine } from '../shared/sqliteOpen.js';
import { STRAKER_OUTBOX_CHANNELS, STRAKER_OUTBOX_STATUSES } from './outbox.js';
import { CLAIM_OUTCOMES, SKIP_REASONS } from './outcomePolicy.js';
import type { ClaimOutcome, EndedOfferSighting, OfferSighting, SkipReason } from './types.js';

export type StrakerDB = Database.Database;

/** Straker's database file. Deliberately NOT `acolad.db`: two bots pointed at one
 *  directory by a bad deploy must still open two different files. */
export const STRAKER_DB_FILENAME = 'straker.db';

const SCHEMA_VERSION = 1;

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
  released_at_ms INTEGER
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

export interface OpenStrakerDbResult {
  readonly db: StrakerDB;
  /** The file actually opened. Returned rather than implied, so a caller — and the
   *  isolation test — can assert which file this store touched. */
  readonly path: string;
  /** True when the previous file was unusable and was quarantined; the caller treats
   *  this as a cold start plus an alert. */
  readonly recoveredFromCorruption: boolean;
  /** Absent — not present-and-undefined — when nothing was quarantined. */
  readonly corruptCopyPath?: string | undefined;
}

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
  });
}

function migrate(db: StrakerDB): void {
  db.exec(ddl());
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

/** One recorded event about one offer. Deduplicated on `objId` + `eventType` (FR-014). */
export interface OfferEvent {
  readonly objId: string;
  readonly eventType: OfferEventType;
  /** Set for `claim` and `recovery`, null otherwise. */
  readonly outcome: ClaimOutcome | null;
  /** Set for `skip`, null otherwise. */
  readonly skipReason: SkipReason | null;
  /** Raw word count (`STRAKER_EFFORT_UNIT`); null when the payload carried none — which
   *  is itself a skip reason that alerts (FR-023a), not a value to invent. */
  readonly effortWords: number | null;
  readonly deadlineMs: number | null;
  readonly occurredAtMs: number;
}

/** Work the team holds on this portal — the ledger's only source (data-model §5). */
export interface HeldWork {
  readonly objId: string;
  readonly effortWords: number;
  /** Null only when the work was recovered without a readable deadline; such rows cannot
   *  be bucketed and are surfaced by the ledger rather than silently dropped. */
  readonly deadlineMs: number | null;
  readonly heldSinceMs: number;
  readonly releasedAtMs: number | null;
}

export type NewHold = Omit<HeldWork, 'releasedAtMs'>;

interface SightingRow {
  obj_id: string;
  sighting: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  not_found_at_ms: number | null;
}

interface EventRow {
  obj_id: string;
  event_type: OfferEventType;
  outcome: ClaimOutcome | null;
  skip_reason: SkipReason | null;
  effort_words: number | null;
  deadline_ms: number | null;
  occurred_at_ms: number;
}

interface HeldRow {
  obj_id: string;
  effort_words: number;
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
    // Read and write in one transaction so the guard cannot be stepped over by a write
    // landing between the two. Nested inside a caller's transaction this becomes a
    // savepoint, so a cycle-wide rollback still takes it with it.
    this.db.transaction(() => {
      const stored = this.db
        .prepare('SELECT outcome FROM offer_events WHERE obj_id = ? AND event_type = ?')
        .get(objId, event.eventType) as { outcome: ClaimOutcome | null } | undefined;

      if (stored !== undefined && isSettled(stored.outcome) && stored.outcome !== event.outcome) {
        throw new OutcomeOverwriteError(objId, event.eventType, stored.outcome, event.outcome);
      }

      this.db
        .prepare(
          `INSERT INTO offer_events
             (obj_id, event_type, outcome, skip_reason, effort_words, deadline_ms, occurred_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (obj_id, event_type) DO UPDATE SET
             outcome = excluded.outcome,
             skip_reason = excluded.skip_reason,
             effort_words = excluded.effort_words,
             deadline_ms = excluded.deadline_ms,
             occurred_at_ms = excluded.occurred_at_ms`,
        )
        .run(
          objId,
          event.eventType,
          event.outcome,
          event.skipReason,
          event.effortWords,
          event.deadlineMs,
          event.occurredAtMs,
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

  /** Every event, oldest first — the tracking record's source. */
  listEvents(): OfferEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM offer_events ORDER BY occurred_at_ms, obj_id, event_type')
      .all() as EventRow[];
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
        `INSERT INTO held_work (obj_id, effort_words, deadline_ms, held_since_ms, released_at_ms)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (obj_id) DO UPDATE SET
           effort_words = excluded.effort_words,
           deadline_ms = excluded.deadline_ms,
           released_at_ms = NULL`,
      )
      .run(objId, work.effortWords, work.deadlineMs, work.heldSinceMs);
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
      deadlineMs: r.deadline_ms,
      heldSinceMs: r.held_since_ms,
      releasedAtMs: r.released_at_ms,
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

function toEvent(r: EventRow): OfferEvent {
  return {
    objId: r.obj_id,
    eventType: r.event_type,
    outcome: r.outcome,
    skipReason: r.skip_reason,
    effortWords: r.effort_words,
    deadlineMs: r.deadline_ms,
    occurredAtMs: r.occurred_at_ms,
  };
}
