/**
 * Daily 09:00 Bangkok "Jobs in Progress" report helpers.
 *
 * TZ-IMPORTANT: The bot has no process timezone set. All Bangkok math is done
 * by adding 7 h to the epoch milliseconds then reading UTC parts — NEVER
 * getHours()/toLocaleString()/process.env.TZ.
 */

import { buildCard } from './chatCard.js';
import { formatReadableDate } from './dateFormat.js';
import type { XtmJobState } from '../detection/types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Safe display fallback: null / empty string → '—'. */
function dash(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—';
  return String(v);
}

/** Shift to Asia/Bangkok (+07:00) then read UTC hours. */
function bangkokHour(nowMs: number): number {
  return new Date(nowMs + 7 * 3_600_000).getUTCHours();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the Bangkok calendar date as 'YYYY-MM-DD' for the given epoch ms.
 * Uses +7h shift then UTC parts — safe without a process timezone.
 */
export function bangkokDate(nowMs: number): string {
  const d = new Date(nowMs + 7 * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * Returns true when the daily report is due: Bangkok hour >= `hour` (default 9)
 * AND the Bangkok date has not already been sent (lastSentDate !== today).
 *
 * @param nowMs       Current epoch ms (from injected Clock).
 * @param lastSentDate  The value stored in meta, or null if never sent.
 * @param hour        Bangkok hour threshold (default 9 = 09:00).
 */
export function dueDailyReport(nowMs: number, lastSentDate: string | null, hour = 9): boolean {
  return bangkokHour(nowMs) >= hour && bangkokDate(nowMs) !== lastSentDate;
}

/**
 * Builds the Google Chat cardsV2 payload for the daily in-progress jobs report.
 *
 * @param held    Jobs currently in lifecycle_status='accepted'.
 * @param nowMs   Current epoch ms (for the date header / card ID).
 * @param xtmUrl  Deep-link to XTM Active task list.
 */
export function buildDailyReportCard(
  held: XtmJobState[],
  nowMs: number,
  xtmUrl: string,
): { cardsV2: unknown[] } {
  const date = bangkokDate(nowMs);

  const rows =
    held.length > 0
      ? held.map((j) => ({
          label: dash(j.projectName),
          value: `${dash(j.fileName)} · due ${formatReadableDate(j.dueDate ?? j.dueRaw ?? null) || '—'} · ${dash(j.words)}w`,
        }))
      : [{ label: '—', value: 'No jobs in progress' }];

  return buildCard({
    cardId: `daily-${date}`,
    headerTitle: `📋 Jobs in Progress (${held.length})`,
    headerSubtitle: date,
    rows,
    buttonUrl: xtmUrl,
    buttonText: 'Open in XTM',
  });
}
