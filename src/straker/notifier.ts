/**
 * Straker's two Google Chat destinations (T054, T055 — contract §2 and §3).
 *
 * ## The asymmetry below is deliberate. Do not "make it consistent".
 *
 * Job news is separated per portal; operational alerts are unified. Straker's wins and
 * recoveries go to Straker's **own** announcement channel (FR-015), while every Straker
 * alert goes to the **single existing operations channel** the live XTM bot already uses
 * (FR-026b) and names its portal instead of getting a channel of its own.
 *
 * That is not an oversight and it is not a migration half-finished. The two surfaces have
 * different readers:
 *
 * - **Job news** is chosen. People follow the streams of work they care about, and a
 *   translator watching only XTM should not have Straker's offers in their feed. Splitting
 *   by portal is what makes that choice possible.
 * - **Alerts** are watched. On-call watches one place for failures, and an alert delivered
 *   somewhere nobody looks is the same as no alert. A second alert channel does not double
 *   the coverage; it halves the odds that any given failure is seen.
 *
 * The spec puts it as a prohibition — FR-015: "this asymmetry is deliberate and MUST NOT be
 * 'made consistent' in either direction". Unifying the announcements would bury one
 * portal's work in the other's; splitting the alerts would create a channel nobody has a
 * reason to open. If a future change proposes either, it needs to answer this paragraph
 * first.
 *
 * ## What this file does not do
 *
 * - **It does not retry.** A sender makes exactly one attempt and reports the result; the
 *   outbox owns the backoff and the give-up rule, shared with the XTM bot in
 *   `shared/outboxRetry.ts`. A retry here would be a second schedule nobody configured.
 * - **It does not de-duplicate identity-carrying alerts.** `StrakerOutbox.enqueue` is
 *   already idempotent on event id together with channel, and `pollCycle.ts` keys its
 *   alerts `claim:${objId}:${outcome}` — identity plus outcome, which is exactly FR-019a.
 *   A suppressor here would be a second opinion about what counts as the same alert, and
 *   two mechanisms disagreeing is worse than one. `tests/unit/straker/alerts.test.ts`
 *   proves the queue already satisfies it.
 *   The one exception is `createTransportAlertHooks`, and it is an exception precisely
 *   because those alerts carry **no** identity for FR-019a's key to work on — see there.
 * - **It does not build its own cards, dates or HTTP.** `reporting/chatCard.ts`,
 *   `reporting/cardText.ts`, `reporting/dateFormat.ts` and `reporting/googleChat.ts` are
 *   the live XTM bot's and are imported unchanged, so both bots' output reads alike
 *   (DC-2/DC-3) and no second `+7h` exists anywhere — `schedule/bangkokCalendar.ts` stays
 *   the only one, by way of `formatReadableDate`.
 */

import type { Logger } from '../monitoring/logger.js';
import { buildCard } from '../reporting/chatCard.js';
import { sanitizeCardId, wordsValue } from '../reporting/cardText.js';
import { formatReadableDate } from '../reporting/dateFormat.js';
import type { ChatPayload, ChatSender } from '../reporting/googleChat.js';
import type { SendOutcome, StrakerSender } from './dispatcher.js';
import type { StrakerTransportAlert, StrakerTransportWarning } from './httpClient.js';
import type { ClaimOutcome, SkipReason } from './outcomePolicy.js';

/** Named once, used in every heading. FR-015 and FR-026b are both "the card says which
 *  portal", and a constant is what lets one test assert it across every card at once. */
export const STRAKER_PORTAL_NAME = 'Straker';

/** The Google Chat transport, narrowed to the one method a sender needs. Production hands
 *  over a `GoogleChatSender` built on the webhook URL; tests hand over a stub, so no test
 *  ever holds a webhook — they are secrets, and they are in the pino redaction list. */
export type ChatPost = Pick<ChatSender, 'send'>;

// =========================================================================================
// §2 — Straker's own announcement channel
// =========================================================================================

/**
 * What the `offers` channel carries.
 *
 * `outcome` is narrowed to the two events that are announced. A loss and a skip are
 * recorded in the tracking file and counted in the win rate; at a few offers a day a
 * message for each would be noise, and a lost race is not news (contract §2, SC-007).
 * Narrowing it here means a loss reaching this channel is refused rather than posted.
 */
export interface StrakerOfferAnnouncement {
  readonly objId: string;
  readonly outcome: 'won' | 'recovered';
  /** FR-011a: with all 44 directions eligible, the claimed mix must be visible at once. */
  readonly languageDirection: string | null;
  readonly effortWords: number | null;
  readonly deadlineMs: number | null;
  /** When the claim landed, or when reconciliation found the work. */
  readonly occurredAtMs: number;
  readonly detail: string | null;
}

/** The two outcomes §2 announces, as a value so the refusal has one source. */
const ANNOUNCED_OUTCOMES: ReadonlySet<string> = new Set<StrakerOfferAnnouncement['outcome']>([
  'won',
  'recovered',
]);

export function renderOfferAnnouncement(announcement: StrakerOfferAnnouncement): ChatPayload {
  const won = announcement.outcome === 'won';
  return buildCard({
    cardId: sanitizeCardId(`straker-${announcement.outcome}-${announcement.objId}`),
    // FR-015 lives in this line: the portal is in the heading, where someone scanning a
    // feed sees it, not buried in a row they would have to open the card to read.
    headerTitle: won
      ? `✅ Offer Won · ${STRAKER_PORTAL_NAME}`
      : `🔄 Work Recovered · ${STRAKER_PORTAL_NAME}`,
    // Marked as recovered in words as well as in the title: the team is holding work
    // nobody announced, and reading it as an ordinary win hides the upstream gap.
    ...(won ? {} : { headerSubtitle: 'Found by reconciliation — this work was never announced' }),
    rows: [
      { label: 'Offer', value: announcement.objId },
      { label: 'Language', value: announcement.languageDirection },
      { label: 'Words', value: wordsValue(announcement.effortWords) },
      { label: 'Deadline', value: bangkok(announcement.deadlineMs) },
      { label: won ? 'Claimed' : 'Found', value: bangkok(announcement.occurredAtMs) },
      ...(announcement.detail ? [{ label: 'Detail', value: announcement.detail }] : []),
    ],
  });
}

/**
 * The `offers` sender (contract §2). One message per offer, never a batch.
 *
 * Refuses, rather than posts, anything that is not a win or a recovery — including a loss
 * queued here by mistake. Refusing costs a queued row its retries and then a visible
 * `dead` status; posting would put a per-loss message in front of the whole team, which is
 * the thing §2 exists to prevent.
 */
export function createStrakerOffersSender(chat: ChatPost): StrakerSender {
  return async (payload: unknown): Promise<SendOutcome> => {
    const parsed = parseAnnouncement(payload);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return post(chat, renderOfferAnnouncement(parsed.value));
  };
}

// =========================================================================================
// §3 — the single existing operations channel
// =========================================================================================

/** Conditions that happen *to an offer*, and so carry an identity FR-019a can key on. */
export const OFFER_ALERT_CONDITIONS = [
  'claim_failed',
  'claim_outcome_unknown',
  'work_recovered',
  'offer_effort_unknown',
  'offer_deadline_unknown',
] as const;
export type OfferAlertCondition = (typeof OFFER_ALERT_CONDITIONS)[number];

/** Conditions raised by the transport, which knows nothing about offers. */
export const TRANSPORT_ALERT_CONDITIONS = ['read_retries_exhausted', 'rate_limit_unknown'] as const;
export type TransportAlertCondition = (typeof TRANSPORT_ALERT_CONDITIONS)[number];

/**
 * Conditions raised by a **subsystem** about itself — no offer identity, and not the
 * transport either.
 *
 * `reconcile_failing` is the first. It was tempting to file it under the transport, whose
 * notice shape it happens to fit, but a reconciliation pass counts a failure when the read
 * failed **or** when the read succeeded and a recovery could not be persisted — so calling
 * it a transport condition would be wrong about half the cases it fires on. It also needs a
 * different subject line: what is failing is a pass, not a request.
 */
export const SYSTEM_ALERT_CONDITIONS = [
  'reconcile_failing',
  'db_quarantined',
  'sign_in_refused',
] as const;
export type SystemAlertCondition = (typeof SYSTEM_ALERT_CONDITIONS)[number];

export type StrakerAlertCondition =
  | OfferAlertCondition
  | TransportAlertCondition
  | SystemAlertCondition;

/**
 * Contract §3 lists more conditions than these, and the missing ones are deliberate
 * absences rather than omissions: sign-in failure, a portal shape departing from the
 * contract, a blocked account, the ceiling being reached, an uncurated holiday year and a
 * reconciliation that has failed three times all belong to modules that are not built yet
 * (T053 reconciliation, and the wiring of T056a). Each arrives by adding one condition
 * here and one entry to `ALERT_SPECS` — which is the point of the table. Declaring them in
 * advance would be a card no producer can raise, and the constitution's "no dead code"
 * applies to alerts as much as to anything else.
 */
export interface StrakerOfferAlert {
  readonly kind: 'offer';
  readonly condition: OfferAlertCondition;
  readonly objId: string;
  /** What actually happened, in the words of whatever raised it. */
  readonly detail: string;
  readonly occurredAtMs: number;
  readonly languageDirection?: string;
  readonly effortWords?: number;
  readonly deadlineMs?: number;
}

/**
 * A transport condition, plus what the throttle collapsed into it.
 *
 * `suppressed` is not decoration. Without it, sixty failed reads and one failed read look
 * identical on the channel, and an operator cannot tell a blip from an outage.
 */
export interface StrakerTransportAlertNotice {
  readonly kind: 'transport';
  readonly condition: TransportAlertCondition;
  /** The request that failed. Two broken endpoints must not hide behind one alert. */
  readonly path: string;
  readonly detail: string;
  readonly occurredAtMs: number;
  /** Identical occurrences this alert stands for, since the previous one was raised. */
  readonly suppressed: number;
  readonly windowMs: number;
}

/**
 * A subsystem reporting on itself (FR-016c). Carries a **count and a span** rather than a
 * suppression figure: the threshold is the news — "this has now failed three times running
 * since 09:12" — where a transport notice reports one event standing for several.
 */
export interface StrakerSystemAlert {
  readonly kind: 'system';
  readonly condition: SystemAlertCondition;
  /** What is failing, in our words. Not a request path: a pass can fail without a request. */
  readonly subsystem: string;
  readonly detail: string;
  readonly occurredAtMs: number;
  readonly consecutiveFailures: number;
  /** When the current run of failures began, so a long outage reads as one event. */
  readonly failingSinceMs: number;
}

export type StrakerAlert = StrakerOfferAlert | StrakerTransportAlertNotice | StrakerSystemAlert;

/**
 * Which claim outcomes alert, and as what.
 *
 * `null` is an answer, not a gap: `won` is news and belongs on the announcement channel,
 * and `lost` is the commonest non-win outcome and must **never** page anyone (FR-006,
 * SC-007). The table is total over `ClaimOutcome`, so a sixth outcome added to
 * `outcomePolicy.ts` fails the typecheck here instead of silently never alerting — and a
 * test asserts this agrees with `alertsOn()` for every outcome, so the two cannot become
 * two opinions.
 */
export const CLAIM_ALERT_CONDITION: Readonly<Record<ClaimOutcome, OfferAlertCondition | null>> = {
  won: null,
  lost: null,
  failed: 'claim_failed',
  unknown: 'claim_outcome_unknown',
  recovered: 'work_recovered',
};

/**
 * Which skip reasons alert, and as what. Total over `SkipReason` for the same reason, and
 * asserted against `alertsOnSkip()` for the same reason again.
 *
 * Only the two that mean a **contract assumption failed** alert (FR-023a, V26). The rest
 * are our own rules working as intended and are recorded, not announced.
 */
export const SKIP_ALERT_CONDITION: Readonly<Record<SkipReason, OfferAlertCondition | null>> = {
  ineligible_language: null,
  outside_schedule: null,
  deadline_on_non_working_day: null,
  deadline_unreachable: null,
  ceiling_reached: null,
  exceeds_daily_ceiling_entirely: null,
  holiday_calendar_uncurated: null,
  effort_unknown: 'offer_effort_unknown',
  deadline_unknown: 'offer_deadline_unknown',
  claiming_halted: null,
};

interface AlertSpec {
  readonly severity: 'warn' | 'critical';
  /** Without the portal — `renderStrakerAlert` appends it to every one. */
  readonly title: string;
  readonly impact: string;
  readonly action: string;
}

/**
 * Impact / action / detail, in the XTM alert card's own shape and order (`systemAlerts.ts`)
 * so an operator reading one channel is not reading two formats. What differs is the
 * portal in the heading, which is the whole of FR-026b.
 */
const ALERT_SPECS: Readonly<Record<StrakerAlertCondition, AlertSpec>> = {
  claim_failed: {
    severity: 'critical',
    title: 'Claim Failed',
    impact: 'The offer was not claimed, and the portal did not say it was a lost race',
    action:
      'Open Straker and check whether the offer is ours; if its rejection code is a normal lost race, add it to CONFIRMED_LOST_RACE_SIGNALS in src/straker/claimOutcome.ts',
  },
  claim_outcome_unknown: {
    severity: 'critical',
    title: 'Claim Outcome Unknown',
    impact: 'The portal may or may not hold us to this work, and the claim is never retried',
    action:
      'Wait for reconciliation, which settles it against the portal; if it is still unresolved after a cycle, check the assigned list by hand',
  },
  work_recovered: {
    severity: 'warn',
    title: 'Unrecorded Work Found',
    impact: 'The team was holding work that reached no record until reconciliation found it',
    action:
      'Check why the claim went unrecorded — one is recoverable, a recurring gap means something upstream is wrong',
  },
  offer_effort_unknown: {
    severity: 'critical',
    title: 'Offer Arrived Without Its Effort Count',
    impact:
      'The scheduling rules could not decide, so the offer was skipped — and the assumption every later decision rests on has failed',
    action:
      'Compare the offer payload against the recorded capture evidence and update src/straker/offerParse.ts if the field moved',
  },
  offer_deadline_unknown: {
    severity: 'critical',
    title: 'Offer Arrived Without Its Deadline',
    impact:
      'The scheduling rules could not decide, so the offer was skipped — and the assumption every later decision rests on has failed',
    action:
      'Compare the offer payload against the recorded capture evidence and update src/straker/offerParse.ts if the field moved',
  },
  read_retries_exhausted: {
    severity: 'critical',
    title: 'Offer List Unreadable',
    impact: 'Offers appearing now are being missed — the read failed rather than returning none',
    action:
      'Check Straker is reachable; the loop keeps polling and recovers by itself once the portal answers',
  },
  rate_limit_unknown: {
    severity: 'warn',
    title: 'Request Budget Unreadable',
    impact:
      'The portal stopped reporting its budget; only the hard per-minute ceiling restrains polling',
    action:
      'No action while the ceiling holds; if it persists, confirm the portal has not changed its rate-limit headers',
  },
  db_quarantined: {
    severity: 'critical',
    title: 'State File Quarantined',
    impact:
      'The record of work the team already holds went with the old file, so the daily ceiling now reads as ZERO committed capacity and every offer will fit — the bot will over-claim until reconciliation restores the held set',
    action:
      'Stop the bot if the ceiling matters today. Keep the quarantined copy: it is the only record of what was held. Reconciliation rebuilds the held set from the portal within fifteen minutes of the next start',
  },
  sign_in_refused: {
    severity: 'critical',
    title: 'Sign-In Refused',
    impact:
      'The bot cannot reach the portal at all — no offers are being read and none can be claimed. It has stopped re-attempting so that a refused credential is not offered repeatedly to an account whose lockout policy is unknown',
    action:
      'Check STRAKER_LOGIN_ID and STRAKER_PASSWORD in .env against the portal. If the password was rotated (RP-1), delete state/storageState.json too. The bot retries on its own backoff and recovers without a restart once the credentials work',
  },
  reconcile_failing: {
    severity: 'critical',
    title: 'Reconciliation Failing',
    impact:
      'Work the portal has committed to the team may be going unrecorded — and a reconciliation that has silently stopped looks exactly like one finding nothing',
    action:
      'Check Straker is reachable and that the Straker state file is writable; claimed work is safe on the portal, but the ledger and the record will drift until this recovers',
  },
};

export function renderStrakerAlert(alert: StrakerAlert): ChatPayload {
  const spec = ALERT_SPECS[alert.condition];
  const subject = subjectOf(alert);
  return buildCard({
    cardId: sanitizeCardId(`straker-alert-${alert.condition}-${subject}`),
    // FR-026b lives in this line. Both bots' alerts arrive in one channel on purpose, so
    // the portal has to be the first thing read.
    headerTitle: `${spec.severity === 'critical' ? '🔴' : '⚠️'} ${spec.title} · ${STRAKER_PORTAL_NAME}`,
    rows: [
      ...contextRowsOf(alert),
      { label: 'Impact', value: spec.impact },
      { label: 'Action', value: spec.action },
      { label: 'Detail', value: alert.detail },
      { label: 'Time', value: bangkok(alert.occurredAtMs) },
    ],
  });
}

/** What the card is about, and what identifies it for deduplication at the Chat end. */
function subjectOf(alert: StrakerAlert): string {
  switch (alert.kind) {
    case 'offer':
      return alert.objId;
    case 'transport':
      return alert.path;
    case 'system':
      return alert.subsystem;
  }
}

function contextRowsOf(alert: StrakerAlert): { label: string; value: string | null }[] {
  switch (alert.kind) {
    case 'offer':
      return offerContextRows(alert);
    case 'transport':
      return transportContextRows(alert);
    case 'system':
      return systemContextRows(alert);
  }
}

function systemContextRows(alert: StrakerSystemAlert): { label: string; value: string | null }[] {
  return [
    { label: 'Subsystem', value: alert.subsystem },
    {
      label: 'Failures',
      value: `${alert.consecutiveFailures} consecutive, since ${bangkok(alert.failingSinceMs)}`,
    },
  ];
}

function offerContextRows(alert: StrakerOfferAlert): { label: string; value: string | null }[] {
  return [
    { label: 'Offer', value: alert.objId },
    { label: 'Language', value: alert.languageDirection ?? null },
    { label: 'Words', value: wordsValue(alert.effortWords) },
    { label: 'Deadline', value: bangkok(alert.deadlineMs ?? null) },
  ];
}

function transportContextRows(
  alert: StrakerTransportAlertNotice,
): { label: string; value: string | null }[] {
  return [
    { label: 'Request', value: alert.path },
    // Omitted when the alert stands only for itself: a "0 more" row would read as noise
    // on the common case and dull the row that matters.
    ...(alert.suppressed > 0
      ? [
          {
            label: 'Occurrences',
            value: `${alert.suppressed} more suppressed in the last ${Math.round(alert.windowMs / 60_000)} min`,
          },
        ]
      : []),
  ];
}

/**
 * The `alerts` sender (contract §3) — the single existing operations channel,
 * `GOOGLE_CHAT_WEBHOOK_SYSTEM`, shared with the live XTM bot on purpose. See the module
 * docstring before changing that.
 */
export function createStrakerAlertsSender(chat: ChatPost): StrakerSender {
  return async (payload: unknown): Promise<SendOutcome> => {
    const parsed = parseAlert(payload);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    return post(chat, renderStrakerAlert(parsed.value));
  };
}

// =========================================================================================
// Transport alerts — the one place a throttle belongs
// =========================================================================================

/**
 * How long one raised transport alert stands for.
 *
 * Ten minutes, chosen against the failure it exists to stop: at the ten-second poll rhythm
 * a ten-minute outage raises around sixty `read_retries_exhausted` alerts, and sixty
 * identical pages are not six times more informative than one — they are less, because the
 * channel they arrive in also carries the XTM bot's alerts and they bury it.
 *
 * It is also already the operator's clock: Healthchecks is configured at a 60s period with
 * a 300s grace, so a bot that has stopped pages inside five minutes through a path that
 * does not involve this channel at all. The alert channel does not need to be the thing
 * that repeats.
 */
export const TRANSPORT_ALERT_WINDOW_MS = 10 * 60_000;

export interface TransportAlertHooksDeps {
  /**
   * Where a raised alert goes. The composition root hooks this to
   * `outbox.enqueue(eventId, 'alerts', JSON.stringify(alert), alert.occurredAtMs)` — the
   * alert is durable before anyone tries to send it, like every other outcome (FR-016).
   */
  readonly raise: (eventId: string, alert: StrakerTransportAlertNotice) => void;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly windowMs?: number;
}

/** Shaped to drop straight into `HttpClientOptions` — `{ baseUrl, ...hooks }`. */
export interface TransportAlertHooks {
  readonly onAlert: (alert: StrakerTransportAlert) => void;
  readonly onWarning: (warning: StrakerTransportWarning) => void;
}

/**
 * Totality checks against the transport's own unions: adding a `kind` to
 * `StrakerTransportAlert` or `StrakerTransportWarning` fails the typecheck here rather
 * than quietly arriving under the wrong condition name.
 */
const CONDITION_OF_ALERT: Readonly<Record<StrakerTransportAlert['kind'], TransportAlertCondition>> =
  { read_retries_exhausted: 'read_retries_exhausted' };
const CONDITION_OF_WARNING: Readonly<
  Record<StrakerTransportWarning['kind'], TransportAlertCondition>
> = { rate_limit_unknown: 'rate_limit_unknown' };

/**
 * The transport's alert hooks, throttled.
 *
 * ## Why a throttle here, when FR-019a's dedup is the outbox's job
 *
 * FR-019a keys on **offer identity together with outcome**, and `StrakerOutbox.enqueue`
 * already enforces exactly that key for everything `pollCycle.ts` raises. Transport alerts
 * are the one thing that key cannot reach: `read_retries_exhausted` and
 * `rate_limit_unknown` are facts about a request, not about an offer, so there is no
 * identity to de-duplicate on and the transport does not throttle them itself. This is
 * therefore not a second dedup layer competing with the first — it is the only mechanism
 * covering alerts the first cannot see.
 *
 * ## The rule, and why this one
 *
 * **First occurrence immediately; then at most one per window, carrying the count of what
 * it stands for.**
 *
 * - *Immediately*, because a real fault must not wait out a window before anyone hears it.
 *   The race is decided in seconds and a read that has stopped working is worth knowing at
 *   once.
 * - *Then at most one per window*, because the repeats add nothing: they are the same
 *   condition on the same path, and their only content is "still happening".
 * - *Still speaking while it persists*, because the alternative — raise once, then stay
 *   silent until the condition clears — needs a "cleared" signal the transport never
 *   sends. A condition that goes quiet while it is still happening is indistinguishable
 *   from one that fixed itself, and contract §3 names that exact failure elsewhere: "one
 *   that has silently stopped looks exactly like one finding nothing".
 * - *Carrying the count*, because without it a ten-minute outage and a single blip render
 *   as the same card.
 *
 * Keyed per condition **and per request path**: one broken endpoint must not hide another,
 * and a budget warning is a different fault from a failed read even on the same path.
 *
 * The window state is in memory, which a restart clears — correctly, since a restart is
 * itself worth an alert. What a restart *loop* must not do is page on every start, so the
 * event id buckets on the window: two starts inside one window produce the same id and the
 * outbox refuses the duplicate. The durable queue backs up the in-memory throttle rather
 * than duplicating it.
 */
export function createTransportAlertHooks(deps: TransportAlertHooksDeps): TransportAlertHooks {
  const now = deps.now ?? Date.now;
  const windowMs = deps.windowMs ?? TRANSPORT_ALERT_WINDOW_MS;
  const windows = new Map<string, { openedAtMs: number; suppressed: number }>();

  function consider(
    key: string,
    condition: TransportAlertCondition,
    path: string,
    detail: string,
  ): void {
    const atMs = now();
    const open = windows.get(key);
    if (open !== undefined && atMs - open.openedAtMs < windowMs) {
      open.suppressed++;
      // Throttling decides what pages a human, never what is knowable afterwards: every
      // suppressed occurrence still reaches the log, so "what did it do at 03:00" stays
      // answerable (Constitution V).
      deps.logger.info(
        {
          module: 'notifier',
          action: 'transport_alert',
          outcome: 'suppressed',
          condition,
          path,
          suppressed: open.suppressed,
          windowMs,
        },
        'transport alert repeated inside its window — collapsed into the next one',
      );
      return;
    }

    const notice: StrakerTransportAlertNotice = {
      kind: 'transport',
      condition,
      path,
      detail,
      occurredAtMs: atMs,
      suppressed: open?.suppressed ?? 0,
      windowMs,
    };
    windows.set(key, { openedAtMs: atMs, suppressed: 0 });
    try {
      deps.raise(`transport:${key}:${Math.floor(atMs / windowMs)}`, notice);
    } catch (err) {
      // The transport swallows whatever escapes these hooks — deliberately, since a
      // broken sink must not turn a good read into a failed one. That makes silence here
      // the one real risk: an alert lost with nothing recording that it was.
      deps.logger.error(
        { module: 'notifier', action: 'transport_alert', outcome: 'lost', condition, path },
        `a transport alert could not be queued and will not be delivered: ${errorText(err)}`,
      );
    }
  }

  return {
    onAlert: (alert) =>
      consider(
        `${alert.kind}:${alert.path}`,
        CONDITION_OF_ALERT[alert.kind],
        alert.path,
        `${alert.reason} — ${alert.attempts} attempts over ${alert.waitedMs}ms`,
      ),
    onWarning: (warning) =>
      consider(
        `${warning.kind}:${warning.reason}:${warning.path}`,
        CONDITION_OF_WARNING[warning.kind],
        warning.path,
        warning.detail,
      ),
  };
}

// =========================================================================================
// Posting, and reading a queued payload back
// =========================================================================================

/**
 * One attempt, and the answer as the dispatcher's own result type.
 *
 * Both non-`ok` classifications come back as `{ ok: false }` because that is the whole of
 * what a `StrakerSender` can say; the classification is put in the reason so the
 * dispatcher's log distinguishes a webhook in trouble from a card the endpoint refused.
 */
async function post(chat: ChatPost, card: ChatPayload): Promise<SendOutcome> {
  let outcome;
  try {
    outcome = await chat.send(card);
  } catch (err) {
    // A sender reports; it does not throw. The dispatcher would catch this anyway, and
    // would then have to guess whether the row or the dispatcher was at fault.
    return { ok: false, reason: `Google Chat could not be reached: ${errorText(err)}` };
  }
  if (outcome === 'ok') return { ok: true };
  return { ok: false, reason: `Google Chat refused the card (${outcome})` };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A number of milliseconds as Bangkok `DD/MM/YYYY HH:mm`, through the XTM bot's own
 *  formatter. Going via ISO rather than doing arithmetic is what keeps
 *  `schedule/bangkokCalendar.ts` the only `+7h` in the repository. */
function bangkok(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return formatReadableDate(new Date(ms).toISOString()) || null;
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

function fields(payload: unknown): Readonly<Record<string, unknown>> | null {
  // Arrays are refused here, which is also where "one message per job, no batching" is
  // enforced: a list of announcements has no card to render into.
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  return payload as Readonly<Record<string, unknown>>;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Read a queued row back into an announcement.
 *
 * Anything that fails here is reported rather than posted: a queued row with the wrong
 * shape means something upstream changed, and a half-rendered card in the team channel
 * would hide that behind a message that looks almost right.
 */
function parseAnnouncement(payload: unknown): Parsed<StrakerOfferAnnouncement> {
  const raw = fields(payload);
  if (raw === null) return { ok: false, reason: 'not an announcement payload' };

  const objId = text(raw['objId']);
  if (objId === null) return { ok: false, reason: 'announcement has no offer identity' };

  const outcome = text(raw['outcome']);
  if (outcome === null) return { ok: false, reason: `announcement for ${objId} has no outcome` };
  if (!ANNOUNCED_OUTCOMES.has(outcome)) {
    // The load-bearing refusal (contract §2, SC-007). A loss is recorded and counted, not
    // announced; reaching this channel it is a defect, and posting it would put a per-loss
    // message in front of the team at the volume the contract rules out.
    return {
      ok: false,
      reason: `'${outcome}' is not announced on the offers channel — only a win or a recovery is`,
    };
  }

  const occurredAtMs = count(raw['occurredAtMs']);
  if (occurredAtMs === null) {
    return { ok: false, reason: `announcement for ${objId} has no timestamp` };
  }

  return {
    ok: true,
    value: {
      objId,
      outcome: outcome as StrakerOfferAnnouncement['outcome'],
      languageDirection: text(raw['languageDirection']),
      effortWords: count(raw['effortWords']),
      deadlineMs: count(raw['deadlineMs']),
      occurredAtMs,
      detail: text(raw['detail']),
    },
  };
}

function parseAlert(payload: unknown): Parsed<StrakerAlert> {
  const raw = fields(payload);
  if (raw === null) return { ok: false, reason: 'not an alert payload' };

  const condition = text(raw['condition']);
  if (condition === null) return { ok: false, reason: 'alert has no condition' };
  if (!(condition in ALERT_SPECS)) {
    // A card with no impact and no action is worse than a refused row: it pages someone
    // and then tells them nothing.
    return { ok: false, reason: `no alert card is defined for condition '${condition}'` };
  }

  const detail = text(raw['detail']);
  if (detail === null) return { ok: false, reason: `alert '${condition}' has no detail` };
  const occurredAtMs = count(raw['occurredAtMs']);
  if (occurredAtMs === null) return { ok: false, reason: `alert '${condition}' has no timestamp` };

  if (raw['kind'] === 'transport') {
    if (!(TRANSPORT_ALERT_CONDITIONS as readonly string[]).includes(condition)) {
      return { ok: false, reason: `'${condition}' is not a transport condition` };
    }
    const path = text(raw['path']);
    if (path === null) return { ok: false, reason: `transport alert '${condition}' has no path` };
    return {
      ok: true,
      value: {
        kind: 'transport',
        condition: condition as TransportAlertCondition,
        path,
        detail,
        occurredAtMs,
        suppressed: Math.max(0, count(raw['suppressed']) ?? 0),
        windowMs: count(raw['windowMs']) ?? TRANSPORT_ALERT_WINDOW_MS,
      },
    };
  }

  if (raw['kind'] === 'system') {
    if (!(SYSTEM_ALERT_CONDITIONS as readonly string[]).includes(condition)) {
      return { ok: false, reason: `'${condition}' is not a system condition` };
    }
    const subsystem = text(raw['subsystem']);
    if (subsystem === null) {
      return { ok: false, reason: `system alert '${condition}' does not say what is failing` };
    }
    const consecutiveFailures = count(raw['consecutiveFailures']);
    const failingSinceMs = count(raw['failingSinceMs']);
    if (consecutiveFailures === null || failingSinceMs === null) {
      // The count and the span ARE the news — "it failed" without "three times, since
      // 09:12" is a card that cannot be acted on and cannot be told from a blip.
      return { ok: false, reason: `system alert '${condition}' has no failure count or span` };
    }
    return {
      ok: true,
      value: {
        kind: 'system',
        condition: condition as SystemAlertCondition,
        subsystem,
        detail,
        occurredAtMs,
        consecutiveFailures,
        failingSinceMs,
      },
    };
  }

  if (raw['kind'] !== 'offer') return { ok: false, reason: `alert has no kind` };
  if (!(OFFER_ALERT_CONDITIONS as readonly string[]).includes(condition)) {
    return { ok: false, reason: `'${condition}' is not an offer condition` };
  }
  const objId = text(raw['objId']);
  if (objId === null) return { ok: false, reason: `alert '${condition}' has no offer identity` };

  const languageDirection = text(raw['languageDirection']);
  const effortWords = count(raw['effortWords']);
  const deadlineMs = count(raw['deadlineMs']);
  return {
    ok: true,
    value: {
      kind: 'offer',
      condition: condition as OfferAlertCondition,
      objId,
      detail,
      occurredAtMs,
      // Context, not identity: absent rather than null, so the card omits the row instead
      // of showing an empty one (`exactOptionalPropertyTypes` makes that distinction real).
      ...(languageDirection === null ? {} : { languageDirection }),
      ...(effortWords === null ? {} : { effortWords }),
      ...(deadlineMs === null ? {} : { deadlineMs }),
    },
  };
}
