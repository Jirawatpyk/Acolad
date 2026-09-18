/**
 * Reconciliation — closing the window the claim path deliberately opens (T053, FR-016a..d).
 *
 * ## Why this file is not optional polish
 *
 * FR-003 forbids anything deferrable between noticing an eligible offer and dispatching its
 * claim, so the claim is sent **before** it is recorded. That is a genuine deviation from
 * Constitution VII ("state writes MUST be committed before the action is reported as
 * complete") and it is recorded as such in the plan's Complexity Tracking — with *this
 * module* named as the justification. Between the portal committing work to the team and
 * our own record catching up there is a window in which the team owes work that appears in
 * no record, counts against no ceiling, and reaches nobody. The principle's intent is met
 * behind the action instead of in front of it, and this is the behind.
 *
 * Delete this and the deviation becomes an unjustified one.
 *
 * ## The portal is the authority; our record is a copy
 *
 * A pass reads what the portal says is assigned to the team and adds whatever our ledger is
 * missing, marked **`recovered`** rather than as an ordinary claim (FR-016b). The
 * distinction carries information: a win the bot recorded and a win it only discovered
 * afterwards mean different things about whether the claim path is working, and collapsing
 * the two hides a recurring gap behind a healthy-looking claim history.
 *
 * ## Fail loud here means alert, not halt — and that is deliberate
 *
 * The portal contract's governing rule is that any departure "must fail loud and stop that
 * action". For the offer read, stopping is safe: the bot claims nothing it does not
 * understand. For reconciliation, stopping is **the failure this module exists to prevent**
 * — work the team already owes stays unrecorded for as long as the halt lasts. So the rule
 * is applied with one axis reversed:
 *
 * | Departure | Answer | Why |
 * |---|---|---|
 * | The reply is not the `{ items, total }` envelope | Throw, the pass fails | An envelope read as a bare list is the silent zero: "the team holds nothing". See `offersApi.ts`. |
 * | An entry carries no identity | Throw, the pass fails | There is nothing to record. An offer we cannot name is one we cannot deduplicate, reconcile or hold. |
 * | A status nobody has seen | Recover it anyway, and alert | Over-stating the ceiling costs an offer passed over; under-stating it costs a commitment the team cannot deliver. Only one of those is a missed delivery. |
 * | Effort or deadline unreadable | Recover it anyway, and alert | It is already committed on the portal. Refusing over a missing number would cause the exact failure this module repairs. |
 * | Language direction unreadable | Recover it, alert, and **withhold the tracking row** | See below. |
 *
 * ## The language direction, and the one row that can be withheld
 *
 * `trackingSink.ts` requires a non-empty `languageDirection` on every row (FR-011a), and
 * rejects the row otherwise. That is right, and it puts a condition on this module.
 *
 * The condition is normally met: the captured assigned-job payload carries `source_lang`
 * and `target_lang` (recon note 4.2, confirmed against a real payload), and
 * {@link readAssignedWork} formats them with `eligibility.formatLanguageDirection` — the
 * very function the offer path uses, so the two spellings cannot drift.
 *
 * When they are absent there is **nothing to fall back on**. Neither `offer_events` nor
 * `offer_sightings` carries a language column; the direction lives only in the payload.
 * So the answer is not to invent one — a fabricated direction is worse than a missing one,
 * because nothing downstream can tell it from a real one — and not to queue a row the sink
 * will refuse, because a rejected row retries, dies, and is then a recovered job that
 * silently never reached the record. The recovery is recorded, held, counted and announced
 * as always; only the spreadsheet row is withheld, and the alert says which job and why.
 * The durable record is `offer_events`; the sheet is the human-readable copy of it.
 *
 * ## What this module deliberately does NOT do
 *
 * **It never releases held work.** Reconciliation is the only thing that reads the portal's
 * assigned list, so it is the only thing that *could* notice work the team no longer holds —
 * and both `StrakerStore.release` and `StrakerLedger.release` were written anticipating this
 * caller ("a repeated reconciliation pass is a no-op"). It is left unbuilt because FR-016a
 * mandates only the additive direction, and the subtractive one is not safe on the same
 * evidence: a partial read would free capacity for work the team genuinely holds, and
 * over-committing an irreversible claim is the one error this feature cannot take back.
 * Until something releases, the ledger's budget never returns — see the report accompanying
 * this task.
 */

import { formatLanguageDirection, isMonolingualDirection } from './eligibility.js';
import { isBudgetSuspended, isSessionExpired, type StrakerHttpClient } from './httpClient.js';
import type { HoldResult, StrakerLedger } from './ledger.js';
import type { Logger } from '../monitoring/logger.js';
import { STRAKER_DEADLINE_ZONE, type DeadlineZone } from './offerParse.js';
import type { StrakerOutbox, StrakerOutboxChannel } from './outbox.js';
import { countsTowardLedger } from './outcomePolicy.js';
import {
  CLAIM_ALERT_CONDITION,
  type StrakerOfferAlert,
  type StrakerOfferAnnouncement,
} from './notifier.js';
import type { StrakerSession } from './session.js';
import { trackingRowKey, type TrackingRecord } from './trackingSink.js';
import type { ClaimOutcome } from './types.js';
import type { StrakerStore } from './strakerStore.js';

// ---------------------------------------------------------------------------
// The cadence and the alert threshold
// ---------------------------------------------------------------------------

/**
 * FR-016a's "at least every 15 minutes". Fifteen minutes bounds the window in which the
 * team can unknowingly owe work to well inside a working day, at a cost of four reads an
 * hour against a budget of three hundred a minute.
 *
 * Exported so the caller can log it and the suite can assert it, **not** so it can be
 * tuned: SC-009 is expressed in this number.
 */
export const RECONCILE_INTERVAL_MS = 15 * 60_000;

/** FR-016c's "three consecutive failures". */
export const RECONCILE_FAILURE_ALERT_THRESHOLD = 3;

/** The outcome every row this module writes carries (FR-016b). */
const RECOVERED: ClaimOutcome = 'recovered';

/**
 * The same value, narrowed to what each destination will accept — so that a change to
 * either contract is a compile error here rather than a row the sender refuses at 03:00.
 *
 * `RECOVERED_ALERT_CONDITION` is read out of the notifier's own outcome table rather than
 * written as a literal: which condition an outcome alerts as is one decision, and it is
 * `notifier.ts`'s. The non-null assertion is safe by that table's own construction — it is
 * total over `ClaimOutcome` and `alertsOn('recovered')` is true — and the alternative, a
 * fallback condition, would invent a card for a case that cannot arise.
 */
const RECOVERED_ANNOUNCED: StrakerOfferAnnouncement['outcome'] = 'recovered';
const RECOVERED_ALERT_CONDITION = CLAIM_ALERT_CONDITION[RECOVERED]!;

/** How many jobs to ask for per page. The read is paginated; the offer list is not. */
const DEFAULT_PAGE_LIMIT = 100;

/**
 * A stop on the paging loop. Reached only if the portal keeps reporting a total it never
 * delivers — at which point continuing is a request loop against a portal in a bad state,
 * and stopping quietly would under-recover in silence.
 */
const DEFAULT_MAX_PAGES = 20;

// ---------------------------------------------------------------------------
// What the portal says the team holds
// ---------------------------------------------------------------------------

/**
 * Statuses the recon capture and the portal's own bundle name (recon note 4.2). Anything
 * else is a status this code has never seen — which is a fact worth alerting on, not a
 * reason to decide the work is finished.
 */
export const OBSERVED_ASSIGNED_STATUSES = [
  'pending',
  'assigned',
  'in_progress',
  'delivered',
  'open',
] as const;

/**
 * The statuses that mean the team still owes the work. `delivered` is the one observed
 * status deliberately absent: the job is done, and putting it on the ledger would consume
 * its deadline day's capacity for as long as the database lives, because nothing releases
 * held work today.
 */
export const OUTSTANDING_ASSIGNED_STATUSES = [
  'pending',
  'assigned',
  'in_progress',
  'open',
] as const;

/**
 * One job the portal says is assigned to the team, in this codebase's vocabulary rather
 * than the portal's.
 *
 * `effortWords` and `deadlineMs` are nullable because a recovery cannot be refused just
 * because a number was missing from it (see `LedgerStore`'s `CommittedWork`). `status` is
 * kept as the portal's own string rather than narrowed to a union, so an unrecognised one
 * survives to be named in the alert instead of being coerced into a value it is not.
 */
export interface AssignedWork {
  readonly objId: string;
  readonly status: string;
  readonly effortWords: number | null;
  readonly deadlineMs: number | null;
  /** `a>b`, as `eligibility.ts` formats it. Null when the payload named neither side. */
  readonly languageDirection: string | null;
  /** The portal's human-readable handle (`aj-175`), so an operator can find the job. */
  readonly reference: string | null;
}

/** The read door this module comes through: **one attempt, no backoff** (FR-016c). */
export type AssignedWorkReadDoor = Pick<StrakerHttpClient, 'getJson'>;

export interface ReadAssignedWorkOptions {
  readonly pageLimit?: number;
  readonly maxPages?: number;
  /** Defaults to {@link STRAKER_DEADLINE_ZONE}; a parameter so a test can prove it is used. */
  readonly deadlineZone?: DeadlineZone;
}

/**
 * Read every page of the portal's assigned-work list.
 *
 * Through `getJson` — the single-attempt door — on purpose. FR-016c gives this read its own
 * fifteen-minute cadence instead of FR-019b's exponential backoff, because a retry that is
 * already a quarter of an hour away cannot meaningfully be slowed down, and layering the two
 * would leave two implementers each able to cite a requirement for a different answer.
 *
 * ## The envelope guard is the point of this function
 *
 * `job-offers` returns a **bare array**; `assigned-jobs` returns an `{ items, total, limit,
 * offset }` **envelope** (contract 2 and 5). The two shapes differ, so a permissive cast is
 * not a convenience here — reading an envelope as a list yields zero items, and zero items
 * from this endpoint means *"the team holds nothing"*, which is indistinguishable from a
 * healthy quiet day. That is the same family of failure `offersApi.ts` documents at length,
 * reached from the opposite direction.
 *
 * No `job_status` filter is sent. The query parameter exists (recon note 3) but has never
 * been exercised, and a filter the portal silently ignores — or silently misreads — would
 * shrink this list without saying so. Filtering happens here, on values this code can name.
 */
export async function readAssignedWork(
  client: AssignedWorkReadDoor,
  vendorId: string,
  options: ReadAssignedWorkOptions = {},
): Promise<readonly AssignedWork[]> {
  const pageLimit = options.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const zone = options.deadlineZone ?? STRAKER_DEADLINE_ZONE;

  const collected: AssignedWork[] = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const reply = await client.getJson<unknown>(
      `/api/vendors/${vendorId}/assigned-jobs?limit=${pageLimit}&offset=${offset}`,
    );
    const { items, total } = readEnvelope(reply);
    for (const entry of items) collected.push(toAssignedWork(entry, zone));

    // Three ways a page is the last one, and none of them may be guessed. A short page is
    // the portal's own end-of-list signal; an empty one stops a loop that would otherwise
    // never advance; and `total` is what the envelope exists to tell us.
    if (items.length === 0 || items.length < pageLimit || collected.length >= total) {
      // …but the first two of those are the portal's *behaviour*, and `total` is its own
      // *claim*. When they disagree, the list is short and nothing here can say why. That
      // used to be returned as though it were the whole list, which was survivable only
      // while absence meant nothing. It now releases capacity (FR-016d), so a silently
      // short list would hand back a ceiling for work the team still owes — the exact
      // failure the positive-evidence rule was written to avoid, arriving through the
      // read instead of through the rule.
      if (collected.length < total) {
        throw new Error(
          `Straker assigned-jobs stopped at ${collected.length} of ${total} it says exist — ` +
            `refusing to treat a short list as the whole of it`,
        );
      }
      return collected;
    }
    offset += items.length;
  }

  // Reached only when the portal keeps promising more than it delivers. Throwing rather
  // than returning what we have: a short list from this endpoint reads as "the team holds
  // less than it does", which is the under-statement that lets a claim slip past a ceiling.
  throw new Error(
    `Straker assigned-jobs is still incomplete after ${maxPages} pages ` +
      `(${collected.length} read) — refusing to treat a partial list as the whole of it`,
  );
}

interface AssignedEnvelope {
  readonly items: readonly unknown[];
  readonly total: number;
}

function readEnvelope(reply: unknown): AssignedEnvelope {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) {
    throw new Error(
      `Straker assigned-jobs reply is not the { items, total } envelope it has always been ` +
        `(got ${describe(reply)}) — refusing to read it as "the team holds nothing"`,
    );
  }
  const record = reply as { items?: unknown; total?: unknown };
  if (!Array.isArray(record.items)) {
    throw new Error(
      `Straker assigned-jobs reply has no items array (got ${describe(record.items)}) — ` +
        'refusing to read it as "the team holds nothing"',
    );
  }
  // `total` drives the paging loop. Without a believable one there is no way to know the
  // list was read to the end, and a list read half way is a list that under-states.
  const total = record.total;
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) {
    throw new Error(
      `Straker assigned-jobs envelope carries no usable total (got ${describe(total)}) — ` +
        'the read cannot tell whether it saw the whole list',
    );
  }
  return { items: record.items, total };
}

function toAssignedWork(entry: unknown, zone: DeadlineZone): AssignedWork {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`Straker assigned-jobs entry is not an object (got ${describe(entry)})`);
  }
  const record = entry as Record<string, unknown>;
  const objId = record['obj_id'];
  if (typeof objId !== 'string' || objId.trim() === '') {
    throw new Error(
      'Straker assigned-jobs entry has no obj_id — work we cannot name is work we cannot ' +
        'reconcile, deduplicate or hold against a ceiling',
    );
  }
  const status = record['status'];
  return {
    objId: objId.trim(),
    // Not narrowed and not defaulted: an absent or oddly typed status becomes a string that
    // matches nothing, which routes it down the unrecognised-status path and alerts.
    status: typeof status === 'string' ? status : describe(status),
    effortWords: readEffort(record['words']),
    deadlineMs: readDeadline(record['due_at'], zone),
    languageDirection: readDirection(record['source_lang'], record['target_lang']),
    reference: typeof record['external_job_id'] === 'string' ? record['external_job_id'] : null,
  };
}

/** FR-009's raw word count. Anything unusable is `null`, which alerts rather than throws. */
function readEffort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * The assigned list's direction, read the same way `offerParse` reads the offer list's.
 *
 * The two endpoints name the field identically, so they must not disagree about what it
 * means: a `target_lang` of exactly `null` is monolingual work, and the direction doubles
 * the source (`ja>ja`). Every assigned DTP job observed so far has arrived with the doubled
 * tag already spelled out — the live record holds one — so the null branch here is
 * defensive. It costs one line and it removes the case where the same portal fact produces
 * a DTP row from one endpoint and an unreadable direction charged to the translation
 * ceiling from the other.
 */
function readDirection(source: unknown, target: unknown): string | null {
  if (typeof source !== 'string' || source.trim() === '') return null;
  if (target === null) return formatLanguageDirection(source, source);
  if (typeof target !== 'string' || target.trim() === '') return null;
  return formatLanguageDirection(source, target);
}

/**
 * `2026-08-21T05:59:59.999000Z`, as the captured assigned-job payload carries it — a
 * different shape from the offer list's zone-less `2026-09-15T23:20:00`, which is why this
 * cannot reuse `offerParse.parseDeadline`. Microseconds are accepted and truncated: the
 * ECMAScript grammar specifies exactly three fractional digits and the portal sends six,
 * so relying on the engine's leniency would be relying on an implementation detail.
 *
 * A zone-less value falls back to {@link STRAKER_DEADLINE_ZONE} rather than to the host's
 * clock, so one unverified assumption about the portal lives in one place.
 */
const ASSIGNED_DUE_AT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;

function readDeadline(value: unknown, zone: DeadlineZone): number | null {
  if (typeof value !== 'string') return null;
  const match = ASSIGNED_DUE_AT.exec(value.trim());
  if (match === null) return null;

  const [, wallClock = '', fraction = '', designator] = match;
  const offset = designator === undefined ? zone.utcOffset : designator;
  const millis = `${fraction}000`.slice(0, 3);
  const ms = Date.parse(`${wallClock}.${millis}${offset}`);
  if (Number.isNaN(ms)) return null;

  // `Date.parse` rejects a 13th month but SILENTLY ROLLS OVER an impossible day: a
  // 2026-02-31 comes back as 3 March, three days late, and the ledger would bucket the
  // work into a day it does not belong to. Read the instant back and compare.
  const offsetMs = offset === 'Z' ? 0 : utcOffsetMs(offset);
  if (offsetMs === null) return null;
  if (new Date(ms + offsetMs).toISOString().slice(0, 19) !== wallClock) return null;
  return ms;
}

function utcOffsetMs(designator: string): number | null {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(designator);
  if (match === null) return null;
  const [, sign = '+', hours = '00', minutes = '00'] = match;
  return (sign === '-' ? -1 : 1) * (Number(hours) * 3_600_000 + Number(minutes) * 60_000);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}

// ---------------------------------------------------------------------------
// The reconciler
// ---------------------------------------------------------------------------

/** The portal side, narrowed to the two things a pass needs. */
export interface ReconcilePortal {
  /** Signs in and reads the vendor identity back from the portal every time (FR-022). */
  signIn(): Promise<StrakerSession>;
  /** One attempt at the assigned-work list — see {@link readAssignedWork}. */
  listAssignedWork(vendorId: string): Promise<readonly AssignedWork[]>;
}

/** Exactly what a pass touches, declared so the dependency is visible (as `LedgerStore` is). */
export type ReconcileStore = Pick<
  StrakerStore,
  'transaction' | 'recordEvent' | 'heldWork' | 'sightingsOf'
>;
export type ReconcileLedger = Pick<StrakerLedger, 'hold' | 'release'>;
export type ReconcileOutbox = Pick<StrakerOutbox, 'enqueue'>;

export interface ReconcileDeps {
  readonly portal: ReconcilePortal;
  readonly store: ReconcileStore;
  readonly ledger: ReconcileLedger;
  readonly outbox: ReconcileOutbox;
  readonly logger: Logger;
  /** Injected so the fifteen-minute rule is testable without waiting fifteen minutes. */
  readonly now?: () => number;
  /** Overridable for tests only. SC-009 is expressed in the default. */
  readonly intervalMs?: number;
  readonly failureAlertThreshold?: number;
}

/** What one call to {@link StrakerReconciler.runIfDue} did. */
export type ReconcileOutcome =
  | { readonly ran: false; readonly reason: 'not_due' | 'already_running' }
  | {
      readonly ran: true;
      readonly ok: true;
      /** Outstanding jobs the portal reported. */
      readonly assigned: number;
      /** Identities added to the record by this pass. */
      readonly recovered: readonly string[];
      /**
       * Identities this pass gave back to the ledger (T056b) — held work the portal
       * **positively reported as finished**. Never work the read merely omitted.
       */
      readonly released: readonly string[];
      readonly consecutiveFailures: 0;
    }
  | {
      readonly ran: true;
      readonly ok: false;
      /** `read` — the portal could not be asked. `record` — it answered and we could not write. */
      readonly stage: 'read' | 'record';
      readonly detail: string;
      readonly recovered: readonly string[];
      readonly consecutiveFailures: number;
      /** Whether this pass crossed the threshold and queued an alert (FR-016c). */
      readonly alerted: boolean;
    }
  /**
   * The pass was due and the transport held it back to protect the request budget
   * (FR-019). Its own variant rather than a flag on the failure above, because the two
   * call for opposite responses: this one means the bot obeyed a rule, and the streak that
   * feeds FR-016c's alert is deliberately left untouched by it.
   */
  | {
      readonly ran: true;
      readonly ok: false;
      readonly shed: true;
      readonly recovered: readonly string[];
      readonly consecutiveFailures: number;
    };

export interface StrakerReconciler {
  /**
   * Run a pass if one is due, and never throw.
   *
   * **This is the only call site.** It is due on its very first call — which is FR-016a's
   * "on start" — and every {@link RECONCILE_INTERVAL_MS} after that, so a caller that
   * invokes it once per poll cycle satisfies both halves of the requirement with one line.
   */
  runIfDue(): Promise<ReconcileOutcome>;
  /** When the next pass falls due; null before the first has run. */
  nextDueAtMs(): number | null;
}

export function createStrakerReconciler(deps: ReconcileDeps): StrakerReconciler {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? RECONCILE_INTERVAL_MS;
  const threshold = deps.failureAlertThreshold ?? RECONCILE_FAILURE_ALERT_THRESHOLD;

  let lastAttemptAtMs: number | null = null;
  let inFlight: Promise<ReconcileOutcome> | null = null;
  let session: StrakerSession | null = null;

  /**
   * How "three consecutive" is counted, in one place.
   *
   * `consecutiveFailures` counts **attempted passes that did not complete their work** —
   * a read that failed, or a read that succeeded and then could not be recorded. A pass
   * that was not due is not an attempt and does not touch it. A successful pass resets it
   * to zero and clears `streakStartedAtMs`.
   *
   * `streakStartedAtMs` exists for the alert's identity. Keying the alert on the count
   * alone (`reconcile_failing:3`) would be deduplicated away by the outbox the second time
   * an outage reached three — the one case where a repeat is not a duplicate. Keyed on the
   * streak's first failure, every outage gets its own.
   *
   * **It lives in memory and resets on restart**, which is a real limit: a bot crash-looping
   * every fifteen minutes would never reach three. That is not silent — a bot that keeps
   * restarting fails its own heartbeat long before this counter would have said anything.
   */
  let consecutiveFailures = 0;
  let streakStartedAtMs: number | null = null;

  return {
    nextDueAtMs: () => (lastAttemptAtMs === null ? null : lastAttemptAtMs + intervalMs),

    async runIfDue(): Promise<ReconcileOutcome> {
      // A pass overlapping itself cannot corrupt anything — every write below is idempotent
      // — but it would read the portal twice and announce the same recovery from two
      // transactions racing on one row. Cheaper to refuse.
      if (inFlight !== null) return { ran: false, reason: 'already_running' };

      const atMs = now();
      // Never run before means due: FR-016a's "on start". A failed pass advances this too,
      // which is FR-016c's "retried on its next scheduled pass" — its own cadence governs
      // it, and FR-019b's backoff explicitly does not apply.
      if (lastAttemptAtMs !== null && atMs - lastAttemptAtMs < intervalMs) {
        return { ran: false, reason: 'not_due' };
      }
      lastAttemptAtMs = atMs;

      // The whole pass, inside one guard. `runPass` grew several calls that sat outside
      // every try — the held-work read, the success log, and the `logger.error` inside
      // `fail()` itself, which is the one place a throw could escape the function meant to
      // absorb failures. The promise this method makes is that it never throws, and the
      // composition root relies on it; a promise kept by inspection is not kept.
      //
      // It matters more than an unhandled rejection usually would, because `lastAttemptAtMs`
      // is set above, before the pass runs. A throwing `heldWork()` therefore meant a pass
      // attempted every fifteen minutes, throwing every time, advancing its own schedule
      // every time — reconciliation silently off for the life of the process, with only
      // stderr saying so, while the FR-003 window it exists to close stayed open.
      const pass = runPass(atMs).catch((err: unknown) => fail('record', err, [], atMs));
      inFlight = pass;
      try {
        return await pass;
      } finally {
        inFlight = null;
      }
    },
  };

  async function runPass(atMs: number): Promise<ReconcileOutcome> {
    let work: readonly AssignedWork[];
    try {
      work = await read();
    } catch (err) {
      return fail('read', err, [], atMs);
    }

    const outstanding = work.filter((w) => !isFinished(w.status));
    // objId → when it was first held. A map rather than a set because release-on-absence
    // needs the age: see `releaseFinished`, and the race it closes.
    const held = new Map(deps.store.heldWork().map((w) => [w.objId, w.heldSinceMs] as const));
    const missing = outstanding.filter((w) => !held.has(w.objId));

    const recovered: string[] = [];
    let firstFailure: unknown = null;
    for (const item of missing) {
      try {
        recover(item, atMs);
        recovered.push(item.objId);
      } catch (err) {
        // The recovery is rolled back whole — held work nobody was told about is the state
        // FR-016 exists to make impossible — so the next pass meets this row again. Loud,
        // per item, and named so it can be searched for.
        firstFailure ??= err;
        deps.logger.error(
          {
            module: 'reconcile',
            action: 'recover',
            outcome: 'failed',
            objId: item.objId,
          },
          message(err),
        );
      }
    }

    if (firstFailure !== null) return fail('record', firstFailure, recovered, atMs);

    if (consecutiveFailures >= threshold) {
      deps.logger.info(
        { module: 'reconcile', action: 'failure_streak', outcome: 'cleared', consecutiveFailures },
        'reconciliation is reaching the portal again',
      );
    }
    consecutiveFailures = 0;
    streakStartedAtMs = null;

    const released = releaseFinished(work, held, atMs);

    deps.logger.info(
      {
        module: 'reconcile',
        action: 'pass',
        outcome: 'ok',
        assigned: outstanding.length,
        recovered: recovered.length,
        released: released.length,
      },
      'reconciled the portal assigned list against our record',
    );
    return {
      ran: true,
      ok: true,
      assigned: outstanding.length,
      recovered,
      released,
      consecutiveFailures: 0,
    };
  }

  /**
   * Give back the budget for work the portal no longer holds against us (T056b, FR-016d).
   *
   * Two ways that is true, and the second one was added on 2026-09-17:
   *
   * 1. **Present and finished** — the read names the item and gives it a status this bot
   *    recognises as done. `isFinished` is "recognised AND not outstanding", so a status
   *    never seen before keeps the work held rather than handing back a ceiling on a word
   *    it cannot read.
   * 2. **Absent from a complete read** — the portal does not list the item at all.
   *
   * ## Why absence counts now, when it deliberately did not before
   *
   * This function used to be positive-evidence only, and the argument was that "a partial
   * read would free capacity for work the team genuinely holds". That argument was right
   * about the danger and wrong about the remedy: refusing to read absence did not make
   * partial reads safe, it just moved the cost somewhere quieter.
   *
   * **What it cost.** A job the client cancels vanishes from the assigned list — no status,
   * no final page, simply gone. Under rule 1 alone nothing could ever release it, so its
   * words stayed charged against its deadline day **forever**. That happened on 2026-09-17
   * (`b7000ad1`, 956 words, cancelled), and the wider evidence is that `released` was `0`
   * on every one of the 132 reconciliation passes the bot had ever run: rule 1 had never
   * fired once. A release path that cannot fire is not a conservative safeguard, it is an
   * absent feature whose absence nothing reports.
   *
   * **What makes absence safe to read — two guards, for two different ways it can lie.**
   *
   * - *The list is short.* {@link readAssignedWork} now throws rather than returning a list
   *   shorter than the `total` the portal itself claims, so a list that reaches this
   *   function is one the portal vouched for as whole. A failed or short read fails the pass
   *   and releases nothing. The old rule guarded the right thing in the wrong place — the
   *   guard belongs at the read, where completeness is knowable.
   * - *The list is whole but not yet current.* A job the bot has just won is held at once,
   *   and reaches the portal's assigned list some moments later. Absence in that gap means
   *   "not listed yet", not "gone", so work held for less than one reconcile interval is
   *   never released on absence. See the loop below for why the cost of the other answer is
   *   an irreversible over-claim rather than a delay.
   *
   * Failures are per item and never fail the pass. The cost of a missed release is an
   * offer the bot passes over; the cost of failing the pass would be the recoveries that
   * already succeeded looking like they did not.
   */
  function releaseFinished(
    work: readonly AssignedWork[],
    held: ReadonlyMap<string, number>,
    atMs: number,
  ): string[] {
    const released: string[] = [];
    const listed = new Set(work.map((item) => item.objId));

    const give = (objId: string, why: string): void => {
      try {
        // `release` answers false when the row is already released, which is the normal
        // steady state: the portal keeps reporting a delivered job every fifteen minutes.
        // Only a state CHANGE is reported, so a repeat pass is silent rather than noisy.
        if (!deps.ledger.release(objId, atMs)) return;
        released.push(objId);
        deps.logger.info(
          { module: 'reconcile', action: 'release', outcome: 'ok', objId, why },
          'gave the ceiling back for work the portal no longer holds against us',
        );
      } catch (err) {
        deps.logger.error(
          { module: 'reconcile', action: 'release', outcome: 'failed', objId },
          message(err),
        );
      }
    };

    for (const item of work) {
      if (isFinished(item.status) && held.has(item.objId)) give(item.objId, 'reported finished');
    }
    for (const [objId, heldSinceMs] of held) {
      if (listed.has(objId)) continue;
      // The grace, and the race it closes. A claim writes `held_work` the moment the portal
      // answers, but the portal can take a while to move the job onto its assigned list. A
      // pass landing in that gap sees work held and not listed, and without this line it
      // would hand back the ceiling for a job the bot has JUST WON — and the next offer
      // claimed against that freed ceiling is an over-commitment nothing can undo. The next
      // pass would find the job listed and recover it, so the damage heals; the claims made
      // in between do not.
      //
      // One full interval is generous against a propagation delay of seconds, and costs
      // nothing: a cancelled job's budget comes back one pass later than it could have.
      if (atMs - heldSinceMs < intervalMs) continue;
      give(objId, 'absent from a complete assigned list');
    }
    return released;
  }

  /**
   * One read, with exactly one re-sign-in if the portal says the session expired.
   *
   * The poll cycle drops its session and waits for the next cycle instead, which costs it
   * ten seconds. Here the next pass is fifteen minutes away, so an expiry would cost a whole
   * window — and three ordinary expiries in a row would look like an outage. `isSessionExpired`
   * is narrow (401 only): a 403 is a barred account, and re-signing in against a portal that
   * has already said no is how a suspension becomes a sign-in storm (contract 4a).
   */
  async function read(): Promise<readonly AssignedWork[]> {
    // The sign-in is OUTSIDE the guard on purpose. It used to be inside it, and a 401 from
    // the login POST itself is indistinguishable from a 401 on the read — so a refused
    // password was posted, read as "the session expired", and posted again immediately.
    //
    // RP-1 records that this account's password was shared over chat and is to be treated
    // as compromised, and the portal's lockout policy is unknown. Doubling the failed
    // logins is the wrong direction to be wrong in, and it is the same mistake contract §4a
    // forbids on the claim path: a bot that argues with a refusal is how an account earns a
    // permanent block rather than recovers from one.
    session ??= await deps.portal.signIn();
    const vendorId = session.vendorId;
    try {
      return await deps.portal.listAssignedWork(vendorId);
    } catch (err) {
      // Only the READ's 401 means the session expired, and only that is worth one retry:
      // the next pass is fifteen minutes away, so losing one to an ordinary expiry costs a
      // whole window. `isSessionExpired` is narrow (401 only) — a 403 is a barred account.
      if (!isSessionExpired(err)) throw err;
      session = null;
      session = await deps.portal.signIn();
      return deps.portal.listAssignedWork(session.vendorId);
    }
  }

  /**
   * Record one piece of recovered work — the row, the ledger and the announcements — in
   * **one transaction**, so a destination that cannot be queued takes the whole recovery
   * with it rather than leaving held work nobody was told about (FR-016).
   */
  function recover(item: AssignedWork, atMs: number): void {
    deps.store.transaction(() => {
      deps.store.recordEvent({
        objId: item.objId,
        eventType: 'recovery',
        outcome: RECOVERED,
        effortWords: item.effortWords,
        deadlineMs: item.deadlineMs,
        occurredAtMs: atMs,
      });

      // The predicate rather than a literal `true`: what counts toward the ledger is one
      // decision, and it is `outcomePolicy.ts`'s.
      const hold = countsTowardLedger(RECOVERED)
        ? deps.ledger.hold(
            {
              objId: item.objId,
              // Read back from the direction the assigned list reports, because the offer that
              // produced this work is long gone. `ja>ja` is DTP preparation; anything with two
              // different sides is translation. An unreadable direction falls to translation —
              // the stricter budget, so an unknown kind cannot quietly buy extra capacity.
              kind:
                item.languageDirection !== null && isMonolingualDirection(item.languageDirection)
                  ? 'monolingual'
                  : 'translation',
              // Zero, not a guess. An unreadable effort makes the day under-state by an
              // unknown amount, which is what the alert's detail says in words.
              effortWords: item.effortWords ?? 0,
              deadlineMs: item.deadlineMs,
            },
            atMs,
          )
        : null;

      const detail = describeRecovery(item, hold);

      // §2 — the team's own channel. Somebody has to actually do this work, and nobody has
      // been told it exists. Built to `StrakerOfferAnnouncement` so a change to the card's
      // contract breaks the build here rather than dead-lettering a row at 03:00.
      const announcement: StrakerOfferAnnouncement = {
        objId: item.objId,
        outcome: RECOVERED_ANNOUNCED,
        languageDirection: item.languageDirection,
        effortWords: item.effortWords,
        deadlineMs: item.deadlineMs,
        // When reconciliation found the work. The moment the portal committed it is
        // unknown to us, which is the whole meaning of `recovered`.
        occurredAtMs: atMs,
        detail,
      };
      enqueue('offers', `recovery:${item.objId}`, atMs, announcement);

      // §3 — the shared operations channel, answering a different question for a different
      // audience: the claim path committed work and lost the record of it. Neither message
      // substitutes for the other, and the outbox keys on event id **together with**
      // channel, so this is one delivery to each rather than two of either.
      //
      // The condition comes from the notifier's own table rather than a literal, so the
      // outcome-to-condition mapping has one source. One alert per recovered offer, which
      // is also FR-019a's "once per offer identity per outcome": the ceiling breach and
      // any unreadable field ride in `detail` rather than as alerts of their own, because
      // they are facts about this offer at this moment and a second card would page the
      // same person twice about the same discovery.
      const alert: StrakerOfferAlert = {
        kind: 'offer',
        condition: RECOVERED_ALERT_CONDITION,
        objId: item.objId,
        detail,
        occurredAtMs: atMs,
        // Omitted rather than passed as undefined: `exactOptionalPropertyTypes` is on, and
        // the card renders an absent field as unknown rather than as empty.
        ...(item.languageDirection === null ? {} : { languageDirection: item.languageDirection }),
        ...(item.effortWords === null ? {} : { effortWords: item.effortWords }),
        ...(item.deadlineMs === null ? {} : { deadlineMs: item.deadlineMs }),
      };
      enqueue('alerts', `recovery:${item.objId}`, atMs, alert);

      // FR-014: every outcome reaches the tracking record, and a recovery is the one
      // outcome nothing else produces. Typed as the sink's own `TrackingRecord` and keyed
      // with its own `trackingRowKey`, so a schema change there breaks the build here
      // rather than turning up as a row the sink refuses at three in the morning.
      if (item.languageDirection !== null && item.languageDirection !== '') {
        const row: TrackingRecord = {
          eventType: 'recovery',
          objId: item.objId,
          languageDirection: item.languageDirection,
          // The real sighting when the offer was seen and the record was lost afterwards;
          // null when it never appeared in a read at all. The difference is diagnostic —
          // one says the claim path dropped a record, the other says the offer never
          // reached us — and the sink is built to carry the null rather than invent a time.
          firstSeenAtMs: firstSightingOf(item.objId),
          effortWords: item.effortWords,
          deadlineMs: item.deadlineMs,
          outcome: RECOVERED,
          // When the record caught up, not when the portal committed the work: that moment
          // is unknown to us, which is the whole meaning of `recovered`. One meaning for
          // every recovery row beats a timestamp that silently changes what it denotes.
          claimedAtMs: atMs,
          note: detail,
        };
        enqueue('tracking', `row:${trackingRowKey(item.objId, 'recovery')}`, atMs, row);
      }
    });
  }

  /**
   * When this offer was first seen, across every appearance the store holds — or null when
   * it holds none, which is the case FR-016a exists for.
   */
  function firstSightingOf(objId: string): number | null {
    const sightings = deps.store.sightingsOf(objId);
    if (sightings.length === 0) return null;
    return Math.min(...sightings.map((s) => s.firstSeenAtMs));
  }

  function fail(
    stage: 'read' | 'record',
    err: unknown,
    recovered: readonly string[],
    atMs: number,
  ): ReconcileOutcome {
    // Being **shed** is not failing. This read goes through the deferrable door on purpose
    // — it is the one read the bot can afford to skip — and FR-019 suspends it below 120
    // remaining. Counting that toward FR-016c would raise "reconciliation has failed three
    // times running" after forty-five minutes of a *busy* portal, which is the bot obeying
    // a rule correctly. The alert an operator is meant to act on must not cry wolf during
    // normal budget pressure.
    //
    // The streak is left untouched rather than reset, so a portal that is both busy and
    // broken still reaches the alert on its genuine failures.
    if (isBudgetSuspended(err)) {
      deps.logger.info(
        { module: 'reconcile', action: 'pass', outcome: 'shed', stage, consecutiveFailures },
        'reconciliation skipped this pass to protect the request budget (FR-019) — not a failure, and the next pass is due as usual',
      );
      return { ran: true, ok: false, shed: true, consecutiveFailures, recovered, alerted: false };
    }

    consecutiveFailures += 1;
    streakStartedAtMs ??= atMs;
    const detail = message(err);

    deps.logger.error(
      { module: 'reconcile', action: 'pass', outcome: 'failed', stage, consecutiveFailures },
      detail,
    );

    // At the threshold, and at every further multiple of it. Once only would announce a
    // day-long outage a single time; every pass would announce it four times an hour.
    const alerted = consecutiveFailures % threshold === 0;
    if (alerted) {
      try {
        enqueue(
          'alerts',
          `${RECONCILE_FAILING_CONDITION}:${String(streakStartedAtMs)}:${consecutiveFailures}`,
          atMs,
          reconcileFailingAlert(consecutiveFailures, threshold, atMs, streakStartedAtMs, detail),
        );
      } catch (alertErr) {
        // The alert path itself failing must not turn a failed pass into a thrown one:
        // `runIfDue` promises never to throw, and the caller is a 24/7 loop.
        deps.logger.error(
          { module: 'reconcile', action: 'alert', outcome: 'failed' },
          message(alertErr),
        );
      }
    }

    return { ran: true, ok: false, stage, detail, recovered, consecutiveFailures, alerted };
  }

  function enqueue(
    channel: StrakerOutboxChannel,
    eventId: string,
    atMs: number,
    payload: unknown,
  ): void {
    const result = deps.outbox.enqueue(eventId, channel, JSON.stringify(payload), atMs);
    if (result === 'already_dead') {
      // The one duplicate answer a caller must not read as "already handled": it will never
      // be delivered until an operator requeues it (FR-016).
      deps.logger.error(
        { module: 'reconcile', action: 'notify', outcome: 'already_dead', eventId, channel },
        'a reconciliation outcome was queued before and has since died undelivered — ' +
          'requeue it, it will not resend itself',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * FR-016c's alert, shaped as `notifier.StrakerTransportAlertNotice`.
 *
 * **The condition does not exist in the notifier yet, and that is a real gap, not an
 * oversight here.** `notifier.ts` says so itself: "a reconciliation that has failed three
 * times" is listed among the conditions belonging to modules not built when it was
 * written, each of which "arrives by adding one condition here and one entry to
 * `ALERT_SPECS`". That file is not this task's to edit, so until those two lines land the
 * alerts sender refuses this payload, the row retries and then shows as `dead` — visible
 * and requeueable, but not delivered. The failure is also logged at error level on every
 * failing pass, which is what carries the signal in the meantime.
 *
 * The **transport** shape rather than the offer one, and not a third kind, because the
 * The notifier gained a `system` kind for it on 2026-09-15 (`SYSTEM_ALERT_CONDITIONS`), in
 * preference to filing it under the transport whose notice shape it superficially fits. The
 * reason is that a pass counts a failure when the read failed **or** when the read succeeded
 * and a recovery could not be persisted — so half the cases this fires on are not transport
 * failures at all, and the subject is a pass rather than a request.
 */
const RECONCILE_FAILING_CONDITION = 'reconcile_failing';

/** What is failing, named for a human rather than as a request path — a pass can fail with
 *  no request having been made at all, when a recovery cannot be persisted. */
const RECONCILE_SUBSYSTEM = 'reconciliation (assigned-work read and recovery)';

function reconcileFailingAlert(
  consecutiveFailures: number,
  threshold: number,
  atMs: number,
  streakStartedAtMs: number,
  cause: string,
): Record<string, unknown> {
  return {
    kind: 'system',
    condition: RECONCILE_FAILING_CONDITION,
    subsystem: RECONCILE_SUBSYSTEM,
    occurredAtMs: atMs,
    // The count and the span, not a suppression figure: the news is that it has now failed
    // this many times running since then. A three-failure blip and a day-long outage must
    // not read identically on the channel.
    consecutiveFailures,
    failingSinceMs: streakStartedAtMs,
    detail:
      `reconciliation has failed ${consecutiveFailures} times running (${cause}). Work the ` +
      'portal has committed to the team may be going unrecorded, uncounted and unannounced ' +
      'for as long as this lasts — and a reconciliation that has stopped looks exactly like ' +
      'one that keeps finding nothing, which is why this is an alert rather than a log line.',
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function isObservedStatus(status: string): boolean {
  return (OBSERVED_ASSIGNED_STATUSES as readonly string[]).includes(status);
}

function isOutstanding(status: string): boolean {
  return (OUTSTANDING_ASSIGNED_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether the portal says this work is done with.
 *
 * Written as "recognised **and** not outstanding" rather than "not outstanding", so the
 * unknown case falls on the side that keeps the work. Over-stating the ceiling costs an
 * offer the bot passes over; under-stating it costs a commitment the team cannot deliver.
 */
function isFinished(status: string): boolean {
  return isObservedStatus(status) && !isOutstanding(status);
}

/** What about this recovery could not be read — or null when all of it could. */
function describeRecovery(item: AssignedWork, hold: HoldResult | null): string {
  const base =
    'the portal says the team holds this work and our record did not — recovered rather ' +
    'than claimed, because it was found rather than won';

  const gaps: string[] = [];

  // FR-016d's warning, in the one card this discovery raises rather than in a second one:
  // the ceiling breach is a fact about this offer at this moment, and a separate alert
  // would page the same person twice about the same discovery.
  if (hold !== null && hold.deadlineDay !== null && hold.ceilingExceeded) {
    gaps.push(
      `counting it has taken ${hold.deadlineDay} past its ceiling ` +
        `(${hold.committedEffort} of ${hold.ceiling} words). The team already owes the work, ` +
        'so it is counted rather than refused; further claims for that day are blocked as normal',
    );
  }
  if (!isObservedStatus(item.status)) {
    gaps.push(
      `its status ${JSON.stringify(item.status)} is one this bot has never seen, so it is ` +
        'held rather than assumed finished',
    );
  }
  if (item.effortWords === null) {
    gaps.push(
      'its word count could not be read, so it is held at zero words and that deadline day ' +
        'now under-states its load by an unknown amount',
    );
  }
  if (item.deadlineMs === null) {
    gaps.push(
      'its deadline could not be read, so it is held against no day at all and counts ' +
        "toward no day's ceiling",
    );
  }
  if (item.languageDirection === null) {
    gaps.push(
      'its language direction could not be read, and nothing here holds one to fall back ' +
        'on, so no tracking row was written for it rather than a fabricated direction or a ' +
        'row the sheet would refuse (FR-011a). The recovery itself is recorded and counted',
    );
  }
  return gaps.length === 0 ? base : `${base}. This one needs a human: ${gaps.join('; ')}`;
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
