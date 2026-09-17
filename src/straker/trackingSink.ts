/**
 * The tracking record — Straker's own spreadsheet (T052/T046, FR-014, FR-011a, R11).
 *
 * One row per offer event, in a **separate file** from the XTM bot's record. Not a tab
 * inside it: the two bots are bulkheaded, and a shared file is a shared failure. The file
 * id and tab come from `STRAKER_SHEETS_ID` / `STRAKER_SHEETS_TAB_NAME`
 * (`cfg.trackingSheetId` / `cfg.trackingTabName`), never from `src/config/`.
 *
 * **Every offer seen produces a row — won, lost and skipped alike.** Without the losses and
 * the skips the team cannot tell "Straker sends us nothing" from "we keep arriving second",
 * and the win rate has no denominator. A sink that wrote only wins would look perfectly
 * healthy while destroying the only number this feature exists to produce.
 *
 * ## The layout — decided 2026-09-15, and why it is this
 *
 * `contracts/straker-reporting.md` §1 deferred the layout "with the offer model (SC-000)".
 * SC-000 was lifted on 2026-09-15 and the payload is known (`fixtures/straker/offers/`), so
 * the deferral has lapsed and the columns are settled here:
 *
 * | Col | Header             | Why it is there, and there |
 * |-----|--------------------|---|
 * | A   | First seen         | When the offer was first sighted — the win rate's clock and, if the race is real, the latency measure's start |
 * | B   | Event              | `Sighting` / `Claim` / `Recovery` / `Skip`. Second because it is the dedup axis: a sheet keyed on identity **and** event type is unreadable without a column saying which event a row is |
 * | C   | Outcome            | `Won` / `Lost` / `Failed` / `Unknown` / `Recovered`, blank where the event had none. Kept apart from the skip reason so `lost` — a normal result — never reads as a fault |
 * | D   | Offer ID           | The portal's own opaque identifier (R8), never composed from other fields |
 * | E   | Language direction | FR-011a. With all 44 directions eligible, the claimed mix has to be visible here rather than discovered at delivery |
 * | F   | Deadline           | What the gate decided on |
 * | G   | Words              | The other half of what the gate decided on — raw word count (FR-009), the same unit the XTM bot runs on |
 * | H   | Skip reason        | Its own column, so skips can be counted by reason without parsing prose |
 * | I   | Claimed at         | The latency measure's end |
 * | J   | Note               | The gate's own sentence, or the failure detail — the specifics column H generalises |
 * | K   | `_row_key`         | `objId\|eventType`, the hidden upsert key |
 *
 * The reading order deliberately follows the XTM sheet's — when, what, which job,
 * languages, due, effort, note, key — because an operator reads both and should not have to
 * re-learn where to look. `Event` is the one insertion, and it earns its place above.
 *
 * ## Timestamps read `DD/MM/YYYY HH:mm`, and that is a recorded deviation (2026-09-17)
 *
 * Constitution III says user-facing timestamps MUST be ISO 8601 in Asia/Bangkok, and this
 * sheet shipped that way — `2026-09-17T08:18:32+07:00`. The owner then asked for the record
 * to be readable, and the clause's own rationale is readability: operators must be able to
 * "scan, filter, and trust them without decoding format drift". Two formats across the two
 * sheets one operator reads side by side **is** the drift the clause guards against, and the
 * XTM sheet has rendered `DD/MM/YYYY HH:mm` since 002. The two now agree, on the format the
 * operator already knows. Recorded in 003's Complexity Tracking rather than argued away.
 *
 * The seconds SC-001's latency measure needs do not survive the XTM format, so they are kept
 * in the two columns that are load-bearing and dropped where they were only noise — see
 * {@link toRowValues}. The zone is no longer written into each cell; the sheet is
 * Asia/Bangkok throughout, as its XTM counterpart already was.
 *
 * ## What is deliberately NOT here
 *
 * **Retry.** The sender reports `{ ok: false, reason }` and the outbox decides whether the
 * row waits or dies (`shared/outboxRetry.ts`, one policy for both bots). A retry loop in
 * here would re-send a row whose first attempt may already have landed.
 *
 * **A cached header check.** The XTM sink verifies its layout once per process, which is a
 * concession to its write volume. Straker sees two or three offers a day, so the check runs
 * before every write and a column inserted at 10am is caught at 10am rather than at the next
 * restart — see {@link requireExpectedLayout}.
 */

import { google } from 'googleapis';
import { z } from 'zod';
import { BKK_OFFSET_MS, bangkokCalendar } from '../schedule/bangkokCalendar.js';
import type { SendOutcome, StrakerSender } from './dispatcher.js';
import { CLAIM_OUTCOMES, SKIP_REASONS, type SkipReason } from './outcomePolicy.js';

/**
 * The column layout, version 1. Changing it is a migration, not an edit: existing rows do
 * not move, so anything but appending to the right leaves history misaligned.
 */
export const TRACKING_HEADER: readonly string[] = [
  'First seen', // A
  'Event', // B
  'Outcome', // C
  'Offer ID', // D
  'Language direction', // E
  'Deadline', // F
  'Words', // G
  'Skip reason', // H
  'Claimed at', // I
  'Note', // J
  '_row_key', // K
];

/**
 * `K` — the last column of the layout, derived from its width so the transport's A1 ranges
 * cannot drift from the header, and so the `_row_key` column the upsert reads is the same
 * column the layout declares.
 */
const LAST_COLUMN_LETTER = columnLetter(TRACKING_HEADER.length - 1);

/**
 * 0-based column index → its spreadsheet letter, single letters only (A–Z).
 *
 * That is enough because it is only ever called with an index into {@link TRACKING_HEADER},
 * a literal eleven entries long in this same file. A layout that grew past twenty-six
 * columns would need the two-letter form — and would fail the test that pins the header
 * before it could ever reach here.
 */
function columnLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

// --- what a row carries --------------------------------------------------------------

/**
 * A union rather than a flat record, for the reason the store learned the hard way: with
 * `outcome` and `skipReason` nullable on every variant, a skip carrying `won` compiles.
 * Here it would reach the Outcome column of a row that says `skip`, and the sheet would
 * assert both that we passed the offer over and that we won it.
 *
 * `firstSeenAtMs` is nullable on purpose. Reconciliation legitimately finds work no
 * sighting ever recorded (FR-016a) — that is the gap it exists to close — and a recovery
 * row must be able to say "never sighted" rather than invent a time.
 */
const common = {
  objId: z.string().min(1),
  /** FR-011a. Required: a blank here is the requirement quietly not being met. */
  languageDirection: z.string().min(1),
  firstSeenAtMs: z.number().finite().nullable(),
  /** The gate's own sentence, or the failure detail. */
  note: z.string().nullable().optional(),
};

/** The two numbers the gate decided on. Null where the payload carried none — never a 0,
 *  which reads as "no work" rather than "we do not know". */
const work = {
  effortWords: z.number().finite().nullable(),
  deadlineMs: z.number().finite().nullable(),
};

const settled = {
  outcome: z.enum(CLAIM_OUTCOMES),
  claimedAtMs: z.number().finite(),
};

const trackingRecordSchema = z.discriminatedUnion('eventType', [
  z.object({ eventType: z.literal('sighting'), ...common, ...work }),
  z.object({ eventType: z.literal('claim'), ...common, ...work, ...settled }),
  z.object({ eventType: z.literal('recovery'), ...common, ...work, ...settled }),
  z.object({
    eventType: z.literal('skip'),
    ...common,
    ...work,
    skipReason: z.enum(SKIP_REASONS),
  }),
]);

/** One row's worth of fact. The schema is the definition; this is its inferred shape, so
 *  the two cannot drift. */
export type TrackingRecord = z.infer<typeof trackingRecordSchema>;

/** The event types a row can describe — the second half of its identity (FR-014). */
export type TrackingEventType = TrackingRecord['eventType'];

/**
 * The upsert key: identity **together with** event type (FR-014, constitution VII). One
 * offer legitimately produces a sighting, a claim and possibly a recovery, and keying on
 * identity alone collapses three real events into one row — the record would then say an
 * offer was recovered without ever saying its claim came back unknown.
 *
 * Exported because the caller queuing these records needs an outbox event id that agrees
 * with it: `row:${trackingRowKey(...)}`. Two different keys for the same row is how one
 * event ends up delivered twice and another not at all.
 */
export function trackingRowKey(objId: string, eventType: TrackingEventType): string {
  return `${objId}|${eventType}`;
}

/**
 * Skip reasons as a human reads them (contract §1: "named in plain language, not a code").
 * `satisfies` rather than an annotation, so a new reason added to {@link SKIP_REASONS}
 * fails the typecheck here instead of printing its own identifier into the sheet.
 */
const SKIP_REASON_TEXT = {
  ineligible_language: 'language direction is not one this account claims',
  outside_schedule: 'outside working hours',
  deadline_on_non_working_day: 'the deadline falls on a weekend or a holiday',
  deadline_unreachable: 'not enough working time before the deadline',
  ceiling_reached: 'the day’s word ceiling is already committed',
  exceeds_daily_ceiling_entirely: 'larger on its own than a whole day’s ceiling — needs a human',
  holiday_calendar_uncurated: 'the deadline’s year has no curated holiday calendar',
  effort_unknown: 'the offer arrived without a word count',
  deadline_unknown: 'the offer arrived without a deadline',
  claiming_halted: 'claiming had already stopped for this cycle',
} as const satisfies Record<SkipReason, string>;

/**
 * Epoch ms → `DD/MM/YYYY HH:mm` in Asia/Bangkok, with seconds when the column needs them.
 *
 * The date comes from the canonical Bangkok helper and the time of day from the canonical
 * offset it is built on; the +7h shift is not re-derived here (`reporting/dateFormat.ts`
 * sets the same precedent, and the output deliberately matches what it renders).
 *
 * `seconds` is not a stylistic choice — see {@link toRowValues} for which columns pass it
 * and why the answer differs per column.
 */
function bangkokClock(ms: number | null, seconds = false): string {
  if (ms === null) return '';
  const [year, month, day] = bangkokCalendar(ms).date.split('-'); // canonical, already +07:00
  const shifted = new Date(ms + BKK_OFFSET_MS); // UTC parts now read as Bangkok wall clock
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const time = `${p2(shifted.getUTCHours())}:${p2(shifted.getUTCMinutes())}`;
  const secs = seconds ? `:${p2(shifted.getUTCSeconds())}` : '';
  return `${day}/${month}/${year} ${time}${secs}`;
}

/**
 * `sighting` → `Sighting`. The enum values are identifiers, and a column of bare
 * identifiers reads as a log dump rather than a record someone keeps.
 *
 * Display only. {@link trackingRowKey} keeps the raw value, because it is the upsert's
 * identity: capitalising that would stop every existing row matching, and the sink would
 * append a second row for an event it was asked to update.
 */
function forReading(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The record as eleven cells, in the order {@link TRACKING_HEADER} declares.
 *
 * **First seen and Claimed at carry seconds; Deadline does not.** Those two are the ends of
 * SC-001's latency measure and the races seen so far are decided inside two seconds — at
 * minute resolution the number this feature exists to produce would be quantised to zero
 * before anyone could read it. A deadline has no second hand, and printing `:00` on every
 * one of them would only add a column of noise.
 */
function toRowValues(record: TrackingRecord): string[] {
  const settledEvent = record.eventType === 'claim' || record.eventType === 'recovery';
  return [
    bangkokClock(record.firstSeenAtMs, true),
    forReading(record.eventType),
    settledEvent ? forReading(record.outcome) : '',
    record.objId,
    record.languageDirection,
    bangkokClock(record.deadlineMs),
    record.effortWords === null ? '' : String(record.effortWords),
    record.eventType === 'skip' ? SKIP_REASON_TEXT[record.skipReason] : '',
    settledEvent ? bangkokClock(record.claimedAtMs, true) : '',
    record.note ?? '',
    trackingRowKey(record.objId, record.eventType),
  ];
}

// --- the layout guard ----------------------------------------------------------------

/**
 * The sheet is not shaped the way this module writes. Its own class so the failure is
 * distinguishable from a transport outage in a log line, and so a future caller can react
 * to it specifically rather than by matching on message text.
 */
export class StrakerSheetLayoutError extends Error {
  constructor(
    readonly found: readonly string[],
    detail: string,
  ) {
    super(
      `Straker tracking sheet layout has shifted — refusing to write. ${detail}. ` +
        `Found (${found.length} cols): ${found.join(' | ')}`,
    );
    this.name = 'StrakerSheetLayoutError';
  }
}

/**
 * Verify the header before writing, and throw rather than write into columns that have
 * moved. The XTM bot needed this guard after a real incident, and the reason it is worth
 * a dead-lettered row is that the alternative is silent: a deadline written into the effort
 * column is indistinguishable from an effort, so nothing downstream can ever detect it.
 *
 * Detection is a **prefix** match, not an exact one. Extra columns to the right of the key
 * are a human's own — an invoice column, a paid-yet column — and nothing left of the key has
 * moved, so refusing them would turn a harmless edit into a page at 03:00. That over-strict
 * check is the second half of the XTM bot's lesson, learned after the first.
 */
function requireExpectedLayout(header: readonly string[]): void {
  for (const [index, expected] of TRACKING_HEADER.entries()) {
    const found = header[index];
    if (found === expected) continue;
    throw new StrakerSheetLayoutError(
      header,
      `column ${columnLetter(index)} should be '${expected}' but is ` +
        (found === undefined ? '(missing)' : `'${found}'`),
    );
  }
}

// --- the sink ------------------------------------------------------------------------

/**
 * The spreadsheet, as the sink needs it. Injected so the upsert and the layout guard are
 * unit-tested against an in-memory fake: nothing under test opens `google-credentials.json`
 * or reaches Google. {@link GoogleTrackingSheet} is the real one.
 *
 * There is no `insertColumn` here, unlike the XTM sink's transport. That one exists to
 * migrate a live sheet whose shape predates a column; this file is version 1 and has no
 * history to migrate. A sheet that does not match is a human's edit and needs a human.
 */
export interface TrackingSheetApi {
  /** Header row (row 1), or `[]` when the sheet is empty. */
  getHeader(): Promise<string[]>;
  /** Write the header row (row 1). Only ever called on an empty sheet. */
  setHeader(values: readonly string[]): Promise<void>;
  /** The `_row_key` column including its header cell at index 0, for the upsert lookup. */
  getKeyColumn(): Promise<string[]>;
  /** Overwrite one data row, 1-based as the sheet numbers them (row 1 is the header). */
  writeRow(rowNum: number, values: readonly string[]): Promise<void>;
  appendRow(values: readonly string[]): Promise<void>;
}

/**
 * The dispatcher's `tracking` sender.
 *
 * Takes the already-parsed payload — the dispatcher owns reading the row — and returns a
 * result rather than throwing, so a bad row costs its own delivery and nothing else. Every
 * failure path here is `{ ok: false, reason }`: the outbox then schedules the retry, and
 * gives up loudly on its own terms once the retries are spent.
 */
export function createTrackingSink(sheet: TrackingSheetApi): StrakerSender {
  return async (payload: unknown): Promise<SendOutcome> => {
    const parsed = trackingRecordSchema.safeParse(payload);
    if (!parsed.success) {
      // Reported, not thrown, and not written: a payload this sink cannot read is a caller
      // bug, and writing a partial row would put a half-truth in the record permanently.
      return {
        ok: false,
        reason: `not a tracking record: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
          .join('; ')}`,
      };
    }

    try {
      const header = await sheet.getHeader();
      if (header.length === 0) await sheet.setHeader(TRACKING_HEADER);
      else requireExpectedLayout(header);

      const values = toRowValues(parsed.data);
      const rowKey = trackingRowKey(parsed.data.objId, parsed.data.eventType);
      const keys = await sheet.getKeyColumn(); // index 0 is the header cell
      const existing = keys.indexOf(rowKey);
      if (existing === -1) await sheet.appendRow(values);
      else await sheet.writeRow(existing + 1, values);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

// --- the real spreadsheet -------------------------------------------------------------

/**
 * googleapis-backed {@link TrackingSheetApi}, pointed at Straker's **own** file.
 *
 * Constructed only by the composition root, and never by a test — everything above it is
 * tested through the interface. The scope is the least-privilege one the constitution asks
 * for, and the same service account file the XTM bot uses; the separation R11 requires is
 * the spreadsheet id, which is Straker's own.
 *
 * `keyFile` defaults to the repo's own convention because **`StrakerBotConfig` has no field
 * for it** — `src/config/index.ts` defaults `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` to this same
 * literal, and Straker must not read the XTM config (that is what makes the two bots
 * separable). The default is a stand-in, not a preference: when `STRAKER_SHEETS_KEY_PATH`
 * is added to `src/straker/config.ts`, pass it here and the default stops being reached.
 */
export class GoogleTrackingSheet implements TrackingSheetApi {
  private readonly sheets;

  constructor(
    private readonly spreadsheetId: string,
    private readonly tab: string,
    keyFile = 'google-credentials.json',
  ) {
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  async getHeader(): Promise<string[]> {
    // Read past the layout's own width, so the extra columns a human added are visible to
    // the prefix check rather than looking like the end of the header.
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A1:Z1`,
    });
    return (res.data.values?.[0] as string[] | undefined) ?? [];
  }

  async setHeader(values: readonly string[]): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [[...values]] },
    });
  }

  async getKeyColumn(): Promise<string[]> {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!${LAST_COLUMN_LETTER}:${LAST_COLUMN_LETTER}`,
    });
    return ((res.data.values ?? []) as string[][]).map((row) => row[0] ?? '');
  }

  async writeRow(rowNum: number, values: readonly string[]): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A${rowNum}:${LAST_COLUMN_LETTER}${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[...values]] },
    });
  }

  async appendRow(values: readonly string[]): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A:${LAST_COLUMN_LETTER}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[...values]] },
    });
  }
}
