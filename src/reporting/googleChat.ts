export type SendOutcome = 'ok' | 'transient' | 'permanent';

/** Shape stored in outbox.payload_json — the implicit producer/consumer contract.
 *  Tagged union: either a plain text message or a cardsV2 card payload. */
export type ChatPayload = { text: string } | { cardsV2: unknown[] };

export interface ChatSender {
  send(payload: ChatPayload): Promise<SendOutcome>;
  sendDetailed(payload: ChatPayload): Promise<{ outcome: SendOutcome; status: number }>;
}

/**
 * Classify an HTTP status into the transport failure taxonomy (contracts/notifications.md):
 *   2xx                  -> ok
 *   429, 5xx             -> transient (retry with backoff)
 *   400                  -> permanent (transport layer: payload rejected by endpoint)
 *   401/403/404 (4xx)    -> permanent (webhook revoked/removed)
 *
 * Callers that need to distinguish payload-rejection (400) from webhook errors
 * (401/403/404) must call isPayloadRejection(status) separately. The dead+alert
 * behavior for 400 is the dispatcher's responsibility, not this function's.
 */
export function classifyStatus(status: number): SendOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429 || status >= 500) return 'transient';
  if (status >= 400) return 'permanent';
  return 'transient';
}

/**
 * Returns true when the HTTP status indicates the payload itself was rejected
 * (400 Bad Request — oversized or malformed card body). These should be dead+alerted,
 * not retried forever, since the payload cannot be fixed by config.
 * 401/403/404 are webhook config errors (retry slowly).
 */
export function isPayloadRejection(status: number): boolean {
  return status === 400;
}

/** Posts a text or cardsV2 message to a Google Chat incoming webhook. */
export class GoogleChatSender implements ChatSender {
  constructor(
    private readonly webhookUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async sendDetailed(payload: ChatPayload): Promise<{ outcome: SendOutcome; status: number }> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(payload),
        // Bounded wait: a hung endpoint must not stall the poll loop.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return { outcome: classifyStatus(res.status), status: res.status };
    } catch {
      // Network error / timeout / abort — treat as transient.
      return { outcome: 'transient', status: 0 };
    }
  }

  async send(payload: ChatPayload): Promise<SendOutcome> {
    const { outcome } = await this.sendDetailed(payload);
    return outcome;
  }
}
