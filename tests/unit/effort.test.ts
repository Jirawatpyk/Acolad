import { describe, it, expect } from 'vitest';
import { effortOf } from '../../src/schedule/effort.js';
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
