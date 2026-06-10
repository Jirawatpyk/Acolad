/**
 * Dead-man switch heartbeat to Healthchecks.io (FR-010). The bot pings after a
 * successful poll cycle; if pings stop for > 10 minutes the external service
 * alerts the team (covers whole-machine death). During lockout/backoff or when
 * the outbox has dead rows, the bot pings `/fail` instead — proving the process
 * is alive but failing, so the operator can tell "machine dead" from "knowingly
 * failing" and avoid duplicate alerts.
 */
export class Heartbeat {
  constructor(
    private readonly pingUrl: string,
    private readonly onError: (e: unknown, action: string) => void = () => undefined,
  ) {}

  async ok(): Promise<void> {
    await this.ping(this.pingUrl, 'heartbeat_ok');
  }

  async fail(): Promise<void> {
    await this.ping(`${this.pingUrl}/fail`, 'heartbeat_fail');
  }

  private async ping(url: string, action: string): Promise<void> {
    try {
      await fetch(url, { method: 'POST' });
    } catch (e) {
      // A failed heartbeat must never propagate into the poll loop.
      this.onError(e, action);
    }
  }
}
