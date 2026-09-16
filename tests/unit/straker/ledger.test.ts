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
 *     decision — it reports the breach and then blocks further claims for that day.
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

const CALENDAR: LedgerWorkCalendar = {
  hoursStartMin: 9 * 60,
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
      ? new StrakerLedger(store, ceiling, CALENDAR)
      : new StrakerLedger(store, ceiling, CALENDAR, holidaysAt);
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
    ledger.hold({ objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON }, NOW_MS);

    expect(ledger.committedOn('2026-09-17', NOW_MS)).toBe(400);
    expect(ledger.committedOn('2026-09-14', NOW_MS)).toBe(0);
  });

  it('charges a deadline that falls before the working day starts to the previous one', () => {
    const { ledger } = freshLedger();
    // 08:00 Wednesday leaves zero working minutes on Wednesday, so the work is Tuesday's.
    ledger.hold({ objId: 'offer-1', effortWords: 400, deadlineMs: WED_BEFORE_WORK }, NOW_MS);

    expect(ledger.committedOn('2026-09-15', NOW_MS)).toBe(400);
    expect(ledger.committedOn('2026-09-16', NOW_MS)).toBe(0);
  });

  it('charges a weekend deadline to the working day before it', () => {
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'offer-1', effortWords: 400, deadlineMs: SAT_MIDDAY }, NOW_MS);

    expect(ledger.committedOn('2026-09-18', NOW_MS)).toBe(400);
    expect(ledger.committedOn('2026-09-19', NOW_MS)).toBe(0);
  });

  it('honours the work calendar, so a holiday deadline lands on the working day before it', () => {
    const holidays = new Map([['2026-09-18', 'Invented Day']]);
    const { ledger } = freshLedger(CEILING, () => holidays);
    ledger.hold({ objId: 'offer-1', effortWords: 400, deadlineMs: FRI_AFTERNOON }, NOW_MS);

    expect(ledger.committedOn('2026-09-17', NOW_MS)).toBe(400);
    expect(ledger.committedOn('2026-09-18', NOW_MS)).toBe(0);
  });

  it('sums several offers due on the same day and keeps different days apart', () => {
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'a', effortWords: 300, deadlineMs: THU_AFTERNOON }, NOW_MS);
    ledger.hold({ objId: 'b', effortWords: 250, deadlineMs: THU_AFTERNOON }, NOW_MS);
    ledger.hold({ objId: 'c', effortWords: 100, deadlineMs: FRI_AFTERNOON }, NOW_MS);

    expect([...ledger.committedByDay(NOW_MS)].sort()).toEqual([
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
    ledger.hold({ objId: 'offer-1', effortWords: 500, deadlineMs: THU_AFTERNOON }, NOW_MS);
    expect(ledger.committedOn('2026-09-17', NOW_MS)).toBe(500);

    expect(ledger.release('offer-1', NOW_MS + 3_600_000)).toBe(true);
    expect(ledger.committedOn('2026-09-17', NOW_MS)).toBe(0);
    expect(ledger.remainingOn('2026-09-17', NOW_MS)).toBe(CEILING);
  });

  it('reports what the held set says even when the ledger itself was never told', () => {
    // The decisive test that no counter is being kept: the held set is changed behind the
    // ledger's back, through a second store on the same database, and the ledger's answer
    // moves with it. A counter would still be reporting the old number.
    const { ledger, store } = freshLedger();
    ledger.hold({ objId: 'offer-1', effortWords: 500, deadlineMs: THU_AFTERNOON }, NOW_MS);

    store.hold({
      objId: 'offer-2',
      effortWords: 200,
      deadlineMs: THU_AFTERNOON,
      heldSinceMs: NOW_MS,
    });
    expect(ledger.committedOn('2026-09-17', NOW_MS)).toBe(700);

    store.release('offer-1', NOW_MS);
    expect(ledger.committedOn('2026-09-17', NOW_MS)).toBe(200);
  });

  it('counts an offer held twice once, so a re-run after a crash does not double the day', () => {
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'offer-1', effortWords: 500, deadlineMs: THU_AFTERNOON }, NOW_MS);
    ledger.hold({ objId: 'offer-1', effortWords: 500, deadlineMs: THU_AFTERNOON }, NOW_MS + 1_000);

    expect(ledger.committedOn('2026-09-17', NOW_MS)).toBe(500);
  });

  it('names held work whose deadline it cannot read, rather than quietly under-counting', () => {
    const { ledger } = freshLedger();
    // Reconciliation can hand back work the portal says is ours without a readable
    // deadline. Refusing to record it would lose it (FR-016d); bucketing it under a
    // guessed day would corrupt the ceiling. It is recorded, excluded, and named.
    ledger.hold({ objId: 'offer-1', effortWords: 500, deadlineMs: null }, NOW_MS);

    expect([...ledger.committedByDay(NOW_MS)]).toEqual([]);
    expect(ledger.heldWorkMissingDeadline(NOW_MS)).toEqual(['offer-1']);
  });
});

// ---------------------------------------------------------------------------
// A ceiling of Straker's own (FR-009)
// ---------------------------------------------------------------------------

describe('a ceiling of its own', () => {
  it('uses the ceiling it was given and reads no figure from the XTM bot', () => {
    const { ledger } = freshLedger(2_500);
    expect(ledger.ceiling).toBe(2_500);
    expect(ledger.remainingOn('2026-09-17', NOW_MS)).toBe(2_500);
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
      ledger.hold({ objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON }, NOW_MS);

      expect(ledger.ceiling).toBe(1_000);
      expect(ledger.remainingOn('2026-09-17', NOW_MS)).toBe(600);
      expect(
        ledger.checkCapacity({ objId: 'big', effortWords: 900, deadlineMs: THU_AFTERNOON }, NOW_MS),
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
    const ledger = new StrakerLedger(new StrakerStore(opened.db), CEILING, CALENDAR);

    ledger.hold({ objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON }, NOW_MS);
    ledger.checkCapacity({ objId: 'offer-2', effortWords: 400, deadlineMs: THU_AFTERNOON }, NOW_MS);
    ledger.committedByDay(NOW_MS);
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
    expect(imports.some((m) => m.endsWith('/src/schedule/acceptCapacity.js'))).toBe(true);
    expect(imports.some((m) => m.endsWith('/src/straker/outcomePolicy.js'))).toBe(true);
    expect(imports.filter((m) => /(^|\/)(state|config)(\/|$)/.test(m))).toEqual([]);
  });

  it('draws the line at the ceiling itself: exactly full fits, one word more does not', () => {
    // The boundary is where an off-by-one turns into an over-commitment, and an
    // irreversible claim is a poor place to discover one.
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'held', effortWords: 600, deadlineMs: THU_AFTERNOON }, NOW_MS);

    expect(
      ledger.checkCapacity({ objId: 'exact', effortWords: 400, deadlineMs: THU_AFTERNOON }, NOW_MS),
    ).toMatchObject({ fits: true });
    expect(
      ledger.checkCapacity({ objId: 'over', effortWords: 401, deadlineMs: THU_AFTERNOON }, NOW_MS),
    ).toMatchObject({ fits: false, reason: 'ceiling_reached' });
  });

  it('refuses a ceiling that is not a positive number rather than reading it as unlimited', () => {
    const dir = mkdtempSync(join(tmpdir(), 'straker-ledger-'));
    dirs.push(dir);
    const opened = openStrakerDatabase(dir, NOW_MS);
    openDbs.push(opened.db);
    const store = new StrakerStore(opened.db);

    expect(() => new StrakerLedger(store, 0, CALENDAR)).toThrow(/ceiling/i);
    expect(() => new StrakerLedger(store, -1, CALENDAR)).toThrow(/ceiling/i);
  });

  it('measures effort in raw words, and says so in the reason a human reads', () => {
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'held', effortWords: 900, deadlineMs: THU_AFTERNOON }, NOW_MS);

    const verdict = ledger.checkCapacity(
      { objId: 'next', effortWords: 300, deadlineMs: THU_AFTERNOON },
      NOW_MS,
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
      { objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON },
      NOW_MS,
    );

    expect(verdict).toMatchObject({ fits: true, deadlineDay: '2026-09-17' });
    if (verdict.fits) expect(verdict.remaining).toBe(CEILING);
  });

  it('blocks with ceiling_reached once the day is spent, which frees up as work finishes', () => {
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'held', effortWords: 900, deadlineMs: THU_AFTERNOON }, NOW_MS);

    const verdict = ledger.checkCapacity(
      { objId: 'offer-1', effortWords: 300, deadlineMs: THU_AFTERNOON },
      NOW_MS,
    );
    expect(verdict).toMatchObject({ fits: false, reason: 'ceiling_reached' });
  });

  it('blocks an offer larger than a whole day with its own reason, because it needs a human', () => {
    const { ledger } = freshLedger();
    const verdict = ledger.checkCapacity(
      { objId: 'offer-1', effortWords: CEILING + 1, deadlineMs: THU_AFTERNOON },
      NOW_MS,
    );

    // Distinct from an ordinary ceiling skip: no amount of waiting clears it, so it would
    // otherwise recur every day forever.
    expect(verdict).toMatchObject({ fits: false, reason: 'exceeds_daily_ceiling_entirely' });
  });

  it('applies the ceiling per day, so a full Thursday does not block a Friday deadline', () => {
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'held', effortWords: CEILING, deadlineMs: THU_AFTERNOON }, NOW_MS);

    expect(
      ledger.checkCapacity({ objId: 'a', effortWords: 100, deadlineMs: THU_AFTERNOON }, NOW_MS),
    ).toMatchObject({ fits: false });
    expect(
      ledger.checkCapacity({ objId: 'b', effortWords: 100, deadlineMs: FRI_AFTERNOON }, NOW_MS),
    ).toMatchObject({ fits: true });
  });

  it('treats a deadline it cannot read as a hard failure, never as a day with room', () => {
    const { ledger } = freshLedger();
    expect(() =>
      ledger.checkCapacity({ objId: 'offer-1', effortWords: 100, deadlineMs: Number.NaN }, NOW_MS),
    ).toThrow(/deadline/i);
  });
});

// ---------------------------------------------------------------------------
// FR-016d / V25 — recovered work counts even past the ceiling
// ---------------------------------------------------------------------------

describe('work recovered by reconciliation (FR-016d, V25)', () => {
  it('records work that pushes the day past its ceiling, and reports that it did', () => {
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'held', effortWords: 900, deadlineMs: THU_AFTERNOON }, NOW_MS);

    // Reconciliation found an offer the portal says is already ours. The ledger is
    // recording reality here, not deciding anything — refusing it would leave the team
    // holding work that counts against nothing.
    const result = ledger.hold(
      { objId: 'recovered', effortWords: 300, deadlineMs: THU_AFTERNOON },
      NOW_MS,
    );

    expect(result).toMatchObject({
      deadlineDay: '2026-09-17',
      committedEffort: 1_200,
      ceiling: CEILING,
      ceilingExceeded: true,
    });
    expect(ledger.committedOn('2026-09-17', NOW_MS)).toBe(1_200);
  });

  it('then blocks further claims for that day as normal, leaving other days alone', () => {
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'held', effortWords: 900, deadlineMs: THU_AFTERNOON }, NOW_MS);
    ledger.hold({ objId: 'recovered', effortWords: 300, deadlineMs: THU_AFTERNOON }, NOW_MS);

    expect(ledger.remainingOn('2026-09-17', NOW_MS)).toBe(0); // never negative — spent is spent
    expect(
      ledger.checkCapacity({ objId: 'next', effortWords: 1, deadlineMs: THU_AFTERNOON }, NOW_MS),
    ).toMatchObject({ fits: false, reason: 'ceiling_reached' });
    expect(
      ledger.checkCapacity({ objId: 'next', effortWords: 500, deadlineMs: FRI_AFTERNOON }, NOW_MS),
    ).toMatchObject({ fits: true });
  });

  it('reports no breach for a hold that lands exactly on the ceiling', () => {
    // Exactly full is full, not over: `committedEffort >= ceiling` here would warn about a
    // day that is precisely within its budget, and an FR-016d warning that cries wolf is a
    // warning nobody reads on the day it matters.
    const { ledger } = freshLedger();
    ledger.hold({ objId: 'held', effortWords: 600, deadlineMs: THU_AFTERNOON }, NOW_MS);

    const exact = ledger.hold(
      { objId: 'exact', effortWords: 400, deadlineMs: THU_AFTERNOON },
      NOW_MS,
    );
    expect(exact.committedEffort).toBe(CEILING);
    expect(exact.ceilingExceeded).toBe(false);

    // And one word past it is a breach.
    const over = ledger.hold({ objId: 'over', effortWords: 1, deadlineMs: THU_AFTERNOON }, NOW_MS);
    expect(over.committedEffort).toBe(CEILING + 1);
    expect(over.ceilingExceeded).toBe(true);
  });

  it('reports no breach for a hold that stays inside the ceiling', () => {
    const { ledger } = freshLedger();
    const result = ledger.hold(
      { objId: 'offer-1', effortWords: 400, deadlineMs: THU_AFTERNOON },
      NOW_MS,
    );

    expect(result.ceilingExceeded).toBe(false);
    expect(result.committedEffort).toBe(400);
  });

  it('records work whose deadline it cannot read without claiming a day was breached', () => {
    const { ledger } = freshLedger();
    const result = ledger.hold({ objId: 'offer-1', effortWords: 5_000, deadlineMs: null }, NOW_MS);

    expect(result.deadlineDay).toBeNull();
    // No day means no day total. Reporting 0 for a 5_000-word hold reads as "that day has
    // nothing committed", which is the opposite of what happened.
    expect(result.committedEffort).toBeNull();
    expect(result.ceilingExceeded).toBe(false);
    expect(ledger.heldWorkMissingDeadline(NOW_MS)).toEqual(['offer-1']);
  });
});
