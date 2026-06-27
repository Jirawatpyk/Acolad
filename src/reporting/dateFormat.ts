/**
 * Human-readable Bangkok-local date for the Sheet ("DD/MM/YYYY HH:mm"). The bot
 * stores timestamps as ISO (UTC `...Z` or `+07:00`); the Sheet should show the local
 * wall-clock without the T / Z / offset / millisecond noise. Empty values become '';
 * an unparseable value passes through unchanged (never throws) so an odd raw due
 * string is preserved rather than blanked.
 */
import { BKK_OFFSET_MS } from '../schedule/bangkokCalendar.js';

export function formatReadableDate(value: string | null): string {
  if (!value) return '';
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  const d = new Date(t + BKK_OFFSET_MS); // shift to Asia/Bangkok (+07:00), then read UTC parts
  const p = (n: number): string => String(n).padStart(2, '0');
  const date = `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  // A date-only input (no time component) must not gain a spurious "07:00" from the
  // +07 shift of UTC-midnight — show just the date.
  const hasTime = value.includes('T') || /\d:\d/.test(value);
  return hasTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}
