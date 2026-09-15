import { describe, expect, it } from 'vitest';
import { SKIP_REASONS, CLAIM_OUTCOMES } from '../../../src/straker/outcomePolicy.js';
import type { ClaimOutcome, SkipReason } from '../../../src/straker/outcomePolicy.js';
import type { ClaimEvent, OfferEvent, SkipEvent } from '../../../src/straker/strakerStore.js';
import {
  WIN_RATE_SIDE_OF_OUTCOME,
  WIN_RATE_SIDE_OF_SKIP,
  classifyOffer,
  computeWinRate,
} from '../../../src/straker/winRate.js';
import { formatWinRateReport, parseWinRateWindow } from '../../../src/straker/winRateReport.js';

/**
 * T050 — the win rate (FR-017), its companion turn-away count (FR-017a) and SC-004/V22.
 *
 * **What these tests are actually defending is the denominator.** The arithmetic is a
 * division; the measure is the classification. Both ways of getting it wrong produce a
 * number that looks perfectly reasonable and says the opposite of the truth:
 *
 * - put the offers our own rules turned away into the denominator and a bot that was
 *   obediently declining work reads as a bot losing races it never entered;
 * - count only what we attempted and a bot that passes over most of the work reads as
 *   brilliant.
 *
 * So nearly every test below is of the form "this offer does / does not raise `winnable`",
 * and each names the mutation it would catch. The two the task asked to be demonstrated by
 * actually mutating the source are marked **MUTATION-CHECKED**.
 */

const T0 = Date.UTC(2026, 8, 15, 6, 38, 0); // 2026-09-15 13:38 Bangkok — a real arrival
const MINUTE = 60_000;

function claim(objId: string, outcome: ClaimOutcome, atMs: number = T0): ClaimEvent {
  return {
    objId,
    eventType: 'claim',
    outcome,
    effortWords: 4,
    deadlineMs: T0 + 8 * 60 * MINUTE,
    occurredAtMs: atMs,
  };
}

function recovery(objId: string, atMs: number = T0 + 15 * MINUTE): ClaimEvent {
  return {
    objId,
    eventType: 'recovery',
    outcome: 'recovered',
    effortWords: 4,
    deadlineMs: T0 + 8 * 60 * MINUTE,
    occurredAtMs: atMs,
  };
}

function skip(objId: string, skipReason: SkipReason, atMs: number = T0): SkipEvent {
  return { objId, eventType: 'skip', skipReason, occurredAtMs: atMs };
}

/** A sighting row carries no decision at all — the shape an undecided offer arrives in. */
function sighting(objId: string, atMs: number = T0): OfferEvent {
  return {
    objId,
    eventType: 'sighting',
    effortWords: 4,
    deadlineMs: T0 + 8 * 60 * MINUTE,
    occurredAtMs: atMs,
  };
}

// ---------------------------------------------------------------------------
// The classification table itself
// ---------------------------------------------------------------------------

describe('the classification table (FR-017) is exhaustive rather than incidental', () => {
  it('places every claim outcome on one side of the ratio', () => {
    for (const outcome of CLAIM_OUTCOMES) {
      expect(WIN_RATE_SIDE_OF_OUTCOME).toHaveProperty(outcome);
    }
  });

  it('places every skip reason on one side of the ratio', () => {
    for (const reason of SKIP_REASONS) {
      expect(WIN_RATE_SIDE_OF_SKIP).toHaveProperty(reason);
    }
  });

  it('treats a recovered offer as a win, because the portal says the work is ours', () => {
    expect(WIN_RATE_SIDE_OF_OUTCOME.won).toBe('won');
    expect(WIN_RATE_SIDE_OF_OUTCOME.recovered).toBe('won');
  });

  it('keeps lost, failed and unknown winnable but unwon — three ways to not win a race', () => {
    expect(WIN_RATE_SIDE_OF_OUTCOME.lost).toBe('winnable');
    expect(WIN_RATE_SIDE_OF_OUTCOME.failed).toBe('winnable');
    expect(WIN_RATE_SIDE_OF_OUTCOME.unknown).toBe('winnable');
  });

  it('marks claiming_halted winnable and every other skip reason turned-away', () => {
    // data-model §4: the offer passed every rule and the cycle stopped before it could be
    // attempted. Our rules did not turn it away, so it is not a companion-count skip — and
    // leaving it out of the denominator would flatter the rate at the one time the bot can
    // win nothing at all.
    expect(WIN_RATE_SIDE_OF_SKIP.claiming_halted).toBe('winnable');
    for (const reason of SKIP_REASONS) {
      if (reason === 'claiming_halted') continue;
      expect(WIN_RATE_SIDE_OF_SKIP[reason]).toBe('turned_away');
    }
  });
});

// ---------------------------------------------------------------------------
// One offer at a time
// ---------------------------------------------------------------------------

describe('classifying one offer from its events', () => {
  it('reads a won claim as won and not via recovery', () => {
    expect(classifyOffer([claim('a', 'won')])).toEqual({ kind: 'won', viaRecovery: false });
  });

  it('reads a lost race as lost — a normal outcome, not a fault (FR-006)', () => {
    expect(classifyOffer([claim('a', 'lost')])).toEqual({ kind: 'lost' });
  });

  it('lets a claim outcome override an earlier skip row for the same offer', () => {
    // Kills: classifying on whichever row happens to sort first. The ceiling refused this
    // offer on Monday and it was claimed on Tuesday when capacity freed; both rows survive,
    // because the store upserts per (objId, eventType).
    const events = [skip('a', 'ceiling_reached'), claim('a', 'won', T0 + 24 * 60 * MINUTE)];
    expect(classifyOffer(events)).toEqual({ kind: 'won', viaRecovery: false });
  });

  it('lets reconciliation settle an unknown claim into a win (FR-016a/b)', () => {
    // Kills: ignoring the recovery row, which would leave a landed claim counted as unwon
    // forever.
    expect(classifyOffer([claim('a', 'unknown'), recovery('a')])).toEqual({
      kind: 'won',
      viaRecovery: true,
    });
  });

  it('prefers a recovery over a recorded loss, because the portal is authoritative', () => {
    expect(classifyOffer([claim('a', 'lost'), recovery('a')])).toEqual({
      kind: 'won',
      viaRecovery: true,
    });
  });

  it('reads a skip with no claim as turned away, naming the rule', () => {
    expect(classifyOffer([skip('a', 'ineligible_language')])).toEqual({
      kind: 'turned_away',
      reason: 'ineligible_language',
    });
  });

  it('reads claiming_halted as halted rather than turned away', () => {
    expect(classifyOffer([skip('a', 'claiming_halted')])).toEqual({ kind: 'halted' });
  });

  it('reads an offer with no decision of any kind as undecided, not as a skip', () => {
    // Kills: folding a decision-less offer into either side. It belongs to neither and is
    // reported on its own, because an offer that produced no row is a defect signal.
    expect(classifyOffer([sighting('a')])).toEqual({ kind: 'undecided' });
    expect(classifyOffer([])).toEqual({ kind: 'undecided' });
  });

  it('classifies every skip reason without throwing — the function is total', () => {
    for (const reason of SKIP_REASONS) {
      const standing = classifyOffer([skip('a', reason)]);
      expect(['turned_away', 'halted']).toContain(standing.kind);
    }
  });
});

// ---------------------------------------------------------------------------
// The denominator
// ---------------------------------------------------------------------------

describe('the denominator — offers that were genuinely winnable (FR-017)', () => {
  it('counts a won offer in both the numerator and the denominator', () => {
    const r = computeWinRate([claim('a', 'won')]);
    expect(r.won).toBe(1);
    expect(r.winnable).toBe(1);
    expect(r.ratePct).toBe(100);
  });

  it('**MUTATION-CHECKED** counts a lost race in the denominator and never in the numerator', () => {
    // The race was entered and lost on speed: exactly what this measure exists to show.
    // Kills three mutations: `lost` credited as a win (rate 100%), `lost` dropped from the
    // denominator (rate n/a), and `lost` filed as a rules turn-away (rate n/a, companion 1).
    const r = computeWinRate([claim('a', 'lost')]);
    expect(r.won).toBe(0);
    expect(r.lost).toBe(1);
    expect(r.winnable).toBe(1);
    expect(r.turnedAway).toBe(0);
    expect(r.ratePct).toBe(0);
  });

  it('counts a failed claim in the denominator — the gate permitted it, we did not win it', () => {
    // Deliberately DIVERGES from data-model §3's "counts toward: neither"; FR-017's own
    // definition of winnable is "eligible and the scheduling gate would have permitted the
    // claim", which a failed claim satisfies. Kills: excluding faults, which would report a
    // wholly broken claim path as `n/a` instead of 0%.
    const r = computeWinRate([claim('a', 'failed')]);
    expect(r.failed).toBe(1);
    expect(r.winnable).toBe(1);
    expect(r.ratePct).toBe(0);
  });

  it('counts an offer halted before it could be attempted (data-model §4)', () => {
    // A barred account or an expired session stopped the cycle. Our rules said yes, so the
    // offer was winnable and we won nothing — the rate must fall, loudly.
    const r = computeWinRate([skip('a', 'claiming_halted')]);
    expect(r.haltedBeforeAttempt).toBe(1);
    expect(r.winnable).toBe(1);
    expect(r.turnedAway).toBe(0);
    expect(r.ratePct).toBe(0);
  });

  it('**MUTATION-CHECKED** keeps every rules-turned-away skip out of the denominator', () => {
    // The whole point of FR-017's "genuinely". Kills: any turn-away leaking into the
    // denominator, which would make an obedient bot read as a slow one.
    const events = SKIP_REASONS.filter((reason) => reason !== 'claiming_halted').map((reason, i) =>
      skip(`off-${String(i)}`, reason),
    );
    const r = computeWinRate([...events, claim('winner', 'won')]);
    expect(r.winnable).toBe(1);
    expect(r.won).toBe(1);
    expect(r.ratePct).toBe(100);
    expect(r.turnedAway).toBe(SKIP_REASONS.length - 1);
  });

  it('keeps an ineligible language out of the denominator (FR-011, FR-017)', () => {
    const r = computeWinRate([claim('a', 'won'), skip('b', 'ineligible_language')]);
    expect(r.winnable).toBe(1);
    expect(r.ratePct).toBe(100);
  });

  it('counts offers by identity, so one offer seen many times is one offer', () => {
    const r = computeWinRate([
      skip('a', 'ceiling_reached'),
      skip('a', 'ceiling_reached', T0 + MINUTE),
      claim('a', 'lost', T0 + 2 * MINUTE),
    ]);
    expect(r.offers).toBe(1);
    expect(r.winnable).toBe(1);
    expect(r.turnedAway).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// unknown
// ---------------------------------------------------------------------------

describe('an unknown claim, while it is still unknown', () => {
  it('sits in the denominator and not in the numerator', () => {
    // The claim may or may not have landed. It was unambiguously winnable — eligible and
    // gate-permitted — so the denominator is not in question; the numerator is, and a
    // measure of wins counts only confirmed wins. Kills: crediting a maybe as a win, which
    // flatters the figure exactly when the system is least trustworthy.
    const r = computeWinRate([claim('a', 'unknown')]);
    expect(r.won).toBe(0);
    expect(r.winnable).toBe(1);
    expect(r.ratePct).toBe(0);
  });

  it('is reported separately as still pending, so the rate is read as a lower bound', () => {
    // Kills: burying it among the losses. Without this count nobody can tell a rate that is
    // settled from one that reconciliation is about to move.
    const r = computeWinRate([claim('a', 'unknown'), claim('b', 'lost')]);
    expect(r.unknownPending).toBe(1);
    expect(r.lost).toBe(1);
  });

  it('moves into the numerator once reconciliation resolves it (FR-016a, SC-009)', () => {
    const before = computeWinRate([claim('a', 'unknown'), claim('b', 'won')]);
    const after = computeWinRate([claim('a', 'unknown'), recovery('a'), claim('b', 'won')]);
    expect(before.ratePct).toBe(50);
    expect(after.ratePct).toBe(100);
    expect(after.unknownPending).toBe(0);
    expect(after.recovered).toBe(1);
  });

  it('stays unwon when reconciliation shows the claim never landed', () => {
    // Resolution can also settle the other way: the store lets an `unknown` outcome be
    // overwritten (nothing else may be), so the claim row simply becomes `lost`.
    const r = computeWinRate([claim('a', 'lost')]);
    expect(r.won).toBe(0);
    expect(r.unknownPending).toBe(0);
    expect(r.winnable).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The companion count
// ---------------------------------------------------------------------------

describe('the companion count — offers our own rules turned away (FR-017a)', () => {
  it('counts each turned-away offer once and breaks the total down by rule', () => {
    const r = computeWinRate([
      skip('a', 'ineligible_language'),
      skip('b', 'ineligible_language'),
      skip('c', 'ceiling_reached'),
      claim('d', 'won'),
    ]);
    expect(r.turnedAway).toBe(3);
    expect(r.turnedAwayByReason.get('ineligible_language')).toBe(2);
    expect(r.turnedAwayByReason.get('ceiling_reached')).toBe(1);
  });

  it('lists only the rules that actually turned something away', () => {
    // Kills: printing all ten reasons at zero, which buries the one that matters.
    const r = computeWinRate([skip('a', 'holiday_calendar_uncurated')]);
    expect([...r.turnedAwayByReason.keys()]).toEqual(['holiday_calendar_uncurated']);
  });

  it('never counts claiming_halted as a rules turn-away', () => {
    const r = computeWinRate([skip('a', 'claiming_halted')]);
    expect(r.turnedAway).toBe(0);
    expect(r.turnedAwayByReason.size).toBe(0);
  });

  it('reports both figures from the same pass, because neither is interpretable alone', () => {
    // A low rate with a high turn-away count is a configuration question; a low rate with a
    // low one is a speed question. They call for opposite responses.
    const r = computeWinRate([claim('a', 'lost'), skip('b', 'ceiling_reached')]);
    expect(r.ratePct).toBe(0);
    expect(r.turnedAway).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Degenerate periods
// ---------------------------------------------------------------------------

describe('degenerate periods', () => {
  it('reports no offers at all as n/a rather than as 0%', () => {
    // 0/0 is not zero. A bot that saw nothing has not lost anything.
    const r = computeWinRate([]);
    expect(r.offers).toBe(0);
    expect(r.winnable).toBe(0);
    expect(r.ratePct).toBeNull();
  });

  it('reports offers that were all turned away as n/a rather than as 0%', () => {
    const r = computeWinRate([skip('a', 'ineligible_language'), skip('b', 'ceiling_reached')]);
    expect(r.offers).toBe(2);
    expect(r.winnable).toBe(0);
    expect(r.ratePct).toBeNull();
    expect(r.turnedAway).toBe(2);
  });

  it('reports a clean sweep as 100%', () => {
    const r = computeWinRate([claim('a', 'won'), claim('b', 'won'), skip('c', 'ceiling_reached')]);
    expect(r.ratePct).toBe(100);
    expect(r.won).toBe(2);
  });

  it('counts an offer seen with no decision recorded on neither side', () => {
    const r = computeWinRate([sighting('a'), claim('b', 'won')]);
    expect(r.undecided).toBe(1);
    expect(r.winnable).toBe(1);
    expect(r.turnedAway).toBe(0);
    expect(r.offers).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Windowing
// ---------------------------------------------------------------------------

describe('measuring a period (SC-004 baseline)', () => {
  it('measures everything when given no window', () => {
    const r = computeWinRate([claim('a', 'won', T0 - 30 * 24 * 60 * MINUTE), claim('b', 'lost')]);
    expect(r.offers).toBe(2);
  });

  it('excludes events before the window opens', () => {
    const r = computeWinRate([claim('old', 'won', T0 - MINUTE), claim('new', 'lost', T0)], {
      fromMs: T0,
    });
    expect(r.offers).toBe(1);
    expect(r.won).toBe(0);
    expect(r.lost).toBe(1);
  });

  it('treats the window as half-open, so adjacent periods cannot double-count an offer', () => {
    const events = [claim('a', 'won', T0), claim('b', 'won', T0 + MINUTE)];
    const first = computeWinRate(events, { fromMs: T0, toMs: T0 + MINUTE });
    const second = computeWinRate(events, { fromMs: T0 + MINUTE, toMs: T0 + 2 * MINUTE });
    expect(first.offers).toBe(1);
    expect(second.offers).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

describe('invariants that hold whatever the input', () => {
  const everything: OfferEvent[] = [
    claim('won-1', 'won'),
    claim('won-2', 'unknown'),
    recovery('won-2'),
    claim('lost-1', 'lost'),
    claim('failed-1', 'failed'),
    claim('unknown-1', 'unknown'),
    skip('halted-1', 'claiming_halted'),
    skip('away-1', 'ceiling_reached'),
    skip('away-2', 'deadline_unreachable'),
    sighting('quiet-1'),
  ];

  it('splits the denominator into exactly the five standings that make it up', () => {
    const r = computeWinRate(everything);
    expect(r.winnable).toBe(r.won + r.lost + r.failed + r.unknownPending + r.haltedBeforeAttempt);
    expect(r.winnable).toBe(6);
  });

  it('accounts for every offer it saw exactly once', () => {
    const r = computeWinRate(everything);
    expect(r.offers).toBe(r.winnable + r.turnedAway + r.undecided);
    expect(r.offers).toBe(9);
  });

  it('never reports a rate outside 0-100', () => {
    const r = computeWinRate(everything);
    expect(r.ratePct).not.toBeNull();
    expect(r.ratePct ?? -1).toBeGreaterThanOrEqual(0);
    expect(r.ratePct ?? 101).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// What the ops script prints (T056)
// ---------------------------------------------------------------------------

describe('the printed report (V22, SC-004)', () => {
  const source = 'state/straker/straker.db';

  it('prints n/a, never 0%, when nothing was winnable', () => {
    const text = formatWinRateReport(computeWinRate([]), { source, windowLabel: 'all time' });
    expect(text).toContain('n/a');
    expect(text).not.toContain('0.0%');
  });

  it('prints the rate and the companion count together, never one alone', () => {
    const rate = computeWinRate([
      claim('a', 'won'),
      claim('b', 'lost'),
      skip('c', 'ceiling_reached'),
    ]);
    const text = formatWinRateReport(rate, { source, windowLabel: 'all time' });
    expect(text).toContain('50.0%');
    expect(text).toMatch(/turned away by our own rules \(FR-017a\): 1/);
    expect(text).toContain('ceiling_reached');
  });

  it('names the source and the window it measured, so a figure cannot be quoted bare', () => {
    const text = formatWinRateReport(computeWinRate([]), {
      source,
      windowLabel: 'the last 14 days',
    });
    expect(text).toContain(source);
    expect(text).toContain('the last 14 days');
  });

  it('keeps every label clear of its number, including the longest one', () => {
    // A real run printed `seen, no decision recorded0`: the label column was exactly the
    // width of the longest label, so the count collided with the word.
    const text = formatWinRateReport(computeWinRate([sighting('a')]), {
      source,
      windowLabel: 'all time',
    });
    for (const line of text.split('\n')) expect(line).not.toMatch(/[a-z)]\d/);
    expect(text).toMatch(/seen, no decision recorded {2,}1/);
  });

  it('warns that unresolved claims make the rate a lower bound', () => {
    const text = formatWinRateReport(computeWinRate([claim('a', 'unknown')]), {
      source,
      windowLabel: 'all time',
    });
    expect(text).toMatch(/lower bound/);
  });

  it('marks a thin sample as a weak signal (SC-004)', () => {
    const text = formatWinRateReport(computeWinRate([claim('a', 'won')]), {
      source,
      windowLabel: 'all time',
    });
    expect(text).toMatch(/weak signal/);
  });
});

describe('the period the ops script measures', () => {
  it('measures all time when no period is asked for', () => {
    const { window, label } = parseWinRateWindow([], T0);
    expect(window).toBeUndefined();
    expect(label).toBe('all time');
  });

  it('turns --days into a window opening that many days before now', () => {
    const { window, label } = parseWinRateWindow(['--days', '14'], T0);
    expect(window).toEqual({ fromMs: T0 - 14 * 24 * 60 * MINUTE });
    expect(label).toContain('14');
  });

  it('refuses a --days that is not a positive number rather than measuring the wrong period', () => {
    // Fail loud: silently falling back to all-time would answer a question nobody asked,
    // and the answer looks exactly like a correct one.
    expect(() => parseWinRateWindow(['--days', 'fortnight'], T0)).toThrow(/--days/);
    expect(() => parseWinRateWindow(['--days', '0'], T0)).toThrow(/--days/);
    expect(() => parseWinRateWindow(['--days'], T0)).toThrow(/--days/);
  });
});
