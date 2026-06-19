import { describe, it, expect } from 'vitest';
import { decideAccept } from '../../src/detection/acceptDecision.js';

const base = {
  targetLang: 'Malay (Malaysia)',
  words: 100 as number | null,
  acceptEnabled: true,
  acceptLanguages: ['Malay (Malaysia)'],
  maxWords: 0, // no limit
  acceptedThisCycle: 0,
  maxPerCycle: 0, // no limit
};

describe('decideAccept (FR-006/007/012/025)', () => {
  it('accepts an eligible Malay job under no caps with accept enabled', () => {
    expect(decideAccept(base)).toEqual({ action: 'accept' });
  });

  it('skips a non-Malay job (Skipped, FR-007) regardless of accept switch', () => {
    const d = decideAccept({ ...base, targetLang: 'Thai' });
    expect(d.action).toBe('skip');
  });

  it('marks an eligible job as disabled when ACCEPT_ENABLED is off (FR-012)', () => {
    expect(decideAccept({ ...base, acceptEnabled: false })).toEqual({ action: 'disabled' });
  });

  it('still skips a non-Malay job even when accept is disabled (language wins)', () => {
    const d = decideAccept({ ...base, acceptEnabled: false, targetLang: 'Thai' });
    expect(d.action).toBe('skip');
  });

  it('skips an eligible job that exceeds the configured max words (FR-025)', () => {
    const d = decideAccept({ ...base, maxWords: 50, words: 100 });
    expect(d.action).toBe('skip');
    if (d.action === 'skip') expect(d.reason).toMatch(/word/i);
  });

  it('accepts when within the max-words cap', () => {
    expect(decideAccept({ ...base, maxWords: 200, words: 100 })).toEqual({ action: 'accept' });
  });

  it('treats unknown word count as within any cap (does not skip on null words)', () => {
    expect(decideAccept({ ...base, maxWords: 50, words: null })).toEqual({ action: 'accept' });
  });

  it('skips when the per-cycle accept cap is already reached (FR-025)', () => {
    const d = decideAccept({ ...base, maxPerCycle: 2, acceptedThisCycle: 2 });
    expect(d.action).toBe('skip');
    if (d.action === 'skip') expect(d.reason).toMatch(/cycle/i);
  });

  it('accepts while under the per-cycle cap', () => {
    expect(decideAccept({ ...base, maxPerCycle: 2, acceptedThisCycle: 1 })).toEqual({
      action: 'accept',
    });
  });

  it('zero caps mean unlimited (default)', () => {
    expect(
      decideAccept({ ...base, maxWords: 0, words: 999999, maxPerCycle: 0, acceptedThisCycle: 99 }),
    ).toEqual({ action: 'accept' });
  });
});
