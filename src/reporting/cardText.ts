/**
 * Shared pure helpers for building Google Chat card text.
 * No I/O, no side effects — safe to unit-test without stubs.
 */

/**
 * Safe display fallback: null / undefined / empty string → '—'.
 * The number 0 renders as '0' (falsy numbers are real values).
 */
export const dash = (v: string | number | null | undefined): string =>
  v !== null && v !== undefined && v !== '' ? String(v) : '—';

/**
 * Convert a word count to its string form, preserving 0 as '0'.
 * Returns null when the count is null or undefined (caller decides the fallback).
 */
export const wordsValue = (words: number | null | undefined): string | null =>
  words !== null && words !== undefined ? String(words) : null;

/**
 * Sanitize an arbitrary string to a safe Google Chat cardId:
 *   - non-alnum characters → '-'
 *   - consecutive dashes collapsed to single '-'
 *   - leading/trailing dashes trimmed
 */
export const sanitizeCardId = (raw: string): string =>
  raw
    .replace(/[^A-Za-z0-9]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
