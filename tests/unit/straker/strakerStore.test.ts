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
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../../src/state/db.js';
import { CLAIM_OUTCOMES, SKIP_REASONS } from '../../../src/straker/types.js';
import type { EndedOfferSighting, OfferSighting } from '../../../src/straker/types.js';
import {
  MissingOfferIdentityError,
  STRAKER_DB_FILENAME,
  StrakerStore,
  openStrakerDatabase,
  type NewHold,
  type OfferEvent,
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

const event = (over: Partial<OfferEvent> = {}): OfferEvent => ({
  objId: 'e3b0c442-98fc-1c14-9afb-f4c8996fb924',
  eventType: 'sighting',
  outcome: null,
  skipReason: null,
  effortWords: 1_200,
  deadlineMs: Date.parse('2026-09-17T17:00:00+07:00'),
  occurredAtMs: NOW_MS,
  ...over,
});

const hold = (over: Partial<NewHold> = {}): NewHold => ({
  objId: 'e3b0c442-98fc-1c14-9afb-f4c8996fb924',
  effortWords: 1_200,
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
    store.recordEvent(event({ eventType: 'claim', outcome: 'won' }));
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
        store.hold(hold());
        throw new Error('cycle aborted');
      }),
    ).toThrow('cycle aborted');

    expect(store.liveSightings()).toEqual([]);
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
    expect(source).not.toMatch(/from '\.\.\/state\//);
    expect(source).not.toMatch(/from '\.\.\/config\//);
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
    store.recordEvent(event({ objId: 'offer-a' }));
    store.recordEvent(event({ objId: 'offer-b' }));

    expect(store.listEvents()).toHaveLength(2);
  });

  it('treats a missing identity as a hard failure, not a skip', () => {
    const { store } = freshStore();

    expect(() => store.recordSighting(sighting({ objId: '' }))).toThrow(MissingOfferIdentityError);
    expect(() => store.recordEvent(event({ objId: '   ' }))).toThrow(MissingOfferIdentityError);
    expect(() => store.hold(hold({ objId: '' }))).toThrow(MissingOfferIdentityError);

    // A hard failure writes nothing — it does not half-record the entry it refused.
    expect(store.liveSightings()).toEqual([]);
    expect(store.listEvents()).toEqual([]);
    expect(store.heldWork()).toEqual([]);
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
});

// ---------------------------------------------------------------------------
// Outcome rows (FR-014, V10, data-model §3/§4)
// ---------------------------------------------------------------------------

describe('outcome rows', () => {
  it('keeps a sighting, a claim and a recovery of one offer as three rows, not one', () => {
    const { store } = freshStore();
    const objId = 'offer-1';
    store.recordEvent(event({ objId, eventType: 'sighting' }));
    store.recordEvent(event({ objId, eventType: 'claim', outcome: 'won' }));
    store.recordEvent(event({ objId, eventType: 'recovery', outcome: 'recovered' }));

    expect(
      store
        .eventsOf(objId)
        .map((e) => e.eventType)
        .sort(),
    ).toEqual(['claim', 'recovery', 'sighting']);
  });

  it('upserts on identity together with event type, so a re-run never duplicates a row', () => {
    const { store } = freshStore();
    store.recordEvent(event({ eventType: 'claim', outcome: 'unknown' }));
    store.recordEvent(event({ eventType: 'claim', outcome: 'won', occurredAtMs: NOW_MS + 5_000 }));

    const rows = store.listEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('won');
    expect(rows[0]?.occurredAtMs).toBe(NOW_MS + 5_000);
  });

  it('records a skip with the reason that blocked it, and no outcome', () => {
    const { store } = freshStore();
    store.recordEvent(event({ eventType: 'skip', skipReason: 'ceiling_reached' }));

    const [row] = store.listEvents();
    expect(row?.skipReason).toBe('ceiling_reached');
    expect(row?.outcome).toBeNull();
  });

  it('refuses a claim with no outcome, and a skip with no reason', () => {
    const { store } = freshStore();

    expect(() => store.recordEvent(event({ eventType: 'claim', outcome: null }))).toThrow();
    expect(() => store.recordEvent(event({ eventType: 'skip', skipReason: null }))).toThrow();
    expect(() => store.recordEvent(event({ eventType: 'sighting', outcome: 'won' }))).toThrow();
    expect(store.listEvents()).toEqual([]);
  });

  it('accepts every outcome and every skip reason the shared vocabulary defines', () => {
    const { store } = freshStore();
    for (const outcome of CLAIM_OUTCOMES) {
      store.recordEvent(event({ objId: `outcome-${outcome}`, eventType: 'claim', outcome }));
    }
    for (const reason of SKIP_REASONS) {
      store.recordEvent(event({ objId: `skip-${reason}`, eventType: 'skip', skipReason: reason }));
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
    expect(opened.corruptCopyPath).toMatch(/straker\.db\.corrupt-/);
    expect(filesUnder(strakerDir).some((f) => f.startsWith('straker.db.corrupt-'))).toBe(true);
    expect(new StrakerStore(opened.db).listEvents()).toEqual([]);
  });
});
