/**
 * Daily 09:00 Bangkok "Jobs in Progress" report helpers.
 *
 * TZ-IMPORTANT: The bot has no process timezone set. All Bangkok math is done
 * by adding 7 h to the epoch milliseconds then reading UTC parts — NEVER
 * getHours()/toLocaleString()/process.env.TZ.
 */

import { buildCard } from './chatCard.js';
import { formatReadableDate } from './dateFormat.js';
import { dash } from './cardText.js';
import { bangkokCalendar, bangkokDateString } from '../schedule/bangkokCalendar.js';
import type { XtmJobState } from '../detection/types.js';

/** Bangkok hour 0..23 — delegates to the canonical calendar (F5/F7). */
function bangkokHour(nowMs: number): number {
  return Math.floor(bangkokCalendar(nowMs).minutesOfDay / 60);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the Bangkok calendar date as 'YYYY-MM-DD' for the given epoch ms.
 * Delegates to the canonical `bangkokDateString` (F5/F7) so the daily-report read
 * and the meta word-counter write key off the IDENTICAL "Bangkok date" function —
 * eliminating the latent key-divergence that could silently bypass the daily cap.
 */
export function bangkokDate(nowMs: number): string {
  return bangkokDateString(nowMs);
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
 * @param held                Jobs currently in lifecycle_status='accepted'.
 * @param nowMs               Current epoch ms (for the date header / card ID).
 * @param xtmUrl              Deep-link to XTM Active task list.
 * @param acceptedWordsToday  Running word total auto-accepted today (Bangkok date).
 * @param maxWordsPerDay      Daily word cap from config (0 = no cap).
 */
export function buildDailyReportCard(
  held: XtmJobState[],
  nowMs: number,
  xtmUrl: string,
  acceptedWordsToday: number,
  maxWordsPerDay: number,
): { cardsV2: unknown[] } {
  const date = bangkokDate(nowMs);

  const usage =
    maxWordsPerDay > 0
      ? `${acceptedWordsToday} / ${maxWordsPerDay}`
      : `${acceptedWordsToday} words (no cap)`;
  const capacityRow = { label: 'Auto-accepted today', value: usage };

  const jobRows =
    held.length > 0
      ? held.map((j) => ({
          label: dash(j.projectName),
          value: `${dash(j.fileName)} · due ${formatReadableDate(j.dueDate ?? j.dueRaw ?? null) || '—'} · ${j.words != null ? `${j.words}w` : '—'}`,
        }))
      : [{ label: '—', value: 'No jobs in progress' }];

  return buildCard({
    cardId: `daily-${date}`,
    headerTitle: `📋 Jobs in Progress (${held.length})`,
    headerSubtitle: date,
    rows: [capacityRow, ...jobRows],
    buttonUrl: xtmUrl,
    buttonText: 'Open in XTM',
  });
}
