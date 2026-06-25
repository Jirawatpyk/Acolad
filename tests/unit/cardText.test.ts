import { describe, it, expect } from 'vitest';
import { dash, wordsValue, sanitizeCardId } from '../../src/reporting/cardText.js';

describe('dash', () => {
  it('returns the string value for a non-empty string', () => {
    expect(dash('hello')).toBe('hello');
  });

  it('returns "0" for the number 0 (falsy number must NOT become dash)', () => {
    expect(dash(0)).toBe('0');
  });

  it('returns a positive number as its string form', () => {
    expect(dash(42)).toBe('42');
  });

  it('returns "—" for null', () => {
    expect(dash(null)).toBe('—');
  });

  it('returns "—" for undefined', () => {
    expect(dash(undefined)).toBe('—');
  });

  it('returns "—" for empty string', () => {
    expect(dash('')).toBe('—');
  });
});

describe('wordsValue', () => {
  it('returns "0" for 0 (preserves zero)', () => {
    expect(wordsValue(0)).toBe('0');
  });

  it('returns the word count as a string for a positive number', () => {
    expect(wordsValue(120)).toBe('120');
  });

  it('returns null for null', () => {
    expect(wordsValue(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(wordsValue(undefined)).toBeNull();
  });
});

describe('sanitizeCardId', () => {
  it('replaces non-alnum chars with dashes', () => {
    expect(sanitizeCardId('a:b')).toBe('a-b');
  });

  it('collapses consecutive dashes into one', () => {
    expect(sanitizeCardId('a--b')).toBe('a-b');
  });

  it('trims leading and trailing dashes', () => {
    expect(sanitizeCardId('-abc-')).toBe('abc');
  });

  it('handles the new-:group:001 example correctly (no double dash, no leading/trailing dash)', () => {
    // 'new-:group:001' → replace non-alnum → 'new--group-001' → collapse → 'new-group-001'
    expect(sanitizeCardId('new-:group:001')).toBe('new-group-001');
  });

  it('preserves existing single dashes', () => {
    expect(sanitizeCardId('abc-def')).toBe('abc-def');
  });

  it('handles already-clean ids without change', () => {
    expect(sanitizeCardId('newjob123')).toBe('newjob123');
  });
});
