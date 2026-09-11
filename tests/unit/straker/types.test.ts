import { describe, expect, it } from 'vitest';
import { WORDS_UNIT } from '../../../src/schedule/effort.js';
import {
  CLAIM_OUTCOMES,
  SKIP_REASONS,
  STRAKER_EFFORT_UNIT,
  XTM_ACCEPT_OUTCOME_OF,
  alertsOn,
  countsTowardLedger,
} from '../../../src/straker/types.js';

/**
 * DC-2 (FR-028) / V33: both portals must use the same names, with the same meanings, for
 * the shared concepts. These tests are the automated form of that check — the alternative
 * is comparing two files by eye, which is exactly how drift survives until the deferred
 * core extraction stops being mechanical.
 */
describe('shared vocabulary with the XTM bot (DC-2, V33)', () => {
  it('measures effort with the XTM bot own words unit rather than a Straker copy of it', () => {
    expect(STRAKER_EFFORT_UNIT).toBe(WORDS_UNIT);
  });

  it('maps every claim outcome onto the XTM accept vocabulary, so the two can be compared', () => {
    for (const outcome of CLAIM_OUTCOMES) {
      expect(XTM_ACCEPT_OUTCOME_OF).toHaveProperty(outcome);
    }
  });

  it('maps a won claim onto the XTM accepted outcome and a lost race onto its missing one', () => {
    expect(XTM_ACCEPT_OUTCOME_OF.won).toBe('accepted');
    expect(XTM_ACCEPT_OUTCOME_OF.lost).toBe('missing');
    expect(XTM_ACCEPT_OUTCOME_OF.failed).toBe('failed');
  });

  it('leaves unknown and recovered without an XTM equivalent, because the XTM bot has none', () => {
    expect(XTM_ACCEPT_OUTCOME_OF.unknown).toBeNull();
    expect(XTM_ACCEPT_OUTCOME_OF.recovered).toBeNull();
  });
});

describe('ClaimOutcome — the result of the one irreversible action (data-model 3)', () => {
  it('carries exactly the five outcomes the data model settled on', () => {
    expect([...CLAIM_OUTCOMES].sort()).toEqual(
      ['failed', 'lost', 'recovered', 'unknown', 'won'].sort(),
    );
  });

  it('never alerts on a lost race, which is the normal non-win outcome (FR-006, SC-007)', () => {
    expect(alertsOn('lost')).toBe(false);
  });

  it('alerts on every outcome that is a fault or an open question', () => {
    expect(alertsOn('failed')).toBe(true);
    expect(alertsOn('unknown')).toBe(true);
    expect(alertsOn('recovered')).toBe(true);
  });

  it('does not alert on a win, which is news rather than a fault', () => {
    expect(alertsOn('won')).toBe(false);
  });

  it('counts won and recovered work against the ledger, and nothing else', () => {
    expect(countsTowardLedger('won')).toBe(true);
    expect(countsTowardLedger('recovered')).toBe(true);
    expect(countsTowardLedger('lost')).toBe(false);
    expect(countsTowardLedger('failed')).toBe(false);
    expect(countsTowardLedger('unknown')).toBe(false);
  });
});

describe('SkipReason — why an offer that appeared was never claimed (data-model 4)', () => {
  it('carries exactly the reasons the data model settled on', () => {
    expect([...SKIP_REASONS].sort()).toEqual(
      [
        'ineligible_language',
        'outside_schedule',
        'deadline_on_non_working_day',
        'deadline_unreachable',
        'ceiling_reached',
        'exceeds_daily_ceiling_entirely',
        'holiday_calendar_uncurated',
        'effort_unknown',
        'deadline_unknown',
      ].sort(),
    );
  });

  it('keeps an offer larger than a whole day distinct from an ordinary ceiling skip', () => {
    // They are not the same event: one clears tomorrow, the other recurs forever and
    // needs a human. Collapsing them is how a permanently un-claimable offer goes unseen.
    expect(SKIP_REASONS).toContain('ceiling_reached');
    expect(SKIP_REASONS).toContain('exceeds_daily_ceiling_entirely');
  });
});
