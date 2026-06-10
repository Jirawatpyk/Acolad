import type { Outbox } from '../state/outbox.js';
import type { ChatSender, SendOutcome } from './googleChat.js';
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

/**
 * Flushes due outbox rows to the chat channel. One message per row (no batching —
 * SC-008). Marks a row sent immediately after a 2xx to keep the at-least-once
 * window minimal (data-model.md). A failure never blocks detection (Constitution IV).
 */
export class Dispatcher {
  constructor(
    private readonly outbox: Outbox,
    private readonly sender: ChatSender,
    private readonly logger: Logger,
    private readonly hooks: DispatcherHooks = {},
  ) {}

  async flush(nowIso: string, nowMs: number): Promise<DispatchSummary> {
    const summary: DispatchSummary = {
      sent: 0,
      transientFailures: 0,
      dead: 0,
      permanentFailures: 0,
    };
    const due = this.outbox.due(nowIso);
    for (const row of due) {
      const payload = JSON.parse(row.payload_json) as { text: string };
      const start = Date.now();
      let outcome: SendOutcome;
      try {
        outcome = await this.sender.send(payload.text);
      } catch {
        outcome = 'transient';
      }
      const latencyMs = Date.now() - start;

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
}
