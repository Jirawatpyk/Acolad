/**
 * `npm run straker:win-rate` — print Straker's win rate and the offers our own rules turned
 * away (FR-017, FR-017a, SC-004, V22).
 *
 * ## Read-only, and out of the claim path entirely
 *
 * SC-004 asks for the win rate to be measured continuously, which is a statement about the
 * record, not about the bot: every figure below already exists in `offer_events`, written as
 * outcomes were decided. This script adds no measurement to the running bot — it opens
 * Straker's database **read-only** and computes over the rows. FR-003's rule that nothing
 * deferrable may sit between noticing an offer and claiming it is therefore satisfied by
 * construction: there is no path from the poll cycle to this file.
 *
 * Read-only is also what makes it safe to run while the bot is running, and what stops a
 * report from creating the state directory as a side effect. Where the bot has never run,
 * there is nothing to open and the script says so and exits 0 — "no offers yet" is an
 * answer, not a failure.
 *
 * ## Why it reads one environment variable rather than the bot's config loader
 *
 * `loadStrakerBotConfig` fail-fasts without the portal password, both webhooks, the sheet id
 * and the ceiling. A report that counts rows needs none of them, and demanding them would
 * mean a read-only ops script could not run on a machine where the bot is not configured —
 * while also putting credentials in reach of something that has no use for them. So only
 * `STRAKER_STATE_DIR` is read, with the same default `config.ts` declares. Those two
 * defaults must stay in step; if the bot's ever changes, change it here too.
 *
 * Shape follows `src/runtime/latencyReport.ts` and `catchRateReport.ts` — a pure function
 * plus a guarded entry point — so the printing is testable without a database.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { STRAKER_DB_FILENAME, StrakerStore } from './strakerStore.js';
import { computeWinRate, type WinRate, type WinRateWindow } from './winRate.js';

/** Must match `STRAKER_STATE_DIR`'s default in `config.ts`. */
const DEFAULT_STATE_DIR = 'state/straker';

/**
 * Below this many winnable offers the figure is a weak signal. SC-004 sets a target only
 * after roughly two weeks of baseline, which at the stated 2–3 offers a day is about thirty
 * offers; ten is the point below which a single race moves the rate by ten points or more.
 */
const WEAK_SIGNAL_BELOW = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface WinRateReportContext {
  /** The file the figures came from, printed so a number cannot be quoted without it. */
  readonly source: string;
  /** The period measured, in words. */
  readonly windowLabel: string;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * `--days N` measures the last N days; with no argument the whole record is measured.
 *
 * A malformed `--days` throws rather than falling back to all time: the fallback would
 * answer a question nobody asked and its answer would look exactly like a correct one.
 */
export function parseWinRateWindow(
  argv: readonly string[],
  nowMs: number,
): { readonly window?: WinRateWindow; readonly label: string } {
  const at = argv.indexOf('--days');
  if (at === -1) return { label: 'all time' };

  const raw = argv[at + 1];
  const days = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(days) || days <= 0) {
    throw new Error(`--days needs a positive number of days, got ${String(raw)}`);
  }
  return {
    window: { fromMs: nowMs - days * MS_PER_DAY },
    label: `the last ${String(days)} days`,
  };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/**
 * One `label   value` line. The column is wider than the longest label rather than equal to
 * it: at exactly the longest label the number runs straight into the word, which is how
 * `seen, no decision recorded0` reached a real run of this script.
 */
const LABEL_COLUMN = 30;

function row(label: string, value: number | string): string {
  return `  ${label.padEnd(LABEL_COLUMN)}${String(value)}`;
}

/**
 * The report, as text.
 *
 * The two headline figures are printed **together and always**, because neither is
 * interpretable alone: a low rate with a high turn-away count is a configuration question,
 * a low rate with a low one is a speed question (FR-017a). The legend at the foot says so
 * in the output rather than only here, so the reader of a pasted report gets it too.
 */
export function formatWinRateReport(rate: WinRate, ctx: WinRateReportContext): string {
  const lines: string[] = [
    'JobCatch — Straker win rate (FR-017 / FR-017a, SC-004)',
    `  source: ${ctx.source}`,
    `  period: ${ctx.windowLabel}`,
    '',
  ];

  if (rate.ratePct === null) {
    // 0 of 0 is not 0%. An empty period is unmeasured, not lost.
    lines.push(`win rate: n/a — no genuinely winnable offers in this period (0 of 0)`);
  } else {
    lines.push(
      `win rate: ${rate.ratePct.toFixed(1)}% — ${String(rate.won)} won of ` +
        `${String(rate.winnable)} genuinely winnable`,
    );
  }

  lines.push(
    row('won', `${String(rate.won)} (${String(rate.recovered)} via reconciliation)`),
    row('lost to another vendor', rate.lost),
    row('failed', rate.failed),
    row('unknown, unresolved', rate.unknownPending),
    row('halted before attempt', rate.haltedBeforeAttempt),
    '',
    `turned away by our own rules (FR-017a): ${String(rate.turnedAway)}`,
  );
  for (const [reason, count] of rate.turnedAwayByReason) lines.push(row(reason, count));

  lines.push(
    '',
    row('seen, no decision recorded', rate.undecided),
    row('offers seen', rate.offers),
  );

  const notes: string[] = [];
  if (rate.unknownPending > 0) {
    notes.push(
      `${String(rate.unknownPending)} claim(s) unresolved — counted as not-won, so the rate ` +
        'above is a lower bound until reconciliation (FR-016a) settles them.',
    );
  }
  if (rate.winnable > 0 && rate.winnable < WEAK_SIGNAL_BELOW) {
    notes.push(
      'weak signal — SC-004 sets a target only after about two weeks of baseline; at this ' +
        'sample one race moves the rate by ten points or more.',
    );
  }
  notes.push(
    'read the two figures together: a low rate with a high turn-away count is a ' +
      'configuration question, a low rate with a low one is a speed question.',
  );

  lines.push('');
  for (const note of notes) lines.push(`note: ${note}`);

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Print a line to stdout.
 *
 * `process.stdout.write` rather than `console.log` because the `no-console` allowlist in
 * `eslint.config.js` names the XTM bot's entry points one by one, and Straker's own entry
 * point (`reconMain.ts`) already writes to stdout directly rather than being added to it.
 * Following that keeps a report script from needing a lint-config change to exist.
 */
function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** What to print where the bot has never run. Not an error — there is simply no record. */
function noRecordYet(dbPath: string): string {
  return (
    `JobCatch — Straker win rate: no record at ${dbPath}.\n` +
    'The Straker bot has not written any state here yet, so there is nothing to measure. ' +
    '(Set STRAKER_STATE_DIR if its state lives elsewhere.)'
  );
}

function main(): void {
  loadDotenv();
  const { window, label } = parseWinRateWindow(process.argv.slice(2), Date.now());

  const stateDir = (process.env['STRAKER_STATE_DIR'] ?? '').trim() || DEFAULT_STATE_DIR;
  const dbPath = join(stateDir, STRAKER_DB_FILENAME);
  if (!existsSync(dbPath)) {
    say(noRecordYet(dbPath));
    return;
  }

  // Read-only and `fileMustExist`: a report must never create, migrate or write the live
  // bot's state. A missing table or an unreadable file throws from here and is printed by
  // the guard below rather than being smoothed into an empty report — an empty report and a
  // broken store must not look the same.
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rate = computeWinRate(new StrakerStore(db).listEvents(), window);
    say(formatWinRateReport(rate, { source: dbPath, windowLabel: label }));
  } finally {
    db.close();
  }
}

// Run only when invoked as the entry point, never when imported by a test.
if (process.argv[1]?.endsWith('winRateReport.js') === true) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
