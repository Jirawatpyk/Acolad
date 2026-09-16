/**
 * T057 / T058 / T059 — the combined daily view across both portals (FR-018, US3, V17).
 *
 * ## What this view is for, and therefore what these tests are about
 *
 * Each portal enforces its own daily ceiling against one translation crew. Separate
 * ledgers were chosen deliberately, for complete isolation between the two bots, at the
 * known cost that the two ceilings can sum past what the crew can actually do. This view
 * is the agreed mitigation — shared **visibility**, not shared enforcement — so a human
 * can lower a ceiling before the crew is over-committed.
 *
 * That makes a *wrong* combined number worse than no combined number at all: it is the one
 * figure someone would act on. Two of the three tasks below are therefore about refusing to
 * produce it, and the third is about the two figures that say whether a bot is limping.
 *
 * ## Why almost nothing here needs a database
 *
 * The substance is the comparison and the suppression rules; the file handles are not. The
 * combiner is pure over two already-read "portal readings", each of which is either a
 * reading or a stated failure, so every rule can be exercised directly. The thin readers
 * are tested separately, against real temporary SQLite files, for the two claims that can
 * only be shown against a real database: that the read cannot write, and that a state
 * directory which has never existed is reported rather than created.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../../src/state/db.js';
import { WORDS_UNIT, WWC_UNIT } from '../../../src/schedule/effort.js';
import {
  combineDailyView,
  computeUptime,
  countOutboxRetries,
  cycleTimestampsIn,
  effectiveDayMapper,
  formatCombinedDailyView,
  openRecordReadOnly,
  parseSummaryPeriod,
  readCeilingFromEnv,
  readCycleTimestamps,
  readStrakerWorkload,
  strakerWinRateRow,
  combinedReportRows,
  readXtmWorkload,
  UPTIME_MIN_GRACE_MS,
  type Measured,
  type UptimeReading,
  type PortalResult,
  type PortalWorkload,
  type SummaryPeriod,
} from '../../../src/straker/combinedSummary.js';

const SOURCE = fileURLToPath(new URL('../../../src/straker/combinedSummary.ts', import.meta.url));

/**
 * Every module `file` imports, with relative specifiers resolved to real paths. Copied in
 * shape from `ledger.test.ts`: it resolves rather than matching text, because a text guard
 * is walked past by spelling `../../src/state/db.js` for `../state/db.js`.
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

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'combined-summary-'));
  dirs.push(d);
  return d;
}

// September 2026 carries no Thai public holiday, so a weekday in it is unambiguously a
// working day and the dates below say what they mean.
//   Mon 14 · Tue 15 · Wed 16 · Thu 17 · Fri 18 · Sat 19 · Sun 20
const NOW_MS = Date.parse('2026-09-16T10:00:00+07:00'); // Wednesday, mid-morning
const PERIOD: SummaryPeriod = {
  fromMs: NOW_MS - 24 * 3_600_000,
  toMs: NOW_MS,
  label: 'the last 24 hours',
};

const known = <T>(value: T): Measured<T> => ({ known: true, value });

/** A readable portal, with everything known unless the caller says otherwise. */
function workload(over: Partial<PortalWorkload> & Pick<PortalWorkload, 'portal'>): PortalWorkload {
  return {
    source: `state/${over.portal}.db`,
    unit: WORDS_UNIT,
    committedEffort: 0,
    heldItems: 0,
    byDeadlineDay: new Map(),
    effortMissingDeadline: 0,
    itemsWithoutEffort: 0,
    ceilingPerDay: known(1_000),
    retries: known(0),
    uptime: known({ pct: 100, downtimeMs: 0, observedMs: 86_400_000, cycles: 8_640 }),
    ...over,
  };
}

const reading = (w: PortalWorkload): PortalResult => ({ read: true, workload: w });
const unreadable = (
  portal: 'XTM' | 'Straker',
  why: string,
  uptime: Measured<UptimeReading> = { known: false, why: 'not measured in this test' },
): PortalResult => ({
  read: false,
  failure: { portal, source: `state/${portal}.db`, why, uptime },
});

/** The ordinary case: both portals readable, both measuring in raw words. */
function bothReadable(): PortalResult[] {
  return [
    reading(
      workload({
        portal: 'XTM',
        source: 'state/acolad.db',
        committedEffort: 1_200,
        heldItems: 3,
        byDeadlineDay: new Map([
          ['2026-09-17', 900],
          ['2026-09-18', 300],
        ]),
        ceilingPerDay: known(3_500),
        retries: known(4),
        uptime: known({ pct: 99.2, downtimeMs: 691_200, observedMs: 86_400_000, cycles: 4_200 }),
      }),
    ),
    reading(
      workload({
        portal: 'Straker',
        source: 'state/straker/straker.db',
        committedEffort: 800,
        heldItems: 2,
        byDeadlineDay: new Map([['2026-09-17', 800]]),
        ceilingPerDay: known(1_000),
        retries: known(1),
        uptime: known({ pct: 100, downtimeMs: 0, observedMs: 86_400_000, cycles: 8_600 }),
      }),
    ),
  ];
}

// ===========================================================================================
// T057 — reads BOTH records; each portal separately, the combined total, and the period's
//        retries performed and uptime (FR-018, V17)
// ===========================================================================================

describe('T057 — the combined daily view reports both portals, the total, retries and uptime', () => {
  it('reports each portal separately, by name, with its own figure and unit', () => {
    // Kills: collapsing the two records into a single number. The separate figures are what
    // tell a human WHICH ceiling to lower, which is the only action this view enables.
    const view = combineDailyView(PERIOD, bothReadable());

    expect(view.portals.map((p) => (p.read ? p.workload.portal : p.failure.portal))).toEqual([
      'XTM',
      'Straker',
    ]);
    const xtm = view.portals[0];
    const straker = view.portals[1];
    expect(xtm?.read === true && xtm.workload.committedEffort).toBe(1_200);
    expect(straker?.read === true && straker.workload.committedEffort).toBe(800);
  });

  it('reports the combined total when both records are readable and measured alike', () => {
    // Kills: never producing a total at all, and producing one portal's figure as "the
    // total" — 1200 and 800 are distinguishable from 2000 in both directions.
    const view = combineDailyView(PERIOD, bothReadable());

    expect(view.committedTotal).toEqual({ shown: true, value: 2_000, unit: WORDS_UNIT });
    expect(view.ceilingTotal).toEqual({ shown: true, value: 4_500, unit: WORDS_UNIT });
  });

  it('shows the combined workload per deadline day, which is the day each ceiling is keyed to', () => {
    // A total across all future days cannot answer "is the crew over-committed on Thursday?"
    // — and Thursday is the question, because both ceilings are per deadline day.
    const view = combineDailyView(PERIOD, bothReadable());

    expect(view.byDeadlineDay.map((d) => d.day)).toEqual(['2026-09-17', '2026-09-18']);
    const thursday = view.byDeadlineDay[0];
    expect(thursday?.perPortal.get('XTM')).toBe(900);
    expect(thursday?.perPortal.get('Straker')).toBe(800);
    expect(thursday?.combined).toEqual({ shown: true, value: 1_700, unit: WORDS_UNIT });
    // Friday has XTM work only; Straker contributes nothing rather than being absent.
    expect(view.byDeadlineDay[1]?.combined).toEqual({
      shown: true,
      value: 300,
      unit: WORDS_UNIT,
    });
  });

  it('reports retries performed for the period — the figure that shows a bot limping', () => {
    // Kills: dropping retries from the view. A bot retrying its way through every cycle
    // still reports success, so this is the figure that distinguishes limping from healthy.
    const view = combineDailyView(PERIOD, bothReadable());

    expect(view.retriesTotal).toEqual({ known: true, value: 5 });
    expect(view.portals[0]?.read === true && view.portals[0].workload.retries).toEqual({
      known: true,
      value: 4,
    });
  });

  it('reports uptime PER PORTAL and never as one averaged figure', () => {
    // Kills: averaging. One bot dead and one healthy averages to 50% "uptime", which reads
    // as a degraded system rather than as a system with a dead half — and FR-026a exists
    // precisely so a stopped bot is noticed on its own rather than masked by the other.
    const view = combineDailyView(PERIOD, [
      reading(
        workload({
          portal: 'XTM',
          uptime: known({ pct: 100, downtimeMs: 0, observedMs: 86_400_000, cycles: 4_000 }),
        }),
      ),
      reading(
        workload({
          portal: 'Straker',
          uptime: known({ pct: 0, downtimeMs: 86_400_000, observedMs: 86_400_000, cycles: 1 }),
        }),
      ),
    ]);

    expect(view.uptime.map((u) => u.portal)).toEqual(['XTM', 'Straker']);
    expect(view.uptime[0]?.uptime).toMatchObject({ known: true, value: { pct: 100 } });
    expect(view.uptime[1]?.uptime).toMatchObject({ known: true, value: { pct: 0 } });
    expect(view).not.toHaveProperty('uptimeTotal');
  });

  it('renders all four — both portals, the total, retries and uptime — in the printed view (V17)', () => {
    const text = formatCombinedDailyView(combineDailyView(PERIOD, bothReadable()));

    expect(text).toContain('XTM');
    expect(text).toContain('Straker');
    expect(text).toMatch(/combined/i);
    expect(text).toContain('2,000');
    expect(text).toMatch(/retries performed/i);
    expect(text).toMatch(/uptime/i);
    expect(text).toContain('99.2%');
  });
});

// ===========================================================================================
// T058 — one record unreadable is STATED PLAINLY; a partial total is never presented as whole
//        (FR-018, US3 scenario 2)
// ===========================================================================================

describe('T058 — an unreadable record is stated plainly, never hidden inside a total', () => {
  it('still reports the portal it can read', () => {
    // Half a view beats no view: the readable side is exactly what the coordinator can act
    // on, and refusing to report it would make one bot's outage blind the other's ceiling.
    const view = combineDailyView(PERIOD, [
      unreadable('XTM', 'SQLITE_CANTOPEN: state/acolad.db'),
      reading(workload({ portal: 'Straker', committedEffort: 800, heldItems: 2 })),
    ]);

    const straker = view.portals[1];
    expect(straker?.read).toBe(true);
    expect(straker?.read === true && straker.workload.committedEffort).toBe(800);
  });

  it('SUPPRESSES the combined total when one record is unreadable, naming the portal and why', () => {
    // THE test of this task. A number that is quietly half the truth is worse than no
    // number, because it is the one a human would act on. Kills: returning 800 as "the
    // combined total" when only Straker could be read.
    const view = combineDailyView(PERIOD, [
      unreadable('XTM', 'SQLITE_CANTOPEN: state/acolad.db'),
      reading(workload({ portal: 'Straker', committedEffort: 800 })),
    ]);

    expect(view.committedTotal).toMatchObject({ shown: false, withheld: 'record_unreadable' });
    expect(view.committedTotal.shown).toBe(false);
    if (view.committedTotal.shown === false) {
      expect(view.committedTotal.why).toContain('XTM');
    }
    expect(view.ceilingTotal.shown).toBe(false);
  });

  it('suppresses the per-day combined figure too, not merely the headline', () => {
    // The per-day rows are where the over-commitment decision is actually made; a headline
    // that admits the gap while the day rows quietly total one portal is the same lie in
    // smaller type.
    const view = combineDailyView(PERIOD, [
      unreadable('XTM', 'unreadable'),
      reading(workload({ portal: 'Straker', byDeadlineDay: new Map([['2026-09-17', 800]]) })),
    ]);

    expect(view.byDeadlineDay[0]?.perPortal.get('Straker')).toBe(800);
    expect(view.byDeadlineDay[0]?.combined.shown).toBe(false);
  });

  it('reports retries as UNKNOWN, never as the readable portal’s count alone', () => {
    // An unavailable source reads as unknown, never as zero or as a partial sum — the same
    // rule the uptime derivation follows, for the same reason.
    const view = combineDailyView(PERIOD, [
      unreadable('XTM', 'unreadable'),
      reading(workload({ portal: 'Straker', retries: known(1) })),
    ]);

    expect(view.retriesTotal.known).toBe(false);
  });

  it('states the gap in words in the printed view, and prints no figure where the total was', () => {
    const view = combineDailyView(PERIOD, [
      unreadable('XTM', 'SQLITE_CANTOPEN: no such file'),
      reading(workload({ portal: 'Straker', committedEffort: 800 })),
    ]);
    const text = formatCombinedDailyView(view);

    expect(text).toMatch(/unreadable/i);
    expect(text).toContain('XTM');
    expect(text).toMatch(/not shown|no combined total|cannot be/i);
    // The readable portal's own 800 may appear on its own line; what must not appear is a
    // line offering a combined figure.
    expect(text).not.toMatch(/combined committed workload:\s*[\d,]/i);
    expect(view.gaps.join(' ')).toMatch(/XTM/);
  });

  it('keeps reporting uptime for a portal whose record is broken — the limping case', () => {
    // Uptime comes from the cycle log, a different source from the record. A process that
    // is still polling with a corrupt database is exactly the state these two figures exist
    // to distinguish from a dead one, and discarding the liveness would hide it.
    const view = combineDailyView(PERIOD, [
      unreadable('XTM', 'SQLITE_CORRUPT', {
        known: true,
        value: { pct: 100, downtimeMs: 0, observedMs: 86_400_000, cycles: 4_300 },
      }),
      reading(workload({ portal: 'Straker' })),
    ]);

    expect(view.uptime[0]).toMatchObject({ portal: 'XTM', uptime: { known: true } });
    expect(formatCombinedDailyView(view)).toMatch(/XTM uptime:\s*100\.0%/);
  });

  it('withholds everything combinable when a portal is simply absent, not merely unreadable', () => {
    // The degenerate call: only one portal handed in at all. A "combined" figure over one
    // portal is that portal's figure wearing a label it has not earned.
    const view = combineDailyView(PERIOD, [
      reading(workload({ portal: 'XTM', retries: known(4) })),
    ]);

    expect(view.committedTotal.shown).toBe(false);
    expect(view.retriesTotal.known).toBe(false);
    if (view.retriesTotal.known === false) expect(view.retriesTotal.why).toContain('Straker');
  });

  it('withholds the total when BOTH records are unreadable, and names both', () => {
    const view = combineDailyView(PERIOD, [
      unreadable('XTM', 'locked'),
      unreadable('Straker', 'no such file'),
    ]);

    expect(view.committedTotal.shown).toBe(false);
    expect(view.byDeadlineDay).toEqual([]);
    expect(view.gaps.join(' ')).toContain('XTM');
    expect(view.gaps.join(' ')).toContain('Straker');
  });
});

// ===========================================================================================
// T059 — the total is suppressed or labelled when the two portals do not measure in the
//        same unit (FR-018)
// ===========================================================================================

describe('T059 — unlike units never get added together', () => {
  it('SUPPRESSES the combined total when XTM measures WWC and Straker measures words', () => {
    // Not hypothetical: the XTM bot's effort metric is switchable (ACCEPT_EFFORT_METRIC,
    // code default `wwc`), while Straker always measures raw words. Adding the two produces
    // a confident wrong number, which is the failure mode this whole view exists to prevent.
    // Kills: summing regardless of unit — 1200 + 800 = 2000 would be returned as a total.
    const view = combineDailyView(PERIOD, [
      reading(workload({ portal: 'XTM', unit: WWC_UNIT, committedEffort: 1_200 })),
      reading(workload({ portal: 'Straker', unit: WORDS_UNIT, committedEffort: 800 })),
    ]);

    expect(view.committedTotal).toMatchObject({ shown: false, withheld: 'unlike_units' });
    if (view.committedTotal.shown === false) {
      expect(view.committedTotal.why).toMatch(/WWC/);
      expect(view.committedTotal.why).toMatch(/words/);
    }
    expect(view.ceilingTotal.shown).toBe(false);
  });

  it('still reports each portal separately, each labelled with its own unit', () => {
    // Suppression must not cost the reader the two figures that are still true.
    const view = combineDailyView(PERIOD, [
      reading(workload({ portal: 'XTM', unit: WWC_UNIT, committedEffort: 1_200 })),
      reading(workload({ portal: 'Straker', unit: WORDS_UNIT, committedEffort: 800 })),
    ]);
    const text = formatCombinedDailyView(view);

    expect(text).toContain('1,200 WWC');
    expect(text).toContain('800 words');
    expect(text).toMatch(/different units|not the same unit|unlike/i);
  });

  it('suppresses the per-day combined figure under the same rule', () => {
    const view = combineDailyView(PERIOD, [
      reading(
        workload({
          portal: 'XTM',
          unit: WWC_UNIT,
          byDeadlineDay: new Map([['2026-09-17', 900]]),
        }),
      ),
      reading(
        workload({
          portal: 'Straker',
          unit: WORDS_UNIT,
          byDeadlineDay: new Map([['2026-09-17', 800]]),
        }),
      ),
    ]);

    expect(view.byDeadlineDay[0]?.combined).toMatchObject({
      shown: false,
      withheld: 'unlike_units',
    });
  });

  it('shows the total when the units agree — the control that proves the rule is not vacuous', () => {
    // Without this, a combiner that never shows a total would pass every test above.
    const view = combineDailyView(PERIOD, [
      reading(workload({ portal: 'XTM', unit: WWC_UNIT, committedEffort: 1_200 })),
      reading(workload({ portal: 'Straker', unit: WWC_UNIT, committedEffort: 800 })),
    ]);

    expect(view.committedTotal).toEqual({ shown: true, value: 2_000, unit: WWC_UNIT });
  });

  it('reports a single readable portal without a total, since one portal is not a combination', () => {
    // Degenerate but real: run the report before the Straker bot has ever started.
    const view = combineDailyView(PERIOD, [
      reading(workload({ portal: 'XTM', committedEffort: 1_200 })),
      unreadable('Straker', 'never started'),
    ]);

    expect(view.committedTotal.shown).toBe(false);
  });
});

// ===========================================================================================
// Uptime and retries — derivation, and what they say when the source is not there
// ===========================================================================================

describe('uptime is derived from the bot’s own cycle log, and is unknown when there is none', () => {
  const spec = { fromMs: PERIOD.fromMs, toMs: PERIOD.toMs, intervalMs: 20_000 };

  /** A cycle line every `intervalMs` across the whole period, as the logger writes them. */
  function steadyCycles(fromMs: number, toMs: number, intervalMs: number): number[] {
    const out: number[] = [];
    for (let t = fromMs; t <= toMs; t += intervalMs) out.push(t);
    return out;
  }

  it('reports UNKNOWN — never 100% — when the log source is unavailable', () => {
    // The most flattering possible lie: a bot with no log file reporting perfect uptime and
    // no retries. An absent source is an absence of evidence, not evidence of health.
    const absent: Measured<readonly number[]> = { known: false, why: 'no log directory at logs/' };

    const uptime = computeUptime(absent, spec);

    expect(uptime.known).toBe(false);
    if (uptime.known === false) expect(uptime.why).toContain('logs/');
  });

  it('reports UNKNOWN when the log exists but carries no cycle line in the period', () => {
    // Zero cycles in 24 hours could mean a dead bot or a rotated-away log, and the two are
    // not distinguishable from here. 0% would accuse; 100% would flatter; unknown is true.
    const uptime = computeUptime(known([] as readonly number[]), spec);

    expect(uptime.known).toBe(false);
  });

  it('reads ~100% from an unbroken run of cycles', () => {
    const uptime = computeUptime(known(steadyCycles(spec.fromMs, spec.toMs, 20_000)), spec);

    expect(uptime.known).toBe(true);
    if (uptime.known) {
      expect(uptime.value.pct).toBeCloseTo(100, 5);
      expect(uptime.value.downtimeMs).toBe(0);
      expect(uptime.value.cycles).toBeGreaterThan(4_000);
    }
  });

  it('counts a long silence as downtime, in proportion to the silence', () => {
    // Four hours with no cycle line is four hours the bot was not polling. Anything that
    // reported this as healthy would make the figure worthless.
    const gapStart = spec.fromMs + 10 * 3_600_000;
    const cycles = [
      ...steadyCycles(spec.fromMs, gapStart, 20_000),
      ...steadyCycles(gapStart + 4 * 3_600_000, spec.toMs, 20_000),
    ];

    const uptime = computeUptime(known(cycles), spec);

    expect(uptime.known).toBe(true);
    if (uptime.known) {
      expect(uptime.value.downtimeMs).toBeGreaterThan(3.9 * 3_600_000);
      expect(uptime.value.pct).toBeGreaterThan(80);
      expect(uptime.value.pct).toBeLessThan(85);
    }
  });

  it('forgives a gap inside the grace window, so ordinary jitter is not an outage', () => {
    const cycles = [spec.fromMs, spec.fromMs + UPTIME_MIN_GRACE_MS - 1, spec.toMs];

    const uptime = computeUptime(known(cycles), spec);

    expect(uptime.known).toBe(true);
    // The long tail from the second line to `toMs` is still downtime; the small gap is not.
    if (uptime.known) {
      expect(uptime.value.downtimeMs).toBeLessThan(PERIOD.toMs - PERIOD.fromMs);
    }
  });

  it('never reports a negative or above-100 percentage, whatever the timestamps do', () => {
    // Lines from outside the period — a rotated file that spans the boundary, or a clock
    // that stepped — must not create a negative gap and push the figure past 100%. An
    // impossible number destroys trust in every other figure on the page.
    const uptime = computeUptime(
      known([spec.fromMs - 5_000, spec.fromMs + 1_000, spec.toMs + 5_000]),
      spec,
    );

    expect(uptime.known).toBe(true);
    if (uptime.known) {
      expect(uptime.value.cycles).toBe(1); // only the in-period line counted
      expect(uptime.value.pct).toBeGreaterThanOrEqual(0);
      expect(uptime.value.pct).toBeLessThanOrEqual(100);
    }
  });

  it('picks the bot’s own cycle lines out of a log and ignores everything else', () => {
    const lines = [
      JSON.stringify({ time: PERIOD.fromMs + 1_000, action: 'cycle', outcome: 'ok' }),
      JSON.stringify({ time: PERIOD.fromMs + 2_000, action: 'cycle', outcome: 'failed' }),
      JSON.stringify({ time: PERIOD.fromMs + 3_000, action: 'send', outcome: 'ok' }),
      JSON.stringify({ time: PERIOD.fromMs - 1_000, action: 'cycle', outcome: 'ok' }),
      'not json at all',
      '',
    ];

    // A failed cycle still proves the process was alive and trying, which is exactly the
    // "limping, not dead" state uptime is paired with retries to reveal.
    expect(cycleTimestampsIn(lines, PERIOD.fromMs, PERIOD.toMs)).toEqual([
      PERIOD.fromMs + 1_000,
      PERIOD.fromMs + 2_000,
    ]);
  });

  it('says so when the log location cannot be listed at all, rather than reporting no cycles', () => {
    // A path that exists but is not a directory — a stand-in for any filesystem refusal.
    // "Could not look" and "looked and found nothing" must not produce the same answer.
    const dir = tempDir();
    const notADirectory = join(dir, 'logs');
    writeFileSync(notADirectory, 'this is a file', 'utf8');

    const result = readCycleTimestamps(notADirectory, 'acolad', PERIOD.fromMs, PERIOD.toMs);

    expect(result.known).toBe(false);
    if (result.known === false) expect(result.why).toMatch(/could not list/i);
  });

  it('reads cycle timestamps from the rotated files of one bot only, and says so when there are none', () => {
    const logDir = tempDir();
    writeFileSync(
      join(logDir, 'acolad.2026-09-16.1.log'),
      `${JSON.stringify({ time: PERIOD.fromMs + 5_000, action: 'cycle', outcome: 'ok' })}\n`,
      'utf8',
    );
    writeFileSync(
      join(logDir, 'jobcatch-straker.2026-09-16.1.log'),
      `${JSON.stringify({ time: PERIOD.fromMs + 6_000, action: 'cycle', outcome: 'ok' })}\n`,
      'utf8',
    );

    // The two bots share one log directory (an enumerated, accepted sharing), so reading
    // the wrong prefix would credit one bot with the other's liveness.
    expect(readCycleTimestamps(logDir, 'acolad', PERIOD.fromMs, PERIOD.toMs)).toEqual({
      known: true,
      value: [PERIOD.fromMs + 5_000],
    });
    expect(
      readCycleTimestamps(join(logDir, 'nope'), 'acolad', PERIOD.fromMs, PERIOD.toMs).known,
    ).toBe(false);
  });
});

// ===========================================================================================
// Everything the view could not tell you is SAID, not left as a number that looks complete
// ===========================================================================================

describe('an unknown figure inside a readable record is stated, never defaulted', () => {
  it('withholds the combined CEILING when one portal’s ceiling is unset, while still totalling the work', () => {
    // Real and likely: STRAKER_MAX_WORDS_PER_DAY is required configuration with no default,
    // so "unset" is genuinely unknown. Defaulting it would invent a ceiling the bot would
    // never have enforced, and the combined ceiling is half of the over-commitment answer.
    const view = combineDailyView(PERIOD, [
      reading(workload({ portal: 'XTM', committedEffort: 1_200, ceilingPerDay: known(3_500) })),
      reading(
        workload({
          portal: 'Straker',
          committedEffort: 800,
          ceilingPerDay: { known: false, why: 'STRAKER_MAX_WORDS_PER_DAY is not set' },
        }),
      ),
    ]);

    expect(view.committedTotal).toEqual({ shown: true, value: 2_000, unit: WORDS_UNIT });
    expect(view.ceilingTotal).toMatchObject({ shown: false, withheld: 'figure_unknown' });
    expect(view.gaps.join(' ')).toContain('STRAKER_MAX_WORDS_PER_DAY');
  });

  it('makes the total retry count unknown when one portal’s own count is unknown', () => {
    // Both records readable, but one bot's queue could not be read. Summing what is left
    // would report fewer retries than happened — the direction that hides a limping bot.
    const view = combineDailyView(PERIOD, [
      reading(workload({ portal: 'XTM', retries: { known: false, why: 'outbox unreadable' } })),
      reading(workload({ portal: 'Straker', retries: known(2) })),
    ]);

    expect(view.retriesTotal.known).toBe(false);
    if (view.retriesTotal.known === false) expect(view.retriesTotal.why).toContain('XTM');
    expect(view.gaps.join(' ')).toMatch(/retries performed unknown/);
  });

  it('says unknown uptime is unknown rather than letting a blank read as healthy', () => {
    const view = combineDailyView(PERIOD, [
      reading(workload({ portal: 'XTM', uptime: { known: false, why: 'no acolad*.log files' } })),
      reading(workload({ portal: 'Straker' })),
    ]);

    expect(view.gaps.join(' ')).toMatch(/uptime unknown.*not as healthy/);
    expect(formatCombinedDailyView(view)).toMatch(/XTM uptime:\s*unknown/);
  });

  it('names held work that is in no day bucket, and held items with no readable effort', () => {
    // Work counted nowhere under-states every day it might have landed on, and an
    // under-stated day is exactly how an over-commitment goes unseen.
    const view = combineDailyView(PERIOD, [
      reading(
        workload({
          portal: 'XTM',
          committedEffort: 1_500,
          byDeadlineDay: new Map([['2026-09-17', 1_200]]),
          effortMissingDeadline: 300,
          itemsWithoutEffort: 2,
        }),
      ),
      reading(workload({ portal: 'Straker' })),
    ]);
    const text = formatCombinedDailyView(view);

    expect(view.gaps.join(' ')).toMatch(/300 words of held work has no readable deadline/);
    expect(view.gaps.join(' ')).toMatch(/2 held item\(s\) carry no readable effort/);
    expect(text).toMatch(/What this view cannot tell you/);
  });
});

describe('the effective-deadline-day mapper degrades without inventing a day', () => {
  it('returns null for a deadline it has no instant for', () => {
    const dayOf = effectiveDayMapper(540, new Set([1, 2, 3, 4, 5]), new Map());

    expect(dayOf(null)).toBeNull();
    expect(dayOf(Number.NaN)).toBeNull();
    expect(dayOf(Date.parse('2026-09-17T17:00:00+07:00'))).toBe('2026-09-17');
  });

  it('returns null rather than throwing when the work calendar has no working day at all', () => {
    // `effectiveDeadlineDay` fails loud on the accept path, where guessing a day would
    // mis-bucket an irreversible commitment. A report must not crash on it — but it must
    // not invent a day either, so the effort surfaces as unbucketed instead.
    const noWorkdays = effectiveDayMapper(540, new Set<number>(), new Map());

    expect(noWorkdays(Date.parse('2026-09-17T17:00:00+07:00'))).toBeNull();
  });
});

describe('readCeilingFromEnv — required configuration with no default is unknown, not zero', () => {
  const VAR = 'COMBINED_SUMMARY_TEST_CEILING';
  afterEach(() => {
    delete process.env[VAR];
  });

  it('is unknown when unset — a ceiling the bot would never have enforced must not be invented', () => {
    expect(readCeilingFromEnv(VAR)).toEqual({ known: false, why: `${VAR} is not set` });
  });

  it('is unknown, with the offending value, when it is not a positive number', () => {
    process.env[VAR] = '0';
    expect(readCeilingFromEnv(VAR).known).toBe(false);
    process.env[VAR] = 'lots';
    const bad = readCeilingFromEnv(VAR);
    expect(bad.known).toBe(false);
    if (bad.known === false) expect(bad.why).toContain('lots');
  });

  it('reads a positive number', () => {
    process.env[VAR] = '3500';
    expect(readCeilingFromEnv(VAR)).toEqual({ known: true, value: 3_500 });
  });
});

describe('parseSummaryPeriod', () => {
  it('defaults to the last 24 hours, which is the period a daily summary describes', () => {
    expect(parseSummaryPeriod([], NOW_MS)).toEqual({
      fromMs: NOW_MS - 86_400_000,
      toMs: NOW_MS,
      label: 'the last 24 hours',
    });
  });

  it('accepts --days N', () => {
    expect(parseSummaryPeriod(['--days', '7'], NOW_MS)).toMatchObject({
      fromMs: NOW_MS - 7 * 86_400_000,
      label: 'the last 7 days',
    });
  });

  it('throws on a malformed --days rather than quietly answering a different question', () => {
    // A fallback to "all time" would look exactly like a correct answer to the question
    // that was actually asked.
    expect(() => parseSummaryPeriod(['--days', 'soon'], NOW_MS)).toThrow(/positive number/);
    expect(() => parseSummaryPeriod(['--days'], NOW_MS)).toThrow(/positive number/);
  });
});

describe('retries performed are counted from the outbox, which is durable rather than rotated', () => {
  it('counts every failed delivery attempt in the period, and nothing outside it', () => {
    // `attempts` is incremented ONLY on failure (`recordFailure`), never by a first-try
    // success, so the column already IS the retry count — subtracting one would under-count
    // every retried row by exactly one.
    const rows = [
      { attempts: 0, createdAtMs: PERIOD.fromMs + 1_000 },
      { attempts: 3, createdAtMs: PERIOD.fromMs + 2_000 },
      { attempts: 2, createdAtMs: PERIOD.fromMs + 3_000 },
      { attempts: 9, createdAtMs: PERIOD.fromMs - 1 },
      { attempts: 9, createdAtMs: PERIOD.toMs + 1 },
    ];

    expect(countOutboxRetries(rows, PERIOD.fromMs, PERIOD.toMs)).toBe(5);
  });

  it('ignores a row whose creation time cannot be read rather than counting it as in-period', () => {
    const rows = [
      { attempts: 4, createdAtMs: Number.NaN },
      { attempts: 1, createdAtMs: PERIOD.fromMs + 1 },
    ];

    expect(countOutboxRetries(rows, PERIOD.fromMs, PERIOD.toMs)).toBe(1);
  });
});

// ===========================================================================================
// The thin readers — the two claims that can only be shown against a real database
// ===========================================================================================

describe('reading a record at reporting time cannot write to it', () => {
  it('opens a handle that REFUSES every write, proven by attempting one', () => {
    // The XTM bot is live and its database is open in WAL mode by another process. The
    // claim that this read is harmless is verified here rather than asserted in a comment.
    const dir = tempDir();
    const opened = openDatabase(dir, new Date(NOW_MS).toISOString());
    opened.db.prepare("INSERT INTO meta (key, value) VALUES ('probe', '1')").run();
    opened.db.close();

    const db = openRecordReadOnly(join(dir, 'acolad.db'));
    try {
      expect(() =>
        db.prepare("INSERT INTO meta (key, value) VALUES ('written-by-report', '1')").run(),
      ).toThrow(/readonly/i);
      expect(() => db.exec('CREATE TABLE intruder (x)')).toThrow(/readonly/i);
      // The read itself still works — a handle that refuses everything would be useless.
      expect(db.prepare("SELECT value FROM meta WHERE key = 'probe'").get()).toEqual({
        value: '1',
      });
    } finally {
      db.close();
    }
  });

  it('refuses to bring a record into existence: a database that is not there stays not there', () => {
    // `state/straker/` has never been created on the live host. A report that created it —
    // or migrated it — would be writing to the very state it claims only to read.
    const dir = tempDir();
    const absent = join(dir, 'never-created');

    expect(() => openRecordReadOnly(join(absent, 'straker.db'))).toThrow();
    expect(existsSync(absent)).toBe(false);
  });
});

describe('readXtmWorkload — the live bot’s record, read-only and by its own schema', () => {
  function seedXtm(dir: string): void {
    const opened = openDatabase(dir, new Date(NOW_MS).toISOString());
    const insert = opened.db.prepare(`
      INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                        project_name, file_name, due_date, words, file_wwc, lifecycle_status)
      VALUES (@k, @k, 'visible', @at, @at, 'h', 'P', @k, @due, @words, @wwc, @lifecycle)
    `);
    const at = new Date(NOW_MS).toISOString();
    insert.run({
      k: 'held-thu',
      at,
      due: '2026-09-17T17:00:00+07:00',
      words: 900,
      wwc: 700,
      lifecycle: 'accepted',
    });
    insert.run({
      k: 'held-fri',
      at,
      due: '2026-09-18T17:00:00+07:00',
      words: 300,
      wwc: 250,
      lifecycle: 'accepted',
    });
    // Not held: must not count towards committed workload.
    insert.run({
      k: 'seen-only',
      at,
      due: '2026-09-17T17:00:00+07:00',
      words: 5_000,
      wwc: 5_000,
      lifecycle: 'new',
    });
    opened.db
      .prepare(
        `INSERT INTO outbox (event_id, channel, payload_json, status, attempts, next_attempt_at, created_at)
         VALUES ('e1', 'chat', '{}', 'sent', 2, @at, @at)`,
      )
      .run({ at });
    opened.db.close();
  }

  it('sums held work only, under the metric the bot is configured to run on', () => {
    const dir = tempDir();
    seedXtm(dir);

    const wordsView = readXtmWorkload({
      stateDir: dir,
      metric: 'words',
      ceilingPerDay: 3_500,
      period: PERIOD,
      uptime: { known: false, why: 'not measured in this test' },
      dayOf: (ms) => (ms === null ? null : new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10)),
    });

    expect(wordsView.read).toBe(true);
    if (wordsView.read) {
      expect(wordsView.workload.committedEffort).toBe(1_200); // not 6,200 — 'new' is not held
      expect(wordsView.workload.heldItems).toBe(2);
      expect(wordsView.workload.unit).toEqual(WORDS_UNIT);
      expect([...wordsView.workload.byDeadlineDay.entries()]).toEqual([
        ['2026-09-17', 900],
        ['2026-09-18', 300],
      ]);
      expect(wordsView.workload.retries).toEqual({ known: true, value: 2 });
    }
  });

  it('measures in WWC when that is the metric, so the unit it reports is the unit it used', () => {
    const dir = tempDir();
    seedXtm(dir);

    const view = readXtmWorkload({
      stateDir: dir,
      metric: 'wwc',
      ceilingPerDay: 1_000,
      period: PERIOD,
      uptime: { known: false, why: 'not measured in this test' },
      dayOf: (ms) => (ms === null ? null : new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10)),
    });

    expect(view.read === true && view.workload.committedEffort).toBe(950);
    expect(view.read === true && view.workload.unit).toEqual(WWC_UNIT);
  });

  it('reports the record as unreadable — with the path and the reason — rather than as empty', () => {
    // Reading a missing record as "nothing committed" is the same class of error as reading
    // a failed portal response as "no offers": it erases work that exists.
    const view = readXtmWorkload({
      stateDir: join(tempDir(), 'not-here'),
      metric: 'words',
      ceilingPerDay: 3_500,
      period: PERIOD,
      uptime: { known: false, why: 'unmeasured' },
      dayOf: () => null,
    });

    expect(view.read).toBe(false);
    if (!view.read) {
      expect(view.failure.portal).toBe('XTM');
      expect(view.failure.source).toContain('acolad.db');
      expect(view.failure.why).not.toBe('');
    }
  });
});

describe('a partial record degrades to unknown, not to a wrong number', () => {
  it('still reports the workload when only the queue is unreadable, with retries unknown', () => {
    // The grain matters: an unreadable outbox must not throw away a perfectly good workload
    // figure, and it must not be reported as zero retries either.
    const dir = tempDir();
    const opened = openDatabase(dir, new Date(NOW_MS).toISOString());
    opened.db.exec('DROP TABLE outbox');
    opened.db.close();

    const view = readXtmWorkload({
      stateDir: dir,
      metric: 'words',
      ceilingPerDay: 3_500,
      period: PERIOD,
      uptime: { known: false, why: 'unmeasured' },
      dayOf: () => null,
    });

    expect(view.read).toBe(true);
    if (view.read) {
      expect(view.workload.committedEffort).toBe(0);
      expect(view.workload.retries.known).toBe(false);
      if (view.workload.retries.known === false) {
        expect(view.workload.retries.why).toMatch(/outbox/i);
      }
    }
  });

  it('reports a file that is not this bot’s record as unreadable rather than as empty', () => {
    // A database with no `jobs` table is not "nothing committed" — it is a file we do not
    // understand, and saying so is the only honest answer.
    const dir = tempDir();
    const db = new Database(join(dir, 'acolad.db'));
    db.exec('CREATE TABLE something_else (x)');
    db.close();

    const view = readXtmWorkload({
      stateDir: dir,
      metric: 'words',
      ceilingPerDay: 3_500,
      period: PERIOD,
      uptime: { known: false, why: 'unmeasured' },
      dayOf: () => null,
    });

    expect(view.read).toBe(false);
    if (!view.read) expect(view.failure.why).toMatch(/jobs/);
  });

  it('reports Straker held work with its retries unknown when only its queue is unreadable', async () => {
    const dir = tempDir();
    const stateDir = join(dir, 'straker');
    mkdirSync(stateDir, { recursive: true });
    const { openStrakerDatabase } = await import('../../../src/straker/strakerStore.js');
    const opened = openStrakerDatabase(stateDir, NOW_MS);
    opened.db.exec('DROP TABLE straker_outbox');
    opened.db.close();

    const view = readStrakerWorkload({
      stateDir,
      ceilingPerDay: { known: true, value: 1_000 },
      period: PERIOD,
      uptime: { known: false, why: 'unmeasured' },
      dayOf: () => null,
    });

    expect(view.read).toBe(true);
    if (view.read) {
      expect(view.workload.retries.known).toBe(false);
      if (view.workload.retries.known === false) {
        expect(view.workload.retries.why).toMatch(/outbox/i);
      }
    }
  });

  it('reports a Straker file that is not a Straker record as unreadable', () => {
    const dir = tempDir();
    const db = new Database(join(dir, 'straker.db'));
    db.exec('CREATE TABLE something_else (x)');
    db.close();

    const view = readStrakerWorkload({
      stateDir: dir,
      ceilingPerDay: { known: true, value: 1_000 },
      period: PERIOD,
      uptime: { known: false, why: 'unmeasured' },
      dayOf: () => null,
    });

    expect(view.read).toBe(false);
    if (!view.read) expect(view.failure.portal).toBe('Straker');
  });

  it('holds held work whose deadline cannot be placed out of every day bucket, and counts it', () => {
    const dir = tempDir();
    const opened = openDatabase(dir, new Date(NOW_MS).toISOString());
    const at = new Date(NOW_MS).toISOString();
    opened.db
      .prepare(
        `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                           project_name, file_name, due_date, words, file_wwc, lifecycle_status)
         VALUES ('no-deadline', 'no-deadline', 'visible', @at, @at, 'h', 'P', 'f',
                 NULL, 400, NULL, 'accepted')`,
      )
      .run({ at });
    opened.db
      .prepare(
        `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                           project_name, file_name, due_date, words, file_wwc, lifecycle_status)
         VALUES ('no-words', 'no-words', 'visible', @at, @at, 'h', 'P', 'g',
                 '2026-09-17T17:00:00+07:00', NULL, NULL, 'accepted')`,
      )
      .run({ at });
    opened.db.close();

    const view = readXtmWorkload({
      stateDir: dir,
      metric: 'words',
      ceilingPerDay: 3_500,
      period: PERIOD,
      uptime: { known: false, why: 'unmeasured' },
      dayOf: (ms) => (ms === null ? null : '2026-09-17'),
    });

    expect(view.read).toBe(true);
    if (view.read) {
      expect(view.workload.effortMissingDeadline).toBe(400);
      expect(view.workload.itemsWithoutEffort).toBe(1);
      expect(view.workload.byDeadlineDay.get('2026-09-17')).toBe(0);
    }
  });
});

describe('readStrakerWorkload — a state directory that has never existed', () => {
  it('reports it unreadable and does not create it', () => {
    const dir = tempDir();
    const stateDir = join(dir, 'straker');

    const view = readStrakerWorkload({
      stateDir,
      ceilingPerDay: { known: true, value: 1_000 },
      period: PERIOD,
      uptime: { known: false, why: 'unmeasured' },
      dayOf: () => null,
    });

    expect(view.read).toBe(false);
    if (!view.read) expect(view.failure.portal).toBe('Straker');
    expect(existsSync(stateDir)).toBe(false);
  });

  it('reads held work and its retries once the bot has a record', async () => {
    const dir = tempDir();
    const stateDir = join(dir, 'straker');
    mkdirSync(stateDir, { recursive: true });
    const { openStrakerDatabase, StrakerStore } =
      await import('../../../src/straker/strakerStore.js');
    const opened = openStrakerDatabase(stateDir, NOW_MS);
    const store = new StrakerStore(opened.db);
    store.hold({
      objId: 'offer-1',
      effortWords: 800,
      deadlineMs: Date.parse('2026-09-17T17:00:00+07:00'),
      heldSinceMs: NOW_MS,
    });
    opened.db
      .prepare(
        `INSERT INTO straker_outbox (event_id, channel, payload_json, status, attempts,
                                     next_attempt_at_ms, created_at_ms)
         VALUES ('e1', 'offers', '{}', 'pending', 3, @t, @t)`,
      )
      .run({ t: NOW_MS - 1_000 });
    opened.db.close();

    const view = readStrakerWorkload({
      stateDir,
      ceilingPerDay: { known: true, value: 1_000 },
      period: PERIOD,
      uptime: { known: false, why: 'unmeasured' },
      dayOf: (ms) => (ms === null ? null : new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10)),
    });

    expect(view.read).toBe(true);
    if (view.read) {
      expect(view.workload.committedEffort).toBe(800);
      expect(view.workload.unit).toEqual(WORDS_UNIT);
      expect(view.workload.retries).toEqual({ known: true, value: 3 });
      expect(view.workload.byDeadlineDay.get('2026-09-17')).toBe(800);
    }
  });
});

// ===========================================================================================
// The bulkhead (R11) — reporting-time reads must not become an import
// ===========================================================================================

describe('the bulkhead holds', () => {
  it('never imports the XTM state or configuration layer, however the path is spelled', () => {
    // FR-018 requires reading the XTM record; R11 forbids importing its modules. The
    // resolution is a direct, read-only handle with this file's own SQL — which is not an
    // import and not a shared transaction. This guard is what keeps the two apart.
    const imports = importedModules(SOURCE);

    // Guard the guard: an extractor that silently found nothing would "pass" everything.
    expect(imports.some((m) => m.endsWith('/src/schedule/effort.js'))).toBe(true);
    expect(imports).toContain('better-sqlite3');
    expect(imports.filter((m) => /(^|\/)(state|config)(\/|$)/.test(m))).toEqual([]);
  });
});

describe('combinedReportRows — the rows the XTM 09:00 report renders (T060a, FR-018)', () => {
  /**
   * The bridge between this module and the one place a human actually reads a daily
   * summary. Everything it does is defensive on purpose: it is called from inside the live
   * XTM bot's report, and the combined view is a **mitigation** for the two-ceiling problem.
   * A mitigation that can break the report it rides on is worse than not having it.
   *
   * So the contract is narrow and absolute: it returns rows, and it never throws. Whatever
   * it cannot find out, it says in a row.
   */
  const xtmSpec = (stateDir: string) => ({
    stateDir,
    metric: 'words' as const,
    ceilingPerDay: 3500,
    dayOf: effectiveDayMapper(9 * 60, new Set([1, 2, 3, 4, 5]), new Map()),
  });

  it('never throws, even handed a state directory that does not exist', () => {
    // The one guarantee that matters. `dailyReport.ts` is throw-safe at its call site, but
    // relying on someone else's try/catch for a property this module can hold itself is how
    // PR #14's bug — a throw in the daily report taking the whole loop down — happened.
    const rows = combinedReportRows({
      xtm: xtmSpec(join(tmpdir(), 'straker-nope-does-not-exist')),
      strakerStateDir: join(tmpdir(), 'straker-also-nope'),
      nowMs: NOW_MS,
    });

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('states the gap in a row rather than going quiet, when a record cannot be read', () => {
    const rows = combinedReportRows({
      xtm: xtmSpec(join(tmpdir(), 'straker-nope-does-not-exist')),
      strakerStateDir: join(tmpdir(), 'straker-also-nope'),
      nowMs: NOW_MS,
    });

    // A report that silently omits the combined line is indistinguishable from one where
    // the two portals happened to sum to nothing.
    const text = JSON.stringify(rows);
    expect(text).toMatch(/Straker/);
    expect(text).toMatch(/could not|unreadable|not found|no combined/i);
  });

  it('carries both portals and a combined figure when both records are readable', async () => {
    const xtmDir = tempDir();
    const at = new Date(NOW_MS).toISOString();
    const xtm = openDatabase(xtmDir, at);
    xtm.db
      .prepare(
        `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                           project_name, file_name, due_date, words, file_wwc, lifecycle_status)
         VALUES ('k', 'k', 'visible', @at, @at, 'h', 'P', 'k', '2026-09-17T17:00:00+07:00',
                 350, 300, 'accepted')`,
      )
      .run({ at });
    xtm.db.close();

    const strakerDir = join(tempDir(), 'straker');
    mkdirSync(strakerDir, { recursive: true });
    const { openStrakerDatabase, StrakerStore } =
      await import('../../../src/straker/strakerStore.js');
    const straker = openStrakerDatabase(strakerDir, NOW_MS);
    new StrakerStore(straker.db).hold({
      objId: 'a',
      effortWords: 120,
      deadlineMs: Date.parse('2026-09-17T17:00:00+07:00'),
      heldSinceMs: NOW_MS,
    });
    straker.db.close();

    const rows = combinedReportRows({
      xtm: xtmSpec(xtmDir),
      strakerStateDir: strakerDir,
      nowMs: NOW_MS,
    });

    const text = JSON.stringify(rows);
    expect(text).toContain('Straker');
    // Both figures present and a combined one alongside them — the whole point of the view.
    expect(text).toContain('350');
    expect(text).toContain('120');
    expect(text).toContain('470');
  });
});

// ===========================================================================================
// T076 / SC-004 — the win rate has to reach the report, not wait for someone to run a script
// ===========================================================================================

describe('T076 — the Straker win rate reaches the 09:00 report (SC-004)', () => {
  /**
   * SC-004 says the win rate is "measured and reported **continuously**". It was measured —
   * `computeWinRate` is correct and tested — but its only caller was the manual
   * `npm run straker:win-rate`. The gap that matters is not a missing number: SC-004 sets a
   * target only after a two-week baseline, and a baseline nobody is shown is one nobody reads.
   */

  async function strakerRecord(events: readonly unknown[]): Promise<string> {
    const dir = tempDir();
    const stateDir = join(dir, 'straker');
    mkdirSync(stateDir, { recursive: true });
    const { openStrakerDatabase, StrakerStore } =
      await import('../../../src/straker/strakerStore.js');
    const opened = openStrakerDatabase(stateDir, NOW_MS);
    const store = new StrakerStore(opened.db);
    for (const e of events) store.recordEvent(e as never);
    opened.db.close();
    return stateDir;
  }

  const won = (id: string, atMs = NOW_MS - 3_600_000) => ({
    objId: id,
    occurredAtMs: atMs,
    eventType: 'claim' as const,
    outcome: 'won' as const,
    effortWords: 4,
    deadlineMs: NOW_MS + 24 * 3_600_000,
  });
  const lost = (id: string, atMs = NOW_MS - 3_600_000) => ({
    ...won(id, atMs),
    outcome: 'lost' as const,
  });
  const turnedAway = (id: string, atMs = NOW_MS - 3_600_000) => ({
    objId: id,
    occurredAtMs: atMs,
    eventType: 'skip' as const,
    skipReason: 'ineligible_language' as const,
  });

  it('reports the rate, the numerator and the denominator — never a bare percentage', async () => {
    const stateDir = await strakerRecord([won('a'), lost('b'), lost('c')]);

    const row = strakerWinRateRow(PERIOD, stateDir);

    expect(row.label).toBe('Straker win rate');
    // 1 of 3 winnable. The counts travel with the percentage because at 2-3 offers a day a
    // bare "33%" invites a decision the sample cannot support.
    expect(row.value).toContain('33.3%');
    expect(row.value).toContain('1 won of 3');
  });

  it('says n/a rather than 0% when nothing was genuinely winnable', async () => {
    // FR-017's only exclusion is offers the team's own rules turned away. A day of those is
    // not a day of losing — reporting 0% would read as the bot failing at its job.
    const stateDir = await strakerRecord([turnedAway('a'), turnedAway('b')]);

    const row = strakerWinRateRow(PERIOD, stateDir);

    expect(row.value).toContain('n/a');
    expect(row.value).not.toContain('0.0%');
  });

  it('marks a small sample as a weak signal, which is what SC-004 turns on', async () => {
    const stateDir = await strakerRecord([won('a'), lost('b')]);

    const row = strakerWinRateRow(PERIOD, stateDir);

    expect(row.value).toMatch(/weak signal/i);
  });

  it('counts only what happened inside the period', async () => {
    // A figure quoted without its window is the failure this guards: a loss from last week
    // must not drag down today's line.
    const stateDir = await strakerRecord([won('a'), lost('old', NOW_MS - 8 * 24 * 3_600_000)]);

    const row = strakerWinRateRow(PERIOD, stateDir);

    expect(row.value).toContain('1 won of 1');
  });

  it('says the record was unreadable rather than going quiet', async () => {
    const row = strakerWinRateRow(PERIOD, join(tempDir(), 'never-existed'));

    expect(row.emoji).toBe('⚠️');
    expect(row.value).toMatch(/unreadable/i);
  });

  it('never throws, whatever the state directory is', () => {
    expect(() => strakerWinRateRow(PERIOD, '')).not.toThrow();
  });

  it('is actually wired into the report rows — the seam, not just the capability', async () => {
    // The lesson this feature learned five times: a capability can ship built, tested and
    // unreachable. Asserting the row exists in `combinedReportRows` is the seam test.
    const stateDir = await strakerRecord([won('a'), lost('b')]);
    const xtmDir = tempDir();

    const rows = combinedReportRows({
      xtm: {
        stateDir: xtmDir,
        metric: 'words',
        ceilingPerDay: 3_500,
        dayOf: (ms) =>
          ms === null ? null : new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10),
      },
      strakerStateDir: stateDir,
      nowMs: NOW_MS,
    });

    expect(rows.some((r) => r.label === 'Straker win rate')).toBe(true);
  });
});

describe('T076 review fixes — the row has to be usable, not merely present', () => {
  async function record(events: readonly unknown[]): Promise<string> {
    const dir = tempDir();
    const stateDir = join(dir, 'straker');
    mkdirSync(stateDir, { recursive: true });
    const { openStrakerDatabase, StrakerStore } =
      await import('../../../src/straker/strakerStore.js');
    const opened = openStrakerDatabase(stateDir, NOW_MS);
    const store = new StrakerStore(opened.db);
    for (const e of events) store.recordEvent(e as never);
    opened.db.close();
    return stateDir;
  }
  const claim = (id: string, outcome: string, atMs: number) => ({
    objId: id,
    occurredAtMs: atMs,
    eventType: 'claim' as const,
    outcome,
    effortWords: 4,
    deadlineMs: NOW_MS + 24 * 3_600_000,
  });
  const skip = (id: string, atMs: number) => ({
    objId: id,
    occurredAtMs: atMs,
    eventType: 'skip' as const,
    skipReason: 'ineligible_language' as const,
  });

  it('reports offers turned away beside the rate, because FR-017a says one number hides the other', async () => {
    // "a low rate with a high turn-away count is a configuration question; a low rate with a
    // low one is a speed question, and they call for opposite responses" — winRate.ts. The ops
    // script printed both; the first cut of this row printed only the rate, which by T076's own
    // argument left FR-017a unreported on the surface that counts.
    const stateDir = await record([
      claim('a', 'won', NOW_MS - 3_600_000),
      claim('b', 'lost', NOW_MS - 3_600_000),
      skip('c', NOW_MS - 3_600_000),
      skip('d', NOW_MS - 3_600_000),
    ]);

    const row = strakerWinRateRow(PERIOD, stateDir);

    expect(row.value).toContain('2 turned away');
  });

  it('says the figure is a lower bound while claims are still unresolved', async () => {
    // An `unknown` outcome is a claim reconciliation has not settled. Counting it as a loss
    // would understate the rate; hiding it lets a temporarily depressed figure read as a verdict.
    const stateDir = await record([
      claim('a', 'won', NOW_MS - 3_600_000),
      claim('b', 'unknown', NOW_MS - 3_600_000),
    ]);

    const row = strakerWinRateRow(PERIOD, stateDir);

    expect(row.value).toMatch(/unresolved|lower bound/i);
  });

  it('measures the report row over 14 days, not the card’s 24-hour period', async () => {
    // The window this row needs is not the window the rest of the card uses. At 2-3 offers a
    // day a 24-hour window makes `winnable` 0-3, so it can NEVER reach WEAK_SIGNAL_BELOW (10):
    // the caveat would be permanently on and SC-004's two-week baseline never arrives. A
    // caveat that is always true is one people stop reading.
    const eightDaysAgo = NOW_MS - 8 * 24 * 3_600_000;
    const stateDir = await record([
      claim('recent', 'won', NOW_MS - 3_600_000),
      claim('older', 'lost', eightDaysAgo),
    ]);
    const xtmDir = tempDir();

    const rows = combinedReportRows({
      xtm: {
        stateDir: xtmDir,
        metric: 'words',
        ceilingPerDay: 3_500,
        dayOf: (ms) =>
          ms === null ? null : new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10),
      },
      strakerStateDir: stateDir,
      nowMs: NOW_MS,
    });

    const row = rows.find((r) => r.label === 'Straker win rate');
    // The eight-day-old loss is inside 14 days and outside 24 hours. Seeing it counted is
    // what proves the call site does not simply reuse the card's period.
    expect(row?.value).toContain('1 won of 2');
  });

  it('keeps the portal rows even if the win-rate row were to fail', async () => {
    // Defence in depth for the composition: the least important row must not be able to
    // discard the most important ones. No input reaches the throwing path today — that is the
    // point, since what this protects against is the NEXT edit to strakerWinRateRow.
    const stateDir = await record([claim('a', 'won', NOW_MS - 3_600_000)]);
    const xtmDir = tempDir();

    const rows = combinedReportRows({
      xtm: {
        stateDir: xtmDir,
        metric: 'words',
        ceilingPerDay: 3_500,
        dayOf: (ms) =>
          ms === null ? null : new Date(ms + 7 * 3_600_000).toISOString().slice(0, 10),
      },
      strakerStateDir: stateDir,
      nowMs: NOW_MS,
    });

    // The FR-018 section survives as itself, rather than collapsing to one "unavailable" line.
    expect(rows.filter((r) => r.label === 'Both portals')).toHaveLength(1);
    expect(rows.length).toBeGreaterThan(2);
  });
});
