/**
 * Turning a raw Straker entry into the values a decision needs (T042, FR-023, FR-023a).
 *
 * ## Built from files, not from a field list
 *
 * Every field named below was read off a payload the capture probe wrote to
 * `fixtures/straker/offers/`, and the suite that governs this file reads those same files
 * from disk rather than restating them as literals. That is the whole reason SC-000's
 * premise was judged spent: the shape is no longer an assumption.
 *
 * What has **not** changed is how thin the evidence is. Three files, of which only **two are
 * independent** — `aj-265` arrived as one job split across `th` and `ms-my`. So this parser
 * is written to be brittle on purpose: it names the values it has seen, and anything else
 * stops the read (contract §"The governing rule").
 *
 * ## The one line that matters most: a skip is not a failure
 *
 * | Payload condition | What happens | Why |
 * |---|---|---|
 * | `words` or `due_at` **absent** | that field parses to `null` | The gate turns it into an `effort_unknown` / `deadline_unknown` skip **and an alert** (FR-023a). One offer is passed over; the read is fine. |
 * | any field of the **wrong type**, an unknown `listing_type` or `status`, a missing `obj_id` | throw {@link StrakerOfferShapeError} | The shape changed. Interpreting it is how a bot claims the wrong work while looking healthy. |
 *
 * A throw rejects the **whole read**, not the one entry. That matches `listOpenOffers`, which
 * already rejects an entire reply over a single entry with no `obj_id`, and it is deliberate:
 * dropping a bad entry would shrink the list silently, and a silently shorter list is
 * indistinguishable from offers vanishing — which stamps fabricated lifetimes on live offers.
 * That is the silent-zero family the XTM bot's 38-minute outage belongs to; the mechanism
 * there was different and `offersApi.ts` records it. Upstream, a throw is caught
 * by the bot's supervised cycle guard, logged as `outcome: 'threw'` and fails the heartbeat,
 * so a portal change pages a human within about five minutes instead of decaying quietly.
 *
 * ## The assumptions encoded here, all four of them
 *
 * 1. **`due_at` is Bangkok** — and this is the assumption whose error runs the wrong way.
 *    The payload carries no zone (`2026-09-15T23:20:00`) and the portal's own is unknown;
 *    Straker is a New Zealand company, and NZST is UTC+12 against Bangkok's +7. If the
 *    portal means New Zealand, every deadline here is read **five hours later than it is**
 *    (six under NZDT), so the bot believes it has five hours it does not have: it accepts
 *    work the team cannot finish and misses the deadline, rather than passing over work it
 *    could have taken. Both errors are possible; only this one costs a delivery. Pinned in
 *    {@link STRAKER_DEADLINE_ZONE}, overridable per call, never left to a bare `Date.parse`
 *    (which would silently take the host's zone: Bangkok on the office machine, UTC in CI).
 *    `createOfferExtractor` states it in the log at startup so it is visible at runtime and
 *    not only in this comment. **RP-4 settles it on the first real claim** — an assigned job
 *    shows its deadline in the portal UI, which is the observation that decides.
 * 2. **Effort is the raw `words` count** (FR-009), not `total_unit` and not `budget`. What
 *    the sample shows: `total_unit` is **hours** when `rate_type` is `per_hour` and one
 *    project when it is `total_project`, so the third offer's 0.010 hours is 36 seconds —
 *    and 4 words in 36 seconds is a coherent pair, where 4 *projects* or 4 *dollars* would
 *    not be. That is consistent with `words` meaning words; it is not proof. The pricing
 *    identity that would have made it proof does **not** hold: `unit_cost × total_unit` is
 *    18.0000 × 0.010 = **0.18** against a stated `budget` of **0.19** on that very offer,
 *    a cent that rounding does not explain. It holds exactly on the other two, which are
 *    one job split across two languages — so the arithmetic is confirmed on a single
 *    independent offer and contradicted on the other. Effort is the number the whole
 *    capacity ceiling rests on; RP-4 should settle it against an assigned job rather than
 *    leaving it on this.
 * 3. **Every direction that arrives is one of the 44 registered**, so eligibility is just
 *    "not excluded" — see `eligibility.ts`, where that inference is written down. An
 *    unfamiliar-looking direction is logged loudly and still treated as eligible.
 * 4. **`direct_po` is the only listing type known to be claimable**, and `open` the only
 *    status. Both have exactly one observed value, and what the others mean is still
 *    Straker's to answer, so both fail loud.
 */

import type { Logger } from '../monitoring/logger.js';
import type { OfferForDecision } from './claimDecision.js';
import {
  formatLanguageDirection,
  isEligibleDirection,
  isFamiliarDirectionShape,
} from './eligibility.js';
import type { RawOffer } from './probe.js';

/** A zone to read `due_at` in. Fixed-offset, like `BKK_OFFSET_MS`: Bangkok has no DST. */
export interface DeadlineZone {
  readonly id: string;
  /** As an ISO-8601 designator, e.g. `+07:00`. */
  readonly utcOffset: string;
}

/**
 * **The zone assumption, in one place.**
 *
 * `due_at` carries no timezone and two payloads cannot reveal which zone the portal means.
 * This follows the repo's existing precedent for the same problem — the XTM bot's Due cell is
 * equally zone-less and is resolved by pinning `TZ=Asia/Bangkok` (both PM2 configs do) — but
 * pins it *in the code* rather than in the environment, so a CI run in UTC and the office
 * machine agree. **If Straker turns out to mean New Zealand time, this constant is the one
 * line that changes** — and until it is confirmed, every deadline is being read in the
 * optimistic direction: five hours later than a New Zealand `due_at` would mean, which is
 * five hours of capacity the team does not have. See assumption 1 in the module docstring.
 */
export const STRAKER_DEADLINE_ZONE: DeadlineZone = { id: 'Asia/Bangkok', utcOffset: '+07:00' };

/** The only listing type ever observed; the spec records that the others are unknown. */
const CLAIMABLE_LISTING_TYPE = 'direct_po';

/** The list is read with `?status=open`, so anything else is the portal contradicting itself. */
const OPEN_STATUS = 'open';

/** `2026-09-15T23:20:00` — zone-less to the second, exactly as captured. Nothing else. */
const DUE_AT_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

/**
 * A payload that does not match the shape this parser was built against.
 *
 * Carries the field and the offer so an operator can find the payload again without
 * reconstructing which of a read's entries was the bad one.
 */
export class StrakerOfferShapeError extends Error {
  constructor(
    readonly field: string,
    detail: string,
    readonly objId: string | null,
  ) {
    super(`Straker offer ${objId ?? '(no obj_id)'} has an unusable ${field}: ${detail}`);
    this.name = 'StrakerOfferShapeError';
  }
}

export interface OfferParseOptions {
  /** Lower-case `a>b` pairs, as `loadStrakerBotConfig` produces them. Empty = all eligible. */
  readonly excludedLanguagePairs: readonly string[];
  readonly logger: Logger;
  /** Defaults to {@link STRAKER_DEADLINE_ZONE}. A parameter so a test can prove it is used. */
  readonly deadlineZone?: DeadlineZone;
  /**
   * Called for each entry that cannot be read, instead of the whole read failing.
   *
   * `objId` is null when the entry is broken enough to have no identity — there is then
   * nothing to record it against, and the caller has only the reason to alert on.
   */
  readonly onUnreadable?: (objId: string | null, reason: string) => void;
}

/**
 * One raw entry to the values a decision needs. Takes `unknown` rather than `RawOffer`
 * because this is external input and the type is what is being checked.
 */
export function parseOffer(entry: unknown, options: OfferParseOptions): OfferForDecision {
  const record = asRecord(entry);
  const objId = requireNonEmptyString(record, 'obj_id', null);

  requireObservedValue(record, 'listing_type', CLAIMABLE_LISTING_TYPE, objId);
  requireObservedValue(record, 'status', OPEN_STATUS, objId);

  const sourceLang = requireNonEmptyString(record, 'source_lang', objId);
  // `target_lang: null` is not a broken payload — it is work with no target language.
  //
  // The portal offered a DTP preparation job on 2026-09-17 (`Members Co Ltd Q3.docx`, 956
  // words, Japanese to Japanese) with an explicit null here. Refusing it threw away the whole
  // reading for seventeen cycles and lost the job. Null now means monolingual.
  //
  // Only null. A missing key, an empty string or a number still fail: those are a payload
  // this parser does not understand, and the difference between "no target" and "the target
  // field is wrong" is exactly what keeps this from being a blanket relaxation.
  const monolingual = 'target_lang' in record && record['target_lang'] === null;
  const languageDirection = monolingual
    ? // Source repeated, so the same job reads identically here and in the assigned-work
      // list — that endpoint does carry a target and reports `ja>ja` for this very job.
      formatLanguageDirection(sourceLang, sourceLang)
    : formatLanguageDirection(sourceLang, requireNonEmptyString(record, 'target_lang', objId));
  if (!isFamiliarDirectionShape(languageDirection)) {
    // Not a refusal: `eligibility.ts` infers that anything the portal offers is a direction
    // the account is registered for, and refusing an unrecognised one would drop real work.
    // This line is what keeps that inference observable instead of silent.
    options.logger.warn(
      {
        module: 'offerParse',
        action: 'parse',
        outcome: 'unfamiliar_direction',
        objId,
        languageDirection,
      },
      'offer arrived in a language direction shaped unlike any in the captured sample — ' +
        'the "every direction offered is one of the 44 registered" inference may no longer hold',
    );
  }

  return {
    objId,
    languageDirection,
    monolingual,
    eligible: isEligibleDirection(languageDirection, options.excludedLanguagePairs),
    effortWords: parseEffort(record['words'], objId),
    deadlineMs: parseDeadline(
      record['due_at'],
      options.deadlineZone ?? STRAKER_DEADLINE_ZONE,
      objId,
    ),
  };
}

/**
 * The extractor the poll cycle runs (`OfferExtractor` in `pollCycle.ts`).
 *
 * Returned from a factory rather than exported as a function so the zone assumption is
 * announced **once per process**: at a ten-second rhythm, per-cycle would be eight and a half
 * thousand identical lines a day.
 */
export function createOfferExtractor(
  options: OfferParseOptions,
): (raw: readonly RawOffer[]) => readonly OfferForDecision[] {
  const zone = options.deadlineZone ?? STRAKER_DEADLINE_ZONE;
  options.logger.info(
    {
      module: 'offerParse',
      action: 'configure',
      deadlineZone: zone.id,
      utcOffset: zone.utcOffset,
      excludedLanguagePairs: options.excludedLanguagePairs.length,
    },
    `offer deadlines carry no timezone and are read as ${zone.id} (${zone.utcOffset}) — ` +
      'an unverified assumption about the portal, not a fact it states',
  );

  // Resolved once, not rebuilt per offer: the zone announced in the line above is then
  // provably the same object every parse runs against.
  const resolved: OfferParseOptions = { ...options, deadlineZone: zone };
  return (raw) => {
    const parsed: OfferForDecision[] = [];
    for (const entry of raw) {
      try {
        parsed.push(parseOffer(entry, resolved));
      } catch (error) {
        // ONE unreadable entry costs that entry, not the read.
        //
        // This threw until 2026-09-17, and the reasoning was sound as far as it went: silently
        // dropping a bad entry shrinks the list, and a shrinking list is indistinguishable from
        // offers vanishing. But those were not the only two options. That morning the portal
        // offered a DTP job carrying `target_lang: null`; the throw took down the whole read for
        // **17 consecutive cycles across three minutes**, in which the bot saw nothing at all —
        // and since a parse failure is not a transport failure, nothing alerted either.
        //
        // Reporting the entry is the third option: not silent, and not fatal to the offers that
        // parsed correctly beside it. A claimable offer sitting in the same response as an
        // unreadable one is no longer collateral damage.
        if (!(error instanceof StrakerOfferShapeError)) throw error;
        options.logger.error(
          {
            module: 'offerParse',
            action: 'parse',
            outcome: 'unreadable',
            objId: error.objId,
            field: error.field,
          },
          error.message,
        );
        resolved.onUnreadable?.(error.objId, error.message);
      }
    }
    return parsed;
  };
}

function asRecord(entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new StrakerOfferShapeError('entry', `expected an object, got ${describe(entry)}`, null);
  }
  return entry as Record<string, unknown>;
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  field: string,
  objId: string | null,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StrakerOfferShapeError(
      field,
      `expected a non-empty string, got ${describe(value)}`,
      objId,
    );
  }
  return value;
}

/**
 * A field whose every observed value is one single value. Anything else stops the read.
 *
 * This is the deliberately brittle part, and the trade is worth naming: a new `listing_type`
 * or a new `status` takes the bot dark (every read throws, the heartbeat fails, someone is
 * paged) rather than letting it claim work whose terms nobody has established. Three offers
 * of one type cannot show that every type behaves this way — the spec says so in as many
 * words — and claiming is irreversible. Loosening either is a one-line change here, to be
 * made knowingly once Straker has answered what the other values mean (U3/Q3).
 */
function requireObservedValue(
  record: Record<string, unknown>,
  field: string,
  observed: string,
  objId: string | null,
): void {
  const value = record[field];
  if (value !== observed) {
    throw new StrakerOfferShapeError(
      field,
      `only ${JSON.stringify(observed)} has ever been observed, got ${describe(value)}`,
      objId,
    );
  }
}

/**
 * Effort is FR-009's raw word count. Absent means "cannot be decided" (a skip that alerts);
 * a wrong type means the payload changed (a failure).
 *
 * **Zero is treated as absent**, which is a judgment call rather than something the sample
 * settles. A zero passes every gate check trivially — the feasibility sum and the daily
 * ceiling both see nothing — so claiming on it is claiming blind, while an `effort_unknown`
 * skip both refuses it and raises FR-023a's alert so a human sees a zero-word offer exists.
 * The captured jobs were 2, 2 and 4 words; a 0 would be new.
 */
function parseEffort(value: unknown, objId: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new StrakerOfferShapeError(
      'words',
      `expected a non-negative whole number or nothing, got ${describe(value)}`,
      objId,
    );
  }
  return value === 0 ? null : value;
}

/**
 * The deadline, read in {@link STRAKER_DEADLINE_ZONE} because the payload states no zone.
 *
 * The strictness is the point. A `due_at` that arrives **with** a zone — `...:00Z`, or a
 * `+13:00` — is not a friendlier version of the same field: it either confirms or refutes the
 * assumption this whole module rests on, and that is a decision for a human. Absorbing it by
 * letting `Date.parse` accept both forms is how the bot would keep running while every
 * feasibility and deadline-day answer moved by hours.
 */
function parseDeadline(value: unknown, zone: DeadlineZone, objId: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !DUE_AT_SHAPE.test(value)) {
    throw new StrakerOfferShapeError(
      'due_at',
      `expected a zone-less YYYY-MM-DDTHH:mm:ss as every captured payload carried ` +
        `(read as ${zone.id}), got ${describe(value)}`,
      objId,
    );
  }
  // Read the configured offset BEFORE touching the payload. A zone we cannot read is a
  // configuration fault, and it must say so — if it were left to `Date.parse` to choke on,
  // every offer would be reported as carrying an unreadable deadline and the actual cause
  // would be nowhere in the message.
  const offsetMs = utcOffsetMs(zone);

  const ms = Date.parse(`${value}${zone.utcOffset}`);
  if (Number.isNaN(ms)) {
    throw new StrakerOfferShapeError('due_at', `is not a real instant: ${describe(value)}`, objId);
  }
  // `Date.parse` rejects a 13th month but SILENTLY ROLLS OVER an impossible day: a
  // `2026-02-31T10:00:00` comes back as 3 March, three days late, and an infeasible job
  // would look comfortably feasible. Reading the instant back as wall-clock and comparing
  // it to what arrived is what turns that into a loud failure. Measured, not assumed.
  const wallClock = new Date(ms + offsetMs).toISOString().slice(0, 19);
  if (wallClock !== value) {
    throw new StrakerOfferShapeError(
      'due_at',
      `is not a real date — ${describe(value)} silently rolls over to ${wallClock}`,
      objId,
    );
  }
  return ms;
}

function utcOffsetMs(zone: DeadlineZone): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(zone.utcOffset);
  if (match === null) {
    throw new Error(
      `Straker deadline zone ${zone.id} has an unusable UTC offset ${JSON.stringify(zone.utcOffset)} — expected e.g. "+07:00"`,
    );
  }
  const [, sign = '+', hours = '00', minutes = '00'] = match;
  return (sign === '-' ? -1 : 1) * (Number(hours) * 3_600_000 + Number(minutes) * 60_000);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'nothing';
  if (typeof value === 'object' && value !== null)
    return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}
