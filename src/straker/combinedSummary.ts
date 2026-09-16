/**
 * `npm run straker:combined` — the combined daily view across both portals (FR-018, US3,
 * V17, contract §5).
 *
 * ## Why this file exists at all
 *
 * The team runs **one** translation crew, and each portal enforces its **own** daily
 * ceiling. Separate ledgers were chosen deliberately, for complete isolation between the
 * two bots, at the known cost that the two ceilings can sum past what the crew can
 * actually do. This view is the agreed mitigation: **shared visibility, not shared
 * enforcement**, so a human can lower a ceiling before the crew is over-committed. It is
 * the reason the isolation decision was acceptable, which means a *wrong* combined number
 * here is worse than none — it is the one figure someone would act on.
 *
 * Two of the three rules below therefore describe when **not** to produce the total:
 *
 * 1. Every portal must be readable. One record unreadable → the readable one is still
 *    reported and the gap is stated plainly; a partial total is never presented as whole.
 * 2. Both portals must be measuring in the same unit. The XTM bot's effort metric is
 *    switchable (`ACCEPT_EFFORT_METRIC`, `words` or `wwc`), while Straker always measures
 *    raw words (`STRAKER_EFFORT_UNIT`). Adding unlike quantities produces a confident
 *    wrong number, which is the failure mode this whole view exists to prevent.
 * 3. Otherwise the total is shown — per deadline day as well as in the headline, because
 *    both ceilings are keyed to the **effective deadline day** and a lifetime total cannot
 *    answer "is the crew over-committed on Thursday?".
 *
 * ## Structure: a pure combiner over two already-read portal readings
 *
 * The comparison and the suppression rules are the substance; the file handles are not.
 * `combineDailyView` is pure over two `PortalResult`s — each either a reading or a stated
 * failure — so every rule above is exercisable without a database. The I/O is confined to
 * `readXtmWorkload`, `readStrakerWorkload` and `readCycleTimestamps`, each of which turns a
 * failure into a *stated* one rather than into an absence.
 *
 * ## Reading the LIVE XTM record without importing the XTM bot (R11 vs FR-018)
 *
 * `src/straker/**` may not import `src/state/` or `src/config/` — the bulkhead that keeps
 * a Straker fault away from a bot that has run unattended for weeks. FR-018 nonetheless
 * requires reading the XTM record, and the spec sanctions exactly that: the summary "reads,
 * **at reporting time only**, and never on the race path".
 *
 * The resolution is `openRecordReadOnly`: this file's own `better-sqlite3` handle on the
 * database **file**, `{ readonly: true, fileMustExist: true }`, with this file's own SQL.
 * That is not an import, not a shared connection and not a shared transaction, and the
 * handle is *incapable* of writing — `tests/unit/straker/combinedSummary.test.ts` proves it
 * by attempting an INSERT and a CREATE TABLE and requiring both to be refused, rather than
 * leaving the claim to this paragraph. `fileMustExist` carries the second half: a report
 * must never bring a record into existence, and `state/straker/` has never been created on
 * the live host.
 *
 * Nothing here runs on the race path. There is no call from `pollCycle.ts` to this file,
 * which is what satisfies FR-003 by construction (US3 scenario 3).
 *
 * ## Uptime and retries: where the two figures come from, and what they say when they can't
 *
 * FR-018 names them; nothing said where they come from. Both are derived from what the
 * bots already record, so this view adds no measurement to a running bot.
 *
 * **Retries performed — from the outbox `attempts` column, summed over rows created in the
 * period.** `attempts` is incremented *only* by `recordFailure`; `markSent` never touches
 * it. The column therefore already **is** the count of delivery attempts that failed and
 * had to be repeated — a first-try success reads 0, and subtracting one would under-count
 * every retried row. The outbox was chosen over the logs because it is durable state: it
 * survives log rotation, and it cannot disagree with what the dispatcher actually did.
 * What it does **not** include is transport-level read retries (FR-019b's backoff), which
 * `httpClient.ts` does not record durably; the printed report says so rather than letting
 * a 0 be read as "the portal never had to be retried".
 *
 * **Uptime — from each bot's own `action: 'cycle'` log lines.** Both bots write exactly one
 * such line per poll, so the timestamps of those lines are a direct record of the moments
 * the process was alive and working. Uptime is the share of the period not spent inside a
 * silence: every gap between consecutive cycle lines (and the gaps at both edges of the
 * period) longer than a grace window counts, beyond that window, as downtime. `outcome` is
 * deliberately ignored — a *failed* cycle still proves the process was alive and trying,
 * which is precisely the "limping rather than dead" state this figure is paired with
 * retries to reveal. The precedent for reading the bots' own logs is
 * `src/runtime/latencyReport.ts` and `catchRateReport.ts`.
 *
 * **An unavailable or partial source reads as `unknown`, never as zero.** A bot with no log
 * file must not report 100% uptime and no retries — the most flattering possible lie, and
 * the one that would be told on exactly the day the bot never started. Every figure that
 * can go missing is a `Measured<T>`, and the unknown propagates: an unknown retry count on
 * either portal makes the combined count unknown too.
 *
 * **Uptime is never combined into one number.** One bot dead and one healthy averages to
 * "50% uptime", which reads as a degraded system rather than as a system with a dead half —
 * and FR-026a exists precisely so that a stopped bot is noticed on its own rather than
 * masked by the other still running.
 */

import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { deadlineMsOf, effectiveDeadlineDay } from '../schedule/deadlineDay.js';
import {
  effortOf,
  unitOf,
  WORDS_UNIT,
  type EffortMetric,
  type EffortUnit,
} from '../schedule/effort.js';
import { parseHHMM, parseWorkdays } from '../schedule/parseSchedule.js';
import { holidaysForEffectiveDay } from '../schedule/thaiHolidays.js';
import type { CardRow } from '../reporting/chatCard.js';
import { STRAKER_EFFORT_UNIT } from './outcomePolicy.js';
import { STRAKER_DB_FILENAME, StrakerStore } from './strakerStore.js';
import { STRAKER_LOG_NAME } from './logger.js';
import { WEAK_SIGNAL_BELOW, computeWinRate } from './winRate.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The two portals this view combines. A total that silently omits one is the failure
 *  mode, so the list is explicit and `combineDailyView` checks its readings against it. */
export const PORTALS = ['XTM', 'Straker'] as const;
export type PortalName = (typeof PORTALS)[number];

/**
 * A figure that may be unavailable, with the reason it is.
 *
 * A union rather than `number | null` for the reason `HoldResult` in `ledger.ts` is one:
 * the alternative to a known figure is not a different number, it is an explanation, and a
 * shape that cannot hold the explanation invites 0 in its place.
 */
export type Measured<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly why: string };

export const measured = <T>(value: T): Measured<T> => ({ known: true, value });
export const unmeasured = <T>(why: string): Measured<T> => ({ known: false, why });

/** What a bot's cycle log says about the period. */
export interface UptimeReading {
  /** Share of the period the bot was polling, 0-100. */
  readonly pct: number;
  readonly downtimeMs: number;
  readonly observedMs: number;
  /** Cycle lines the figure rests on — a sample size, so a thin one can be seen as thin. */
  readonly cycles: number;
}

/** The window the summary describes. */
export interface SummaryPeriod {
  readonly fromMs: number;
  readonly toMs: number;
  /** The period in words, printed so a figure cannot be quoted without its window. */
  readonly label: string;
}

/** One portal's committed workload, as read at reporting time. */
export interface PortalWorkload {
  readonly portal: PortalName;
  /** The file the figures came from, printed so a number cannot be quoted without it. */
  readonly source: string;
  /** The unit `committedEffort` is measured in — the whole basis of the like-for-like rule. */
  readonly unit: EffortUnit;
  /** Σ effort of work the team currently holds on this portal. */
  readonly committedEffort: number;
  readonly heldItems: number;
  /** Committed effort per **effective deadline day** — the key both ceilings use. */
  readonly byDeadlineDay: ReadonlyMap<string, number>;
  /** Held effort whose deadline could not be placed on a day, and so appears in no bucket.
   *  Reported rather than dropped: work counted nowhere under-states every day it might
   *  have landed on, and an under-stated day is how an over-commitment goes unseen. */
  readonly effortMissingDeadline: number;
  /** Held items with no readable effort, contributing 0 to the sums above for want of a
   *  number. Same reason as the field above: a silent 0 understates the commitment. */
  readonly itemsWithoutEffort: number;
  /** This portal's own daily ceiling, per deadline day. Unknown where it is required
   *  configuration with no default (Straker's) and has not been set. */
  readonly ceilingPerDay: Measured<number>;
  readonly retries: Measured<number>;
  readonly uptime: Measured<UptimeReading>;
}

/** A record that could not be read — a live possibility now the two live in separate files. */
export interface PortalUnreadable {
  readonly portal: PortalName;
  readonly source: string;
  readonly why: string;
  /**
   * Liveness anyway, because it comes from a **different** source: the bot's cycle log,
   * not its database. A broken record on a process that is still polling is exactly the
   * limping state uptime exists to reveal, and throwing the figure away because the
   * neighbouring source failed would hide it at the one moment it matters.
   */
  readonly uptime: Measured<UptimeReading>;
}

export type PortalResult =
  | { readonly read: true; readonly workload: PortalWorkload }
  | { readonly read: false; readonly failure: PortalUnreadable };

/** Why a combined figure is not being shown. Each needs a different human response. */
export type WithheldReason =
  /** At least one portal's record could not be read, so the sum would be partial. */
  | 'record_unreadable'
  /** The portals are not measuring in the same unit, so the sum would be meaningless. */
  | 'unlike_units'
  /** Every record read, but a figure inside one is unknown (an unset ceiling, say). */
  | 'figure_unknown';

/**
 * A combined figure, or the refusal to produce one.
 *
 * `shown: false` carries no number at all — deliberately, rather than a nullable `value`
 * that a caller could print by forgetting to look at the flag.
 */
export type CombinedFigure =
  | { readonly shown: true; readonly value: number; readonly unit: EffortUnit }
  | { readonly shown: false; readonly withheld: WithheldReason; readonly why: string };

/** One effective deadline day, across both portals. */
export interface CombinedDay {
  readonly day: string;
  /** Each readable portal's committed effort on this day, 0 where it holds nothing. */
  readonly perPortal: ReadonlyMap<PortalName, number>;
  readonly combined: CombinedFigure;
}

export interface PortalUptime {
  readonly portal: PortalName;
  readonly uptime: Measured<UptimeReading>;
}

export interface CombinedDailyView {
  readonly period: SummaryPeriod;
  /** Every portal, in the order given — readable or not. */
  readonly portals: readonly PortalResult[];
  readonly committedTotal: CombinedFigure;
  readonly ceilingTotal: CombinedFigure;
  readonly byDeadlineDay: readonly CombinedDay[];
  readonly retriesTotal: Measured<number>;
  /** Per portal, never averaged — see the module docstring. */
  readonly uptime: readonly PortalUptime[];
  /** Everything this view could not tell you, in plain sentences. Empty is the good case. */
  readonly gaps: readonly string[];
}

// ---------------------------------------------------------------------------
// The combiner — pure, and the whole substance of FR-018
// ---------------------------------------------------------------------------

/**
 * Build the combined view from the two portal results.
 *
 * Total-showing rule, applied identically to the headline and to every day row: show a
 * combined figure only when **every portal in `PORTALS` is present and readable** and
 * **all of them report the same unit**. Anything else is withheld with the reason.
 */
export function combineDailyView(
  period: SummaryPeriod,
  results: readonly PortalResult[],
): CombinedDailyView {
  const readings = results
    .filter((r): r is Extract<PortalResult, { read: true }> => r.read)
    .map((r) => r.workload);
  const failures = results
    .filter((r): r is Extract<PortalResult, { read: false }> => !r.read)
    .map((r) => r.failure);

  const withheld = whyNoCombinedFigure(readings, failures);
  const combine = (values: readonly number[]): CombinedFigure =>
    withheld ?? {
      shown: true,
      value: values.reduce((a, b) => a + b, 0),
      // Safe: `whyNoCombinedFigure` returned null, so there is at least one reading and
      // every reading shares this unit.
      unit: readings[0]?.unit ?? WORDS_UNIT,
    };

  const ceilings = readings.map((r) => r.ceilingPerDay);
  const unknownCeiling = ceilings.find((c) => !c.known);
  const ceilingTotal: CombinedFigure =
    withheld ??
    (unknownCeiling !== undefined && unknownCeiling.known === false
      ? {
          shown: false,
          withheld: 'figure_unknown',
          why: `a portal's daily ceiling is unknown (${unknownCeiling.why}), so the combined ceiling cannot be stated`,
        }
      : combine(ceilings.map((c) => (c.known ? c.value : 0))));

  return {
    period,
    portals: results,
    committedTotal: combine(readings.map((r) => r.committedEffort)),
    ceilingTotal,
    byDeadlineDay: combineDays(readings, combine),
    retriesTotal: sumMeasured(
      readings.map((r) => [r.portal, r.retries] as const),
      failures,
      'retries performed',
    ),
    uptime: results.map((r) =>
      r.read
        ? { portal: r.workload.portal, uptime: r.workload.uptime }
        : { portal: r.failure.portal, uptime: r.failure.uptime },
    ),
    gaps: statedGaps(readings, failures, withheld),
  };
}

/** The refusal, or `null` when a combined figure may be shown. */
function whyNoCombinedFigure(
  readings: readonly PortalWorkload[],
  failures: readonly PortalUnreadable[],
): Extract<CombinedFigure, { shown: false }> | null {
  const present = new Set(readings.map((r) => r.portal));
  const missing = PORTALS.filter((p) => !present.has(p));
  if (missing.length > 0) {
    const detail = missing
      .map((p) => {
        const failure = failures.find((f) => f.portal === p);
        return failure === undefined ? `${p} (no record supplied)` : `${p} (${failure.why})`;
      })
      .join('; ');
    return {
      shown: false,
      withheld: 'record_unreadable',
      why: `not shown — ${detail}. A total covering only part of the work would read as if it covered all of it.`,
    };
  }

  const units = [...new Set(readings.map((r) => r.unit.noun))];
  if (units.length > 1) {
    const perPortal = readings.map((r) => `${r.portal} in ${r.unit.noun}`).join(', ');
    return {
      shown: false,
      withheld: 'unlike_units',
      why: `not shown — the two portals are not measuring in the same unit (${perPortal}). Adding unlike quantities would produce a confident wrong number.`,
    };
  }
  return null;
}

function combineDays(
  readings: readonly PortalWorkload[],
  combine: (values: readonly number[]) => CombinedFigure,
): CombinedDay[] {
  const days = [...new Set(readings.flatMap((r) => [...r.byDeadlineDay.keys()]))].sort();
  return days.map((day) => {
    const perPortal = new Map<PortalName, number>();
    for (const r of readings) perPortal.set(r.portal, r.byDeadlineDay.get(day) ?? 0);
    return { day, perPortal, combined: combine([...perPortal.values()]) };
  });
}

/** Sum a per-portal figure, or explain why it cannot be summed. Unknown propagates. */
function sumMeasured(
  entries: readonly (readonly [PortalName, Measured<number>])[],
  failures: readonly PortalUnreadable[],
  what: string,
): Measured<number> {
  if (failures.length > 0) {
    const names = failures.map((f) => f.portal).join(' and ');
    return unmeasured(`${names} could not be read, so total ${what} is unknown — not zero`);
  }
  const present = new Set(entries.map(([p]) => p));
  const missing = PORTALS.filter((p) => !present.has(p));
  if (missing.length > 0) {
    return unmeasured(
      `no record supplied for ${missing.join(' and ')}, so total ${what} is unknown`,
    );
  }
  const blank = entries.find(([, m]) => !m.known);
  if (blank !== undefined && blank[1].known === false) {
    return unmeasured(`${blank[0]}'s ${what} is unknown (${blank[1].why}), so the total is too`);
  }
  return measured(entries.reduce((sum, [, m]) => sum + (m.known ? m.value : 0), 0));
}

/** Everything the view could not tell you, in sentences a human reads without a decoder. */
function statedGaps(
  readings: readonly PortalWorkload[],
  failures: readonly PortalUnreadable[],
  withheld: Extract<CombinedFigure, { shown: false }> | null,
): string[] {
  const gaps: string[] = [];
  for (const f of failures) {
    gaps.push(
      `${f.portal}: its record at ${f.source} was unreadable (${f.why}). Its committed workload is missing from this view; its uptime below comes from its log and is unaffected.`,
    );
  }
  if (withheld?.withheld === 'unlike_units') gaps.push(`Combined total ${withheld.why}`);
  for (const r of readings) {
    if (!r.uptime.known) {
      gaps.push(`${r.portal}: uptime unknown (${r.uptime.why}) — read as unknown, not as healthy.`);
    }
    if (!r.retries.known) gaps.push(`${r.portal}: retries performed unknown (${r.retries.why}).`);
    if (!r.ceilingPerDay.known) {
      gaps.push(`${r.portal}: its daily ceiling is unknown (${r.ceilingPerDay.why}).`);
    }
    if (r.effortMissingDeadline > 0) {
      gaps.push(
        `${r.portal}: ${count(r.effortMissingDeadline)} ${r.unit.noun} of held work has no readable deadline and appears in no day below.`,
      );
    }
    if (r.itemsWithoutEffort > 0) {
      gaps.push(
        `${r.portal}: ${count(r.itemsWithoutEffort)} held item(s) carry no readable effort and contribute 0 to the figures above.`,
      );
    }
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Uptime, from the bots' own cycle logs
// ---------------------------------------------------------------------------

/** A gap this many times the configured rhythm is where a hiccup becomes a silence. */
export const UPTIME_GRACE_FACTOR = 3;
/**
 * Floor under the grace window. Below a minute neither bot's own liveness signal can tell
 * the difference either (Healthchecks runs at a 60 s period), so calling a 35-second
 * hiccup an outage would be claiming a precision nothing else in the system has.
 */
export const UPTIME_MIN_GRACE_MS = 60_000;

export interface UptimeSpec {
  readonly fromMs: number;
  readonly toMs: number;
  /** The bot's configured poll rhythm — XTM's and Straker's differ by design (FR-001). */
  readonly intervalMs: number;
}

/**
 * Uptime as the share of the period not spent inside a silence.
 *
 * Unknown — never 0%, never 100% — when the log source is unavailable or carries no cycle
 * line in the period. Zero cycles in twenty-four hours could mean a dead bot or a log that
 * rotated away, and the two are not distinguishable from here: 0% would accuse, 100% would
 * flatter, and only "unknown" is true.
 */
export function computeUptime(
  cycles: Measured<readonly number[]>,
  spec: UptimeSpec,
): Measured<UptimeReading> {
  if (!cycles.known) return unmeasured(cycles.why);

  const observedMs = spec.toMs - spec.fromMs;
  if (!(observedMs > 0)) return unmeasured('the period has no length, so uptime is undefined');

  const inPeriod = cycles.value
    .filter((t) => Number.isFinite(t) && t >= spec.fromMs && t <= spec.toMs)
    .sort((a, b) => a - b);
  if (inPeriod.length === 0) {
    return unmeasured(
      'no cycle line in the period — the bot may have been down, or the log rotated away',
    );
  }

  const grace = Math.max(UPTIME_GRACE_FACTOR * spec.intervalMs, UPTIME_MIN_GRACE_MS);
  const edges = [spec.fromMs, ...inPeriod, spec.toMs];
  let downtimeMs = 0;
  for (let i = 1; i < edges.length; i++) {
    downtimeMs += Math.max(0, (edges[i] ?? 0) - (edges[i - 1] ?? 0) - grace);
  }
  downtimeMs = Math.min(downtimeMs, observedMs);

  return measured({
    pct: clamp((100 * (observedMs - downtimeMs)) / observedMs, 0, 100),
    downtimeMs,
    observedMs,
    cycles: inPeriod.length,
  });
}

/** One pino log line, as far as this file cares. */
interface CycleLine {
  time?: unknown;
  action?: unknown;
}

/**
 * Timestamps of the `action: 'cycle'` lines inside the period — pure, so it is testable
 * without a filesystem, exactly as `computeLatencyMetrics` is.
 *
 * `outcome` is ignored on purpose: a failed cycle still proves the process was alive.
 */
export function cycleTimestampsIn(lines: Iterable<string>, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  for (const line of lines) {
    if (!line) continue;
    let entry: CycleLine;
    try {
      entry = JSON.parse(line) as CycleLine;
    } catch {
      continue; // a non-JSON line (a crash trace, a truncated write) is not evidence
    }
    if (entry.action !== 'cycle') continue;
    const time = entry.time;
    if (typeof time !== 'number' || !Number.isFinite(time)) continue;
    if (time < fromMs || time > toMs) continue;
    out.push(time);
  }
  return out;
}

/**
 * Cycle timestamps from one bot's rotated log files.
 *
 * `filePrefix` matters: the two bots share one log directory (an enumerated, accepted
 * sharing in the spec), so reading the wrong prefix would credit one bot with the other's
 * liveness — the exact masking FR-026a exists to prevent. A missing directory or no files
 * at all is `unknown`, never an empty run of cycles.
 */
export function readCycleTimestamps(
  logDir: string,
  filePrefix: string,
  fromMs: number,
  toMs: number,
): Measured<number[]> {
  if (!existsSync(logDir)) return unmeasured(`no log directory at ${logDir}`);

  let files: string[];
  try {
    files = readdirSync(logDir).filter((f) => f.startsWith(filePrefix) && f.endsWith('.log'));
  } catch (err) {
    return unmeasured(`could not list ${logDir}: ${describe(err)}`);
  }
  if (files.length === 0) return unmeasured(`no ${filePrefix}*.log files in ${logDir}`);

  const times: number[] = [];
  for (const file of files) {
    try {
      const lines = readFileSync(join(logDir, file), 'utf8').split('\n');
      times.push(...cycleTimestampsIn(lines, fromMs, toMs));
    } catch (err) {
      return unmeasured(`could not read ${file}: ${describe(err)}`);
    }
  }
  return measured(times.sort((a, b) => a - b));
}

// ---------------------------------------------------------------------------
// Retries, from the outbox
// ---------------------------------------------------------------------------

/** One queued outcome, as far as the retry count cares. */
export interface OutboxAttempt {
  readonly attempts: number;
  readonly createdAtMs: number;
}

/**
 * Retries performed on delivery in the period.
 *
 * `attempts` is already the retry count — it is incremented only by `recordFailure` and
 * never by a successful send, so a first-try success reads 0 and subtracting one would
 * under-count every retried row by exactly one.
 *
 * The window is the row's **creation** time, which means a row created just before the
 * period and retried inside it is not counted. At a handful of events a day the boundary
 * effect is negligible, and the alternative — a column recording when each attempt
 * happened — does not exist in either schema.
 */
export function countOutboxRetries(
  rows: readonly OutboxAttempt[],
  fromMs: number,
  toMs: number,
): number {
  let total = 0;
  for (const row of rows) {
    if (!Number.isFinite(row.createdAtMs)) continue; // an unreadable timestamp is not "in period"
    if (row.createdAtMs < fromMs || row.createdAtMs > toMs) continue;
    if (Number.isFinite(row.attempts) && row.attempts > 0) total += row.attempts;
  }
  return total;
}

// ---------------------------------------------------------------------------
// The thin readers
// ---------------------------------------------------------------------------

/**
 * A handle on a record that **cannot write to it**.
 *
 * `readonly: true` is what makes every INSERT, UPDATE and DDL fail with `SQLITE_READONLY`
 * — verified in the test rather than asserted here. `fileMustExist: true` is the other
 * half: a report must never create a record, and `state/straker/` has never existed on the
 * live host. Both matter most against the XTM database, which a live process holds open in
 * WAL mode while this runs.
 */
export function openRecordReadOnly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

/** Maps a deadline instant to the working day its work lands on, or null when it cannot. */
export type DayOf = (deadlineMs: number | null) => string | null;

/**
 * The effective-deadline-day mapper both ledgers are keyed by, over instants rather than
 * strings. `effectiveDeadlineDay` throws on a work calendar with no working day in it;
 * that is caught here and surfaced as an unbucketed row (`effortMissingDeadline`) rather
 * than guessed at — a report may degrade, but it may not invent a day.
 */
export function effectiveDayMapper(
  hoursStartMin: number,
  workdays: ReadonlySet<number>,
  holidays: ReadonlyMap<string, string>,
): DayOf {
  return (deadlineMs) => {
    if (deadlineMs === null || !Number.isFinite(deadlineMs)) return null;
    try {
      return effectiveDeadlineDay(deadlineMs, hoursStartMin, workdays, holidays);
    } catch {
      return null;
    }
  };
}

/** Held work reduced to the shape both portals' readers share. */
interface HeldItem {
  readonly effort: number | null;
  readonly deadlineMs: number | null;
}

function summariseHeld(
  held: readonly HeldItem[],
  dayOf: DayOf,
): Pick<
  PortalWorkload,
  'committedEffort' | 'heldItems' | 'byDeadlineDay' | 'effortMissingDeadline' | 'itemsWithoutEffort'
> {
  const byDeadlineDay = new Map<string, number>();
  let committedEffort = 0;
  let effortMissingDeadline = 0;
  let itemsWithoutEffort = 0;

  for (const item of held) {
    const effort = item.effort ?? 0;
    if (item.effort === null) itemsWithoutEffort++;
    committedEffort += effort;
    const day = dayOf(item.deadlineMs);
    if (day === null) effortMissingDeadline += effort;
    else byDeadlineDay.set(day, (byDeadlineDay.get(day) ?? 0) + effort);
  }

  return {
    committedEffort,
    heldItems: held.length,
    byDeadlineDay: new Map([...byDeadlineDay].sort(([a], [b]) => (a < b ? -1 : 1))),
    effortMissingDeadline,
    itemsWithoutEffort,
  };
}

export interface XtmReadSpec {
  readonly stateDir: string;
  /** The metric the XTM bot is configured to run on — it decides the unit, and the unit
   *  decides whether a combined total may be shown at all. */
  readonly metric: EffortMetric;
  readonly ceilingPerDay: number;
  readonly period: SummaryPeriod;
  readonly uptime: Measured<UptimeReading>;
  readonly dayOf: DayOf;
}

/** The XTM bot's database file, opened read-only. Must match `DB_FILENAME` in
 *  `src/state/db.ts`, which this file may not import (R11). */
export const XTM_DB_FILENAME = 'acolad.db';
/** Must match `LOG_NAME` in `src/monitoring/logger.ts`, for the same reason. */
export const XTM_LOG_NAME = 'acolad';
/** Must match `STATE_DIR`'s default in `src/config/index.ts`. */
export const XTM_DEFAULT_STATE_DIR = 'state';
/** Must match `STRAKER_STATE_DIR`'s default in `src/straker/config.ts`. */
export const STRAKER_DEFAULT_STATE_DIR = 'state/straker';
/** Must match `LOG_DIR` / `STRAKER_LOG_DIR` defaults in both config loaders. */
export const DEFAULT_LOG_DIR = 'logs';

/**
 * Read the live XTM bot's committed workload, read-only and by its own schema.
 *
 * Held work is `lifecycle_status = 'accepted'` with a non-empty `file_name`, matching
 * `XtmJobStore.listByLifecycle` exactly; effort is `schedule/effort.effortOf` under the
 * configured metric, reused rather than restated so the report cannot measure differently
 * from the gate that made the commitment.
 *
 * Any failure to read becomes a **stated** failure. Reading a missing record as "nothing
 * committed" is the same class of error as reading a failed portal response as "no offers":
 * it erases work that exists.
 */
export function readXtmWorkload(spec: XtmReadSpec): PortalResult {
  const source = join(spec.stateDir, XTM_DB_FILENAME);
  let db: Database.Database;
  try {
    db = openRecordReadOnly(source);
  } catch (err) {
    return {
      read: false,
      failure: { portal: 'XTM', source, why: describe(err), uptime: spec.uptime },
    };
  }

  try {
    const rows = db
      .prepare(
        `SELECT words, file_wwc, due_date FROM jobs
          WHERE lifecycle_status = 'accepted' AND file_name <> ''`,
      )
      .all() as { words: number | null; file_wwc: number | null; due_date: string | null }[];

    const held: HeldItem[] = rows.map((r) => ({
      effort: effortOf({ words: r.words, fileWwc: r.file_wwc }, spec.metric),
      deadlineMs: deadlineMsOf(r.due_date),
    }));

    return {
      read: true,
      workload: {
        portal: 'XTM',
        source,
        unit: unitOf(spec.metric),
        ...summariseHeld(held, spec.dayOf),
        ceilingPerDay: measured(spec.ceilingPerDay),
        retries: readXtmRetries(db, spec.period),
        uptime: spec.uptime,
      },
    };
  } catch (err) {
    return {
      read: false,
      failure: { portal: 'XTM', source, why: describe(err), uptime: spec.uptime },
    };
  } finally {
    db.close();
  }
}

/** Delivery retries, guarded on its own so a readable workload is not lost to an
 *  unreadable queue — a partial source reads as unknown, not as a failed record. */
function readXtmRetries(db: Database.Database, period: SummaryPeriod): Measured<number> {
  try {
    const rows = db.prepare('SELECT attempts, created_at FROM outbox').all() as {
      attempts: number;
      created_at: string | null;
    }[];
    return measured(
      countOutboxRetries(
        rows.map((r) => ({ attempts: r.attempts, createdAtMs: Date.parse(r.created_at ?? '') })),
        period.fromMs,
        period.toMs,
      ),
    );
  } catch (err) {
    return unmeasured(`the XTM outbox could not be read: ${describe(err)}`);
  }
}

export interface StrakerReadSpec {
  readonly stateDir: string;
  /** Straker's ceiling is required configuration with **no default**, so it is genuinely
   *  unknown when unset — unlike XTM's, which the config loader defaults. */
  readonly ceilingPerDay: Measured<number>;
  readonly period: SummaryPeriod;
  readonly uptime: Measured<UptimeReading>;
  readonly dayOf: DayOf;
}

/**
 * Read the Straker bot's committed workload, read-only.
 *
 * Effort is always the raw word count (`STRAKER_EFFORT_UNIT`, FR-009) — Straker has no
 * switchable metric, which is why a mismatch can only ever arise from the XTM side.
 */
export function readStrakerWorkload(spec: StrakerReadSpec): PortalResult {
  const source = join(spec.stateDir, STRAKER_DB_FILENAME);
  let db: Database.Database;
  try {
    db = openRecordReadOnly(source);
  } catch (err) {
    return {
      read: false,
      failure: { portal: 'Straker', source, why: describe(err), uptime: spec.uptime },
    };
  }

  try {
    const held = new StrakerStore(db)
      .heldWork()
      .map((w) => ({ effort: w.effortWords, deadlineMs: w.deadlineMs }));

    return {
      read: true,
      workload: {
        portal: 'Straker',
        source,
        unit: STRAKER_EFFORT_UNIT,
        ...summariseHeld(held, spec.dayOf),
        ceilingPerDay: spec.ceilingPerDay,
        retries: readStrakerRetries(db, spec.period),
        uptime: spec.uptime,
      },
    };
  } catch (err) {
    return {
      read: false,
      failure: { portal: 'Straker', source, why: describe(err), uptime: spec.uptime },
    };
  } finally {
    db.close();
  }
}

/**
 * The window the win-rate row is measured over, which is deliberately NOT the card's.
 *
 * The rest of the card describes the last 24 hours. At the spec's stated 2-3 offers a day
 * that makes `winnable` 0-3, so the figure could never reach {@link WEAK_SIGNAL_BELOW} and
 * the weak-signal caveat would be permanently attached — a caveat that is always true is one
 * people stop reading. Worse, SC-004's "target set only after two weeks of baseline" would
 * never arrive on this surface at all, which is the whole reason T076 exists.
 *
 * Fourteen days is that baseline, and at 2-3 offers a day it crosses ten winnable in about a
 * week, so the caveat drops off when it stops being true.
 */
export const WIN_RATE_WINDOW_DAYS = 14;

/** The fourteen-day window {@link WIN_RATE_WINDOW_DAYS} describes, as a period. */
function winRatePeriod(nowMs: number): SummaryPeriod {
  return {
    fromMs: nowMs - WIN_RATE_WINDOW_DAYS * 24 * 3_600_000,
    toMs: nowMs,
    label: `the last ${String(WIN_RATE_WINDOW_DAYS)} days`,
  };
}

/**
 * The Straker win rate as one row of the 09:00 report (T076, SC-004).
 *
 * SC-004 asks for the win rate to be "measured and reported **continuously**". It was
 * measured — `computeWinRate` is correct and covered — but its only caller was
 * `npm run straker:win-rate`, a command somebody has to remember to type. The gap that
 * mattered was never a missing number: SC-004 sets a target only after roughly two weeks of
 * baseline, and a baseline nobody is shown is a baseline nobody reads, which leaves the
 * polling rhythm untuned for want of a figure the bot already knew.
 *
 * Deliberately **not** part of the combined view. That machinery exists to decide when two
 * portals' numbers may be added together, and a win rate is not combinable: XTM has no
 * equivalent, and averaging one portal's rate with nothing would invent a figure. So this is
 * a Straker-only row appended beside the combined ones, not a third column in them.
 *
 * Three things it refuses to do, each a way the number could mislead:
 * - report a bare percentage — the counts travel with it, because at 2-3 offers a day "33%"
 *   invites a decision the sample cannot support;
 * - report `0%` when nothing was winnable — FR-017's only exclusion is work the team's own
 *   rules turned away, and a day of those is not a day of losing;
 * - go quiet when the record cannot be read — an absent row reads as "no races", which is
 *   the one thing an unreadable record does not say.
 *
 * Never throws: `combinedReportRows` promises the report still goes out, and a win rate is
 * the least important thing on it.
 */
export function strakerWinRateRow(period: SummaryPeriod, stateDir: string): CardRow {
  const label = 'Straker win rate';
  const source = join(stateDir, STRAKER_DB_FILENAME);

  let db: Database.Database;
  try {
    db = openRecordReadOnly(source);
  } catch (err) {
    return { emoji: '⚠️', label, value: `record unreadable — ${describe(err)}` };
  }

  try {
    // Bounded in SQL. Unbounded, this read materialises every event ever written in order to
    // answer a fourteen-day question, inside the XTM bot's 09:00 report.
    const window = { fromMs: period.fromMs, toMs: period.toMs };
    const rate = computeWinRate(new StrakerStore(db).listEvents(window), window);

    // FR-017a: the turn-away count travels with the rate, always, including on the n/a line.
    // "Reporting only one of the two numbers makes the other invisible" — and the two point at
    // opposite fixes: a low rate with a high turn-away count is a configuration question, a low
    // rate with a low one is a speed question. The ops script prints both; a row that dropped
    // one would leave FR-017a unreported on the surface T076 argues is the one that counts.
    const turnedAway = ` · ${String(rate.turnedAway)} turned away by our own rules`;

    if (rate.ratePct === null) {
      return { label, value: `n/a — no genuinely winnable offers in ${period.label}${turnedAway}` };
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
      label,
      value:
        `${rate.ratePct.toFixed(1)}% — ${String(rate.won)} won of ` +
        `${String(rate.winnable)} winnable in ${period.label}${caveat}${turnedAway}${unresolved}`,
    };
  } catch (err) {
    return { emoji: '⚠️', label, value: `record unreadable — ${describe(err)}` };
  } finally {
    db.close();
  }
}

function readStrakerRetries(db: Database.Database, period: SummaryPeriod): Measured<number> {
  try {
    const rows = db.prepare('SELECT attempts, created_at_ms FROM straker_outbox').all() as {
      attempts: number;
      created_at_ms: number;
    }[];
    return measured(
      countOutboxRetries(
        rows.map((r) => ({ attempts: r.attempts, createdAtMs: r.created_at_ms })),
        period.fromMs,
        period.toMs,
      ),
    );
  } catch (err) {
    return unmeasured(`the Straker outbox could not be read: ${describe(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/**
 * Wider than the longest label, so a number can never run into the word before it. At
 * exactly the longest label the value touches the colon, which is how
 * `retries performed, both portals:unknown` reached a real run of this script — the same
 * collision `winRateReport.ts` records having hit.
 */
const LABEL_COLUMN = 36;

function row(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_COLUMN)}${value}`;
}

/** Thousands separators without a locale, so the output is the same on every machine. */
function count(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function effort(value: number, unit: EffortUnit): string {
  return `${count(value)} ${unit.noun}`;
}

function figure(value: CombinedFigure): string {
  return value.shown ? effort(value.value, value.unit) : value.why;
}

function uptimeText(u: Measured<UptimeReading>): string {
  if (!u.known) return `unknown — ${u.why}`;
  const down = Math.round(u.value.downtimeMs / 60_000);
  return `${u.value.pct.toFixed(1)}% (${count(down)} min not polling, ${count(u.value.cycles)} cycles seen)`;
}

function measuredText(m: Measured<number>): string {
  return m.known ? count(m.value) : `unknown — ${m.why}`;
}

/** The combined daily view, as text. */
export function formatCombinedDailyView(view: CombinedDailyView): string {
  const lines: string[] = [
    'JobCatch — combined daily workload, both portals (FR-018 / US3)',
    `  period: ${view.period.label}`,
    '',
    'Committed workload, per portal',
  ];

  for (const result of view.portals) {
    if (result.read) {
      const w = result.workload;
      lines.push(
        row(
          `${w.portal}:`,
          `${effort(w.committedEffort, w.unit)} held across ${count(w.heldItems)} item(s)` +
            `, ceiling ${w.ceilingPerDay.known ? effort(w.ceilingPerDay.value, w.unit) : 'unknown'}/day`,
        ),
        row('', `source: ${w.source}`),
      );
    } else {
      lines.push(
        row(`${result.failure.portal}:`, `record UNREADABLE — ${result.failure.why}`),
        row('', `source: ${result.failure.source}`),
      );
    }
  }

  lines.push(
    '',
    row('combined committed workload:', figure(view.committedTotal)),
    row('combined ceiling per day:', figure(view.ceilingTotal)),
  );

  if (view.byDeadlineDay.length > 0) {
    lines.push('', 'By effective deadline day — the day each ceiling is keyed to');
    for (const day of view.byDeadlineDay) {
      const parts = [...day.perPortal.entries()].map(([p, v]) => `${p} ${count(v)}`).join(' + ');
      lines.push(row(`${day.day}:`, `${parts} → ${figure(day.combined)}`));
    }
  }

  lines.push('', 'Health of the period');
  for (const u of view.uptime) lines.push(row(`${u.portal} uptime:`, uptimeText(u.uptime)));
  for (const result of view.portals) {
    if (result.read) {
      lines.push(
        row(`${result.workload.portal} retries performed:`, measuredText(result.workload.retries)),
      );
    }
  }
  lines.push(row('retries performed, both portals:', measuredText(view.retriesTotal)));

  if (view.gaps.length > 0) {
    lines.push('', 'What this view cannot tell you');
    for (const gap of view.gaps) lines.push(`  - ${gap}`);
  }

  lines.push(
    '',
    'note: retries performed counts failed DELIVERY attempts recorded in each bot’s outbox. ' +
      'Transport-level read retries (FR-019b) are not recorded durably and are not included, ' +
      'so a 0 here does not mean the portal was never retried.',
    'note: uptime is derived from each bot’s own cycle log lines; it is reported per portal ' +
      'and never averaged, because one bot dead and one healthy must not read as one system at 50%.',
    'note: this view reads both records read-only, at reporting time only. It never ' +
      'participates in a claim decision (FR-003, US3 scenario 3).',
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

function say(text: string): void {
  // `process.stdout.write` rather than `console.log`: the `no-console` allowlist in
  // `eslint.config.js` names the XTM bot's entry points one by one, and Straker's reports
  // deliberately stay off it (see `winRateReport.ts`).
  process.stdout.write(`${text}\n`);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `--days N` measures the last N days; the default period for a daily summary is one day.
 *  A malformed value throws rather than falling back — the fallback would answer a question
 *  nobody asked, and its answer would look exactly like a correct one. */
export function parseSummaryPeriod(argv: readonly string[], nowMs: number): SummaryPeriod {
  const at = argv.indexOf('--days');
  if (at === -1) return { fromMs: nowMs - MS_PER_DAY, toMs: nowMs, label: 'the last 24 hours' };

  const raw = argv[at + 1];
  const days = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(days) || days <= 0) {
    throw new Error(`--days needs a positive number of days, got ${String(raw)}`);
  }
  return {
    fromMs: nowMs - days * MS_PER_DAY,
    toMs: nowMs,
    label: `the last ${String(days)} days`,
  };
}

/** Trimmed environment value, or the default. */
function env(name: string, fallback: string): string {
  return (process.env[name] ?? '').trim() || fallback;
}

/**
 * Read a positive setting from the environment, or explain why it is unknown.
 *
 * Used for Straker's ceiling, which `config.ts` declares with **no default** — so "unset"
 * is genuinely unknown here and must not be defaulted into a number the bot would never
 * have enforced. Exported because that rule is the module's own "unknown, never zero"
 * principle applied to configuration, and it is worth holding in a test.
 */
export function readCeilingFromEnv(name: string): Measured<number> {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return unmeasured(`${name} is not set`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return unmeasured(`${name} is not a positive number (${raw})`);
  }
  return measured(value);
}

// ---------------------------------------------------------------------------
// The bridge into the XTM bot's 09:00 report (T060a, FR-018)
// ---------------------------------------------------------------------------

/** What the XTM loop already knows about itself when it builds the daily card. */
export interface CombinedRowsSpec {
  readonly xtm: Omit<XtmReadSpec, 'period' | 'uptime'>;
  /** Defaults to `STRAKER_STATE_DIR`, then to the documented location. */
  readonly strakerStateDir?: string;
  readonly nowMs: number;
}

/**
 * The combined view as rows for the daily report card — **and it never throws.**
 *
 * `npm run report:combined` puts this view somewhere a human has to go and type a command.
 * FR-018 is about *the* daily summary, and the daily summary anyone actually reads is the
 * `📋 Daily Report` the XTM bot sends at 09:00. A mitigation for the two-ceiling problem
 * that lives where nobody looks is not a mitigation — which is the mistake this feature has
 * now made four times, and the reason T052a and T056a exist.
 *
 * **Why the total absence of throwing matters more here than anywhere else in this module.**
 * This runs inside the live XTM bot's report. That report is already built inside a
 * try/catch whose comment records why — PR #14 fixed a bug in it that took the whole poll
 * loop down. Relying on someone else's guard for a property this function can hold itself
 * is how that bug happened; and degrading to the XTM-only report is strictly better than
 * losing the report, because the combined figure is the addition and the report is the
 * thing being added to.
 *
 * So every failure becomes a **row that says so**. A silently omitted combined line is
 * indistinguishable from two portals that happened to sum to nothing.
 */
export function combinedReportRows(spec: CombinedRowsSpec): CardRow[] {
  try {
    const period = parseSummaryPeriod([], spec.nowMs);
    const strakerStateDir =
      spec.strakerStateDir ?? env('STRAKER_STATE_DIR', STRAKER_DEFAULT_STATE_DIR);
    const view = combineDailyView(period, [
      readXtmWorkload({ ...spec.xtm, period, uptime: unmeasured('not read for this card') }),
      readStrakerWorkload({
        stateDir: strakerStateDir,
        ceilingPerDay: readCeilingFromEnv('STRAKER_MAX_WORDS_PER_DAY'),
        period,
        uptime: unmeasured('not read for this card'),
        dayOf: spec.xtm.dayOf,
      }),
    ]);
    const rows = combinedRowsOf(view);

    // Pushed in its own guard rather than inside the outer one, and the difference is the
    // whole point: the outer `catch` REPLACES every row with a single "unavailable" line, so
    // a throw from the least important row here would discard the XTM figure, the Straker
    // figure and the combined total that were already computed successfully. The section is
    // not optional; this row is.
    // Built BEFORE deciding whether to show it, which is the difference between suppressing a
    // duplicate message and suppressing information. An earlier cut skipped the row whenever
    // the portal read had failed — but `readStrakerWorkload` fails when `heldWork()` does, and
    // `offer_events` can read perfectly while `held_work` cannot. That dropped a computable
    // figure for a fault in a different table, which is the "going quiet on an unreadable
    // record" this row's own docstring refuses to do.
    let winRateRow: CardRow;
    try {
      winRateRow = strakerWinRateRow(winRatePeriod(spec.nowMs), strakerStateDir);
    } catch (err) {
      // Never silent. `strakerWinRateRow` already turns every failure it can see into a stated
      // row, so reaching here means something outside its contract changed — and a row that
      // vanishes is indistinguishable from one that was never wanted. Fail loud, in the card.
      winRateRow = {
        emoji: '⚠️',
        label: 'Straker win rate',
        value: `could not be computed — ${describe(err)}`,
      };
    }

    // One fault, one line — but only when it really is the same fault. Both rows have to be
    // reporting the record as unreadable before the second is dropped as a repetition.
    const portalUnread = view.portals.some((p) => !p.read && p.failure.portal === 'Straker');
    const rowIsUnreadable = (winRateRow.value ?? '').includes('record unreadable');
    if (!(portalUnread && rowIsUnreadable)) rows.push(winRateRow);

    return rows;
  } catch (err) {
    // The last line of defence, and it should never be reached: both readers already turn
    // their own failures into a stated `PortalResult`. If it IS reached, something changed
    // that this module did not anticipate, and the report still goes out.
    return [
      {
        emoji: '⚠️',
        label: 'Both portals',
        value: `combined view unavailable: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }
}

/** One row per portal, then the combined line — or the reason there is not one. */
function combinedRowsOf(view: CombinedDailyView): CardRow[] {
  const rows: CardRow[] = [];
  for (const portal of view.portals) {
    rows.push(
      portal.read
        ? {
            label: portal.workload.portal,
            value: `${portal.workload.committedEffort} ${portal.workload.unit.noun} committed`,
          }
        : {
            emoji: '⚠️',
            label: portal.failure.portal,
            value: `record unreadable — ${portal.failure.why}`,
          },
    );
  }
  rows.push(
    view.committedTotal.shown
      ? {
          label: 'Both portals',
          value: `${view.committedTotal.value} ${view.committedTotal.unit.noun} committed`,
        }
      : {
          emoji: '⚠️',
          label: 'Both portals',
          value: `no combined total: ${view.committedTotal.why}`,
        },
  );
  return rows;
}

function main(): void {
  loadDotenv();
  const nowMs = Date.now();
  const period = parseSummaryPeriod(process.argv.slice(2), nowMs);

  // Every default below must stay in step with the loader it mirrors: the XTM ones with
  // `src/config/index.ts`, the Straker ones with `src/straker/config.ts`. They are read
  // from the environment rather than through either loader because both fail-fast on
  // credentials a read-only report has no use for — and putting a portal password within
  // reach of a row-counting script is a cost with no benefit (the reasoning `winRateReport`
  // established).
  const metric: EffortMetric = env('ACCEPT_EFFORT_METRIC', 'wwc') === 'words' ? 'words' : 'wwc';
  const xtmCeiling = Number(
    env(metric === 'wwc' ? 'ACCEPT_MAX_WWC_PER_DAY' : 'ACCEPT_MAX_WORDS_PER_DAY', '1000'),
  );
  const dayOf = effectiveDayMapper(
    parseHHMM(env('ACCEPT_HOURS_START', '09:00')),
    parseWorkdays(env('ACCEPT_WORKDAYS', '1-5')),
    holidaysForEffectiveDay(nowMs),
  );

  const xtmLogDir = env('LOG_DIR', DEFAULT_LOG_DIR);
  const strakerLogDir = env('STRAKER_LOG_DIR', DEFAULT_LOG_DIR);

  const view = combineDailyView(period, [
    readXtmWorkload({
      stateDir: env('STATE_DIR', XTM_DEFAULT_STATE_DIR),
      metric,
      ceilingPerDay: Number.isFinite(xtmCeiling) ? xtmCeiling : 0,
      period,
      uptime: computeUptime(
        readCycleTimestamps(xtmLogDir, XTM_LOG_NAME, period.fromMs, period.toMs),
        {
          fromMs: period.fromMs,
          toMs: period.toMs,
          intervalMs: Number(env('POLL_INTERVAL_MS', '20000')) || 20_000,
        },
      ),
      dayOf,
    }),
    readStrakerWorkload({
      stateDir: env('STRAKER_STATE_DIR', STRAKER_DEFAULT_STATE_DIR),
      ceilingPerDay: readCeilingFromEnv('STRAKER_MAX_WORDS_PER_DAY'),
      period,
      uptime: computeUptime(
        readCycleTimestamps(strakerLogDir, STRAKER_LOG_NAME, period.fromMs, period.toMs),
        {
          fromMs: period.fromMs,
          toMs: period.toMs,
          intervalMs: Number(env('STRAKER_POLL_INTERVAL_MS', '10000')) || 10_000,
        },
      ),
      dayOf,
    }),
  ]);

  say(formatCombinedDailyView(view));
}

// Run only when invoked as the entry point, never when imported by a test.
if (process.argv[1]?.endsWith('combinedSummary.js') === true) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
