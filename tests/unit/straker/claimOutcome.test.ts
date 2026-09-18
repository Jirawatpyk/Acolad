import { describe, expect, it } from 'vitest';
import {
  CONFIRMED_LOST_RACE_SIGNALS,
  classifyClaim,
  type ClaimResponse,
} from '../../../src/straker/claimOutcome.js';
import { alertsOn, countsTowardLedger } from '../../../src/straker/outcomePolicy.js';

const accepted: ClaimResponse = { kind: 'accepted' };
const rejected = (signal: string): ClaimResponse => ({ kind: 'rejected', signal });
const noAnswer: ClaimResponse = { kind: 'no_answer', reason: 'socket closed' };

describe('classifyClaim — the three outcomes FR-005 distinguishes', () => {
  it('reads an accepted claim as won', () => {
    expect(classifyClaim(accepted)).toBe('won');
  });

  it('reads a rejection carrying a confirmed lost-race signal as a lost race', () => {
    expect(classifyClaim(rejected('already_assigned'), ['already_assigned'])).toBe('lost');
  });

  it('reads a request that produced no answer as unknown, never as a loss', () => {
    // The claim may or may not have landed. Calling it lost would close a question the bot
    // cannot answer, and closing it wrongly means the team silently owes work it never
    // recorded — which is what reconciliation exists to settle instead (FR-016a, R7).
    expect(classifyClaim(noAnswer)).toBe('unknown');
  });
});

describe('classifyClaim — an unrecognised rejection is a fault, not a loss (FR-005a)', () => {
  it('reads a rejection it does not recognise as failed', () => {
    // The conservative direction, and the whole point of FR-005a: `lost` is the one outcome
    // that never alerts, so mislabelling a fault as a loss hides a broken claim path behind
    // silence. Getting this backwards would look exactly like a bot that keeps arriving
    // second.
    expect(classifyClaim(rejected('offer_withdrawn'))).toBe('failed');
  });

  it('does not treat a rejection as lost merely because it is not something else', () => {
    for (const signal of ['', 'unknown', 'error', 'nope', 'lost', 'taken', 'race_lost']) {
      expect(classifyClaim(rejected(signal))).toBe('failed');
    }
  });

  it('recognises the lost-race signal only by exact membership, not by resemblance', () => {
    // 'already_assigned_to_other' merely *looks* like the confirmed signal. Matching on a
    // prefix or a substring is how a rejection nobody has verified starts being read as a
    // normal loss.
    expect(classifyClaim(rejected('already_assigned_to_other'), ['already_assigned'])).toBe(
      'failed',
    );
  });

  it('ignores surrounding whitespace and case, which are transport noise rather than meaning', () => {
    expect(classifyClaim(rejected('  ALREADY_ASSIGNED '), ['already_assigned'])).toBe('lost');
  });
});

describe('the confirmed lost-race signal list (RP-4)', () => {
  // Confirmed 2026-09-18 from the portal's own web app: its Accept button POSTs
  // /job-offers/{id}/accept and treats HTTP 409 — and only 409 — as "Offer no longer
  // available … may have been accepted by another vendor". Anything else stays a fault.
  it('holds exactly the 409 the portal itself reads as "taken by another vendor"', () => {
    expect(CONFIRMED_LOST_RACE_SIGNALS).toEqual(['http_409']);
  });

  it('classifies a 409 as a lost race — the one outcome that does not alert', () => {
    expect(classifyClaim(rejected('http_409'))).toBe('lost');
  });

  it('still classifies every other rejection as a fault', () => {
    expect(classifyClaim(rejected('http_404'))).toBe('failed');
    expect(classifyClaim(rejected('http_400'))).toBe('failed');
    expect(classifyClaim(rejected('already_assigned'))).toBe('failed');
  });
});

describe('what each outcome then causes', () => {
  it('never alerts on a lost race, and never lets it count against the ledger', () => {
    expect(alertsOn(classifyClaim(rejected('already_assigned'), ['already_assigned']))).toBe(false);
    expect(
      countsTowardLedger(classifyClaim(rejected('already_assigned'), ['already_assigned'])),
    ).toBe(false);
  });

  it('alerts on a fault and on an unanswered claim, because both need a human', () => {
    expect(alertsOn(classifyClaim(rejected('offer_withdrawn')))).toBe(true);
    expect(alertsOn(classifyClaim(noAnswer))).toBe(true);
  });

  it('puts won work on the ledger and does not alert about it', () => {
    expect(countsTowardLedger(classifyClaim(accepted))).toBe(true);
    expect(alertsOn(classifyClaim(accepted))).toBe(false);
  });
});
