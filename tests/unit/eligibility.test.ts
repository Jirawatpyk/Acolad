import { describe, it, expect } from 'vitest';
import { isEligibleTarget } from '../../src/detection/eligibility.js';

const MALAY = ['Malay (Malaysia)'];

describe('isEligibleTarget (R8 — exact, config-driven)', () => {
  it('accepts the exact Malay (Malaysia) target', () => {
    expect(isEligibleTarget('Malay (Malaysia)', MALAY)).toBe(true);
  });

  it('is tolerant of surrounding whitespace and case', () => {
    expect(isEligibleTarget('  malay (malaysia) ', MALAY)).toBe(true);
  });

  it('rejects a different language', () => {
    expect(isEligibleTarget('Thai', MALAY)).toBe(false);
  });

  it('rejects a substring of the eligible value (exact match, not substring)', () => {
    expect(isEligibleTarget('Malay', MALAY)).toBe(false);
  });

  it('rejects a null/unreadable target language (never accept on uncertainty)', () => {
    expect(isEligibleTarget(null, MALAY)).toBe(false);
  });

  it('is driven by the configured list, not hard-coded to Malay', () => {
    expect(isEligibleTarget('Thai', ['Thai'])).toBe(true);
    expect(isEligibleTarget('Malay (Malaysia)', ['Thai'])).toBe(false);
  });

  it('supports multiple configured languages', () => {
    const list = ['Malay (Malaysia)', 'Indonesian'];
    expect(isEligibleTarget('Indonesian', list)).toBe(true);
    expect(isEligibleTarget('Malay (Malaysia)', list)).toBe(true);
    expect(isEligibleTarget('Vietnamese', list)).toBe(false);
  });

  it('returns false for an empty accept list', () => {
    expect(isEligibleTarget('Malay (Malaysia)', [])).toBe(false);
  });
});
