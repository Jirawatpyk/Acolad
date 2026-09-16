/**
 * T054/T055 — the two senders that plug into the Straker dispatcher.
 *
 * The reporting contract (§2, §3) is the authority these assert against, and the two
 * requirements it makes concrete are the ones a reviewer can apply rather than judge:
 *
 * - **FR-015** — every announcement names the portal in its heading.
 * - **FR-026b** — every alert names the portal it came from.
 *
 * Both are tested by looping over *every* card this module can produce, not over one
 * sample of each, because "the portal name dropped out of one heading" is exactly the
 * regression a single happy-path assertion misses.
 *
 * The third, and the one with the most force behind it: **a loss is never announced**
 * (contract §2, SC-007). At a few offers a day a per-loss message is noise, and a lost
 * race is not news. The sender refuses it even if something upstream queues one.
 *
 * No network: the Google Chat transport is injected. Webhook URLs are secrets in the pino
 * redaction list and must never reach a test fixture or a snapshot — nothing in this file
 * holds one, because nothing in this file knows one.
 */

import { describe, expect, it } from 'vitest';
import { formatReadableDate } from '../../../src/reporting/dateFormat.js';
import type {
  ChatPayload,
  SendOutcome as ChatSendOutcome,
} from '../../../src/reporting/googleChat.js';
import {
  CLAIM_OUTCOMES,
  SKIP_REASONS,
  alertsOn,
  alertsOnSkip,
} from '../../../src/straker/outcomePolicy.js';
import {
  CLAIM_ALERT_CONDITION,
  OFFER_ALERT_CONDITIONS,
  SYSTEM_ALERT_CONDITIONS,
  SKIP_ALERT_CONDITION,
  STRAKER_PORTAL_NAME,
  TRANSPORT_ALERT_CONDITIONS,
  createStrakerAlertsSender,
  createStrakerOffersSender,
  type OfferAlertCondition,
  type SystemAlertCondition,
  type StrakerAlert,
  type StrakerAlertCondition,
  type StrakerOfferAnnouncement,
  type TransportAlertCondition,
} from '../../../src/straker/notifier.js';

// --- the injected transport ------------------------------------------------------------

interface ChatStub {
  readonly posted: ChatPayload[];
  send(payload: ChatPayload): Promise<ChatSendOutcome>;
}

function chatStub(outcome: ChatSendOutcome = 'ok'): ChatStub {
  const posted: ChatPayload[] = [];
  return {
    posted,
    send: (payload) => {
      posted.push(payload);
      return Promise.resolve(outcome);
    },
  };
}

/** A transport that rejects rather than answering — a sender must report, never throw. */
function throwingChat(): ChatStub {
  const posted: ChatPayload[] = [];
  return {
    posted,
    send: () => Promise.reject(new Error('socket hang up')),
  };
}

// --- reading a cardsV2 payload back ------------------------------------------------------

interface CardShape {
  cardsV2: {
    cardId: string;
    card: {
      header: { title: string; subtitle?: string };
      sections: { widgets: { decoratedText?: { topLabel?: string; text: string } }[] }[];
    };
  }[];
}

interface RenderedCard {
  readonly cardId: string;
  readonly title: string;
  readonly subtitle: string | undefined;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}

function readCard(payload: ChatPayload | undefined): RenderedCard {
  if (payload === undefined) throw new Error('nothing was posted');
  const entry = (payload as unknown as CardShape).cardsV2[0];
  if (entry === undefined) throw new Error('the payload carried no card');
  const rows = entry.card.sections
    .flatMap((section) => section.widgets)
    .map((widget) => widget.decoratedText)
    .filter((text): text is { topLabel?: string; text: string } => text !== undefined)
    .map((text) => ({ label: text.topLabel ?? '', value: text.text }));
  return {
    cardId: entry.cardId,
    title: entry.card.header.title,
    subtitle: entry.card.header.subtitle,
    rows,
  };
}

function rowValue(card: RenderedCard, label: string): string | undefined {
  return card.rows.find((row) => row.label === label)?.value;
}

/** Everything a card renders, as one string — for "this must never appear anywhere". */
function cardText(card: RenderedCard): string {
  return [card.title, card.subtitle ?? '', ...card.rows.map((r) => `${r.label} ${r.value}`)].join(
    ' | ',
  );
}

// --- fixtures -----------------------------------------------------------------------------

const DEADLINE_MS = Date.parse('2026-09-16T17:00:00+07:00');
const CLAIMED_MS = Date.parse('2026-09-15T09:30:00+07:00');

const WIN: StrakerOfferAnnouncement = {
  objId: 'OFFER-1',
  outcome: 'won',
  languageDirection: 'en-GB > ms-MY',
  effortWords: 1200,
  deadlineMs: DEADLINE_MS,
  occurredAtMs: CLAIMED_MS,
  detail: 'the portal committed the work',
};

function sampleAlert(condition: StrakerAlertCondition): StrakerAlert {
  if ((TRANSPORT_ALERT_CONDITIONS as readonly string[]).includes(condition)) {
    return {
      kind: 'transport',
      condition: condition as TransportAlertCondition,
      path: '/api/offers/open',
      detail: 'four attempts, none answered',
      occurredAtMs: CLAIMED_MS,
      suppressed: 0,
      windowMs: 600_000,
    };
  }
  if ((SYSTEM_ALERT_CONDITIONS as readonly string[]).includes(condition)) {
    // This branch was missing, and the list below omitted the system conditions — so a test
    // named "every alert it can raise" could not construct a system alert at all, and
    // FR-026b went unenforced for the whole kind. Dropping the portal name from just the
    // system heading left the suite green.
    return {
      kind: 'system',
      condition: condition as SystemAlertCondition,
      subsystem: 'reconciliation (assigned-work read and recovery)',
      detail: 'three passes in a row could not be completed',
      occurredAtMs: CLAIMED_MS,
      consecutiveFailures: 3,
      failingSinceMs: CLAIMED_MS - 45 * 60_000,
    };
  }
  return {
    kind: 'offer',
    condition: condition as OfferAlertCondition,
    objId: 'OFFER-1',
    detail: 'the portal rejected the claim with code E_UNKNOWN',
    occurredAtMs: CLAIMED_MS,
    languageDirection: 'en-GB > ms-MY',
    effortWords: 1200,
    deadlineMs: DEADLINE_MS,
  };
}

const ALL_CONDITIONS: readonly StrakerAlertCondition[] = [
  ...OFFER_ALERT_CONDITIONS,
  ...TRANSPORT_ALERT_CONDITIONS,
  ...SYSTEM_ALERT_CONDITIONS,
];

// =========================================================================================
// The offers channel — Straker's own announcement channel (contract §2)
// =========================================================================================

describe('offers sender — Straker own announcement channel (contract §2, FR-015)', () => {
  it('announces a win and names the portal in the card heading (FR-015)', async () => {
    const chat = chatStub();
    const send = createStrakerOffersSender(chat);

    const result = await send(WIN);

    expect(result).toEqual({ ok: true });
    expect(chat.posted).toHaveLength(1);
    const card = readCard(chat.posted[0]);
    // The concrete, reviewable form of FR-015: the portal is in the HEADING, not merely
    // somewhere in the body where a reader scanning a feed of two portals would miss it.
    expect(card.title).toContain(STRAKER_PORTAL_NAME);
    expect(card.title.toLowerCase()).toContain('won');
  });

  it('carries the language direction, effort and deadline the team needs on sight', async () => {
    const chat = chatStub();
    await createStrakerOffersSender(chat)(WIN);

    const card = readCard(chat.posted[0]);
    expect(rowValue(card, 'Offer')).toBe('OFFER-1');
    expect(rowValue(card, 'Language')).toBe('en-GB > ms-MY');
    expect(rowValue(card, 'Words')).toBe('1200');
    expect(rowValue(card, 'Deadline')).toBe('16/09/2026 17:00');
  });

  it('announces recovered work AND marks it as recovered (contract §2)', async () => {
    const chat = chatStub();

    const result = await createStrakerOffersSender(chat)({ ...WIN, outcome: 'recovered' });

    expect(result).toEqual({ ok: true });
    const card = readCard(chat.posted[0]);
    expect(card.title).toContain(STRAKER_PORTAL_NAME);
    // The team is holding work nobody announced — the card has to say so, or it reads as
    // an ordinary win and the upstream gap it points at goes unnoticed.
    expect(cardText(card).toLowerCase()).toContain('recover');
  });

  it('never announces a loss — a lost race is not news (contract §2, SC-007)', async () => {
    const chat = chatStub();

    const result = await createStrakerOffersSender(chat)({ ...WIN, outcome: 'lost' });

    expect(chat.posted).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it('never announces a skip, however it arrives on this channel (contract §2)', async () => {
    const chat = chatStub();

    const skipShaped = { objId: 'OFFER-1', reason: 'ineligible_language', detail: 'not Malay' };
    const result = await createStrakerOffersSender(chat)(skipShaped);

    expect(chat.posted).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it('never announces a failed or unknown claim on the team channel', async () => {
    const chat = chatStub();
    const send = createStrakerOffersSender(chat);

    expect((await send({ ...WIN, outcome: 'failed' })).ok).toBe(false);
    expect((await send({ ...WIN, outcome: 'unknown' })).ok).toBe(false);
    expect(chat.posted).toHaveLength(0);
  });

  it('sends one message per offer and refuses a batch (contract §2, no batching)', async () => {
    const chat = chatStub();

    const result = await createStrakerOffersSender(chat)([WIN, { ...WIN, objId: 'OFFER-2' }]);

    expect(chat.posted).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it('reads the deadline through the shared Bangkok formatter, never a second +7h', async () => {
    const chat = chatStub();
    await createStrakerOffersSender(chat)(WIN);

    const card = readCard(chat.posted[0]);
    // Equality with the live XTM bot's own helper, so the two portals' cards cannot drift
    // apart and a duplicate offset implementation cannot creep in unnoticed (DC-2/DC-3).
    expect(rowValue(card, 'Deadline')).toBe(
      formatReadableDate(new Date(DEADLINE_MS).toISOString()),
    );
    expect(rowValue(card, 'Claimed')).toBe(formatReadableDate(new Date(CLAIMED_MS).toISOString()));
  });

  it('renders an offer whose effort or deadline is missing without inventing one', async () => {
    const chat = chatStub();

    const result = await createStrakerOffersSender(chat)({
      ...WIN,
      effortWords: null,
      deadlineMs: null,
      detail: null,
    });

    expect(result).toEqual({ ok: true });
    const card = readCard(chat.posted[0]);
    expect(rowValue(card, 'Words')).toBe('—');
    expect(rowValue(card, 'Deadline')).toBe('—');
  });

  it('reports a refused post instead of retrying it — the outbox owns the retry', async () => {
    const chat = chatStub('transient');

    const result = await createStrakerOffersSender(chat)(WIN);

    expect(chat.posted).toHaveLength(1); // exactly one attempt, never a second
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('transient');
  });

  it('reports rather than throws when the chat transport rejects', async () => {
    const chat = throwingChat();

    const result = await createStrakerOffersSender(chat)(WIN);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('socket hang up');
  });

  it('refuses an announcement with no timestamp rather than dating the card itself', async () => {
    const chat = chatStub();

    // A card that invents "now" for a claim that landed some time ago reads as fresh news
    // and quietly falsifies the one figure the win rate is measured against.
    const result = await createStrakerOffersSender(chat)({ ...WIN, occurredAtMs: null });

    expect(chat.posted).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it('refuses a payload that is not an announcement at all, rather than posting a blank card', async () => {
    const chat = chatStub();
    const send = createStrakerOffersSender(chat);

    for (const payload of [null, undefined, 'OFFER-1', 42, {}]) {
      expect((await send(payload)).ok).toBe(false);
    }
    expect(chat.posted).toHaveLength(0);
  });
});

// =========================================================================================
// The alerts channel — the single existing operations channel (contract §3)
// =========================================================================================

describe('alerts sender — the single existing operations channel (contract §3, FR-026b)', () => {
  it('names the portal in the heading of EVERY alert it can raise (FR-026b)', async () => {
    for (const condition of ALL_CONDITIONS) {
      const chat = chatStub();

      const result = await createStrakerAlertsSender(chat)(sampleAlert(condition));

      expect(result, condition).toEqual({ ok: true });
      const card = readCard(chat.posted[0]);
      // On-call watches ONE channel carrying both bots. An alert that does not say which
      // portal it came from costs the first minutes of every incident.
      expect(card.title, condition).toContain(STRAKER_PORTAL_NAME);
    }
  });

  it('gives an operator the impact, the action and the detail, as the XTM alert card does', async () => {
    const chat = chatStub();

    await createStrakerAlertsSender(chat)(sampleAlert('claim_failed'));

    const card = readCard(chat.posted[0]);
    expect(rowValue(card, 'Offer')).toBe('OFFER-1');
    expect(rowValue(card, 'Impact')).toBeTruthy();
    expect(rowValue(card, 'Action')).toBeTruthy();
    expect(rowValue(card, 'Detail')).toContain('E_UNKNOWN');
  });

  it('names the request and how many occurrences a transport alert stands for', async () => {
    const chat = chatStub();

    const collapsed: StrakerAlert = {
      kind: 'transport',
      condition: 'read_retries_exhausted',
      path: '/api/offers/open',
      detail: 'four attempts, none answered',
      occurredAtMs: CLAIMED_MS,
      suppressed: 59,
      windowMs: 600_000,
    };
    await createStrakerAlertsSender(chat)(collapsed);

    const card = readCard(chat.posted[0]);
    expect(rowValue(card, 'Request')).toBe('/api/offers/open');
    // Without this the collapsed alerts are invisible and a ten-minute outage reads as
    // a single blip. The count is what the throttle owes the operator.
    expect(rowValue(card, 'Occurrences')).toContain('59');
  });

  it('omits the occurrence row when an alert stands only for itself', async () => {
    const chat = chatStub();

    await createStrakerAlertsSender(chat)(sampleAlert('rate_limit_unknown'));

    expect(rowValue(readCard(chat.posted[0]), 'Occurrences')).toBeUndefined();
  });

  it('refuses a condition it does not know rather than posting a nameless card', async () => {
    const chat = chatStub();

    const result = await createStrakerAlertsSender(chat)({
      kind: 'offer',
      condition: 'something_new',
      objId: 'OFFER-1',
      detail: 'x',
      occurredAtMs: CLAIMED_MS,
    });

    expect(chat.posted).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it('refuses an alert whose kind and condition disagree, in either direction', async () => {
    const chat = chatStub();
    const send = createStrakerAlertsSender(chat);
    const base = { detail: 'x', occurredAtMs: CLAIMED_MS };

    // A transport condition wearing an offer identity, and an offer condition wearing a
    // request path. Both mean whatever raised it is wired to the wrong builder, and a card
    // rendered from the wrong half would show an operator a path or an offer that is not
    // the subject of the fault.
    expect(
      (await send({ ...base, kind: 'transport', condition: 'claim_failed', path: '/x' })).ok,
    ).toBe(false);
    expect(
      (await send({ ...base, kind: 'offer', condition: 'read_retries_exhausted', objId: 'O-1' }))
        .ok,
    ).toBe(false);
    expect(chat.posted).toHaveLength(0);
  });

  it('refuses a payload that is not an alert at all', async () => {
    const chat = chatStub();
    const send = createStrakerAlertsSender(chat);

    for (const payload of [null, undefined, [sampleAlert('claim_failed')], 'boom', {}]) {
      expect((await send(payload)).ok).toBe(false);
    }
    expect(chat.posted).toHaveLength(0);
  });

  it('de-duplicates nothing itself — the outbox is the only dedup, by design (FR-019a)', async () => {
    const chat = chatStub();
    const send = createStrakerAlertsSender(chat);
    const alert = sampleAlert('claim_failed');

    await send(alert);
    await send(alert);

    // Two mechanisms disagreeing about what counts as the same alert is worse than one.
    // `StrakerOutbox.enqueue` is idempotent on event id together with channel and is the
    // single authority; a sender that also suppressed would hide rows the queue accepted.
    // Proven end-to-end in `alerts.test.ts`.
    expect(chat.posted).toHaveLength(2);
  });

  it('reports a refused post instead of retrying it', async () => {
    const chat = chatStub('permanent');

    const result = await createStrakerAlertsSender(chat)(sampleAlert('claim_failed'));

    expect(chat.posted).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it('reports rather than throws when the chat transport rejects', async () => {
    const result = await createStrakerAlertsSender(throwingChat())(sampleAlert('claim_failed'));

    expect(result.ok).toBe(false);
  });
});

// =========================================================================================
// The condition tables must not become a second opinion
// =========================================================================================

describe('alert conditions agree with the outcome policy (one decision, not two)', () => {
  it('maps exactly the claim outcomes that alertsOn() alerts on', () => {
    for (const outcome of CLAIM_OUTCOMES) {
      expect(CLAIM_ALERT_CONDITION[outcome] !== null, outcome).toBe(alertsOn(outcome));
    }
  });

  it('never maps a win or a lost race onto an alert (FR-006, SC-007)', () => {
    expect(CLAIM_ALERT_CONDITION.won).toBeNull();
    // The load-bearing null. A lost race is the commonest non-win outcome and must never
    // page anyone; a condition here would route every one of them to on-call.
    expect(CLAIM_ALERT_CONDITION.lost).toBeNull();
  });

  it('maps exactly the skip reasons that alertsOnSkip() alerts on (FR-023a, V26)', () => {
    for (const reason of SKIP_REASONS) {
      expect(SKIP_ALERT_CONDITION[reason] !== null, reason).toBe(alertsOnSkip(reason));
    }
  });

  it('points every mapped condition at a card the sender can actually render', async () => {
    const mapped = [
      ...CLAIM_OUTCOMES.map((o) => CLAIM_ALERT_CONDITION[o]),
      ...SKIP_REASONS.map((r) => SKIP_ALERT_CONDITION[r]),
    ].filter((c): c is OfferAlertCondition => c !== null);

    for (const condition of mapped) {
      const chat = chatStub();
      // A table entry naming a condition the sender refuses would be a silently
      // undeliverable alert — built, queued, and dead ten retries later.
      expect((await createStrakerAlertsSender(chat)(sampleAlert(condition))).ok, condition).toBe(
        true,
      );
    }
  });
});
