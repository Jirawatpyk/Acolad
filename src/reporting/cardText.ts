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
 * Escape text so Google Chat shows it rather than reading it as markup.
 *
 * `decoratedText.text` accepts a small HTML subset (`<b>`, `<a href>`, `<font>`…), and much
 * of what reaches a card row is portal text — file names, job titles, error details — that
 * this bot does not control. Unescaped, a title such as `<a href=…>` renders as a live link
 * in the operations channel, and a stray `<` can swallow the rest of the row.
 *
 * `&` first, so the entities this introduces are not themselves escaped again. Applied to
 * row text only: the header and the card id are plain text to Chat.
 */
export const escapeCardText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
