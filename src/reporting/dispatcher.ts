import type { Outbox, OutboxRow } from '../state/outbox.js';
import type { ChatSender, ChatPayload, SendOutcome } from './googleChat.js';
import { isPayloadRejection } from './googleChat.js';
import type { SheetSender, SheetRow } from './sheets.js';
import type { Logger } from '../monitoring/logger.js';

export interface DispatchSummary {
  sent: number;
  transientFailures: number;
  dead: number;
  permanentFailures: number;
}

export interface DispatcherHooks {
  /** Called when a row exhausts retries (FR-018: raise system alert + /fail ping). */
  onDead?: (eventId: string) => void;
  /** Called when the channel returns a permanent error (webhook revoked). */
  onPermanent?: (eventId: string) => void;
}

/** Map of senders keyed by channel. Only `chat` is required; `team` and `sheet` are optional. */
export interface DispatcherSenders {
  chat: ChatSender;
  team?: ChatSender;
  sheet?: SheetSender;
}

/**
 * Flushes due outbox rows to the appropriate channel sender. One message per row
 * (no batching — SC-008). Marks a row sent immediately after a 2xx to keep the
 * at-least-once window minimal (data-model.md). A failure never blocks detection
 * (Constitution IV).
 *
 * Routing:
 *   'sheets' → senders.sheet
 *   'team'   → senders.team
 *   'chat'   → senders.chat
 * If the target sender is absent → treated as malformed (dead + onDead, queue not wedged).
 *
 * Payload discrimination for chat/team:
 *   { cardsV2: unknown[] } → send as cardsV2 card
 *   { text: string }       → send as plain text
 *   anything else          → malformed
 *
 * A 400 response means the payload itself was rejected (oversized/malformed card) —
 * dead + onDead, NOT recordPermanentFailure (which is for revoked webhooks).
 */
export class Dispatcher {
  private readonly senders: DispatcherSenders;

  constructor(
    private readonly outbox: Outbox,
    senders: DispatcherSenders,
    private readonly logger: Logger,
    private readonly hooks: DispatcherHooks = {},
  ) {
    this.senders = senders;
  }

  async flush(nowIso: string, nowMs: number): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      sent: 0,
      transientFailures: 0,
      dead: 0,
      permanentFailures: 0,
    };
    const due = this.outbox.due(nowIso);
    for (const row of due) {
      const sent = await this.sendRow(row);
      // Guard the implicit contract (Constitution VI): a single malformed row
      // (invalid JSON or missing/unknown payload shape) must not wedge the whole
      // queue or send an empty message — drop it with an error log + dead alert.
      if (sent === 'malformed') {
        summary.dead++;
        this.outbox.markSent(row.outbox_id, nowIso); // drop so the queue can't wedge
        this.logger.error(
          {
            module: 'dispatcher',
            action: 'send',
            outcome: 'malformed',
            eventId: row.event_id,
            channel: row.channel,
          },
          'dropped malformed outbox payload',
        );
        this.hooks.onDead?.(row.event_id);
        continue;
      }
      const { outcome, latencyMs, payloadRejected } = sent;

      if (outcome === 'ok') {
        this.outbox.markSent(row.outbox_id, nowIso);
        summary.sent++;
        this.logger.info(
          { module: 'dispatcher', action: 'send', outcome: 'ok', latencyMs, eventId: row.event_id },
          'notification sent',
        );
        continue;
      }

      if (outcome === 'permanent') {
        if (payloadRejected) {
          // 400: the card payload itself is bad — no point retrying with the same body.
          // Dead + onDead, same as malformed, but with a distinct log line.
          summary.dead++;
          this.outbox.markSent(row.outbox_id, nowIso); // drop
          this.logger.error(
            {
              module: 'dispatcher',
              action: 'send',
              outcome: 'dead',
              latencyMs,
              eventId: row.event_id,
              channel: row.channel,
            },
            'card rejected (payload) — dropped',
          );
          this.hooks.onDead?.(row.event_id);
        } else {
          // Webhook revoked/removed: defer slowly, do NOT count toward dead (FR-018)
          // so queued events flush once the channel is fixed. Out-of-band signal is
          // the heartbeat /fail raised by the caller.
          summary.permanentFailures++;
          this.outbox.recordPermanentFailure(row, nowMs);
          this.logger.error(
            {
              module: 'dispatcher',
              action: 'send',
              outcome: 'permanent',
              latencyMs,
              eventId: row.event_id,
            },
            'notification channel permanently failing',
          );
          this.hooks.onPermanent?.(row.event_id);
        }
        continue;
      }

      // Transient: backoff, eventually dead.
      const result = this.outbox.recordFailure(row, nowMs);
      if (result === 'dead') {
        summary.dead++;
        this.logger.error(
          {
            module: 'dispatcher',
            action: 'send',
            outcome: 'dead',
            latencyMs,
            eventId: row.event_id,
          },
          'notification exhausted retries',
        );
        this.hooks.onDead?.(row.event_id);
      } else {
        summary.transientFailures++;
        this.logger.warn(
          { module: 'dispatcher', action: 'send', outcome, latencyMs, eventId: row.event_id },
          'notification deferred',
        );
      }
    }
    return summary;
  }

  /** Route one row to its channel sender; returns 'malformed' or the send result. */
  private async sendRow(
    row: OutboxRow,
  ): Promise<'malformed' | { outcome: SendOutcome; latencyMs: number; payloadRejected: boolean }> {
    const start = Date.now();

    if (row.channel === 'sheets') {
      if (!this.senders.sheet) return 'malformed';
      let sheetRow: SheetRow | undefined;
      try {
        sheetRow = (JSON.parse(row.payload_json) as { row: SheetRow }).row;
      } catch {
        sheetRow = undefined;
      }
      if (!sheetRow || typeof sheetRow.jobKey !== 'string' || sheetRow.jobKey === '') {
        return 'malformed';
      }
      let outcome: SendOutcome;
      try {
        outcome = await this.senders.sheet.send(sheetRow);
      } catch {
        outcome = 'transient';
      }
      return { outcome, latencyMs: Date.now() - start, payloadRejected: false };
    }

    // 'chat' or 'team'
    const sender: ChatSender | undefined =
      row.channel === 'team' ? this.senders.team : this.senders.chat;

    // No sender configured for this channel → malformed/dead so queue can't wedge.
    if (!sender) return 'malformed';

    // Discriminate payload shape.
    let payload: ChatPayload | undefined;
    try {
      const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (Array.isArray(parsed['cardsV2'])) {
        payload = { cardsV2: parsed['cardsV2'] };
      } else if (typeof parsed['text'] === 'string' && parsed['text'] !== '') {
        payload = { text: parsed['text'] };
      }
    } catch {
      payload = undefined;
    }
    if (!payload) return 'malformed';

    let outcome: SendOutcome;
    let status: number;
    try {
      ({ outcome, status } = await sender.sendDetailed(payload));
    } catch {
      outcome = 'transient';
      status = 0;
    }
    return { outcome, latencyMs: Date.now() - start, payloadRejected: isPayloadRejection(status) };
  }
}
