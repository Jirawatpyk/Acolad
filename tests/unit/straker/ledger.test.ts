/**
 * T009 — Straker's per-portal ledger (FR-009).
 *
 * Three properties carry the whole requirement, and each is tested against real SQLite
 * rather than a stub, because the thing being asserted is what the stored state does:
 *
 *  1. It is keyed by the **effective deadline day** — the working day the work actually
 *     lands on — not the day the offer was claimed. The XTM bot re-keyed exactly this way
 *     (PR #14/#19) after finding that bucketing by claim day charged a Friday rush to the
 *     wrong day.
 *  2. It is **derived from held work, never a running counter.** A counter cannot give the
 *     budget back when a job finishes; a sum over the held set gives it back by doing
 *     nothing at all. The XTM bot shipped a counter first and had to replace it.
 *  3. Work found by **reconciliation counts even past the ceiling** (FR-016d, V25). It is
 *     already committed on the portal, so the ledger records reality rather than making a
 *     decision — it reports the breach and then blocks further claims due on or before that day.
 *
 * September 2026 is used throughout: it carries no Thai public holiday, so a weekday in it
 * is unambiguously a working day and the dates below say what they mean.
 *   Mon 14 · Tue 15 · Wed 16 · Thu 17 · Fri 18 · Sat 19 · Sun 20
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../../src/state/db.js';
import {
  StrakerStore,
  openStrakerDatabase,
  type StrakerDB,
} from '../../../src/straker/strakerStore.js';
import { StrakerLedger, type LedgerWorkCalendar } from '../../../src/straker/ledger.js';

const LEDGER_SOURCE = fileURLToPath(new URL('../../../src/straker/ledger.ts', import.meta.url));

/**
 * Every module `file` imports, with relative specifiers resolved to real paths.
 *
 * Resolving beats pattern-matching the source text, which is what the previous version of
 * this guard did: it looked for `from '../state/` and so said nothing about
 * `from '../../src/state/db.js'` — the same import, a different spelling. A guard that a
 * spelling can walk past is worse than no guard, because it reports green while checking
 * nothing.
 */
function importedModules(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers = [
    ...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[1] ?? m[2] ?? '');
  return specifiers.map((spec) =>
    spec.startsWith('.') ? resolve(dirname(file), spec).replace(/\\/g, '/') : spec,
  );
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

const NOW_MS = Date.parse('2026-09-14T10:00:00+07:00'); // Monday, mid-morning
const at = (iso: string): number => Date.parse(iso);

const THU_AFTERNOON = at('2026-09-17T17:00:00+07:00');
const WED_BEFORE_WORK = at('2026-09-16T08:00:00+07:00');
const SAT_MIDDAY = at('2026-09-19T12:00:00+07:00');
const FRI_AFTERNOON = at('2026-09-18T17:00:00+07:00');
/**
 * The deadline day itself, first working minute. The single-day boundary tests below are
 * judged from here: since 2026-09-18 a deadline has every working day before it, so judged
 * from Monday a Thursday deadline has four days of room and no boundary to test. From
 * Thursday morning the window is one day and the ceiling is the ceiling. The multi-day
 * window has its own block at the end of this file.
 */
const THU_MORNING = at('2026-09-17T09:00:00+07:00');

const CALENDAR: LedgerWorkCalendar = {
  hoursStartMin: 9 * 60,
  hoursEndMin: 18 * 60,
  workdays: new Set([1, 2, 3, 4, 5]),
};

const CEILING = 1_000;

const dirs: string[] = [];
const openDbs: StrakerDB[] = [];

function freshLedger(
  ceiling = CEILING,
  holidaysAt?: (nowMs: number) => ReadonlyMap<string, string>,
): { ledger: StrakerLedger; store: StrakerStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'straker-ledger-'));
  dirs.push(dir);
  const opened = openStrakerDatabase(dir, NOW_MS);
  openDbs.push(opened.db);
  const store = new StrakerStore(opened.db);
  const ledger =
    holidaysAt === undefined
      ? new StrakerLedger(store, { translation: ceiling, monolingual: ceiling }, CALENDAR)
      : new StrakerLedger(
          store,
          { translation: ceiling, monolingual: ceiling },
          CALENDAR,
          holidaysAt,
        );
  return { ledger, store, dir };
}

/** Put one environment variable back exactly as it was, unset included. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The key: the day the work lands on, not the day it was claimed
// ---------------------------------------------------------------------------

describe('keyed by effective deadline day', () => {
  it('charges the work to its deadline day, not to the day it was claimed', () => {
    const { ledger } = freshLedger();
    // Claimed on Monday; due Thursday afternoon.
    ledger.hold(
      { objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );

    expect(ledger.committedOn('2026-09-17', NOW_MS, 'translation')).toBe(400);
    expect(ledger.committedOn('2026-09-14', NOW_MS, 'translation')).toBe(0);
  });

  it('charges a deadline that falls before the working day starts to the previous one', () => {
    const { ledger } = freshLedger();
    // 08:00 Wednesday leaves zero working minutes on Wednesday, so the work is Tuesday's.
    ledger.hold(
      { objId: 'offer-1', effortWords: 400, deadlineMs: WED_BEFORE_WORK, kind: 'translation' },
      NOW_MS,
    );

    expect(ledger.committedOn('2026-09-15', NOW_MS, 'translation')).toBe(400);
    expect(ledger.committedOn('2026-09-16', NOW_MS, 'translation')).toBe(0);
  });

  it('charges a weekend deadline to the working day before it', () => {
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'offer-1', effortWords: 400, deadlineMs: SAT_MIDDAY, kind: 'translation' },
      NOW_MS,
    );

    expect(ledger.committedOn('2026-09-18', NOW_MS, 'translation')).toBe(400);
    expect(ledger.committedOn('2026-09-19', NOW_MS, 'translation')).toBe(0);
  });

  it('honours the work calendar, so a holiday deadline lands on the working day before it', () => {
    const holidays = new Map([['2026-09-18', 'Invented Day']]);
    const { ledger } = freshLedger(CEILING, () => holidays);
    ledger.hold(
      { objId: 'offer-1', effortWords: 400, deadlineMs: FRI_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );

    expect(ledger.committedOn('2026-09-17', NOW_MS, 'translation')).toBe(400);
    expect(ledger.committedOn('2026-09-18', NOW_MS, 'translation')).toBe(0);
  });

  it('sums several offers due on the same day and keeps different days apart', () => {
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'a', effortWords: 300, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );
    ledger.hold(
      { objId: 'b', effortWords: 250, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );
    ledger.hold(
      { objId: 'c', effortWords: 100, deadlineMs: FRI_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );

    expect([...ledger.committedByDay(NOW_MS, 'translation')].sort()).toEqual([
      ['2026-09-17', 550],
      ['2026-09-18', 100],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Derived from held work, never a running counter
// ---------------------------------------------------------------------------

describe('derived from held work', () => {
  it('gives the budget back when the work is finished, which a counter cannot do', () => {
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'offer-1', effortWords: 500, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );
    expect(ledger.committedOn('2026-09-17', NOW_MS, 'translation')).toBe(500);

    expect(ledger.release('offer-1', NOW_MS + 3_600_000)).toBe(true);
    expect(ledger.committedOn('2026-09-17', NOW_MS, 'translation')).toBe(0);
    expect(ledger.remainingOn('2026-09-17', NOW_MS, 'translation')).toBe(CEILING);
  });

  it('reports what the held set says even when the ledger itself was never told', () => {
    // The decisive test that no counter is being kept: the held set is changed behind the
    // ledger's back, through a second store on the same database, and the ledger's answer
    // moves with it. A counter would still be reporting the old number.
    const { ledger, store } = freshLedger();
    ledger.hold(
      { objId: 'offer-1', effortWords: 500, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );

    store.hold({
      objId: 'offer-2',
      effortWords: 200,
      kind: 'translation',
      deadlineMs: THU_AFTERNOON,
      heldSinceMs: NOW_MS,
    });
    expect(ledger.committedOn('2026-09-17', NOW_MS, 'translation')).toBe(700);

    store.release('offer-1', NOW_MS);
    expect(ledger.committedOn('2026-09-17', NOW_MS, 'translation')).toBe(200);
  });

  it('counts an offer held twice once, so a re-run after a crash does not double the day', () => {
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'offer-1', effortWords: 500, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );
    ledger.hold(
      { objId: 'offer-1', effortWords: 500, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS + 1_000,
    );

    expect(ledger.committedOn('2026-09-17', NOW_MS, 'translation')).toBe(500);
  });

  it('names held work whose deadline it cannot read, rather than quietly under-counting', () => {
    const { ledger } = freshLedger();
    // Reconciliation can hand back work the portal says is ours without a readable
    // deadline. Refusing to record it would lose it (FR-016d); bucketing it under a
    // guessed day would corrupt the ceiling. It is recorded, excluded, and named.
    ledger.hold(
      { objId: 'offer-1', effortWords: 500, deadlineMs: null, kind: 'translation' },
      NOW_MS,
    );

    expect([...ledger.committedByDay(NOW_MS, 'translation')]).toEqual([]);
    expect(ledger.heldWorkMissingDeadline(NOW_MS)).toEqual(['offer-1']);
  });
});

// ---------------------------------------------------------------------------
// A ceiling of Straker's own (FR-009)
// ---------------------------------------------------------------------------

describe('a ceiling of its own', () => {
  it('uses the ceiling it was given and reads no figure from the XTM bot', () => {
    const { ledger } = freshLedger(2_500);
    expect(ledger.ceilingFor('translation')).toBe(2_500);
    expect(ledger.remainingOn('2026-09-17', NOW_MS, 'translation')).toBe(2_500);
    expect(readFileSync(LEDGER_SOURCE, 'utf8')).not.toMatch(/ACCEPT_MAX/);
  });

  it('keeps its own ceiling while the XTM bot settings in the environment say otherwise', () => {
    // The behavioural half of "Straker's ceiling is Straker's own": the XTM bot reads its
    // ceiling from these variables, so a ledger that had reached for the XTM config would
    // answer 99_000 here. Only a figure passed in by Straker's own caller survives.
    const before = {
      words: process.env.ACCEPT_MAX_WORDS_PER_DAY,
      wwc: process.env.ACCEPT_MAX_WWC_PER_DAY,
      metric: process.env.ACCEPT_EFFORT_METRIC,
    };
    process.env.ACCEPT_MAX_WORDS_PER_DAY = '99000';
    process.env.ACCEPT_MAX_WWC_PER_DAY = '99000';
    process.env.ACCEPT_EFFORT_METRIC = 'wwc';
    try {
      const { ledger } = freshLedger(1_000);
      ledger.hold(
        { objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON, kind: 'translation' },
        THU_MORNING,
      );

      expect(ledger.ceilingFor('translation')).toBe(1_000);
      expect(ledger.remainingOn('2026-09-17', THU_MORNING, 'translation')).toBe(600);
      expect(
        ledger.checkCapacity(
          { objId: 'big', effortWords: 900, deadlineMs: THU_AFTERNOON, kind: 'translation' },
          THU_MORNING,
        ),
      ).toMatchObject({ fits: false });
    } finally {
      restoreEnv('ACCEPT_MAX_WORDS_PER_DAY', before.words);
      restoreEnv('ACCEPT_MAX_WWC_PER_DAY', before.wwc);
      restoreEnv('ACCEPT_EFFORT_METRIC', before.metric);
    }
  });

  it('runs a whole cycle without touching the XTM database or any file outside its own', () => {
    // The bulkhead as behaviour, not as a comment — the same proof the store and the
    // outbox carry, against a REAL XTM database opened alongside. An import of the XTM
    // state layer that actually wrote anything would land here.
    const root = mkdtempSync(join(tmpdir(), 'straker-ledger-bulkhead-'));
    dirs.push(root);
    const xtmDir = join(root, 'xtm');
    const strakerDir = join(root, 'straker');
    mkdirSync(xtmDir, { recursive: true });
    mkdirSync(strakerDir, { recursive: true });

    const xtm = openDatabase(xtmDir, new Date(NOW_MS).toISOString()).db;
    xtm.prepare("INSERT INTO meta (key, value) VALUES ('straker-ledger-marker', '1')").run();
    const xtmFilesBefore = filesUnder(xtmDir);

    const opened = openStrakerDatabase(strakerDir, NOW_MS);
    openDbs.push(opened.db);
    const ledger = new StrakerLedger(
      new StrakerStore(opened.db),
      { translation: CEILING, monolingual: CEILING },
      CALENDAR,
    );

    ledger.hold(
      { objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );
    ledger.checkCapacity(
      { objId: 'offer-2', effortWords: 400, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );
    ledger.committedByDay(NOW_MS, 'translation');
    ledger.heldWorkMissingDeadline(NOW_MS);
    ledger.release('offer-1', NOW_MS + 3_600_000);

    expect(filesUnder(xtmDir)).toEqual(xtmFilesBefore);
    expect(filesUnder(root).filter((p) => !p.startsWith('xtm/'))).not.toEqual([]);
    expect(
      filesUnder(root)
        .filter((p) => !p.startsWith('xtm/'))
        .every((p) => p.startsWith('straker/')),
    ).toBe(true);
    expect(xtm.prepare("SELECT value FROM meta WHERE key = 'straker-ledger-marker'").get()).toEqual(
      {
        value: '1',
      },
    );
    expect((xtm.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0);
    expect((xtm.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n).toBe(0);
    xtm.close();
  });

  it('never imports the XTM state or configuration layer, however the path is spelled', () => {
    // The structural backstop behind the two behavioural tests above. It resolves each
    // specifier instead of matching its text, because the text form of this check could be
    // walked past by writing '../../src/state/db.js' for '../state/db.js'.
    const imports = importedModules(LEDGER_SOURCE);

    // Guard the guard: an extractor that silently found nothing would "pass" everything.
    // Two imports the ledger is known to have. `acceptCapacity.js` served here until the
    // ledger stopped delegating to it (2026-09-18) — the control only needs to be real.
    expect(imports.some((m) => m.endsWith('/src/schedule/deadlineDay.js'))).toBe(true);
    expect(imports.some((m) => m.endsWith('/src/straker/strakerStore.js'))).toBe(true);
    expect(imports.filter((m) => /(^|\/)(state|config)(\/|$)/.test(m))).toEqual([]);
  });

  it('draws the line at the ceiling itself: exactly full fits, one word more does not', () => {
    // The boundary is where an off-by-one turns into an over-commitment, and an
    // irreversible claim is a poor place to discover one.
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'held', effortWords: 600, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );

    expect(
      ledger.checkCapacity(
        { objId: 'exact', effortWords: 400, deadlineMs: THU_AFTERNOON, kind: 'translation' },
        THU_MORNING,
      ),
    ).toMatchObject({ fits: true });
    expect(
      ledger.checkCapacity(
        { objId: 'over', effortWords: 401, deadlineMs: THU_AFTERNOON, kind: 'translation' },
        THU_MORNING,
      ),
    ).toMatchObject({ fits: false, reason: 'ceiling_reached' });
  });

  it('refuses a ceiling that is not a positive number rather than reading it as unlimited', () => {
    const dir = mkdtempSync(join(tmpdir(), 'straker-ledger-'));
    dirs.push(dir);
    const opened = openStrakerDatabase(dir, NOW_MS);
    openDbs.push(opened.db);
    const store = new StrakerStore(opened.db);

    expect(() => new StrakerLedger(store, { translation: 0, monolingual: 0 }, CALENDAR)).toThrow(
      /ceiling/i,
    );
    expect(() => new StrakerLedger(store, { translation: -1, monolingual: 100 }, CALENDAR)).toThrow(
      /ceiling/i,
    );
    // And the other budget is checked too — a valid translation ceiling must not excuse a
    // nonsensical DTP one, which is the shape a half-configured second budget would take.
    expect(() => new StrakerLedger(store, { translation: 100, monolingual: 0 }, CALENDAR)).toThrow(
      /monolingual/i,
    );
  });

  it('measures effort in raw words, and says so in the reason a human reads', () => {
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'held', effortWords: 900, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );

    const verdict = ledger.checkCapacity(
      { objId: 'next', effortWords: 300, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );
    expect(verdict.fits).toBe(false);
    if (!verdict.fits) expect(verdict.detail).toMatch(/word/);
  });
});

// ---------------------------------------------------------------------------
// Capacity decisions (data-model §4 skip reasons)
// ---------------------------------------------------------------------------

describe('capacity decisions', () => {
  it('lets an offer through while the day has room', () => {
    const { ledger } = freshLedger();
    const verdict = ledger.checkCapacity(
      { objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );

    expect(verdict).toMatchObject({ fits: true, deadlineDay: '2026-09-17' });
    if (verdict.fits) expect(verdict.remaining).toBe(CEILING);
  });

  it('blocks with ceiling_reached once the day is spent, which frees up as work finishes', () => {
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'held', effortWords: 900, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );

    const verdict = ledger.checkCapacity(
      { objId: 'offer-1', effortWords: 300, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );
    expect(verdict).toMatchObject({ fits: false, reason: 'ceiling_reached' });
  });

  it('blocks an offer larger than every working day before its deadline, because it needs a human', () => {
    const { ledger } = freshLedger();
    const verdict = ledger.checkCapacity(
      {
        objId: 'offer-1',
        effortWords: CEILING + 1,
        deadlineMs: THU_AFTERNOON,
        kind: 'translation',
      },
      THU_MORNING,
    );

    // Distinct from an ordinary ceiling skip: no amount of waiting clears it, so it would
    // otherwise recur every day forever.
    expect(verdict).toMatchObject({ fits: false, reason: 'exceeds_daily_ceiling_entirely' });
  });

  it('applies the ceiling per day, so a full Thursday does not block a Friday deadline', () => {
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'held', effortWords: CEILING, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );

    expect(
      ledger.checkCapacity(
        { objId: 'a', effortWords: 100, deadlineMs: THU_AFTERNOON, kind: 'translation' },
        THU_MORNING,
      ),
    ).toMatchObject({ fits: false });
    expect(
      ledger.checkCapacity(
        { objId: 'b', effortWords: 100, deadlineMs: FRI_AFTERNOON, kind: 'translation' },
        THU_MORNING,
      ),
    ).toMatchObject({ fits: true });
  });

  it('treats a deadline it cannot read as a hard failure, never as a day with room', () => {
    const { ledger } = freshLedger();
    expect(() =>
      ledger.checkCapacity(
        { objId: 'offer-1', effortWords: 100, deadlineMs: Number.NaN, kind: 'translation' },
        NOW_MS,
      ),
    ).toThrow(/deadline/i);
  });
});

// ---------------------------------------------------------------------------
// FR-016d / V25 — recovered work counts even past the ceiling
// ---------------------------------------------------------------------------

describe('work recovered by reconciliation (FR-016d, V25)', () => {
  it('records work that pushes the day past its ceiling, and reports that it did', () => {
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'held', effortWords: 900, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );

    // Reconciliation found an offer the portal says is already ours. The ledger is
    // recording reality here, not deciding anything — refusing it would leave the team
    // holding work that counts against nothing.
    const result = ledger.hold(
      { objId: 'recovered', effortWords: 300, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );

    expect(result).toMatchObject({
      deadlineDay: '2026-09-17',
      committedEffort: 1_200,
      ceiling: CEILING,
      ceilingExceeded: true,
    });
    expect(ledger.committedOn('2026-09-17', THU_MORNING, 'translation')).toBe(1_200);
  });

  it('then blocks further claims for that day as normal, leaving other days alone', () => {
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'held', effortWords: 900, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );
    ledger.hold(
      { objId: 'recovered', effortWords: 300, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );

    expect(ledger.remainingOn('2026-09-17', THU_MORNING, 'translation')).toBe(0); // never negative — spent is spent
    expect(
      ledger.checkCapacity(
        { objId: 'next', effortWords: 1, deadlineMs: THU_AFTERNOON, kind: 'translation' },
        THU_MORNING,
      ),
    ).toMatchObject({ fits: false, reason: 'ceiling_reached' });
    expect(
      ledger.checkCapacity(
        { objId: 'next', effortWords: 500, deadlineMs: FRI_AFTERNOON, kind: 'translation' },
        THU_MORNING,
      ),
    ).toMatchObject({ fits: true });
  });

  it('reports no breach for a hold that lands exactly on the ceiling', () => {
    // Exactly full is full, not over: `committedEffort >= ceiling` here would warn about a
    // day that is precisely within its budget, and an FR-016d warning that cries wolf is a
    // warning nobody reads on the day it matters.
    const { ledger } = freshLedger();
    ledger.hold(
      { objId: 'held', effortWords: 600, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );

    const exact = ledger.hold(
      { objId: 'exact', effortWords: 400, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );
    expect(exact.committedEffort).toBe(CEILING);
    expect(exact.ceilingExceeded).toBe(false);

    // And one word past it is a breach.
    const over = ledger.hold(
      { objId: 'over', effortWords: 1, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      THU_MORNING,
    );
    expect(over.committedEffort).toBe(CEILING + 1);
    expect(over.ceilingExceeded).toBe(true);
  });

  it('reports no breach for a hold that stays inside the ceiling', () => {
    const { ledger } = freshLedger();
    const result = ledger.hold(
      { objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );

    expect(result.ceilingExceeded).toBe(false);
    expect(result.committedEffort).toBe(400);
  });

  it('records work whose deadline it cannot read without claiming a day was breached', () => {
    const { ledger } = freshLedger();
    const result = ledger.hold(
      { objId: 'offer-1', effortWords: 5_000, deadlineMs: null, kind: 'translation' },
      NOW_MS,
    );

    expect(result.deadlineDay).toBeNull();
    // No day means no day total. Reporting 0 for a 5_000-word hold reads as "that day has
    // nothing committed", which is the opposite of what happened.
    expect(result.committedEffort).toBeNull();
    expect(result.ceilingExceeded).toBe(false);
    expect(ledger.heldWorkMissingDeadline(NOW_MS)).toEqual(['offer-1']);
  });
});

describe('two budgets — DTP work does not spend the translation ceiling', () => {
  /**
   * From production on 2026-09-17. The portal offered a DTP preparation job of 956 words
   * (`Members Co Ltd Q3.docx`, Japanese to Japanese). A word of formatting and a word of
   * translation are both "a word" and are nothing like the same commitment — so on a single
   * budget, three such documents would exhaust a 3,500-word day and the bot would then refuse
   * real translation work it had every hour free to do.
   */
  const CALENDAR_ONLY: LedgerWorkCalendar = CALENDAR;
  const THU = '2026-09-17';

  function twoBudgets(
    translation: number,
    monolingual: number,
  ): {
    ledger: StrakerLedger;
    store: StrakerStore;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'straker-two-budgets-'));
    dirs.push(dir);
    const opened = openStrakerDatabase(dir, NOW_MS);
    openDbs.push(opened.db);
    const store = new StrakerStore(opened.db);
    return {
      store,
      ledger: new StrakerLedger(
        store,
        { translation, monolingual },
        CALENDAR_ONLY,
        () => new Map(),
      ),
    };
  }

  it('leaves the translation budget untouched when DTP work is held', () => {
    const { ledger } = twoBudgets(3_500, 30_000);

    ledger.hold(
      { objId: 'dtp-1', effortWords: 3_000, deadlineMs: THU_AFTERNOON, kind: 'monolingual' },
      NOW_MS,
    );

    // The DTP day is spent down …
    expect(ledger.committedOn(THU, NOW_MS, 'monolingual')).toBe(3_000);
    // … and the translation day has not moved at all. This is the whole point.
    expect(ledger.committedOn(THU, NOW_MS, 'translation')).toBe(0);
    expect(ledger.remainingOn(THU, NOW_MS, 'translation')).toBe(3_500);
  });

  it('still admits a translation claim on a day already full of DTP work', () => {
    // The failure this prevents, stated as a claim rather than as a sum.
    const { ledger } = twoBudgets(3_500, 30_000);
    ledger.hold(
      { objId: 'dtp-1', effortWords: 29_000, deadlineMs: THU_AFTERNOON, kind: 'monolingual' },
      NOW_MS,
    );

    const verdict = ledger.checkCapacity(
      { objId: 'job-1', effortWords: 1_000, deadlineMs: THU_AFTERNOON, kind: 'translation' },
      NOW_MS,
    );

    expect(verdict.fits).toBe(true);
  });

  it('refuses DTP work once the DTP budget is full, rather than borrowing the other one', () => {
    // Separation has to hold in both directions, or it is just a bigger single budget.
    const { ledger } = twoBudgets(3_500, 1_000);
    ledger.hold(
      { objId: 'dtp-1', effortWords: 900, deadlineMs: THU_AFTERNOON, kind: 'monolingual' },
      THU_MORNING,
    );

    const verdict = ledger.checkCapacity(
      { objId: 'dtp-2', effortWords: 500, deadlineMs: THU_AFTERNOON, kind: 'monolingual' },
      THU_MORNING,
    );

    expect(verdict.fits).toBe(false);
  });

  it('reports the ceiling of the kind being held, not a single figure for both', () => {
    const { ledger } = twoBudgets(3_500, 30_000);

    const held = ledger.hold(
      { objId: 'dtp-1', effortWords: 100, deadlineMs: THU_AFTERNOON, kind: 'monolingual' },
      THU_MORNING,
    );

    expect(held.ceiling).toBe(30_000);
    expect(ledger.ceilingFor('translation')).toBe(3_500);
  });

  it('charges work whose kind survived a restart, because the store remembers it', () => {
    // The kind lives in `held_work`, not in memory: a bot that restarted between claiming DTP
    // work and reading the budget back must not silently re-file it as translation.
    const { ledger, store } = twoBudgets(3_500, 30_000);
    ledger.hold(
      { objId: 'dtp-1', effortWords: 2_000, deadlineMs: THU_AFTERNOON, kind: 'monolingual' },
      NOW_MS,
    );

    expect(store.heldWork().map((w) => w.kind)).toEqual(['monolingual']);
    expect(ledger.committedOn(THU, NOW_MS, 'translation')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Capacity across the days before a deadline (owner decision, 2026-09-18)
// ---------------------------------------------------------------------------

describe('the ceiling is per working day, and a deadline has every working day before it', () => {
  /**
   * Charging a whole job to its deadline day made a 4,000-word job due Wednesday
   * unclaimable on Monday against a 3,500/day ceiling — though Monday, Tuesday and
   * Wednesday together hold 10,500 — and it did so for good: `exceeds_daily_ceiling_entirely`
   * never clears. The owner's ruling was that such a job must be claimable.
   *
   * The rule now is the earliest-deadline-first one: for every deadline day d, the work due
   * on or before d must fit in `ceiling × working days from today through d`. That is what
   * "3,500 words a day" means if the team works the nearest deadline first, which is what a
   * team does. It is more generous for a far deadline than the old rule and exactly as strict
   * for one due today.
   */
  const MON_0900 = at('2026-09-14T09:00:00+07:00');
  const MON_1700 = at('2026-09-14T17:00:00+07:00');
  const WED_1800 = at('2026-09-16T18:00:00+07:00');
  const DAY = 3_500;

  it('claims 4,000 words due Wednesday on the Monday before — case E', () => {
    const { ledger } = freshLedger(DAY);

    const verdict = ledger.checkCapacity(
      { objId: 'e', effortWords: 4_000, deadlineMs: WED_1800, kind: 'translation' },
      MON_0900,
    );

    expect(verdict).toMatchObject({ fits: true, deadlineDay: '2026-09-16' });
  });

  it('holds work due today to one day’s ceiling', () => {
    // One working day in the window: the ceiling is the ceiling.
    const { ledger } = freshLedger(DAY);
    ledger.hold(
      { objId: 'held', effortWords: 3_300, deadlineMs: MON_1700, kind: 'translation' },
      MON_0900,
    );

    expect(
      ledger.checkCapacity(
        { objId: 'd', effortWords: 300, deadlineMs: MON_1700, kind: 'translation' },
        MON_0900,
      ),
    ).toMatchObject({ fits: false, reason: 'ceiling_reached' });
  });

  it('counts everything due on or before the day, not only what is due on it', () => {
    // Monday is full. Monday to Wednesday holds 10,500, so 7,000 more due Wednesday fits and
    // 7,001 does not — the day before's work is in the sum.
    const { ledger } = freshLedger(DAY);
    ledger.hold(
      { objId: 'mon', effortWords: DAY, deadlineMs: MON_1700, kind: 'translation' },
      MON_0900,
    );

    const fits = ledger.checkCapacity(
      { objId: 'a', effortWords: 7_000, deadlineMs: WED_1800, kind: 'translation' },
      MON_0900,
    );
    const over = ledger.checkCapacity(
      { objId: 'b', effortWords: 7_001, deadlineMs: WED_1800, kind: 'translation' },
      MON_0900,
    );

    expect(fits.fits).toBe(true);
    expect(over).toMatchObject({ fits: false, reason: 'ceiling_reached' });
  });

  it('refuses early work that would eat the time later work was counting on', () => {
    // The direction that is easy to miss. 10,000 words are held for Wednesday — nearly the
    // whole Monday-to-Wednesday window. A 600-word job due MONDAY fits Monday on its own,
    // but it would be worked first and leave Wednesday's 10,000 with 9,900 of room. Checking
    // only the new job's own day would claim it, and break a commitment already made.
    const { ledger } = freshLedger(DAY);
    ledger.hold(
      { objId: 'wed', effortWords: 10_000, deadlineMs: WED_1800, kind: 'translation' },
      MON_0900,
    );

    expect(
      ledger.checkCapacity(
        { objId: 'early', effortWords: 600, deadlineMs: MON_1700, kind: 'translation' },
        MON_0900,
      ),
    ).toMatchObject({ fits: false, reason: 'ceiling_reached' });
  });

  it('refuses a job bigger than every working day before its deadline put together', () => {
    // Still a permanent refusal, still needing a human — but only when no amount of waiting
    // could make room, which is now "bigger than the whole window", not "bigger than a day".
    const { ledger } = freshLedger(DAY);

    expect(
      ledger.checkCapacity(
        { objId: 'huge', effortWords: 10_501, deadlineMs: WED_1800, kind: 'translation' },
        MON_0900,
      ),
    ).toMatchObject({ fits: false, reason: 'exceeds_daily_ceiling_entirely' });
    expect(
      ledger.checkCapacity(
        { objId: 'today', effortWords: 3_501, deadlineMs: MON_1700, kind: 'translation' },
        MON_0900,
      ),
    ).toMatchObject({ fits: false, reason: 'exceeds_daily_ceiling_entirely' });
  });

  it('counts overdue work that is still held as due today', () => {
    // Work past its deadline is still owed, and it is what the team does first. Dropping it
    // because its day is behind us would hand its words back to today.
    const { ledger } = freshLedger(DAY);
    ledger.hold(
      {
        objId: 'late',
        effortWords: 3_000,
        deadlineMs: at('2026-09-11T17:00:00+07:00'), // last Friday
        kind: 'translation',
      },
      MON_0900,
    );

    expect(
      ledger.checkCapacity(
        { objId: 'new', effortWords: 600, deadlineMs: MON_1700, kind: 'translation' },
        MON_0900,
      ),
    ).toMatchObject({ fits: false, reason: 'ceiling_reached' });
  });

  it('gives a weekend no working days of its own', () => {
    // Seen Saturday 03:00, due Monday: the window is Monday alone.
    const { ledger } = freshLedger(DAY);
    const sat = at('2026-09-19T03:00:00+07:00');
    const mon = at('2026-09-21T17:00:00+07:00');

    expect(
      ledger.checkCapacity(
        { objId: 'fits', effortWords: DAY, deadlineMs: mon, kind: 'translation' },
        sat,
      ).fits,
    ).toBe(true);
    expect(
      ledger.checkCapacity(
        { objId: 'over', effortWords: DAY + 1, deadlineMs: mon, kind: 'translation' },
        sat,
      ),
    ).toMatchObject({ fits: false, reason: 'exceeds_daily_ceiling_entirely' });
  });

  it('keeps the two budgets apart across the window as well', () => {
    const { ledger } = freshLedger(DAY);
    ledger.hold(
      { objId: 'dtp', effortWords: 10_500, deadlineMs: WED_1800, kind: 'monolingual' },
      MON_0900,
    );

    expect(
      ledger.checkCapacity(
        { objId: 'tr', effortWords: 4_000, deadlineMs: WED_1800, kind: 'translation' },
        MON_0900,
      ).fits,
    ).toBe(true);
  });

  it('does not warn on recovering work the window can hold', () => {
    // FR-016d's warning follows the same rule, or a legitimately multi-day job found by
    // reconciliation would page as a ceiling breach every time.
    const { ledger } = freshLedger(DAY);

    const result = ledger.hold(
      { objId: 'found', effortWords: 4_000, deadlineMs: WED_1800, kind: 'translation' },
      MON_0900,
    );

    expect(result.ceilingExceeded).toBe(false);
  });
});

describe('a window counts the working time that is left, not the days it touches (review C-1)', () => {
  /**
   * The first cut counted today as a full working day at any hour. Seen Monday 17:45, two
   * 3,400-word jobs due Tuesday 18:00 were BOTH claimed against "Monday + Tuesday = 7,000",
   * though what is really left is 15 minutes of Monday and Tuesday: ~3,600 words. The rule
   * before the window never had this hole — it judged Tuesday's bucket alone — so this was
   * a regression, and on an irreversible claim. Found in review, reproduced against the
   * real decision.
   *
   * Capacity through a day is now the larger of one day's ceiling and the ceiling pro-rated
   * over the working minutes actually left before that day ends. The floor keeps the rule
   * never stricter than the old per-day one: held work may be partly done and the ledger
   * cannot know how far, so pro-rating a same-day afternoon on top of counting that work
   * in full would refuse work that fits.
   */
  const DAY = 3_500;
  const MON_1745 = at('2026-09-14T17:45:00+07:00');
  const MON_2200 = at('2026-09-14T22:00:00+07:00');
  const TUE_1800 = at('2026-09-15T18:00:00+07:00');

  for (const [label, nowMs] of [
    ['17:45', MON_1745],
    ['22:00', MON_2200],
  ] as const) {
    it(`claims only one of two 3,400-word jobs due tomorrow when seen at ${label}`, () => {
      const { ledger } = freshLedger(DAY);
      ledger.hold(
        { objId: 'a', effortWords: 3_400, deadlineMs: TUE_1800, kind: 'translation' },
        nowMs,
      );

      expect(
        ledger.checkCapacity(
          { objId: 'b', effortWords: 3_400, deadlineMs: TUE_1800, kind: 'translation' },
          nowMs,
        ),
      ).toMatchObject({ fits: false, reason: 'ceiling_reached' });
    });
  }

  it('does not pro-rate same-day work below one day’s ceiling', () => {
    // 14:00, 3,000 held and due today, 400 more due today: the old rule claimed it (3,400
    // of 3,500) and so does this one. Pro-rating alone would say four hours hold 1,555
    // and refuse — while the 3,000 may well be half done.
    const { ledger } = freshLedger(DAY);
    const mon1400 = at('2026-09-14T14:00:00+07:00');
    const mon1700 = at('2026-09-14T17:00:00+07:00');
    ledger.hold(
      { objId: 'held', effortWords: 3_000, deadlineMs: mon1700, kind: 'translation' },
      at('2026-09-14T09:00:00+07:00'),
    );

    expect(
      ledger.checkCapacity(
        { objId: 'new', effortWords: 400, deadlineMs: mon1700, kind: 'translation' },
        mon1400,
      ).fits,
    ).toBe(true);
  });

  it('still gives a multi-day window its full days when judged at the start of one', () => {
    // Case E at Monday 09:00 is unchanged: three whole days are left.
    const { ledger } = freshLedger(DAY);

    expect(
      ledger.checkCapacity(
        {
          objId: 'e',
          effortWords: 10_500,
          deadlineMs: at('2026-09-16T18:00:00+07:00'),
          kind: 'translation',
        },
        at('2026-09-14T09:00:00+07:00'),
      ).fits,
    ).toBe(true);
  });

  it('shrinks the same window as the day runs out', () => {
    // The same 10,500 at Monday 13:30 has 4.5 + 9 + 9 = 22.5 working hours left: 8,750.
    const { ledger } = freshLedger(DAY);

    expect(
      ledger.checkCapacity(
        {
          objId: 'e',
          effortWords: 10_500,
          deadlineMs: at('2026-09-16T18:00:00+07:00'),
          kind: 'translation',
        },
        at('2026-09-14T13:30:00+07:00'),
      ),
    ).toMatchObject({ fits: false, reason: 'exceeds_daily_ceiling_entirely' });
  });
});
