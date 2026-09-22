/**
 * T007 — the Straker store: sightings, outcomes and the ledger's held-work source, in
 * Straker's OWN database file under its OWN state directory.
 *
 * The isolation tests here are deliberately not comments claiming a bulkhead exists. R11
 * says Straker may share no table, no file and no transaction with the live XTM bot, and
 * SC-005 says the XTM bot must be provably unchanged — so each of those three is asserted
 * against a REAL XTM database opened alongside, with real SQLite on a real temp directory.
 * A mocked store would prove nothing about which file got written.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../../src/state/db.js';
import { StrakerOutbox } from '../../../src/straker/outbox.js';
import { CLAIM_OUTCOMES, SKIP_REASONS } from '../../../src/straker/outcomePolicy.js';
import type { EndedOfferSighting, OfferSighting } from '../../../src/straker/types.js';
import {
  MissingOfferIdentityError,
  OutcomeOverwriteError,
  STRAKER_DB_FILENAME,
  StrakerSchemaError,
  StrakerStore,
  enqueueQuarantineAlert,
  isStrakerCorruption,
  openStrakerDatabase,
  type NewHold,
  type ClaimEvent,
  type OfferEvent,
  type QuarantineOutcome,
  type SightingEvent,
  type SkipEvent,
  type StrakerDB,
} from '../../../src/straker/strakerStore.js';

const NOW_MS = Date.parse('2026-09-14T10:00:00+07:00');

const roots: string[] = [];
const openDbs: StrakerDB[] = [];

/** A temp root holding an `xtm/` state dir and a `straker/` state dir side by side. */
function tempRoot(): { root: string; xtmDir: string; strakerDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'straker-store-'));
  roots.push(root);
  const xtmDir = join(root, 'xtm');
  const strakerDir = join(root, 'straker');
  mkdirSync(xtmDir, { recursive: true });
  mkdirSync(strakerDir, { recursive: true });
  return { root, xtmDir, strakerDir };
}

function freshStore(): { store: StrakerStore; db: StrakerDB; dir: string; path: string } {
  const { strakerDir } = tempRoot();
  const opened = openStrakerDatabase(strakerDir, NOW_MS);
  openDbs.push(opened.db);
  return { store: new StrakerStore(opened.db), db: opened.db, dir: strakerDir, path: opened.path };
}

/** Every table a database actually holds, ignoring SQLite's own internal ones. */
function tablesOf(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

/** Every file under `root`, as sorted relative paths — the "did anything appear?" probe. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relPath);
      else out.push(relPath);
    }
  };
  walk(root, '');
  return out.sort();
}

const sighting = (over: Partial<OfferSighting> = {}): OfferSighting => ({
  objId: 'e3b0c442-98fc-1c14-9afb-f4c8996fb924',
  sighting: 1,
  firstSeenAtMs: NOW_MS,
  lastSeenAtMs: NOW_MS,
  ...over,
});

const ended = (over: Partial<EndedOfferSighting> = {}): EndedOfferSighting => {
  const base = sighting(over);
  return {
    ...base,
    notFoundAtMs: NOW_MS + 90_000,
    lifetimeMs: base.lastSeenAtMs - base.firstSeenAtMs,
    ...over,
  };
};

/**
 * One builder per variant, because `OfferEvent` is a union: a claim carries an outcome and
 * a skip carries a reason, and neither can be handed the other's field. The single flat
 * builder this replaced could produce a skip with a `won` on it, which is exactly the row
 * the table has always refused and the type now refuses too.
 */
const OFFER_ID = 'e3b0c442-98fc-1c14-9afb-f4c8996fb924';
const DEADLINE_MS = Date.parse('2026-09-17T17:00:00+07:00');

const claimEvent = (over: Partial<ClaimEvent> = {}): ClaimEvent => ({
  objId: OFFER_ID,
  eventType: 'claim',
  outcome: 'won',
  effortWords: 1_200,
  deadlineMs: DEADLINE_MS,
  occurredAtMs: NOW_MS,
  ...over,
});

const skipEvent = (over: Partial<SkipEvent> = {}): SkipEvent => ({
  objId: OFFER_ID,
  eventType: 'skip',
  skipReason: 'ceiling_reached',
  occurredAtMs: NOW_MS,
  ...over,
});

const sightingEvent = (over: Partial<SightingEvent> = {}): SightingEvent => ({
  objId: OFFER_ID,
  eventType: 'sighting',
  effortWords: 1_200,
  deadlineMs: DEADLINE_MS,
  occurredAtMs: NOW_MS,
  ...over,
});

const hold = (over: Partial<NewHold> = {}): NewHold => ({
  objId: 'e3b0c442-98fc-1c14-9afb-f4c8996fb924',
  effortWords: 1_200,
  kind: 'translation',
  deadlineMs: Date.parse('2026-09-17T17:00:00+07:00'),
  heldSinceMs: NOW_MS,
  ...over,
});

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Isolation from the live XTM store (R11, FR-024, SC-005)
// ---------------------------------------------------------------------------

describe('isolation from the XTM store', () => {
  it('opens its own database file, named for itself, inside the state directory it was given', () => {
    const { strakerDir } = tempRoot();
    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(opened.db);

    expect(opened.path).toBe(join(strakerDir, STRAKER_DB_FILENAME));
    expect(STRAKER_DB_FILENAME).not.toBe('acolad.db');
    expect(filesUnder(strakerDir)).toContain(STRAKER_DB_FILENAME);
  });

  it('creates and touches no file outside its own state directory, the XTM one included', () => {
    const { root, xtmDir, strakerDir } = tempRoot();

    // A REAL XTM database, opened and migrated exactly as the live bot opens it.
    const xtm = openDatabase(xtmDir, new Date(NOW_MS).toISOString()).db;
    xtm.prepare("INSERT INTO meta (key, value) VALUES ('straker-isolation-marker', '1')").run();
    const xtmFilesBefore = filesUnder(xtmDir);
    const xtmMetaBefore = (xtm.prepare('SELECT COUNT(*) AS n FROM meta').get() as { n: number }).n;

    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(opened.db);
    const store = new StrakerStore(opened.db);
    store.recordSighting(sighting());
    store.recordEvent(claimEvent({ outcome: 'won' }));
    store.hold(hold());

    // Nothing new anywhere except under the Straker state directory.
    const appeared = filesUnder(root).filter((p) => !p.startsWith('xtm/'));
    expect(appeared.every((p) => p.startsWith('straker/'))).toBe(true);
    expect(filesUnder(xtmDir)).toEqual(xtmFilesBefore);
    expect(filesUnder(xtmDir)).not.toContain(STRAKER_DB_FILENAME);

    // And the XTM database's own contents are exactly as they were.
    expect((xtm.prepare('SELECT COUNT(*) AS n FROM meta').get() as { n: number }).n).toBe(
      xtmMetaBefore,
    );
    expect(
      xtm.prepare("SELECT value FROM meta WHERE key = 'straker-isolation-marker'").get(),
    ).toEqual({ value: '1' });
    xtm.close();
  });

  it('shares not one table name with the XTM database', () => {
    const { xtmDir, strakerDir } = tempRoot();
    const xtm = openDatabase(xtmDir, new Date(NOW_MS).toISOString()).db;
    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(opened.db);

    const xtmTables = tablesOf(xtm);
    const strakerTables = tablesOf(opened.db);

    expect(xtmTables).toContain('jobs'); // guards the guard: the XTM schema really is loaded
    expect(strakerTables.length).toBeGreaterThan(0);
    expect(strakerTables.filter((t) => xtmTables.includes(t))).toEqual([]);
    xtm.close();
  });

  it('rolls a failed transaction back within itself, leaving the XTM database untouched', () => {
    const { xtmDir, strakerDir } = tempRoot();
    const xtm = openDatabase(xtmDir, new Date(NOW_MS).toISOString()).db;
    xtm.prepare("INSERT INTO meta (key, value) VALUES ('straker-txn-marker', '1')").run();
    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(opened.db);
    const store = new StrakerStore(opened.db);

    expect(() =>
      store.transaction(() => {
        store.recordSighting(sighting());
        // recordEvent opens a transaction of its own to guard the outcome it is about to
        // overwrite. Nested, that must become a savepoint the outer rollback still takes
        // with it — otherwise the guard would either refuse to run inside a cycle or
        // commit a row the cycle abandoned.
        store.recordEvent(claimEvent({ outcome: 'won' }));
        store.hold(hold());
        throw new Error('cycle aborted');
      }),
    ).toThrow('cycle aborted');

    expect(store.liveSightings()).toEqual([]);
    expect(store.listEvents()).toEqual([]);
    expect(store.heldWork()).toEqual([]);
    expect(xtm.prepare("SELECT value FROM meta WHERE key = 'straker-txn-marker'").get()).toEqual({
      value: '1',
    });
    xtm.close();
  });

  it('never imports the XTM configuration or state layer, which is what keeps the bulkhead', () => {
    // The behavioural proof is above (which file was opened, and that nothing appeared
    // outside it). This is the structural backstop: an import of the XTM state or config
    // layer is how a future change would reach the other bot's database without anyone
    // meaning to. The quoted-literal check catches the XTM filename being named as a
    // value; prose mentioning it in a comment is not a defect.
    const source = readFileSync(
      fileURLToPath(new URL('../../../src/straker/strakerStore.ts', import.meta.url)),
      'utf8',
    );
    // Any specifier that reaches into the XTM state or config layer, however it is
    // spelled: '../state/db.js' and '../../src/state/db.js' are the same import, and a
    // guard that only knows the first reports green while checking nothing. (The ledger
    // test resolves specifiers properly; that is the form to hoist when these three
    // bulkhead guards get a shared home.)
    expect(source).not.toMatch(/(?:from|import)\s*\(?\s*['"][^'"]*(?:^|\/)(?:state|config)\//);
    expect(source).not.toMatch(/['"]acolad\.db['"]/);
  });
});

// ---------------------------------------------------------------------------
// Offer identity (data-model §2, R8)
// ---------------------------------------------------------------------------

describe('offer identity', () => {
  it('stores the portal identifier verbatim, never a key composed from other fields', () => {
    const { store } = freshStore();
    // Separators that a composed key would mangle; the XTM bot shipped a collision fix
    // (PR #22) precisely because its key was composed. Straker's never is.
    const awkward = 'a|b|c';
    store.recordSighting(sighting({ objId: awkward }));

    const [stored] = store.liveSightings();
    expect(stored?.objId).toBe(awkward);
  });

  it('keeps two offers apart on identity alone, even when every other value matches', () => {
    const { store } = freshStore();
    store.recordEvent(sightingEvent({ objId: 'offer-a' }));
    store.recordEvent(sightingEvent({ objId: 'offer-b' }));

    expect(store.listEvents()).toHaveLength(2);
  });

  it('treats a missing identity as a hard failure, not a skip', () => {
    const { store } = freshStore();

    expect(() => store.recordSighting(sighting({ objId: '' }))).toThrow(MissingOfferIdentityError);
    expect(() => store.recordEvent(sightingEvent({ objId: '   ' }))).toThrow(
      MissingOfferIdentityError,
    );
    expect(() => store.hold(hold({ objId: '' }))).toThrow(MissingOfferIdentityError);

    // A hard failure writes nothing — it does not half-record the entry it refused.
    expect(store.liveSightings()).toEqual([]);
    expect(store.listEvents()).toEqual([]);
    expect(store.heldWork()).toEqual([]);
  });

  it('finds the offer again under the identity it was handed, padding and all', () => {
    const { store } = freshStore();
    // The write paths normalise the identity before storing it. Every read path must
    // normalise by the same rule or the asymmetry is silent: `release` matches nothing and
    // answers false — which its own docstring defines as "nothing to release, which is
    // normal" — while the work stays held forever, consuming that deadline day's ceiling
    // with no signal anywhere.
    const padded = '  offer-1  ';
    store.recordSighting(sighting({ objId: padded }));
    store.recordEvent(claimEvent({ objId: padded, outcome: 'won' }));
    store.hold(hold({ objId: padded }));

    expect(store.sightingsOf(padded)).toHaveLength(1);
    expect(store.eventsOf(padded)).toHaveLength(1);
    expect(store.release(padded, NOW_MS + 1_000)).toBe(true);
    expect(store.heldWork()).toEqual([]);
  });

  it('answers to the trimmed spelling too, so one offer never becomes two', () => {
    const { store } = freshStore();
    store.recordSighting(sighting({ objId: ' offer-1 ' }));
    store.hold(hold({ objId: ' offer-1 ' }));

    expect(store.sightingsOf('offer-1')).toHaveLength(1);
    expect(store.release('offer-1', NOW_MS + 1_000)).toBe(true);
  });

  it('treats a blank identity as a hard failure on the read paths as well as the write ones', () => {
    const { store } = freshStore();

    expect(() => store.release('   ', NOW_MS)).toThrow(MissingOfferIdentityError);
    expect(() => store.sightingsOf('')).toThrow(MissingOfferIdentityError);
    expect(() => store.eventsOf(' ')).toThrow(MissingOfferIdentityError);
  });
});

// ---------------------------------------------------------------------------
// Sightings (data-model §2)
// ---------------------------------------------------------------------------

describe('sightings', () => {
  it('records a sighting and reads it back with its bounds', () => {
    const { store } = freshStore();
    store.recordSighting(sighting());

    expect(store.liveSightings()).toEqual([
      {
        objId: 'e3b0c442-98fc-1c14-9afb-f4c8996fb924',
        sighting: 1,
        firstSeenAtMs: NOW_MS,
        lastSeenAtMs: NOW_MS,
        notFoundAtMs: null,
      },
    ]);
  });

  it('moves the last-seen bound forward on a re-read without disturbing the first', () => {
    const { store } = freshStore();
    store.recordSighting(sighting());
    store.recordSighting(sighting({ lastSeenAtMs: NOW_MS + 30_000 }));

    const [stored] = store.liveSightings();
    expect(stored?.firstSeenAtMs).toBe(NOW_MS);
    expect(stored?.lastSeenAtMs).toBe(NOW_MS + 30_000);
    expect(store.sightingsOf(stored?.objId ?? '')).toHaveLength(1);
  });

  it('starts a fresh row when the same offer reappears, rather than overwriting the first', () => {
    const { store } = freshStore();
    store.recordSighting(sighting());
    store.endSighting(ended());
    store.recordSighting(sighting({ sighting: 2, firstSeenAtMs: NOW_MS + 600_000 }));

    expect(store.sightingsOf('e3b0c442-98fc-1c14-9afb-f4c8996fb924')).toHaveLength(2);
    expect(store.liveSightings().map((s) => s.sighting)).toEqual([2]);
  });

  it('keeps both lifetime bounds when a sighting ends, so a report can state the uncertainty', () => {
    const { store } = freshStore();
    store.recordSighting(sighting({ lastSeenAtMs: NOW_MS + 60_000 }));
    store.endSighting(ended({ lastSeenAtMs: NOW_MS + 60_000, notFoundAtMs: NOW_MS + 90_000 }));

    const [stored] = store.sightingsOf('e3b0c442-98fc-1c14-9afb-f4c8996fb924');
    expect(stored?.notFoundAtMs).toBe(NOW_MS + 90_000);
    // lower bound 60s (last seen), upper bound 90s (first missed) — one poll interval apart
    expect((stored?.lastSeenAtMs ?? 0) - (stored?.firstSeenAtMs ?? 0)).toBe(60_000);
    expect((stored?.notFoundAtMs ?? 0) - (stored?.firstSeenAtMs ?? 0)).toBe(90_000);
    expect(store.liveSightings()).toEqual([]);
  });

  it('says whether it actually closed a sighting, instead of updating nothing in silence', () => {
    const { store } = freshStore();
    store.recordSighting(sighting());

    expect(store.endSighting(ended())).toBe(true);
    // No such appearance: the tracker and the store have diverged, and the caller can only
    // alert on that if it is told. `release` returns a boolean for exactly this reason.
    expect(store.endSighting(ended({ sighting: 7 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Outcome rows (FR-014, V10, data-model §3/§4)
// ---------------------------------------------------------------------------

describe('outcome rows', () => {
  it('keeps a sighting, a claim and a recovery of one offer as three rows, not one', () => {
    const { store } = freshStore();
    const objId = 'offer-1';
    store.recordEvent(sightingEvent({ objId }));
    store.recordEvent(claimEvent({ objId, outcome: 'won' }));
    store.recordEvent(claimEvent({ objId, eventType: 'recovery', outcome: 'recovered' }));

    expect(
      store
        .eventsOf(objId)
        .map((e) => e.eventType)
        .sort(),
    ).toEqual(['claim', 'recovery', 'sighting']);
  });

  it('upserts on identity together with event type, so a re-run never duplicates a row', () => {
    const { store } = freshStore();
    store.recordEvent(claimEvent({ outcome: 'unknown' }));
    store.recordEvent(claimEvent({ outcome: 'won', occurredAtMs: NOW_MS + 5_000 }));

    const rows = store.listEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'won', occurredAtMs: NOW_MS + 5_000 });
  });

  it('refuses to overwrite a settled claim outcome with a different one', () => {
    const { store } = freshStore();
    store.recordEvent(claimEvent({ outcome: 'won' }));

    // The claim is the one irreversible act in this feature: the portal has committed the
    // work to the team. A later 'failed' silently replacing 'won' would leave no trace
    // that the work is ours — not in the row, not in a log, nowhere.
    expect(() =>
      store.recordEvent(claimEvent({ outcome: 'failed', occurredAtMs: NOW_MS + 5_000 })),
    ).toThrow(OutcomeOverwriteError);

    // and it says which two answers it could not reconcile, because a human has to
    expect(() => store.recordEvent(claimEvent({ outcome: 'failed' }))).toThrow(
      /won.*failed|failed.*won/s,
    );

    const [row] = store.listEvents();
    expect(row).toMatchObject({ outcome: 'won', occurredAtMs: NOW_MS });
  });

  it('still settles a claim that was left unresolved, which is what reconciliation does', () => {
    // 'unknown' is an open question rather than an answer (data-model §3), so resolving it
    // loses nothing. Refusing the resolution would strand every claim whose answer never
    // arrived — the exact case FR-016a exists to close.
    const { store } = freshStore();
    store.recordEvent(claimEvent({ outcome: 'unknown' }));
    store.recordEvent(claimEvent({ outcome: 'lost', occurredAtMs: NOW_MS + 5_000 }));

    expect(store.listEvents()[0]).toMatchObject({ outcome: 'lost' });
  });

  it('records the same outcome twice without complaint, so a re-run still converges', () => {
    const { store } = freshStore();
    store.recordEvent(claimEvent({ outcome: 'won' }));
    store.recordEvent(claimEvent({ outcome: 'won', occurredAtMs: NOW_MS + 5_000 }));

    const rows = store.listEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurredAtMs).toBe(NOW_MS + 5_000);
  });

  it('lets a skip be re-evaluated, because a skip reason legitimately changes between cycles', () => {
    // Nothing irreversible happened, and a skip carries the reason that applied this
    // cycle: a day that fills up turns 'outside_schedule' into 'ceiling_reached' with no
    // information lost.
    const { store } = freshStore();
    store.recordEvent(skipEvent({ skipReason: 'outside_schedule' }));
    store.recordEvent(skipEvent({ skipReason: 'ceiling_reached' }));

    expect(store.listEvents()[0]).toMatchObject({ skipReason: 'ceiling_reached' });
  });

  it('records a skip with the reason that blocked it, and no outcome at all', () => {
    const { store } = freshStore();
    store.recordEvent(skipEvent({ skipReason: 'ceiling_reached' }));

    const [row] = store.listEvents();
    expect(row).toEqual({
      objId: OFFER_ID,
      eventType: 'skip',
      skipReason: 'ceiling_reached',
      occurredAtMs: NOW_MS,
    });
    // `toEqual` above is exact, so this is the assertion that the reader does not hand back
    // an `outcome: null` the variant has no room for. A skip read as an event with a null
    // outcome is one `?? 'lost'` away from being counted as a race the team lost.
    expect(row).not.toHaveProperty('outcome');
  });

  it('still refuses a claim with no outcome, and a skip with no reason, at the table', () => {
    // The union makes both of these uncompilable, which is the point of it — but the
    // table's CHECKs are what protect a database this build did not write, and a cast is
    // one keystroke away. Cast through deliberately: two guards, not one moved.
    const { store } = freshStore();
    const write =
      (bad: unknown): (() => void) =>
      () => {
        store.recordEvent(bad as OfferEvent);
      };

    expect(write({ ...claimEvent(), outcome: null })).toThrow();
    expect(write({ ...skipEvent(), skipReason: null })).toThrow();
    expect(store.listEvents()).toEqual([]);
  });

  it('drops a field the variant has no room for rather than writing a contradictory row', () => {
    // The third combination behaves DIFFERENTLY from the two above, and the difference is
    // worth naming rather than smoothing over. `recordEvent` no longer copies fields off the
    // object — it derives the four nullable columns from the variant — so an `outcome`
    // smuggled onto a sighting is not rejected by the CHECK, it never reaches the statement.
    // The row stored is a valid sighting.
    //
    // That is the stronger guarantee, not a weaker one: the write cannot produce a
    // contradictory row even when the caller casts. What it is not is loud, so this test
    // exists to keep the silence the deliberate kind.
    const { store } = freshStore();

    store.recordEvent({ ...sightingEvent(), outcome: 'won' } as OfferEvent);

    const [row] = store.listEvents();
    expect(row?.eventType).toBe('sighting');
    expect(row).not.toHaveProperty('outcome');
    expect(store.claimedObjIds().has(OFFER_ID)).toBe(false);
  });

  it('accepts every outcome and every skip reason the shared vocabulary defines', () => {
    const { store } = freshStore();
    for (const outcome of CLAIM_OUTCOMES) {
      store.recordEvent(claimEvent({ objId: `outcome-${outcome}`, outcome }));
    }
    for (const reason of SKIP_REASONS) {
      store.recordEvent(skipEvent({ objId: `skip-${reason}`, skipReason: reason }));
    }

    expect(store.listEvents()).toHaveLength(CLAIM_OUTCOMES.length + SKIP_REASONS.length);
  });

  it('fails loud when the stored schema no longer covers the whole vocabulary', () => {
    const { strakerDir } = tempRoot();
    // A database whose CHECK constraints predate a vocabulary addition. Left undetected
    // this surfaces as an insert failing at 03:00; the open must name it instead.
    const stale = new Database(join(strakerDir, STRAKER_DB_FILENAME));
    stale.exec(`CREATE TABLE offer_events (
      obj_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('won', 'lost')),
      skip_reason TEXT,
      effort_words INTEGER,
      deadline_ms INTEGER,
      occurred_at_ms INTEGER NOT NULL,
      PRIMARY KEY (obj_id, event_type)
    )`);
    stale.close();

    expect(() => openStrakerDatabase(strakerDir, NOW_MS)).toThrow(/vocabulary|recovered/i);
  });
});

// ---------------------------------------------------------------------------
// Every CHECK generated from the shared vocabulary, and every one of them covered
// ---------------------------------------------------------------------------

describe('CHECK constraints generated from the shared vocabulary', () => {
  it('fails loud when a stale outbox table no longer covers every channel and status', () => {
    const { strakerDir } = tempRoot();
    // A database created before a channel and a status were added. `CREATE TABLE IF NOT
    // EXISTS` leaves it exactly as it was, so an uncovered table throws on first use — and
    // an enqueue throws inside the transaction it shares with the state change that
    // produced it, rolling that back too: a cycle that neither records nor announces.
    const stale = new Database(join(strakerDir, STRAKER_DB_FILENAME));
    stale.exec(`CREATE TABLE straker_outbox (
      outbox_id INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('offers', 'tracking')),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      sent_at_ms INTEGER
    )`);
    stale.close();

    let error: unknown;
    try {
      const opened = openStrakerDatabase(strakerDir, NOW_MS);
      openDbs.push(opened.db); // only reached while the table is uncovered
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(StrakerSchemaError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/straker_outbox/);
    expect(message).toMatch(/alerts/); // the channel the stored CHECK would reject
    expect(message).toMatch(/dead/); // and the status
  });

  it('puts a channel added to the shared vocabulary into a fresh database schema', async () => {
    // `ddl()` says its CHECK constraints are generated from the shared vocabulary "so a
    // value added cannot silently disagree with the schema". This executes that sentence:
    // the vocabulary gains a channel, and the schema a fresh database is created with must
    // accept it. A hand-typed list fails here — which is how a channel would otherwise
    // reach production missing from the CHECK and throw at the first enqueue.
    const { strakerDir } = tempRoot();
    const outboxModule = '../../../src/straker/outbox.js';
    vi.resetModules();
    vi.doMock(outboxModule, async () => {
      const actual = await vi.importActual<typeof import('../../../src/straker/outbox.js')>(
        '../../../src/straker/outbox.js',
      );
      return { ...actual, STRAKER_OUTBOX_CHANNELS: [...actual.STRAKER_OUTBOX_CHANNELS, 'digest'] };
    });
    try {
      const store = await import('../../../src/straker/strakerStore.js');
      const { StrakerOutbox } = await import('../../../src/straker/outbox.js');
      const opened = store.openStrakerDatabase(strakerDir, NOW_MS);
      openDbs.push(opened.db);

      expect(() =>
        new StrakerOutbox(opened.db).enqueue('offer-1:claim', 'digest' as 'offers', '{}', NOW_MS),
      ).not.toThrow();
    } finally {
      vi.doUnmock(outboxModule);
      vi.resetModules();
    }
  });
});

// ---------------------------------------------------------------------------
// Held work — the ledger's single source of truth (data-model §5)
// ---------------------------------------------------------------------------

describe('held work', () => {
  it('holds work against an offer identity, idempotently', () => {
    const { store } = freshStore();
    store.hold(hold());
    store.hold(hold());

    expect(store.heldWork()).toHaveLength(1);
    expect(store.heldWork()[0]?.effortWords).toBe(1_200);
    expect(store.heldWork()[0]?.releasedAtMs).toBeNull();
  });

  it('drops released work out of the held set, which is what returns its budget', () => {
    const { store } = freshStore();
    store.hold(hold());

    expect(store.release('e3b0c442-98fc-1c14-9afb-f4c8996fb924', NOW_MS + 3_600_000)).toBe(true);
    expect(store.heldWork()).toEqual([]);
    // Releasing what is not held is a no-op, never an error — reconciliation re-runs.
    expect(store.release('e3b0c442-98fc-1c14-9afb-f4c8996fb924', NOW_MS + 3_600_000)).toBe(false);
  });

  it('keeps held work across a restart, because a ceiling in memory is no ceiling', () => {
    const { strakerDir } = tempRoot();
    const first = openStrakerDatabase(strakerDir, NOW_MS);
    new StrakerStore(first.db).hold(hold());
    first.db.close();

    const second = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(second.db);
    expect(new StrakerStore(second.db).heldWork()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Durability (Constitution IV/VII)
// ---------------------------------------------------------------------------

describe('recovery from an unusable database file', () => {
  it('quarantines a corrupt file, starts fresh, and says that it did', () => {
    const { strakerDir } = tempRoot();
    writeFileSync(join(strakerDir, STRAKER_DB_FILENAME), 'this is not a database', 'utf8');

    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(opened.db);

    expect(opened.recoveredFromCorruption).toBe(true);
    expect(opened.recoveredFromCorruption && opened.corruptCopyPath).toMatch(
      /straker\.db\.corrupt-/,
    );
    expect(filesUnder(strakerDir).some((f) => f.startsWith('straker.db.corrupt-'))).toBe(true);
    expect(new StrakerStore(opened.db).listEvents()).toEqual([]);
  });
});

describe('claimedObjIds — what the cycle must not claim a second time (R7, FR-019c)', () => {
  it('names an offer once a claim has been attempted against it, whatever the outcome', () => {
    // R7 forbids retrying a claim "at all, at any interval" — and a poll interval is an
    // interval. The cycle needs one cheap question per pass to honour that across cycles,
    // because `claim.ts` can only refuse to retry within the single call it is given.
    const { store, db } = freshStore();

    for (const [objId, outcome] of [
      ['won', 'won'],
      ['lost', 'lost'],
      ['failed', 'failed'],
      ['unknown', 'unknown'],
    ] as const) {
      store.recordEvent({
        objId,
        eventType: 'claim',
        outcome,
        effortWords: 4,
        deadlineMs: NOW_MS,
        occurredAtMs: NOW_MS,
      });
    }

    expect([...store.claimedObjIds()].sort()).toEqual(['failed', 'lost', 'unknown', 'won']);
    db.close();
  });

  it('names an offer whose claim outcome is unknown, which is the case R7 exists for', () => {
    // `unknown` means the request may or may not have landed. A second attempt is the one
    // thing that turns "we do not know" into "we may have committed twice".
    const { store, db } = freshStore();
    store.recordEvent({
      objId: 'maybe',
      eventType: 'claim',
      outcome: 'unknown',
      effortWords: 4,
      deadlineMs: NOW_MS,
      occurredAtMs: NOW_MS,
    });

    expect(store.claimedObjIds().has('maybe')).toBe(true);
    db.close();
  });

  it('does not name an offer that was only seen or only skipped', () => {
    const { store, db } = freshStore();
    store.recordSighting({
      objId: 'seen',
      sighting: 1,
      firstSeenAtMs: NOW_MS,
      lastSeenAtMs: NOW_MS,
    });
    store.recordEvent({
      objId: 'skipped',
      eventType: 'skip',
      skipReason: 'ceiling_reached',
      occurredAtMs: NOW_MS,
    });

    expect([...store.claimedObjIds()]).toEqual([]);
    db.close();
  });

  it('is empty on a fresh database, so a cold start claims nothing it should not', () => {
    const { store, db } = freshStore();

    expect(store.claimedObjIds().size).toBe(0);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// What Straker calls corruption — and, far more importantly, what it refuses to
// ---------------------------------------------------------------------------

describe('narrowing corruption to the failures that really are one', () => {
  /** A `better-sqlite3` failure as the store receives one: an Error carrying a `code`. */
  const coded = (code: string): Error => Object.assign(new Error(code), { code });

  it.each([
    ['SQLITE_CORRUPT', 'the disk image is malformed'],
    ['SQLITE_CORRUPT_INDEX', 'an extended corruption code — the family, not one member'],
    ['SQLITE_CORRUPT_VTAB', 'likewise'],
    ['SQLITE_NOTADB', 'the file is not a database at all'],
  ])('calls %s corruption — %s', (code) => {
    expect(isStrakerCorruption(coded(code))).toBe(true);
  });

  it.each([
    ['SQLITE_BUSY', 'another instance, or Windows Defender, is holding the file'],
    ['SQLITE_LOCKED', 'the same, from inside the connection'],
    ['SQLITE_FULL', 'the disk filled during the DDL — the bytes already written are fine'],
    ['SQLITE_READONLY', 'ACLs changed under us; the file is intact and unwritable'],
    ['SQLITE_IOERR', 'a read failed once; a failing disk is not proof the bytes are wrong'],
    ['SQLITE_IOERR_WRITE', 'nor is a failed write'],
    ['SQLITE_PROTOCOL', 'WAL contention, which resolves itself'],
    ['SQLITE_CANTOPEN', 'a path, a permission or a handle limit — never the content'],
    ['EACCES', 'not a SQLite code at all; the OS refusing the file'],
    ['EPERM', 'likewise'],
  ])('refuses to call %s corruption — %s', (code) => {
    // The whole point of the finding. Each of these destroys an intact ledger if it is read
    // as corruption, and `heldWork()` coming back empty means the day's committed workload
    // silently reads zero and every offer then "fits". Adding any of these to the predicate
    // fails here — including SQLITE_CANTOPEN and the SQLITE_IOERR family, which
    // `src/state/db.ts` does list. That list answers a different question (inside a
    // backfill: "is this MY bug, or anything else?"); here the burden of proof runs the
    // other way, because failing to start is recoverable and destroying the ledger is not.
    expect(isStrakerCorruption(coded(code))).toBe(false);
  });

  it.each([
    ['a plain Error with no code', new Error('something went wrong')],
    ['a string', 'SQLITE_CORRUPT'],
    ['null', null],
    ['undefined', undefined],
    ['an object whose code is not a string', { code: 11 }],
  ])('refuses to call %s corruption, and does not throw reading it', (_label, thrown) => {
    // An unrecognised throw is not evidence of a broken file, and the predicate runs inside
    // a catch block: throwing here would replace a recoverable failure with a crash on the
    // error path itself.
    expect(isStrakerCorruption(thrown)).toBe(false);
  });
});

describe('a transient failure must never cost the ledger', () => {
  it('propagates a read-only state file instead of renaming the ledger away', () => {
    // A REAL read-only file, not a simulated code: this is the ACL-after-a-Windows-update
    // case from the finding, and the one that reproduces instantly. Before the predicate
    // this renamed straker.db aside and handed back an empty one — at which point
    // `heldWork()` is empty, the daily ceiling reads zero, and the bot claims past capacity
    // all day while looking healthy.
    const { strakerDir } = tempRoot();
    const first = openStrakerDatabase(strakerDir, NOW_MS);
    new StrakerStore(first.db).hold(hold());
    first.db.close();
    const dbPath = join(strakerDir, STRAKER_DB_FILENAME);
    chmodSync(dbPath, 0o444);

    try {
      let error: unknown = null;
      try {
        const opened = openStrakerDatabase(strakerDir, NOW_MS);
        openDbs.push(opened.db); // only reached while the bug is present
      } catch (err) {
        error = err;
      }

      expect(error).toMatchObject({ code: 'SQLITE_READONLY' });
      expect(filesUnder(strakerDir).filter((f) => f.includes('.corrupt-'))).toEqual([]);
    } finally {
      // Restore the SIDECARS too, not just the database file. SQLite creates `-wal` and
      // `-shm` with the permissions of the database file itself, so the failed open above
      // left read-only sidecars behind — and WAL cannot take a write lock against a
      // read-only `-shm`, so the reopen below still fails with SQLITE_READONLY even once
      // `straker.db` is writable again.
      //
      // This is why the test passed on Windows and failed on POSIX CI: `chmod` on Windows
      // only toggles the read-only attribute, and the sidecars do not inherit it there.
      // The assertions above are unchanged — only the cleanup was incomplete.
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(path)) chmodSync(path, 0o666);
      }
    }

    // And the held work — the ledger's only source — is still there to be read.
    const reopened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(reopened.db);
    expect(reopened.recoveredFromCorruption).toBe(false);
    expect(new StrakerStore(reopened.db).heldWork()).toHaveLength(1);
  });

  it('still quarantines a genuinely malformed file, and says the held work is gone', () => {
    // Narrowing must not become refusing. A file whose header survives but whose pages are
    // wrecked reports SQLITE_CORRUPT rather than the SQLITE_NOTADB a garbage file produces,
    // so both members of the predicate are exercised against a real file on disk.
    const { strakerDir } = tempRoot();
    const first = openStrakerDatabase(strakerDir, NOW_MS);
    new StrakerStore(first.db).hold(hold());
    first.db.close();
    const dbPath = join(strakerDir, STRAKER_DB_FILENAME);
    const bytes = readFileSync(dbPath);
    bytes.fill(0xff, 100, bytes.length); // keep the 100-byte header, wreck every page
    writeFileSync(dbPath, bytes);

    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(opened.db);

    expect(opened.recoveredFromCorruption).toBe(true);
    expect(opened.recoveredFromCorruption && opened.corruptCopyPath).toMatch(
      /straker\.db\.corrupt-/,
    );
    expect(new StrakerStore(opened.db).heldWork()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A quarantined ledger has to reach a human, not just a log file
// ---------------------------------------------------------------------------

describe('reporting a quarantine durably', () => {
  /** An outbox over a fresh Straker database, which is what the coordinator holds. */
  function freshOutbox(): StrakerOutbox {
    const { strakerDir } = tempRoot();
    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(opened.db);
    return new StrakerOutbox(opened.db);
  }

  const quarantined = {
    recoveredFromCorruption: true,
    corruptCopyPath: join('C:', 'state', 'straker.db.corrupt-2026-09-14T03-00-00-000Z'),
  };

  it('queues the alert on the operations channel, where on-call already looks', () => {
    // A `logger.error` line in a file nobody watches is what this replaces. Queued into the
    // outbox it is durable in the same database as everything else, and survives the
    // restart a quarantine usually comes with.
    const outbox = freshOutbox();

    expect(enqueueQuarantineAlert(outbox, quarantined, NOW_MS)).toBe('queued');

    const [row] = outbox.due(NOW_MS);
    expect(row?.channel).toBe('alerts');
    expect(row?.status).toBe('pending');
  });

  it('says the ceiling now reads empty, which is the consequence that matters', () => {
    // The operator does not need to know a file was renamed; they need to know the bot will
    // over-claim until reconciliation runs. A payload naming only the path fails here.
    const outbox = freshOutbox();

    enqueueQuarantineAlert(outbox, quarantined, NOW_MS);

    const payload = JSON.parse(outbox.due(NOW_MS)[0]?.payloadJson ?? '{}') as Record<
      string,
      unknown
    >;
    // `kind: 'system'` with `condition: 'db_quarantined'` — the notifier's own shape. It
    // used to be `kind: 'db_quarantined'` with no condition at all, which the alerts sender
    // refuses before reading anything else, so this alert dead-lettered every time.
    expect(payload['kind']).toBe('system');
    expect(payload['condition']).toBe('db_quarantined');
    expect(payload['corruptCopyPath']).toBe(quarantined.corruptCopyPath);
    expect(payload['heldWorkLost']).toBe(true);
    expect(String(payload['detail'])).toMatch(/ceiling|capacity/i);
  });

  it('queues nothing at all when the database opened cleanly', () => {
    // Called unconditionally by the coordinator, so the healthy path must be silent: an
    // alert on every ordinary start is an alert nobody reads on the one start that matters.
    const outbox = freshOutbox();

    expect(enqueueQuarantineAlert(outbox, { recoveredFromCorruption: false }, NOW_MS)).toBeNull();
    expect(outbox.due(NOW_MS)).toEqual([]);
  });

  it('raises one alert per quarantined file, not one per restart', () => {
    // A bot that quarantines is usually a bot in a restart loop. Keying the event on the
    // quarantined copy's stamped name makes a repeated start converge on the one alert,
    // while a genuinely new quarantine gets its own.
    const outbox = freshOutbox();

    expect(enqueueQuarantineAlert(outbox, quarantined, NOW_MS)).toBe('queued');
    expect(enqueueQuarantineAlert(outbox, quarantined, NOW_MS + 60_000)).toBe('already_pending');
    expect(
      enqueueQuarantineAlert(
        outbox,
        { ...quarantined, corruptCopyPath: 'straker.db.corrupt-2026-09-14T04-00-00-000Z' },
        NOW_MS + 120_000,
      ),
    ).toBe('queued');
    expect(outbox.due(NOW_MS + 120_000)).toHaveLength(2);
  });

  it('cannot be asked to report a quarantine that does not name its copy', () => {
    // This used to be a runtime guard: `corruptCopyPath` was optional beside the flag, so
    // the helper carried a `?? 'unknown'` and this test proved the alert still went out.
    // `QuarantineOutcome` is now a union, so that state is not reachable — the flag carries
    // the path. The guard did not move to a weaker place; the state it guarded is gone, and
    // an operator told their ledger was quarantined is now always told where it went.
    const outbox = freshOutbox();

    // @ts-expect-error a quarantine must name its copy
    const withoutPath: QuarantineOutcome = { recoveredFromCorruption: true };
    expect(withoutPath.recoveredFromCorruption).toBe(true);

    // What the caller can express instead — and the alert still goes out, now naming a file.
    const named: QuarantineOutcome = {
      recoveredFromCorruption: true,
      corruptCopyPath: 'straker.db.corrupt-2026-09-15T10-00-00-000Z',
    };
    expect(enqueueQuarantineAlert(outbox, named, NOW_MS)).toBe('queued');
    expect(outbox.due(NOW_MS)).toHaveLength(1);
  });
});

describe('OfferEvent — the shape refuses the rows the schema refuses (type design)', () => {
  /**
   * The table has carried these two rules since the first migration:
   *
   * ```sql
   * CHECK ((outcome IS NOT NULL)     = (event_type IN ('claim', 'recovery')))
   * CHECK ((skip_reason IS NOT NULL) = (event_type = 'skip'))
   * ```
   *
   * The *type* did not. It was one flat record with `outcome` and `skipReason` both
   * nullable on every variant, so a skip carrying a `won`, or a claim with no outcome at
   * all, compiled perfectly and then threw `SQLITE_CONSTRAINT` at the write. That write is
   * the one inside the per-claim transaction, after the portal has already committed the
   * work — the single worst moment in the cycle to discover a caller bug.
   *
   * These `@ts-expect-error` lines fail the build if any of the four combinations becomes
   * constructible again. They are assertions, not suppressions: TypeScript reports an
   * *unused* `@ts-expect-error` as an error of its own.
   */
  it('keeps the compile-time locks visible in the run', () => {
    const ok: OfferEvent[] = [
      {
        objId: 'a',
        eventType: 'claim',
        outcome: 'won',
        effortWords: 4,
        deadlineMs: 1,
        occurredAtMs: 1,
      },
      {
        objId: 'a',
        eventType: 'recovery',
        outcome: 'unknown',
        effortWords: null,
        deadlineMs: null,
        occurredAtMs: 1,
      },
      { objId: 'a', eventType: 'skip', skipReason: 'ceiling_reached', occurredAtMs: 1 },
      { objId: 'a', eventType: 'sighting', effortWords: null, deadlineMs: null, occurredAtMs: 1 },
    ];
    expect(ok).toHaveLength(4);
  });

  it('cannot be built with an outcome on a skip, or a reason on a claim', () => {
    // A skip that claims to have won. `lost` and `won` are the two outcomes that never
    // alert, so this is the combination that hides best.
    const skipThatWon: OfferEvent = {
      objId: 'a',
      eventType: 'skip',
      skipReason: 'ceiling_reached',
      // @ts-expect-error a skip has no outcome
      outcome: 'won',
      occurredAtMs: 1,
    };
    const claimWithAReason: OfferEvent = {
      objId: 'a',
      eventType: 'claim',
      outcome: 'won',
      // @ts-expect-error a claim has no skip reason
      skipReason: 'ceiling_reached',
      effortWords: 4,
      deadlineMs: 1,
      occurredAtMs: 1,
    };
    // These two are MISSING a required field rather than carrying a forbidden one, so
    // TypeScript anchors the error to the declaration rather than to a property line —
    // which is why the directive sits above the `const` and not inside the braces.
    // A claim row with no outcome records that the irreversible act happened and nothing
    // about what it produced.
    // @ts-expect-error a claim must carry an outcome
    const claimWithNoOutcome: OfferEvent = {
      objId: 'a',
      eventType: 'claim',
      effortWords: 4,
      deadlineMs: 1,
      occurredAtMs: 1,
    };
    // @ts-expect-error a skip must name the rule that blocked the offer
    const skipWithNoReason: OfferEvent = { objId: 'a', eventType: 'skip', occurredAtMs: 1 };

    expect([skipThatWon, claimWithAReason, claimWithNoOutcome, skipWithNoReason]).toHaveLength(4);
  });
});

describe('listEvents(window) — the bound the 09:00 report reads through', () => {
  /**
   * Half-open, matching `WinRateWindow`: `fromMs` inclusive, `toMs` exclusive, so two adjacent
   * windows can never count one event twice. The claim was only asserted in a comment — change
   * `>=` to `>` and exactly one event, the one landing on `fromMs`, disappears from a reported
   * figure with nothing failing. Boundaries are where that kind of edit hides.
   */
  const at = (objId: string, occurredAtMs: number) => ({
    objId,
    occurredAtMs,
    eventType: 'sighting' as const,
    effortWords: 4,
    deadlineMs: null,
  });

  it('includes fromMs, excludes toMs, and drops what falls outside', () => {
    const { store } = freshStore();
    for (const [id, ms] of [
      ['before', 999],
      ['on-from', 1_000],
      ['inside', 1_500],
      ['on-to', 2_000],
      ['after', 2_001],
    ] as const) {
      store.recordEvent(at(id, ms));
    }

    const ids = store.listEvents({ fromMs: 1_000, toMs: 2_000 }).map((e) => e.objId);

    expect(ids.sort()).toEqual(['inside', 'on-from']);
  });

  it('returns everything when no window is given, which is what the ops script relies on', () => {
    // `winRateReport.ts` calls `listEvents()` bare and measures the whole record.
    const { store } = freshStore();
    store.recordEvent(at('old', 1));
    store.recordEvent(at('new', 10_000_000));

    expect(store.listEvents()).toHaveLength(2);
  });
});

describe('the kind column arriving on a database that predates it', () => {
  /**
   * A pre-2026-09-17 record: `held_work` as it was before DTP work needed its own budget.
   * Built by dropping the column off a real database rather than by hand-writing the old
   * DDL, so the two cannot drift — the rest of the schema is whatever the code creates today.
   */
  function databaseWithoutKind(): string {
    const { strakerDir } = tempRoot();
    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    // SQLite refuses DROP COLUMN while a CHECK names the column, so the old table is
    // rebuilt from the CURRENT one's own DDL with the kind clause cut out. Derived rather
    // than hand-written, so the rest of the shape cannot drift away from production's.
    const ddl = (
      opened.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'held_work'")
        .get() as { sql: string }
    ).sql;
    // Cut from the end of the last pre-DTP column to the closing paren. Cutting back from
    // `kind` itself does not work: the clause is preceded by a comment whose prose contains
    // commas, so the nearest comma is inside English rather than inside SQL.
    const lastOldColumn = 'released_at_ms INTEGER';
    const cutFrom = ddl.indexOf(lastOldColumn);
    expect(cutFrom).toBeGreaterThan(-1);
    expect(ddl).toContain('kind TEXT NOT NULL'); // the table really does have it to remove
    const withoutKind =
      ddl.slice(0, cutFrom + lastOldColumn.length) + ddl.slice(ddl.lastIndexOf(')'));
    expect(withoutKind).not.toContain('kind');

    opened.db.exec('DROP TABLE held_work');
    opened.db.exec(withoutKind);
    opened.db
      .prepare(
        'INSERT INTO held_work (obj_id, effort_words, deadline_ms, held_since_ms, released_at_ms)' +
          ' VALUES (@id, 900, @dl, @at, NULL)',
      )
      .run({ id: 'before-dtp', dl: NOW_MS + 86_400_000, at: NOW_MS });
    opened.db.close();
    return strakerDir;
  }

  it('files work held before DTP existed as translation, not as nothing', () => {
    // The live database held real work when this column landed. A row that came back with
    // no kind — or a kind the ledger does not recognise — is excluded from EVERY total in
    // both directions, and the ceiling silently becomes unlimited. The default is the
    // whole safety argument, so it is asserted rather than trusted.
    const dir = databaseWithoutKind();

    const reopened = openStrakerDatabase(dir, NOW_MS);
    openDbs.push(reopened.db);

    expect(new StrakerStore(reopened.db).heldWork()).toEqual([
      expect.objectContaining({ objId: 'before-dtp', kind: 'translation', effortWords: 900 }),
    ]);
  });

  it('adds the column once, however many times the bot restarts', () => {
    // `migrate` runs on every open, so a migration that is not idempotent fails on the
    // SECOND start — after a deploy has already been called a success.
    const dir = databaseWithoutKind();

    for (let restart = 0; restart < 3; restart += 1) {
      const opened = openStrakerDatabase(dir, NOW_MS);
      openDbs.push(opened.db);
      const columns = (opened.db.pragma('table_info(held_work)') as { name: string }[]).map(
        (c) => c.name,
      );
      expect(columns.filter((c) => c === 'kind')).toHaveLength(1);
    }
  });

  it('still refuses a kind the ledger cannot account for', () => {
    // The CHECK has to survive the migration: it is what makes `work.kind !== kind` safe to
    // read as an exhaustive split rather than as a filter that can drop rows on the floor.
    const dir = databaseWithoutKind();
    const opened = openStrakerDatabase(dir, NOW_MS);
    openDbs.push(opened.db);

    expect(() =>
      opened.db
        .prepare(
          'INSERT INTO held_work (obj_id, effort_words, deadline_ms, held_since_ms, kind)' +
            ' VALUES (@id, 1, @dl, @at, @kind)',
        )
        .run({ id: 'bad', dl: NOW_MS, at: NOW_MS, kind: 'desktop-publishing' }),
    ).toThrow(/CHECK/i);
  });
});

// ---------------------------------------------------------------------------
// The identity that ties an offer, its purchase order and its assigned job (2026-09-22)
// ---------------------------------------------------------------------------

describe('work identity on held work and claim events', () => {
  const IDENTITY = {
    jobRef: 'aj-310',
    title: 'NBA - NTRY Hangtag.xlsx',
    service: 'translation',
    workKey: 'aj-310|zh-hk|translation',
  };

  it('keeps the identity a hold was given, and finds held work by its key', () => {
    const { store } = freshStore();
    store.hold({ ...hold(), identity: IDENTITY });

    expect(store.heldWork()[0]?.identity).toEqual(IDENTITY);
  });

  it('never lets a later hold without an identity erase one already recorded', () => {
    // Reconciliation re-holds work it finds; it must not blank what the claim path knew.
    const { store } = freshStore();
    store.hold({ ...hold(), identity: IDENTITY });
    store.hold(hold());

    expect(store.heldWork()[0]?.identity).toEqual(IDENTITY);
  });

  it('leaves the identity off held work that never had one', () => {
    const { store } = freshStore();
    store.hold(hold());

    expect(store.heldWork()[0]).not.toHaveProperty('identity');
  });

  it('fills in the identity of a row that lacked one, and only that', () => {
    const { store } = freshStore();
    store.hold(hold());
    expect(store.backfillHeldIdentity(hold().objId, IDENTITY)).toBe(true);
    expect(store.heldWork()[0]?.identity).toEqual(IDENTITY);

    // A second backfill does not overwrite what is there.
    store.backfillHeldIdentity(hold().objId, { ...IDENTITY, title: 'other.xlsx' });
    expect(store.heldWork()[0]?.identity?.title).toBe(IDENTITY.title);
  });

  it('finds the latest claim made on a work key, with what it was weighed at', () => {
    const { store } = freshStore();
    store.recordEvent({
      objId: 'offer-1',
      eventType: 'claim',
      outcome: 'unknown',
      effortWords: 20,
      deadlineMs: NOW_MS + 86_400_000,
      occurredAtMs: NOW_MS,
      identity: IDENTITY,
    });

    expect(store.claimEventByWorkKey(IDENTITY.workKey)).toEqual({
      objId: 'offer-1',
      outcome: 'unknown',
      effortWords: 20,
      deadlineMs: NOW_MS + 86_400_000,
      occurredAtMs: NOW_MS,
      identity: IDENTITY,
      languageDirection: null, // this claim recorded none
    });
    expect(store.claimEventByWorkKey('aj-999|th|translation')).toBeNull();
  });

  it('reads the identity back on claim and recovery events, so the win rate can join them', () => {
    // The win rate merges a recovery recorded under a purchase-order id into the claim it
    // settles (A3) — which it can only do if the identity survives the read, not only the write.
    const { store } = freshStore();
    const work = { effortWords: 20, deadlineMs: NOW_MS + 86_400_000 };
    store.recordEvent({
      objId: 'offer-1',
      eventType: 'claim',
      outcome: 'won',
      occurredAtMs: NOW_MS,
      identity: IDENTITY,
      ...work,
    });
    store.recordEvent({
      objId: 'po-1',
      eventType: 'recovery',
      outcome: 'recovered',
      occurredAtMs: NOW_MS + 1,
      identity: IDENTITY,
      ...work,
    });
    store.recordEvent({
      objId: 'offer-2',
      eventType: 'claim',
      outcome: 'lost',
      occurredAtMs: NOW_MS + 2,
      ...work,
    });

    const events = store.listEvents();
    expect(events.find((e) => e.objId === 'offer-1')).toMatchObject({ identity: IDENTITY });
    expect(events.find((e) => e.objId === 'po-1')).toMatchObject({ identity: IDENTITY });
    // Absent, not a row of nulls, where none was recorded.
    expect(events.find((e) => e.objId === 'offer-2')).not.toHaveProperty('identity');
  });

  it('remembers a one-time step across restarts', () => {
    const { strakerDir } = tempRoot();
    const first = openStrakerDatabase(strakerDir, NOW_MS);
    const store = new StrakerStore(first.db);
    expect(store.metaFlagSetAt('po_adoption_done')).toBeNull();
    expect(store.setMetaFlag('po_adoption_done', NOW_MS)).toBe(true);
    expect(store.setMetaFlag('po_adoption_done', NOW_MS + 1)).toBe(false);
    first.db.close();

    const second = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(second.db);
    expect(new StrakerStore(second.db).metaFlagSetAt('po_adoption_done')).toBe(NOW_MS);
  });

  it('adds the identity columns to a database that predates them, once', () => {
    const { strakerDir } = tempRoot();
    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    // Rebuilt without the four columns rather than DROP COLUMN, which SQLite refuses on a
    // table whose definition carries comments. offer_events keeps its real DDL (its CHECKs
    // are guarded on open); held_work only needs the column set.
    opened.db.exec('DROP INDEX idx_held_work_key');
    const identityLine =
      /^\s*(work_key|job_ref|title|service) TEXT,?\s*$|^\s*-- (What names the work|rows and offers)/;
    const eventsDdl = (
      opened.db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'offer_events'")
        .get() as { sql: string }
    ).sql
      .split('\n')
      .filter((line) => !identityLine.test(line))
      .join('\n');
    expect(eventsDdl).not.toContain('work_key');
    opened.db.exec('DROP TABLE offer_events');
    opened.db.exec(eventsDdl);
    const keep = (opened.db.pragma('table_info(held_work)') as { name: string }[])
      .map((c) => c.name)
      .filter((c) => !['work_key', 'job_ref', 'title', 'service'].includes(c));
    opened.db.exec(`CREATE TABLE held_work_old AS SELECT ${keep.join(', ')} FROM held_work`);
    opened.db.exec('DROP TABLE held_work');
    opened.db.exec('ALTER TABLE held_work_old RENAME TO held_work');
    opened.db.close();

    for (let restart = 0; restart < 3; restart += 1) {
      const again = openStrakerDatabase(strakerDir, NOW_MS);
      openDbs.push(again.db);
      for (const table of ['held_work', 'offer_events']) {
        const cols = (again.db.pragma(`table_info(${table})`) as { name: string }[]).map(
          (c) => c.name,
        );
        for (const col of ['work_key', 'job_ref', 'title', 'service']) {
          expect(cols.filter((c) => c === col)).toHaveLength(1);
        }
      }
    }
  });
});

describe('checkpoint — the write-ahead log is folded back and truncated (2026-09-22)', () => {
  // SQLite's automatic checkpoint folds pages back into the database but never shrinks the
  // -wal file, and a reader holding a snapshot can stop it altogether: a bot that writes a
  // sighting every ten seconds for weeks grows the file without bound. TRUNCATE resets it.
  it('leaves a non-empty -wal after writes, and a zero-byte one after the checkpoint', () => {
    const { store, db, path } = freshStore();
    for (let i = 0; i < 20; i += 1) {
      store.recordEvent({
        objId: `offer-${i}`,
        eventType: 'claim',
        outcome: 'lost',
        effortWords: 4,
        deadlineMs: NOW_MS,
        occurredAtMs: NOW_MS + i,
      });
    }
    const wal = `${path}-wal`;
    expect(existsSync(wal)).toBe(true);
    expect(statSync(wal).size).toBeGreaterThan(0);

    const result = store.checkpoint();

    expect(result.busy).toBe(0);
    expect(statSync(wal).size).toBe(0);
    // Nothing lost: the rows are in the database file now.
    expect(store.claimedObjIds().size).toBe(20);
    db.close();
  });
});

describe('skip history — every CHANGE of skip reason is kept (2026-09-22)', () => {
  // `offer_events` keeps one skip row per offer and overwrites its reason, so "ceiling
  // reached at 10:00, deadline unreachable by 17:00" left only the last word. The history is
  // append-only and records a reason only when it differs from that offer's latest — the
  // same reason every ten seconds is one row, not 8,640 a day.
  it('turns reasons A, A, B, A into three rows: A, B, A', () => {
    const { store, db } = freshStore();
    const reasons = [
      'ceiling_reached',
      'ceiling_reached',
      'deadline_unreachable',
      'ceiling_reached',
    ] as const;
    reasons.forEach((skipReason, i) =>
      store.recordEvent(skipEvent({ skipReason, occurredAtMs: NOW_MS + i * 10_000 })),
    );

    expect(store.skipHistoryOf(OFFER_ID)).toEqual([
      { skipReason: 'ceiling_reached', occurredAtMs: NOW_MS },
      { skipReason: 'deadline_unreachable', occurredAtMs: NOW_MS + 20_000 },
      { skipReason: 'ceiling_reached', occurredAtMs: NOW_MS + 30_000 },
    ]);
    // offer_events itself is unchanged: one skip row, the latest reason.
    expect(store.eventsOf(OFFER_ID)).toEqual([
      expect.objectContaining({ eventType: 'skip', skipReason: 'ceiling_reached' }),
    ]);
    db.close();
  });

  it('keeps each offer its own history, and records nothing for other event types', () => {
    const { store, db } = freshStore();
    store.recordEvent(skipEvent({ objId: 'a', skipReason: 'ceiling_reached' }));
    store.recordEvent(skipEvent({ objId: 'b', skipReason: 'ceiling_reached' }));
    store.recordEvent({
      objId: 'a',
      eventType: 'claim',
      outcome: 'lost',
      effortWords: 4,
      deadlineMs: NOW_MS,
      occurredAtMs: NOW_MS,
    });

    expect(store.skipHistoryOf('a')).toHaveLength(1);
    expect(store.skipHistoryOf('b')).toHaveLength(1);
    expect(store.skipHistoryOf('never-seen')).toEqual([]);
    db.close();
  });

  it('is idempotent across a reopen: the same reason after a restart adds nothing', () => {
    const { strakerDir } = tempRoot();
    const first = openStrakerDatabase(strakerDir, NOW_MS);
    new StrakerStore(first.db).recordEvent(skipEvent({ skipReason: 'outside_schedule' }));
    first.db.close();

    const second = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(second.db);
    const store = new StrakerStore(second.db);
    store.recordEvent(skipEvent({ skipReason: 'outside_schedule', occurredAtMs: NOW_MS + 1 }));

    expect(store.skipHistoryOf(OFFER_ID)).toEqual([
      { skipReason: 'outside_schedule', occurredAtMs: NOW_MS },
    ]);
  });

  it('adds the table to a database created before it existed, leaving the rows it had', () => {
    const { strakerDir } = tempRoot();
    const first = openStrakerDatabase(strakerDir, NOW_MS);
    new StrakerStore(first.db).recordEvent(skipEvent({ skipReason: 'ceiling_reached' }));
    // As the live database was before this change.
    first.db.exec('DROP TABLE offer_skip_history');
    first.db.close();

    const second = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(second.db);
    const store = new StrakerStore(second.db);

    expect(store.eventsOf(OFFER_ID)).toHaveLength(1);
    expect(store.skipHistoryOf(OFFER_ID)).toEqual([]);
    store.recordEvent(skipEvent({ skipReason: 'deadline_unreachable', occurredAtMs: NOW_MS + 1 }));
    expect(store.skipHistoryOf(OFFER_ID)).toEqual([
      { skipReason: 'deadline_unreachable', occurredAtMs: NOW_MS + 1 },
    ]);
  });

  it('refuses to open over a history table whose CHECK misses a skip reason', () => {
    // Registered with the vocabulary coverage check: a reason added later must not be
    // rejected by the one table created before it — inside the transaction the skip shares.
    const { strakerDir } = tempRoot();
    const stale = new Database(join(strakerDir, STRAKER_DB_FILENAME));
    stale.exec(`CREATE TABLE offer_skip_history (
      obj_id TEXT NOT NULL,
      skip_reason TEXT NOT NULL CHECK (skip_reason IN ('ceiling_reached')),
      occurred_at_ms INTEGER NOT NULL
    )`);
    stale.close();

    let error: unknown;
    try {
      const opened = openStrakerDatabase(strakerDir, NOW_MS);
      openDbs.push(opened.db);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(StrakerSchemaError);
    expect(error instanceof Error ? error.message : '').toMatch(/offer_skip_history/);
  });

  it('rolls the history back with a caller transaction that fails', () => {
    const { store, db } = freshStore();
    expect(() =>
      store.transaction(() => {
        store.recordEvent(skipEvent({ skipReason: 'ceiling_reached' }));
        throw new Error('the cycle failed after recording');
      }),
    ).toThrow();

    expect(store.skipHistoryOf(OFFER_ID)).toEqual([]);
    db.close();
  });
});
