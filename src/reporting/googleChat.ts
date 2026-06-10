export type SendOutcome = 'ok' | 'transient' | 'permanent';

export interface ChatSender {
  send(text: string): Promise<SendOutcome>;
}

/**
 * Classify an HTTP status into the failure taxonomy (contracts/notifications.md):
 *   2xx                  -> ok
 *   429, 5xx             -> transient (retry with backoff)
 *   401/403/404 (4xx)    -> permanent (webhook revoked/removed)
 */
export function classifyStatus(status: number): SendOutcome {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429 || status >= 500) return 'transient';
  if (status >= 400) return 'permanent';
  return 'transient';
}

/** Posts a simple text message to a Google Chat incoming webhook. */
export class GoogleChatSender implements ChatSender {
  constructor(
    private readonly webhookUrl: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(text: string): Promise<SendOutcome> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ text }),
        // Bounded wait: a hung endpoint must not stall the poll loop.
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return classifyStatus(res.status);
    } catch {
      // Network error / timeout / abort — treat as transient.
      return 'transient';
    }
  }
}
