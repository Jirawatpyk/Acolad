/**
 * The Straker win rate as one card row (T076, SC-004) — pure, over an already-computed
 * {@link WinRate}.
 *
 * It used to live in `combinedSummary.ts` as `strakerWinRateRow`, opening the database
 * itself, because its only surface was the XTM bot's 09:00 card. Since 2026-09-22 (owner
 * decision, FR-018 amended) the rate is reported on Straker's **own** 09:00 card in Straker's
 * room, and the XTM card carries no Straker rows at all. What stays the same is the wording,
 * and one formatter is what keeps it so.
 *
 * Three things it refuses to do, each a way the number could mislead:
 * - report a bare percentage — the counts travel with it, because at 2-3 offers a day "33%"
 *   invites a decision the sample cannot support;
 * - report `0%` when nothing was winnable — FR-017's only exclusion is work the team's own
 *   rules turned away, and a day of those is not a day of losing;
 * - drop the turn-away count (FR-017a) — a low rate with a high turn-away count is a
 *   configuration question, a low rate with a low one is a speed question.
 */

import type { CardRow } from '../reporting/chatCard.js';
import { WEAK_SIGNAL_BELOW, type WinRate } from './winRate.js';

export const WIN_RATE_ROW_LABEL = 'Straker win rate';

/**
 * The window the win rate is measured over, which is deliberately NOT the card's.
 *
 * At the spec's stated 2-3 offers a day a one-day window makes `winnable` 0-3, so the figure
 * could never reach {@link WEAK_SIGNAL_BELOW} and the weak-signal caveat would be permanently
 * attached. Fourteen days is SC-004's baseline, and at 2-3 offers a day it crosses ten
 * winnable in about a week, so the caveat drops off when it stops being true.
 */
export const WIN_RATE_WINDOW_DAYS = 14;

const DAY_MS = 24 * 3_600_000;

export interface WinRatePeriod {
  readonly fromMs: number;
  readonly toMs: number;
  /** Printed with the figure so it cannot be quoted without its window. */
  readonly label: string;
}

/** The fourteen days ending now, half-open like `WinRateWindow`. */
export function winRatePeriod(nowMs: number): WinRatePeriod {
  return {
    fromMs: nowMs - WIN_RATE_WINDOW_DAYS * DAY_MS,
    toMs: nowMs,
    label: `the last ${String(WIN_RATE_WINDOW_DAYS)} days`,
  };
}

/** One row: rate, counts, turn-aways, and the caveats that are true right now. */
export function formatWinRateRow(rate: WinRate, periodLabel: string): CardRow {
  const turnedAway = ` · ${String(rate.turnedAway)} turned away by our own rules`;

  if (rate.ratePct === null) {
    return {
      label: WIN_RATE_ROW_LABEL,
      value: `n/a — no genuinely winnable offers in ${periodLabel}${turnedAway}`,
    };
  }

  // An unresolved claim is one reconciliation has not settled yet. Counting it as a loss
  // would understate the rate; omitting it lets a temporarily depressed figure read as a
  // verdict. So the rate is named as a lower bound for exactly as long as that is true.
  const unresolved =
    rate.unknownPending > 0
      ? ` · ${String(rate.unknownPending)} unresolved, so this is a lower bound`
      : '';
  const caveat =
    rate.winnable < WEAK_SIGNAL_BELOW
      ? ` (weak signal — fewer than ${String(WEAK_SIGNAL_BELOW)} winnable)`
      : '';
  return {
    label: WIN_RATE_ROW_LABEL,
    value:
      `${rate.ratePct.toFixed(1)}% — ${String(rate.won)} won of ` +
      `${String(rate.winnable)} winnable in ${periodLabel}${caveat}${turnedAway}${unresolved}`,
  };
}
