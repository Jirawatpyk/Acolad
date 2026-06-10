/**
 * Sliding-window request counter (FR-011). 1 request = 1 page navigation/refresh
 * (login and retries count too). When the window is at the cap, the next cycle
 * is delayed until the oldest request ages out — the loop never silently stops.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly cap: number,
    private readonly windowMs: number = 3_600_000,
  ) {}

  record(nowMs: number): void {
    this.timestamps.push(nowMs);
    this.prune(nowMs);
  }

  count(nowMs: number): number {
    this.prune(nowMs);
    return this.timestamps.length;
  }

  atCap(nowMs: number): boolean {
    return this.count(nowMs) >= this.cap;
  }

  /** ms to wait until a slot frees up, or 0 if under cap. */
  msUntilSlot(nowMs: number): number {
    this.prune(nowMs);
    if (this.timestamps.length < this.cap) return 0;
    const oldest = this.timestamps[0];
    if (oldest === undefined) return 0;
    return Math.max(0, oldest + this.windowMs - nowMs);
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! <= cutoff) {
      this.timestamps.shift();
    }
  }
}
