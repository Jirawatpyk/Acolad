/**
 * Straker's own 09:00 daily report — the payload, and the card it renders to.
 *
 * ## Why Straker reports itself now
 *
 * Until 2026-09-22 the only daily summary of Straker work was a set of companion rows on the
 * XTM bot's `📋 Daily Report`, posted into the XTM room. The people who act on Straker work
 * read Straker's room. The owner decided (FR-018, amended 2026-09-22) that Straker sends its
 * own report into its own room, and the XTM card keeps a single combined line — the one figure
 * that genuinely needs both portals.
 *
 * ## Shape — deliberately the XTM report's
 *
 * - **Due today**, per budget: held words whose **effective deadline day** is today, against
 *   the ceiling that budget is charged to. Translation and DTP are separate ceilings and are
 *   never added (`ledger.ts`: adding them "would let a morning of formatting refuse an
 *   afternoon of translation"). The day key is `schedule/deadlineDay.effectiveDeadlineDay`,
 *   the same rule the ledger buckets by, so the headline agrees with the ceiling.
 * - **⚠️ Overdue**: held work whose deadline instant has passed.
 * - **In progress**: the five nearest deadlines, named the way people name the work — file,
 *   job reference, service — then "(+N more)".
 * - **The fortnightly win rate**, formatted by `winRateRow.ts`.
 *
 * ## Nothing to say is a reason not to speak
 *
 * Nothing held **and** a win rate with no races and no turn-aways ⇒ `null`: no card. A card
 * that never varies trains people not to open the one that does, and liveness is the
 * heartbeat's job (Constitution IV, SC-010), not this card's. The caller logs the decision so
 * "quiet by design" stays tellable from "quiet because broken".
 *
 * ## Pure
 *
 * No store, no clock, no queue. The rows are decided here, carried through the outbox as data,
 * and rendered by the offers sender — so a payload queued today renders the same tomorrow.
 */

import { buildCard, type CardRow } from '../reporting/chatCard.js';
import { dash } from '../reporting/cardText.js';
import { formatReadableDate } from '../reporting/dateFormat.js';
import type { ChatPayload } from '../reporting/googleChat.js';
import { bangkokDateString } from '../schedule/bangkokCalendar.js';
import { effectiveDeadlineDay } from '../schedule/deadlineDay.js';
import type { HeldWork, OfferEvent } from './strakerStore.js';
import { computeWinRate } from './winRate.js';
import { formatWinRateRow, winRatePeriod } from './winRateRow.js';

/** The payload discriminator on the `offers` channel. Announcements carry no `kind`. */
export const STRAKER_DAILY_REPORT_KIND = 'daily_report';

/** How many held items are listed before "(+N more)" — the XTM report's number. */
const LISTED_ITEMS = 5;

export interface StrakerDailyReportInput {
  /** `StrakerStore.heldWork()` — released work is already excluded. */
  readonly held: readonly HeldWork[];
  /** Offer events; only those inside the win-rate window are counted. */
  readonly events: readonly OfferEvent[];
  readonly nowMs: number;
  readonly calendar: {
    readonly hoursStartMin: number;
    readonly workdays: ReadonlySet<number>;
    /** The span the effective-day walk can touch — `holidaysForEffectiveDay(now)`. */
    readonly holidays: ReadonlyMap<string, string>;
  };
  readonly ceilings: { readonly translation: number; readonly monolingual: number };
}

/** What travels through the outbox: the Bangkok day it covers and the decided rows. */
export interface StrakerDailyReport {
  readonly kind: typeof STRAKER_DAILY_REPORT_KIND;
  /** Bangkok `YYYY-MM-DD`. */
  readonly date: string;
  readonly rows: readonly CardRow[];
}

/**
 * Build today's report, or `null` when there is nothing worth sending.
 *
 * Total: never throws for any held input — a null deadline, a calendar with no working day in
 * it, an empty list. A deadline that cannot be placed on a day counts toward no "due today"
 * figure and sorts last in the list, rather than being guessed onto a day.
 */
export function buildStrakerDailyReport(input: StrakerDailyReportInput): StrakerDailyReport | null {
  const { held, nowMs, calendar, ceilings } = input;
  const today = bangkokDateString(nowMs);

  const period = winRatePeriod(nowMs);
  const rate = computeWinRate(input.events, { fromMs: period.fromMs, toMs: period.toMs });
  if (held.length === 0 && rate.winnable === 0 && rate.turnedAway === 0) return null;

  const dayOf = (deadlineMs: number | null): string | null => {
    if (deadlineMs === null || !Number.isFinite(deadlineMs)) return null;
    try {
      return effectiveDeadlineDay(
        deadlineMs,
        calendar.hoursStartMin,
        calendar.workdays,
        calendar.holidays,
      );
    } catch {
      // A calendar with no working day in it: report the day as unknown, never invent one.
      return null;
    }
  };

  let dueTranslation = 0;
  let dueDtp = 0;
  const overdue: HeldWork[] = [];
  for (const work of held) {
    if (dayOf(work.deadlineMs) === today) {
      if (work.kind === 'monolingual') dueDtp += work.effortWords;
      else dueTranslation += work.effortWords;
    }
    if (work.deadlineMs !== null && work.deadlineMs < nowMs) overdue.push(work);
  }

  const rows: CardRow[] = [
    {
      label: 'Due today · translation',
      value: `${String(dueTranslation)} words (cap ${String(ceilings.translation)}/day)`,
    },
    {
      label: 'Due today · DTP',
      value: `${String(dueDtp)} words (cap ${String(ceilings.monolingual)}/day)`,
    },
  ];

  if (overdue.length > 0) {
    const words = overdue.reduce((sum, w) => sum + w.effortWords, 0);
    rows.push({
      emoji: '⚠️',
      label: 'Overdue',
      value: `${String(overdue.length)} job(s) · ${String(words)} words`,
    });
  }

  const dueMs = (w: HeldWork): number =>
    w.deadlineMs !== null && Number.isFinite(w.deadlineMs)
      ? w.deadlineMs
      : Number.POSITIVE_INFINITY;
  const sorted = [...held].sort(
    (a, b) => dueMs(a) - dueMs(b) || (a.objId < b.objId ? -1 : a.objId > b.objId ? 1 : 0),
  );
  const late = new Set(overdue.map((w) => w.objId));
  for (const work of sorted.slice(0, LISTED_ITEMS)) {
    const label = itemLabel(work);
    const value = `${deadlineText(work.deadlineMs)} · ${String(work.effortWords)}w${
      work.kind === 'monolingual' ? ' · DTP' : ''
    }`;
    // A ternary, not `emoji: undefined` — exactOptionalPropertyTypes forbids the latter.
    rows.push(late.has(work.objId) ? { emoji: '⚠️', label, value } : { label, value });
  }
  if (held.length === 0) rows.push({ label: '—', value: 'No jobs in progress' });
  const more = sorted.length - LISTED_ITEMS;
  if (more > 0) rows.push({ label: '—', value: `(+${String(more)} more)` });

  rows.push(formatWinRateRow(rate, period.label));

  return { kind: STRAKER_DAILY_REPORT_KIND, date: today, rows };
}

/** File · job reference · service, or the offer id when the work was held without a name. */
function itemLabel(work: HeldWork): string {
  const id = work.identity;
  if (id === undefined || (id.title === null && id.jobRef === null && id.service === null)) {
    return `Offer ${work.objId}`;
  }
  return `${dash(id.title)} · ${dash(id.jobRef)} · ${dash(id.service)}`;
}

/** Bangkok `DD/MM/YYYY HH:mm` through the XTM bot's formatter, or a dash. */
function deadlineText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return formatReadableDate(new Date(ms).toISOString()) || '—';
}

/** The card: `📋 Straker Daily Report — DD/MM/YYYY`, the portal in the heading (FR-015). */
export function renderStrakerDailyReport(report: StrakerDailyReport): ChatPayload {
  return buildCard({
    cardId: `straker-daily-${report.date}`,
    headerTitle: `📋 Straker Daily Report — ${report.date.split('-').reverse().join('/')}`,
    rows: [...report.rows],
  });
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a queued payload back into a report. Anything malformed is refused rather than
 * rendered: a half-built card in the team room would hide that something upstream changed.
 */
export function parseStrakerDailyReport(payload: unknown): Parsed<StrakerDailyReport> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'not a daily report payload' };
  }
  const raw = payload as Readonly<Record<string, unknown>>;
  if (raw['kind'] !== STRAKER_DAILY_REPORT_KIND) {
    return { ok: false, reason: 'not a daily report payload' };
  }
  const date = raw['date'];
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, reason: 'daily report has no Bangkok date' };
  }
  const rawRows = raw['rows'];
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return { ok: false, reason: `daily report for ${date} has no rows` };
  }
  const rows: CardRow[] = [];
  for (const item of rawRows as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, reason: `daily report for ${date} has a malformed row` };
    }
    const r = item as Readonly<Record<string, unknown>>;
    const label = r['label'];
    const value = r['value'];
    const emoji = r['emoji'];
    if (typeof label !== 'string' || !(typeof value === 'string' || value === null)) {
      return { ok: false, reason: `daily report for ${date} has a malformed row` };
    }
    if (emoji !== undefined && typeof emoji !== 'string') {
      return { ok: false, reason: `daily report for ${date} has a malformed row` };
    }
    rows.push(typeof emoji === 'string' ? { emoji, label, value } : { label, value });
  }
  return { ok: true, value: { kind: STRAKER_DAILY_REPORT_KIND, date, rows } };
}
