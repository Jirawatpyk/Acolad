/**
 * T026–T029 + T039 — the existing scheduling gate, wired to Straker's claim decision.
 *
 * ## What is under test, and what deliberately is not
 *
 * `evaluateAcceptSchedule` is **not** under test here. It is the live XTM bot's gate, it
 * has its own suite, and R6 requires Straker to call it unchanged. What is under test is
 * the wiring: that `src/straker/claimDecision.ts` asks the gate, honours the answer, and
 * turns a refusal into the right `SkipReason` with a reason a human can read.
 *
 * That distinction shapes how these tests assert. Wherever a refusal is expected, the
 * expected **text** is obtained by calling the real gate in the test (`gateOracle` below)
 * rather than written out as a literal. A literal would pass while the module fed the gate
 * different numbers than it claimed to — the exact failure T039 exists to prevent — and
 * would also have to be rewritten every time the gate reworded itself. Comparing against
 * the gate's own output means the module can only pass by having fed the gate the same
 * effort, deadline, throughput and calendar the oracle did.
 *
 * ## Dates
 *
 * September 2026 carries no Thai public holiday, so a weekday in it is unambiguously a
 * working day:  Mon 14 · Tue 15 · Wed 16 · Thu 17 · Fri 18 · Sat 19 · Sun 20.
 * 2026-10-13 (Tue) is King Bhumibol Memorial Day — a curated holiday.
 * 2028 is not in `CURATED_YEARS`, which is what makes it the uncurated-year fixture.
 *
 * Every timestamp is written with an explicit `+07:00`. A bare ISO string is read in the
 * host's zone, which is Bangkok on the office machine and UTC in CI — a seven-hour
 * difference that has already turned date tests green locally and red in CI once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateAcceptSchedule,
  type AcceptScheduleVerdict,
} from '../../../src/schedule/acceptSchedule.js';
import { resolveHolidaysForSpan } from '../../../src/schedule/thaiHolidays.js';
import { StrakerLedger, type LedgerWorkCalendar } from '../../../src/straker/ledger.js';
import { alertsOnSkip } from '../../../src/straker/outcomePolicy.js';
import {
  StrakerStore,
  openStrakerDatabase,
  type HeldWork,
  type StrakerDB,
} from '../../../src/straker/strakerStore.js';
import {
  decideClaims,
  type ClaimDecision,
  type ClaimDecisionContext,
  type ClaimDecisionSettings,
  type OfferForDecision,
} from '../../../src/straker/claimDecision.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const at = (iso: string): number => Date.parse(iso);

const WED_10AM = at('2026-09-16T10:00:00+07:00'); // inside the working window
const WED_0638 = at('2026-09-16T06:38:00+07:00'); // the hour two real probe offers arrived
const WED_9AM = at('2026-09-16T09:00:00+07:00'); // the first working minute
const WED_6PM = at('2026-09-16T18:00:00+07:00'); // the first minute after work
const SAT_NOON = at('2026-09-19T12:00:00+07:00');
const HOLIDAY_NOON = at('2026-10-13T12:00:00+07:00'); // King Bhumibol Memorial Day

const THU_5PM = at('2026-09-17T17:00:00+07:00');
const FRI_5PM = at('2026-09-18T17:00:00+07:00');
/**
 * Thursday's first working minute. Budget tests that are about ONE day's ceiling are judged
 * from here: since 2026-09-18 a deadline has every working day before it, so judged from
 * Wednesday a Thursday deadline has two days of room. From Thursday morning it has one.
 */
const THU_9AM = at('2026-09-17T09:00:00+07:00');
const SAT_DEADLINE = at('2026-09-19T12:00:00+07:00');
const HOLIDAY_DEADLINE = at('2026-10-13T12:00:00+07:00');
const UNCURATED_DEADLINE = at('2028-03-15T12:00:00+07:00');
const ALREADY_PASSED = at('2026-09-16T09:30:00+07:00'); // before WED_10AM
const WED_2320 = at('2026-09-16T23:20:00+07:00'); // the real probe offer's own deadline

const WORKDAYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);

const SETTINGS: ClaimDecisionSettings = {
  throughputWordsPerHour: 100,
  // Deliberately NOT equal to the translation rate. Every offer these tests drive is a
  // translation, so this figure should never be consulted — and if the gate ever reaches
  // for it by mistake, an absurd rate makes that visible as a wrong verdict rather than
  // hiding behind a matching number. Two ceilings set equal is what kept the DTP rate
  // unreachable through a whole suite.
  dtpThroughputWordsPerHour: 9_999,
  hoursStartMin: 9 * 60,
  hoursEndMin: 18 * 60,
  workdays: WORKDAYS,
};

const LEDGER_CALENDAR: LedgerWorkCalendar = {
  hoursStartMin: 9 * 60,
  hoursEndMin: 18 * 60,
  workdays: WORKDAYS,
};

/** Big enough that capacity never binds — used wherever the gate is the thing under test. */
const ROOMY = 100_000;

function offer(objId: string, over: Partial<OfferForDecision> = {}): OfferForDecision {
  return {
    objId,
    monolingual: false,
    languageDirection: 'en-GB>ms-MY',
    eligible: true,
    effortWords: 100,
    deadlineMs: THU_5PM,
    ...over,
  };
}

const dirs: string[] = [];
const openDbs: StrakerDB[] = [];

function freshLedger(ceiling: number): { ledger: StrakerLedger; store: StrakerStore } {
  const dir = mkdtempSync(join(tmpdir(), 'straker-gate-'));
  dirs.push(dir);
  const opened = openStrakerDatabase(dir, WED_10AM);
  openDbs.push(opened.db);
  const store = new StrakerStore(opened.db);
  return {
    ledger: new StrakerLedger(
      store,
      { translation: ceiling, monolingual: ceiling },
      LEDGER_CALENDAR,
    ),
    store,
  };
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

function ctx(
  nowMs: number,
  ledger: StrakerLedger,
  held: readonly HeldWork[] = [],
  settings: ClaimDecisionSettings = SETTINGS,
): ClaimDecisionContext {
  return { nowMs, settings, ledger, held };
}

/** A held row, for seeding a day that is already partly (or wholly) spent. */
function heldRow(objId: string, effortWords: number, deadlineMs: number): HeldWork {
  return {
    objId,
    effortWords,
    deadlineMs,
    heldSinceMs: WED_10AM,
    kind: 'translation',
    releasedAtMs: null,
  };
}

/**
 * The gate's own answer for an offer, computed independently of the module under test.
 *
 * This is the whole basis of the T039 assertions: the module may only pass by feeding the
 * gate exactly these four things — effort, deadline, throughput and the calendar — because
 * anything else produces a different verdict or a differently worded reason.
 */
function gateOracle(
  o: OfferForDecision,
  nowMs: number,
  settings: ClaimDecisionSettings = SETTINGS,
): AcceptScheduleVerdict {
  const { holidays, curated } = resolveHolidaysForSpan(nowMs, o.deadlineMs);
  return evaluateAcceptSchedule({
    enabled: true,
    nowMs,
    dueAtMs: o.deadlineMs,
    effort: o.effortWords,
    throughputPerHour: settings.throughputWordsPerHour,
    calendar: {
      workdays: settings.workdays,
      hoursStartMin: settings.hoursStartMin,
      hoursEndMin: settings.hoursEndMin,
      holidays,
    },
    holidaysCuratedForSpan: curated,
  });
}

/** The gate's refusal text, or a failure if the oracle unexpectedly allowed. */
function gateRefusal(
  o: OfferForDecision,
  nowMs: number,
  settings: ClaimDecisionSettings = SETTINGS,
): string {
  const verdict = gateOracle(o, nowMs, settings);
  if (verdict.allow) throw new Error(`fixture error: the gate allowed ${o.objId}`);
  return verdict.reason;
}

function only(decisions: readonly ClaimDecision[]): ClaimDecision {
  expect(decisions).toHaveLength(1);
  return decisions[0] as ClaimDecision;
}

function skipOf(decisions: readonly ClaimDecision[]): Extract<ClaimDecision, { action: 'skip' }> {
  const d = only(decisions);
  if (d.action !== 'skip') throw new Error(`expected a skip, got a claim for ${d.objId}`);
  return d;
}

// ===========================================================================
// T026 — the gate's verdict is honoured (FR-008, FR-012, FR-013, V4, V5)
// ===========================================================================

describe('T026 the gate refuses and the decision honours it', () => {
  it('claims when the gate allows and the ceiling has room — the control case', () => {
    // Without this the rest of the file could pass with a module that skips everything.
    const { ledger } = freshLedger(ROOMY);

    const decision = only(decideClaims([offer('a')], ctx(WED_10AM, ledger)));

    expect(decision).toMatchObject({
      objId: 'a',
      action: 'claim',
      effortWords: 100,
      deadlineMs: THU_5PM,
      deadlineDay: '2026-09-17',
    });
  });

  it('claims work due on a weekend when the working days before it have the time', () => {
    // Owner decision, 2026-09-18, after two 43-word offers seen at 02:42 on a Friday were
    // refused for being due Saturday 12:59 — with nine working hours still left that day.
    // A day off is where the working time runs out, not a reason to refuse.
    // Kills: a gate that refuses a deadline for falling on a day off.
    const { ledger } = freshLedger(ROOMY);
    const o = offer('a', { deadlineMs: SAT_DEADLINE });

    expect(only(decideClaims([o], ctx(WED_10AM, ledger))).action).toBe('claim');
  });

  it('claims work due on a curated Thai holiday on the same terms', () => {
    const { ledger } = freshLedger(ROOMY);
    const o = offer('a', { deadlineMs: HOLIDAY_DEADLINE });

    expect(only(decideClaims([o], ctx(WED_10AM, ledger))).action).toBe('claim');
  });

  it('refuses weekend work the working days cannot hold — as unreachable, not as a weekday', () => {
    // Saturday adds no working time. From Friday 09:00 there are nine working hours to a
    // Saturday deadline: 900 words at 100/h. 1,000 does not fit, and the reason recorded is
    // the real one. Kills: classifying by the deadline's weekday before the gate's verdict,
    // which would label this `deadline_on_non_working_day` and hide why it was refused.
    const { ledger } = freshLedger(ROOMY);
    const o = offer('a', { effortWords: 1_000, deadlineMs: SAT_DEADLINE });
    const fri9 = at('2026-09-18T09:00:00+07:00');

    const decision = skipOf(decideClaims([o], ctx(fri9, ledger)));

    expect(decision.reason).toBe('deadline_unreachable');
    expect(decision.detail).toBe(gateRefusal(o, fri9));
    expect(decision.detail).toContain('cannot finish in time');
  });

  it('refuses a deadline the crew cannot reach at the configured throughput', () => {
    // 800 words at 100/h needs 8h; Wed 10:00 -> Wed 17:00 offers 7h of working time.
    const { ledger } = freshLedger(ROOMY);
    const o = offer('a', {
      effortWords: 800,
      deadlineMs: at('2026-09-16T17:00:00+07:00'),
    });

    const decision = skipOf(decideClaims([o], ctx(WED_10AM, ledger)));

    expect(decision.reason).toBe('deadline_unreachable');
    expect(decision.detail).toBe(gateRefusal(o, WED_10AM));
    expect(decision.detail).toContain('cannot finish in time');
  });

  it('refuses a deadline that has already passed', () => {
    const { ledger } = freshLedger(ROOMY);
    const o = offer('a', { deadlineMs: ALREADY_PASSED });

    const decision = skipOf(decideClaims([o], ctx(WED_10AM, ledger)));

    expect(decision.reason).toBe('deadline_unreachable');
    expect(decision.detail).toBe(gateRefusal(o, WED_10AM));
  });

  it('refuses an uncurated holiday year rather than assuming it has no holidays (V5)', () => {
    // The fail-CLOSED direction. Assuming an uncurated year is holiday-free would claim
    // work against a deadline that may land on a public holiday nobody has recorded yet.
    // Kills: defaulting `holidaysCuratedForSpan` to true, or omitting it.
    const { ledger } = freshLedger(ROOMY);
    const o = offer('a', { deadlineMs: UNCURATED_DEADLINE });

    const decision = skipOf(decideClaims([o], ctx(WED_10AM, ledger)));

    expect(decision.reason).toBe('holiday_calendar_uncurated');
    expect(decision.detail).toBe(gateRefusal(o, WED_10AM));
    expect(decision.detail).toContain('2028');
  });

  it('refuses an offer whose effort is missing, and that skip alerts (FR-023a)', () => {
    // Also proves the gate is consulted before the ledger: `checkCapacity` THROWS on an
    // unreadable deadline, so a module that weighed capacity first would crash here.
    const { ledger } = freshLedger(ROOMY);
    const o = offer('a', { effortWords: null });

    const decision = skipOf(decideClaims([o], ctx(WED_10AM, ledger)));

    expect(decision.reason).toBe('effort_unknown');
    expect(decision.detail).toBe(gateRefusal(o, WED_10AM));
    expect(alertsOnSkip(decision.reason)).toBe(true);
  });

  it('refuses an offer whose deadline is missing, and that skip alerts (FR-023a)', () => {
    const { ledger } = freshLedger(ROOMY);
    const o = offer('a', { deadlineMs: null });

    const decision = skipOf(decideClaims([o], ctx(WED_10AM, ledger)));

    expect(decision.reason).toBe('deadline_unknown');
    expect(decision.detail).toBe(gateRefusal(o, WED_10AM));
    expect(alertsOnSkip(decision.reason)).toBe(true);
  });

  it('refuses once the day the work lands on is out of budget', () => {
    const { ledger } = freshLedger(1_000);
    const held = [heldRow('earlier', 950, THU_5PM)];

    const decision = skipOf(decideClaims([offer('a')], ctx(THU_9AM, ledger, held)));

    expect(decision.reason).toBe('ceiling_reached');
    expect(decision.detail).toContain('2026-09-17');
  });

  it('keeps an offer larger than a whole day distinct from an ordinary ceiling skip', () => {
    // `ceiling_reached` clears itself as held work finishes; this one recurs every day
    // forever and needs a human. Collapsing the two would hide that difference.
    // 1,500 words at 100/h fit the 16 working hours from Wednesday 10:00 to Thursday 17:00,
    // so the gate lets it through; at 500 words a day the two days in its window hold 1,000.
    const { ledger } = freshLedger(500);

    const decision = skipOf(
      decideClaims([offer('a', { effortWords: 1_500 })], ctx(WED_10AM, ledger)),
    );

    expect(decision.reason).toBe('exceeds_daily_ceiling_entirely');
    expect(decision.detail).toContain('accept manually');
  });

  it('never claims an offer the eligibility answer turned down', () => {
    const { ledger } = freshLedger(ROOMY);

    const decision = skipOf(decideClaims([offer('a', { eligible: false })], ctx(WED_10AM, ledger)));

    expect(decision.reason).toBe('ineligible_language');
    expect(decision.detail).toContain('en-GB>ms-MY');
  });

  it('reports an ineligible offer as ineligible even when its numbers are missing too', () => {
    // Ordering, stated as behaviour: eligibility is the outer filter (it is also the
    // outer term of the win-rate denominator, FR-017), so an offer the team would never
    // take is recorded as ineligible rather than as a payload fault.
    const { ledger } = freshLedger(ROOMY);

    const decision = skipOf(
      decideClaims(
        [offer('a', { eligible: false, effortWords: null, deadlineMs: null })],
        ctx(WED_10AM, ledger),
      ),
    );

    expect(decision.reason).toBe('ineligible_language');
  });
});

describe('T026 the working moment — claiming runs 24/7, on purpose (decided 2026-09-15)', () => {
  it('claims an offer that arrives before the working day starts', () => {
    // The decision this locks in. The reused gate never asked "is the team at work right
    // now" — only whether the work FITS in working time before its deadline — and the spec
    // says the scheduling rules are reused unchanged, so adding a current-moment refusal
    // would be changing them.
    //
    // The measurement is what settles it: two of the three offers the capture probe has
    // seen arrived at exactly this instant, 06:38 Bangkok, and were gone within 204
    // seconds. Refusing them would throw away two thirds of the observed volume for
    // nothing, because by 09:00 there is no offer left to claim.
    const { ledger } = freshLedger(ROOMY);
    const o = offer('a', { effortWords: 4, deadlineMs: WED_2320 });

    expect(gateOracle(o, WED_0638).allow).toBe(true);
    expect(only(decideClaims([o], ctx(WED_0638, ledger))).action).toBe('claim');
  });

  it('claims at the closing minute too, since the claim is not the work', () => {
    const { ledger: openLedger } = freshLedger(ROOMY);
    const { ledger: shutLedger } = freshLedger(ROOMY);

    expect(only(decideClaims([offer('a')], ctx(WED_9AM, openLedger))).action).toBe('claim');
    expect(only(decideClaims([offer('a')], ctx(WED_6PM, shutLedger))).action).toBe('claim');
  });

  it('claims on a weekend and on a holiday when the DEADLINE is still reachable', () => {
    // What the team does not work through is still enforced — by the gate, where it
    // belongs: the deadline must fall on a working day and the work must fit in working
    // minutes before it. Those two tests live in the gate-verdict block above. What is
    // gone is only the refusal based on the clock at the moment the offer appeared.
    const { ledger: satLedger } = freshLedger(ROOMY);
    const { ledger: holLedger } = freshLedger(ROOMY);
    const monday = offer('a', { deadlineMs: at('2026-09-21T17:00:00+07:00') });
    const dayAfterHoliday = offer('b', { deadlineMs: at('2026-10-14T17:00:00+07:00') });

    expect(only(decideClaims([monday], ctx(SAT_NOON, satLedger))).action).toBe('claim');
    expect(only(decideClaims([dayAfterHoliday], ctx(HOLIDAY_NOON, holLedger))).action).toBe(
      'claim',
    );
  });

  it('never produces outside_schedule, the reason this decision retired', () => {
    // Kept as a check rather than deleted: if someone reinstates a current-moment refusal
    // without revisiting spec.md §Clarifications 2026-09-15, this is what says so.
    const { ledger } = freshLedger(ROOMY);
    const moments = [WED_0638, WED_9AM, WED_6PM, SAT_NOON, HOLIDAY_NOON];

    const reasons = moments.flatMap((now) =>
      decideClaims([offer('a', { effortWords: 4, deadlineMs: WED_2320 })], ctx(now, ledger))
        .filter((d) => d.action === 'skip')
        .map((d) => d.reason),
    );

    expect(reasons).not.toContain('outside_schedule');
  });
});

// ===========================================================================
// T039 — the gate is called unchanged, on those four inputs only
// ===========================================================================

describe('T039 the gate is reused unchanged, fed only effort, deadline, throughput, calendar', () => {
  it('moves its feasibility boundary in lock-step with the throughput it is given', () => {
    // The same offer, the same clock, the same calendar — only the throughput differs.
    // A module that hard-coded a rate, or quietly used the XTM bot's, cannot do this.
    const { ledger: slowLedger } = freshLedger(ROOMY);
    const { ledger: fastLedger } = freshLedger(ROOMY);
    const o = offer('a', { effortWords: 800, deadlineMs: at('2026-09-16T17:00:00+07:00') });
    const fast: ClaimDecisionSettings = { ...SETTINGS, throughputWordsPerHour: 200 };

    const slow = only(decideClaims([o], ctx(WED_10AM, slowLedger)));
    const quick = only(decideClaims([o], ctx(WED_10AM, fastLedger, [], fast)));

    expect(slow).toMatchObject({ action: 'skip', reason: 'deadline_unreachable' });
    expect(quick.action).toBe('claim');
    expect(gateOracle(o, WED_10AM).allow).toBe(false);
    expect(gateOracle(o, WED_10AM, fast).allow).toBe(true);
  });

  it('agrees with the gate on every offer in a mixed batch, refusal text included', () => {
    const { ledger } = freshLedger(ROOMY);
    const offers = [
      offer('ok'),
      offer('weekend', { deadlineMs: SAT_DEADLINE }),
      offer('holiday', { deadlineMs: HOLIDAY_DEADLINE }),
      offer('uncurated', { deadlineMs: UNCURATED_DEADLINE }),
      offer('passed', { deadlineMs: ALREADY_PASSED }),
      offer('noEffort', { effortWords: null }),
      offer('noDeadline', { deadlineMs: null }),
      offer('tight', { effortWords: 5_000, deadlineMs: at('2026-09-16T17:00:00+07:00') }),
    ];

    const decisions = decideClaims(offers, ctx(WED_10AM, ledger));

    for (const [i, decision] of decisions.entries()) {
      const source = offers[i] as OfferForDecision;
      const verdict = gateOracle(source, WED_10AM);
      if (verdict.allow) continue;
      expect(decision.action, `${source.objId} must be skipped`).toBe('skip');
      if (decision.action === 'skip') expect(decision.detail).toBe(verdict.reason);
    }
  });

  it('writes no scheduling rule of its own — it imports the gate and no feasibility parts', () => {
    // R6 stated as something a reviewer can check rather than trust. `workingMinutesBetween`
    // is the feasibility arithmetic and `thaiHolidaysData` is the hand-curated list;
    // importing either would mean this module had started deciding for itself.
    const source = fileURLToPath(new URL('../../../src/straker/claimDecision.ts', import.meta.url));
    const text = readFileSync(source, 'utf8');
    const specifiers = [...text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
    const resolved = specifiers.map((s) =>
      s.startsWith('.') ? resolve(dirname(source), s).replace(/\\/g, '/') : s,
    );

    // NodeNext specifiers carry the `.js` extension the emitted code will use.
    expect(resolved.some((s) => s.endsWith('/src/schedule/acceptSchedule.js'))).toBe(true);
    expect(text).not.toContain('workingMinutesBetween');
    expect(text).not.toContain('thaiHolidaysData');
  });
});

// ===========================================================================
// T027 — the ceiling stops claiming, never reading (FR-007a, V23)
// ===========================================================================

describe('T027 reaching the ceiling does not stop the pass', () => {
  it('returns a decision for every offer in a read whose day is already full', () => {
    // FR-007a's reasoning is why this matters: dropping the rest of the read would
    // corrupt the win-rate denominator, hide what the team is turning away, and — in the
    // caller — suspend the reconciliation that shares the cycle.
    // Kills: `break`ing out of the loop, or returning early, once the budget is gone.
    const { ledger } = freshLedger(1_000);
    const held = [heldRow('earlier', 1_000, THU_5PM)];
    const offers = [offer('a'), offer('b'), offer('c'), offer('d')];

    const decisions = decideClaims(offers, ctx(THU_9AM, ledger, held));

    expect(decisions.map((d) => d.objId)).toEqual(['a', 'b', 'c', 'd']);
    expect(decisions.every((d) => d.action === 'skip')).toBe(true);
    for (const d of decisions) {
      if (d.action === 'skip') {
        expect(d.reason).toBe('ceiling_reached');
        expect(d.detail).not.toBe('');
      }
    }
  });

  it('keeps evaluating past an exhausted day and still claims work for a different one', () => {
    // The sharpest form of "does not stop": the offer AFTER the exhausted ones is claimed,
    // because its work lands on a day that still has budget. A pass that stopped at the
    // first refusal would turn this one away for a reason that is not true of it.
    const { ledger } = freshLedger(1_000);
    const held = [heldRow('earlier', 1_000, THU_5PM)];
    const offers = [offer('full-1'), offer('full-2'), offer('other-day', { deadlineMs: FRI_5PM })];

    const decisions = decideClaims(offers, ctx(THU_9AM, ledger, held));

    expect(decisions.map((d) => d.action)).toEqual(['skip', 'skip', 'claim']);
    expect(decisions[2]).toMatchObject({ objId: 'other-day', deadlineDay: '2026-09-18' });
  });

  it('records a reason for every offer it does not claim, whatever turned it away', () => {
    // FR-010, over the whole mix at once: no offer may leave the pass unexplained.
    const { ledger } = freshLedger(1_000);
    const held = [heldRow('earlier', 990, THU_5PM)];
    const offers = [
      offer('ineligible', { eligible: false }),
      offer('passed', { deadlineMs: ALREADY_PASSED }),
      offer('uncurated', { deadlineMs: UNCURATED_DEADLINE }),
      offer('nofields', { effortWords: null }),
      offer('ceiling'),
      // DTP, so its throughput reaches it in working time and the gate allows it — but 2,500
      // words are more than the two 1,000-word days (Thursday, Friday) in its window can
      // hold even empty, so only the ceiling refuses it, and permanently.
      offer('toobig', { effortWords: 2_500, deadlineMs: FRI_5PM, monolingual: true }),
    ];

    const decisions = decideClaims(offers, ctx(THU_9AM, ledger, held));

    expect(decisions.map((d) => d.objId)).toEqual(offers.map((o) => o.objId));
    expect(decisions.map((d) => (d.action === 'skip' ? d.reason : 'claimed'))).toEqual([
      'ineligible_language',
      'deadline_unreachable',
      'holiday_calendar_uncurated',
      'effort_unknown',
      'ceiling_reached',
      'exceeds_daily_ceiling_entirely',
    ]);
    for (const d of decisions) {
      if (d.action === 'skip') expect(d.detail.length).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// T028 — portal order, stopping when the budget is exhausted (FR-007b)
// ===========================================================================

describe('T028 several offers in one read are weighed in the order the portal returned them', () => {
  it('spends the budget in portal order, not on the offers that happen to fit best', () => {
    // Ceiling 100, one deadline day, portal order A=60, B=50, C=30.
    //   portal order : A claims (60), B will not fit (110), C claims (90)   -> {A, C}
    //   sorted by size: C claims (30), B claims (80), A will not fit (140)  -> {C, B}
    // The two disagree on WHICH offers are claimed, not merely on their order, so this
    // kills a sort that a pure ordering assertion would let through.
    // Kills: `[...offers].sort((x, y) => x.effortWords - y.effortWords)` before the loop.
    const { ledger } = freshLedger(100);
    const offers = [
      offer('a', { effortWords: 60 }),
      offer('b', { effortWords: 50 }),
      offer('c', { effortWords: 30 }),
    ];

    const decisions = decideClaims(offers, ctx(THU_9AM, ledger));

    expect(decisions.map((d) => d.objId)).toEqual(['a', 'b', 'c']);
    expect(decisions.map((d) => d.action)).toEqual(['claim', 'skip', 'claim']);
  });

  it('charges each claim against the day before weighing the next offer of that day', () => {
    // Two offers that each fit on their own and cannot both fit. Without advancing the
    // running total inside the pass, both are claimed and the day lands at 160% of its
    // ceiling — an irreversible over-commitment that no later check can undo (SC-006).
    // Kills: passing the unchanged held snapshot to every capacity check.
    const { ledger } = freshLedger(100);
    const offers = [offer('a', { effortWords: 80 }), offer('b', { effortWords: 80 })];

    const decisions = decideClaims(offers, ctx(THU_9AM, ledger));

    expect(decisions.map((d) => d.action)).toEqual(['claim', 'skip']);
  });

  it('claims only one of two 3,400-word jobs due tomorrow when seen at 17:45 (review C-1)', () => {
    // The reviewer's reproduction, against the real decision at the live figures. Each job
    // passes the time gate alone (8.7 h needed, 9.25 h left). Counted as "Monday + Tuesday",
    // both were claimed: 6,800 words into ~3,600 words of working time, irreversibly.
    const { ledger } = freshLedger(3_500);
    const settings: ClaimDecisionSettings = { ...SETTINGS, throughputWordsPerHour: 389 };
    const tue1800 = at('2026-09-15T18:00:00+07:00');
    const offers = [
      offer('a', { effortWords: 3_400, deadlineMs: tue1800 }),
      offer('b', { effortWords: 3_400, deadlineMs: tue1800 }),
    ];

    const decisions = decideClaims(
      offers,
      ctx(at('2026-09-14T17:45:00+07:00'), ledger, [], settings),
    );

    expect(decisions.map((d) => d.action)).toEqual(['claim', 'skip']);
    expect(decisions[1]).toMatchObject({ action: 'skip', reason: 'ceiling_reached' });
  });

  it('lets a full Thursday leave Friday its own day, and carries Thursday’s spare room forward', () => {
    // Since 2026-09-18 the rule is earliest-deadline-first: work due by Friday must fit in
    // Thursday + Friday. Judged from Thursday morning at 100 a day:
    //   thu-1 80  -> by Thu 80  of 100  claim
    //   fri-1 80  -> by Fri 160 of 200  claim
    //   thu-2 80  -> by Thu 160 of 100  skip   (Thursday is full)
    //   fri-2 30  -> by Fri 190 of 200  claim  (Thursday's unused 20 is Friday's too)
    // It used to read "each day's budget is its own" and refuse fri-2; a global running
    // total would refuse fri-1 as well.
    const { ledger } = freshLedger(100);
    const offers = [
      offer('thu-1', { effortWords: 80, deadlineMs: THU_5PM }),
      offer('fri-1', { effortWords: 80, deadlineMs: FRI_5PM }),
      offer('thu-2', { effortWords: 80, deadlineMs: THU_5PM }),
      offer('fri-2', { effortWords: 30, deadlineMs: FRI_5PM }),
    ];

    const decisions = decideClaims(offers, ctx(THU_9AM, ledger));

    expect(decisions.map((d) => d.action)).toEqual(['claim', 'claim', 'skip', 'claim']);
  });

  it('leaves the ledger untouched — deciding is not recording', () => {
    // The pass advances its own copy of the held set. Writing to the store here would
    // put work on the ledger before the portal had committed it, and FR-003 requires
    // nothing deferrable to happen between noticing an offer and claiming it.
    const { ledger, store } = freshLedger(ROOMY);

    decideClaims([offer('a'), offer('b')], ctx(WED_10AM, ledger));

    expect(store.heldWork()).toEqual([]);
  });
});

// ===========================================================================
// T029 — a claim is never attempted for an offer the gate rejected
//        (FR-013, SC-006, V16)
// ===========================================================================

describe('T029 nothing the gate rejected is ever claimed', () => {
  /** Every offer shape that reaches the gate, good and bad, in one list. */
  function mixedBatch(): OfferForDecision[] {
    return [
      offer('good-1'),
      offer('weekend', { deadlineMs: SAT_DEADLINE }),
      offer('holiday', { deadlineMs: HOLIDAY_DEADLINE }),
      offer('uncurated', { deadlineMs: UNCURATED_DEADLINE }),
      offer('passed', { deadlineMs: ALREADY_PASSED }),
      offer('noEffort', { effortWords: null }),
      offer('noDeadline', { deadlineMs: null }),
      offer('unreachable', { effortWords: 5_000, deadlineMs: at('2026-09-16T17:00:00+07:00') }),
      offer('good-2', { deadlineMs: FRI_5PM }),
      offer('ineligible', { eligible: false }),
    ];
  }

  it('claims only where the gate allowed — the SC-006 audit, run over a whole batch', () => {
    // This is V16 in test form: every claim is checked back against the gate's own answer
    // for the same offer. Kills: dropping `if (!verdict.allow) return skip(...)`.
    const { ledger } = freshLedger(ROOMY);
    const offers = mixedBatch();

    const decisions = decideClaims(offers, ctx(WED_10AM, ledger));

    let claimed = 0;
    for (const [i, decision] of decisions.entries()) {
      const source = offers[i] as OfferForDecision;
      if (decision.action !== 'claim') continue;
      claimed += 1;
      expect(gateOracle(source, WED_10AM).allow, `${source.objId} was claimed`).toBe(true);
      expect(source.eligible).toBe(true);
    }
    // Guards the assertion above against passing vacuously. Four: the two good offers, and
    // the weekend and holiday deadlines, reachable since 2026-09-18.
    expect(claimed).toBe(4);
  });

  it('still refuses on a later pass, and on the pass after that', () => {
    // "Under any circumstance, including retries" (FR-013). The robustness pass re-reads
    // offers it has already turned away, so a rejected offer is re-decided repeatedly;
    // none of those passes may reach a different answer.
    const { ledger } = freshLedger(ROOMY);
    const rejected = offer('passed', { deadlineMs: ALREADY_PASSED });
    const snapshots: HeldWork[][] = [[], [heldRow('x', 10, THU_5PM)], [heldRow('y', 90, FRI_5PM)]];

    for (const held of snapshots) {
      const decision = skipOf(decideClaims([rejected], ctx(WED_10AM, ledger, held)));
      expect(decision.reason).toBe('deadline_unreachable');
    }
  });

  it('is not carried through by a claimable offer standing in front of it', () => {
    // A pass that reused the previous offer's verdict, or that kept a "gate already
    // checked" flag across iterations, would claim the second one here.
    const { ledger } = freshLedger(ROOMY);
    const offers = [offer('good'), offer('passed', { deadlineMs: ALREADY_PASSED })];

    const decisions = decideClaims(offers, ctx(WED_10AM, ledger));

    expect(decisions.map((d) => d.action)).toEqual(['claim', 'skip']);
  });

  it('is not rescued by having plenty of ceiling left', () => {
    // The ceiling is the LAST gate, not the only one. An empty ledger must not turn a
    // gate refusal into a claim.
    const { ledger } = freshLedger(ROOMY);
    const o = offer('passed', { effortWords: 1, deadlineMs: ALREADY_PASSED });

    expect(skipOf(decideClaims([o], ctx(WED_10AM, ledger))).reason).toBe('deadline_unreachable');
  });

  it('refuses everything outright when the throughput figure is unusable', () => {
    // A non-positive throughput makes every feasibility answer meaningless. Failing loud
    // once beats emitting a per-offer "cannot finish in time" that blames the offer for a
    // misconfiguration — and beats claiming on an answer nobody can defend.
    const { ledger } = freshLedger(ROOMY);
    const broken: ClaimDecisionSettings = { ...SETTINGS, throughputWordsPerHour: 0 };

    expect(() => decideClaims([offer('a')], ctx(WED_10AM, ledger, [], broken))).toThrow(
      /throughput/i,
    );
  });
});
