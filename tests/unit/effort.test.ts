import { describe, it, expect } from 'vitest';
import { effortOf, unitOf, WORDS_UNIT, WWC_UNIT } from '../../src/schedule/effort.js';
import type { XtmJobState } from '../../src/detection/types.js';

const j = (
  words: number | null,
  fileWwc: number | null,
): Pick<XtmJobState, 'words' | 'fileWwc'> => ({
  words,
  fileWwc,
});

describe('effortOf', () => {
  it('wwc: uses File WWC when it is a real positive value', () => {
    expect(effortOf(j(861, 169), 'wwc')).toBe(169);
  });
  it('wwc: falls back to words when fileWwc is null', () => {
    expect(effortOf(j(861, null), 'wwc')).toBe(861);
  });
  it('wwc: falls back to words when fileWwc is 0 (scrape-0 guard)', () => {
    expect(effortOf(j(861, 0), 'wwc')).toBe(861);
  });
  it('words: always raw words, ignoring a non-null fileWwc', () => {
    expect(effortOf(j(861, 169), 'words')).toBe(861);
  });
  it('both null → null (feasibility "effort unknown" guard fires downstream)', () => {
    expect(effortOf(j(null, null), 'wwc')).toBeNull();
  });
});

describe('unitOf / canonical unit constants (C8)', () => {
  it('WORDS_UNIT is the canonical words-mode label shape', () => {
    expect(WORDS_UNIT).toEqual({ adj: 'word', noun: 'words' });
  });
  it('WWC_UNIT is the canonical wwc-mode label shape', () => {
    expect(WWC_UNIT).toEqual({ adj: 'WWC', noun: 'WWC' });
  });
  it("unitOf('words') returns WORDS_UNIT (the same instance, not a copy)", () => {
    expect(unitOf('words')).toBe(WORDS_UNIT);
  });
  it("unitOf('wwc') returns WWC_UNIT (the same instance, not a copy)", () => {
    expect(unitOf('wwc')).toBe(WWC_UNIT);
  });
});
