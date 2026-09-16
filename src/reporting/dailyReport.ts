/**
 * Daily 09:00 Bangkok "Daily Report" helpers.
 *
 * TZ-IMPORTANT: The bot has no process timezone set. All Bangkok math is done
 * by adding 7 h to the epoch milliseconds then reading UTC parts — NEVER
 * getHours()/toLocaleString()/process.env.TZ.
 */

import { buildCard, type CardRow } from './chatCard.js';
import { formatReadableDate } from './dateFormat.js';
import { dash } from './cardText.js';
import { bangkokCalendar, bangkokDateString } from '../schedule/bangkokCalendar.js';
import { deadlineMsOf, deadlineDayOf } from '../schedule/deadlineDay.js';
import { isNonWorkingDay } from '../schedule/workingHours.js';
import { effortOf, unitOf, type EffortMetric } from '../schedule/effort.js';
import type { XtmJobState } from '../detection/types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true when the daily report is due: today is a working day (not a weekend
 * or Thai holiday), Bangkok time has reached `hour` (default 9 = 09:00), and
 * today's Bangkok date has not already been sent.
 *
 * Fail-open on uncurated years: an empty `holidays` map means the year's data is
 * not yet curated — only weekends are skipped; the report still fires on weekdays.
 * A missed report is worse than an extra one.
 *
 * @param nowMs        Current epoch ms (from injected Clock).
 * @param lastSentDate The value stored in meta, or null if never sent.
 * @param workdays     ISO weekdays that count as working days (1=Mon..7=Sun).
 * @param holidays     Bangkok YYYY-MM-DD → holiday name (empty = uncurated, fail-open).
 * @param hour         Bangkok hour threshold (default 9 = 09:00).
 */
export function dueDailyReport(
  nowMs: number,
  lastSentDate: string | null,
  workdays: ReadonlySet<number>,
  holidays: ReadonlyMap<string, string>,
  hour = 9,
): boolean {
  const { date, weekday, minutesOfDay } = bangkokCalendar(nowMs);
  if (isNonWorkingDay(date, weekday, workdays, holidays)) return false;
  return minutesOfDay >= hour * 60 && date !== lastSentDate;
}

/**
 * Is there anything in today's report worth putting in front of the team?
 *
 * The XTM bot has held no jobs since 2026-07-15 (`specs/003-straker-offer-race/xtm-baseline.md`),
 * so every working day at 09:00 it has posted a card reading "0 words · No jobs in progress"
 * and nothing else. A notification that is always identical trains people not to open it, and
 * the cost of that is paid by the next card — the one that does say something.
 *
 * **Liveness is not a reason to keep sending it.** That is the heartbeat's job (Constitution IV,
 * SC-010), and it is the better instrument: it pages when the bot goes silent, where a daily
 * card only ever told you the bot was alive at 09:00 and said nothing for the other 23 hours.
 *
 * Two things count as worth saying:
 *
 * 1. **The team holds work.** Then the report is doing what it exists for.
 * 2. **A companion row says anything other than "0 committed".** The combined two-portal
 *    section (FR-018) degrades
 *    to rows that *state* a gap rather than going quiet — an unreadable record, a total that
 *    cannot be shown because the portals measure in different units. Those rows are what makes
 *    the section trustworthy, and suppressing them would make "no report" mean both "nothing to
 *    do" and "something is broken", which are the two things an operator most needs to tell
 *    apart. A warning is identified structurally, by the row carrying an emoji, rather than by
 *    matching its text.
 *
 * **Known limitation, and the reason for it.** Work held by *Straker* alone does not keep the
 * report alive: this function can only see what the caller has, and the caller cannot ask
 * Straker directly. The R11 bulkhead permits exactly one import from `src/runtime/` into
 * `src/straker/` — `xtmPollLoop → combinedReportRows` — and that exception is pinned by name in
 * `tests/integration/straker/isolation.test.ts`, so a second one to ask "do you hold anything?"
 * would fail that guard. The practical cost is small: Straker announces every win individually
 * and immediately on its own channel, so its work is never silent, only unsummarised. Closing
 * it properly means `combinedReportRows` reporting whether either portal committed anything,
 * which is a change to that module rather than to this one.
 *
 * Biased toward sending. An unnecessary card costs a glance; a wrongly suppressed one hides
 * work, so anything that is not plainly nothing goes out.
 */
export function reportWorthSending(
  held: readonly XtmJobState[],
  companion: readonly CardRow[],
): boolean {
  if (held.length > 0) return true;
  // Suppress only when EVERY companion row is recognisably nothing. The test is an allowlist,
  // not a denylist, so an unfamiliar row — a win rate, a retry count, something added later —
  // counts as content and the report goes out.
  return !companion.every((row) => NOTHING_COMMITTED.test(row.value ?? ''));
}

/**
 * A companion row that says a portal committed nothing, and nothing else.
 *
 * Anchored and exact on purpose. A loose `includes('0')` would match "10 words committed", and
 * a loose "is this row interesting" test would have to be updated every time the combined
 * section gains a row — silently, in the direction of suppressing more. This way the failure
 * mode of an unrecognised row is an extra card, never a hidden one.
 */
const NOTHING_COMMITTED = /^0 \S+ committed$/;

/**
 * Builds the Google Chat cardsV2 payload for the daily in-progress jobs report.
 *
 * Layout:
 * - "Due today" headline: words whose EFFECTIVE deadline day (the working day the work
 *   lands on — see `effectiveDay`) is today, so the headline matches the capacity cap.
 *   Includes a job due tomorrow-early-morning (before the 09:00 work-start), whose work
 *   is really today's. Day-bucket, not instant — covers night-accepted jobs due today.
 * - "⚠️ Overdue" row (instant-based): present only when at least one held job's
 *   deadline ms is strictly before nowMs.
 * - Up to 5 job rows, sorted by deadline asc (null/unparseable → last).
 * - "(+N more)" marker when N > 0.
 *
 * TOTAL function — never throws for any held input (null/unparseable dueDate,
 * null words, empty list).
 *
 * @param held           Jobs currently in lifecycle_status='accepted'.
 * @param nowMs          Current epoch ms (for the date header / card ID / overdue).
 * @param xtmUrl         Deep-link to XTM Active task list.
 * @param maxPerDay      Daily effort cap (words or WWC per the active metric); 0 = no cap.
 * @param effectiveDay   Maps a dueDate → the Bangkok working day its work lands on (or null
 *                       for null/unparseable). The loop passes the effective-deadline-day mapper
 *                       so "Due today" matches the cap; the default is the raw deadline date
 *                       (`deadlineDayOf`) so the report stays usable standalone (byte-for-byte
 *                       legacy bucketing for callers without a work calendar).
 * @param capEnforced    Whether the per-deadline cap is actually enforced — i.e. the schedule gate
 *                       is ON (`ACCEPT_SCHEDULE_ENABLED=1`). Defaults to true. When false the
 *                       headline must NOT advertise "cap N/day" (accept runs 24/7 with no cap when
 *                       the gate is off; claiming an enforced limit would mislead). The effective-
 *                       day "Due today" workload view is still valid and is shown either way.
 * @param metric         The active effort metric ('words' | 'wwc'). Controls how effort is summed,
 *                       the unit noun in the headline, and how the per-job value is formatted.
 *                       Defaults to 'words'.
 */
export function buildDailyReportCard(
  held: XtmJobState[],
  nowMs: number,
  xtmUrl: string,
  maxPerDay: number,
  effectiveDay: (dueDate: string | null) => string | null = deadlineDayOf,
  capEnforced = true,
  metric: EffortMetric = 'words',
  companion: readonly CardRow[] = [],
): { cardsV2: unknown[] } {
  const today = bangkokDateString(nowMs);
  // Derive the unit noun from the metric so callers need only pass `metric`.
  const noun = unitOf(metric).noun;

  // Returns the deadline as epoch ms, or +Infinity for null/unparseable (sorts last).
  // Canonical parse (F8) — same one the capacity gate + store bucket use.
  const dueMs = (j: XtmJobState): number => deadlineMsOf(j.dueDate) ?? Number.POSITIVE_INFINITY;

  // Pass 1: compute "Due today" effort bucket and collect overdue jobs.
  // Only jobs with a parseable finite deadline contribute to either metric.
  let dueTodayEffort = 0;
  const overdue: XtmJobState[] = [];
  for (const j of held) {
    const ms = dueMs(j);
    if (!Number.isFinite(ms)) continue;
    if (ms < nowMs) overdue.push(j);
    // Bucket by the EFFECTIVE day (the work-day the work lands on) so the headline matches the
    // capacity cap — a before-09:00 deadline tomorrow is today's work; an after-09:00 one is not.
    if (effectiveDay(j.dueDate) === today) dueTodayEffort += effortOf(j, metric) ?? 0;
  }

  // Advertise the enforced cap ONLY when the gate is on AND a positive cap is configured.
  // Gate off (capEnforced=false) → accept is 24/7 with no cap, so "(no cap)" is the honest text;
  // cap=0 also means no cap. Either way, never claim a limit that isn't enforced.
  const usage =
    capEnforced && maxPerDay > 0
      ? `${dueTodayEffort} ${noun} (cap ${maxPerDay}/day per deadline)`
      : `${dueTodayEffort} ${noun} (no cap)`;

  const rows: CardRow[] = [{ label: 'Due today', value: usage }];

  if (overdue.length > 0) {
    const w = overdue.reduce((a, j) => a + (effortOf(j, metric) ?? 0), 0);
    rows.push({
      emoji: '⚠️',
      label: 'Overdue',
      value: `${overdue.length} job(s) · ${w} ${noun}`,
    });
  }

  // Pass 2: top-5 job rows, sorted by deadline asc (tie-break by jobKey).
  const sorted = [...held].sort((a, b) => dueMs(a) - dueMs(b) || a.jobKey.localeCompare(b.jobKey));
  const top = sorted.slice(0, 5);
  const overdueSet = new Set(overdue.map((j) => j.jobKey));
  for (const j of top) {
    const label = dash(j.projectName);
    // Per-job effort: metric-conditional format (NOT a plain unit interpolation).
    // words-mode → "Nw" (compact), wwc-mode → "N WWC" (full label). Null → "—".
    const effortVal = effortOf(j, metric);
    const effortStr =
      effortVal != null ? (metric === 'wwc' ? `${effortVal} WWC` : `${effortVal}w`) : '—';
    const value = `${formatReadableDate(j.dueDate ?? j.dueRaw ?? null) || '—'} · ${dash(j.fileName)} · ${effortStr}`;
    // Use a ternary rather than `emoji: undefined` — exactOptionalPropertyTypes forbids the latter.
    rows.push(overdueSet.has(j.jobKey) ? { emoji: '⚠️', label, value } : { label, value });
  }
  // Explicit empty-state row so operators can tell "nothing in progress" apart from a broken /
  // truncated card (the old card carried this; the held-derived rewrite had dropped it).
  if (held.length === 0) rows.push({ label: '—', value: 'No jobs in progress' });
  const more = sorted.length - top.length;
  if (more > 0) rows.push({ label: '—', value: `(+${more} more)` });

  // The other portal's figures, and the combined total (FR-018, US3). Appended last, so a
  // reader's eye lands on this bot's own workload first and the cross-portal view reads as
  // the context it is.
  //
  // **Already-decided rows, not data.** Whether a combined total may be shown at all is a
  // real decision — the two portals can measure in different units, and one record can be
  // unreadable, in which case a partial total presented as a whole one is worse than no
  // total. That decision lives in `src/straker/combinedSummary.ts`, and this builder
  // deliberately does not import it: the live bot's daily report must not be able to break
  // because Straker's internals changed. An empty list is the ordinary case and renders the
  // card exactly as it was before this existed.
  rows.push(...companion);

  // Header date: `today` is already a Bangkok 'YYYY-MM-DD' (from bangkokDateString), so reverse its
  // parts to 'DD/MM/YYYY' — no parse round-trip / slice fragility.
  const headerDate = today.split('-').reverse().join('/');

  return buildCard({
    cardId: `daily-${today}`,
    headerTitle: `📋 Daily Report — ${headerDate}`,
    rows,
    buttonUrl: xtmUrl,
    buttonText: 'Open in XTM',
  });
}
