import type { DB } from './db.js';

/** Typed key/value access to the meta table (data-model.md). */
export class MetaStore {
  constructor(private readonly db: DB) {}

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
      .run(key, value, value);
  }

  getNumber(key: string, fallback = 0): number {
    const v = this.get(key);
    if (v === undefined) return fallback;
    // Guard NaN/Infinity: getNumber now backs only the yield-state reads (lastAuthSuccessMs,
    // yieldUntilMs, yieldEpisodeStartedMs) + the baseline cursor — a corrupt/non-numeric value
    // must not flow into the yield-window math (e.g. a corrupt yield_until_ms would make the
    // inCooldown/yieldStuck comparisons misbehave — NaN comparisons are always false, collapsing
    // the cooldown window) and must not self-perpetuate via String(NaN)='NaN'. Fall back to the
    // safe default instead.
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  get baselineDone(): boolean {
    return this.get('baseline_done') === '1';
  }

  markBaselineDone(): void {
    this.set('baseline_done', '1');
  }

  recordSuccessfulPoll(nowIso: string): void {
    this.set('last_successful_poll_at', nowIso);
  }

  get lastDailyReportDate(): string | null {
    return this.get('last_daily_report_date') ?? null;
  }

  // --- auto-yield state (ms epoch; 0 = unset/not-yielding) ---
  get lastAuthSuccessMs(): number {
    return this.getNumber('last_auth_success_ms', 0);
  }
  setLastAuthSuccessMs(ms: number): void {
    this.set('last_auth_success_ms', String(ms));
  }
  get yieldUntilMs(): number {
    return this.getNumber('yield_until_ms', 0);
  }
  setYieldUntilMs(ms: number): void {
    this.set('yield_until_ms', String(ms));
  }
  get yieldEpisodeStartedMs(): number {
    return this.getNumber('yield_episode_started_ms', 0);
  }
  setYieldEpisodeStartedMs(ms: number): void {
    this.set('yield_episode_started_ms', String(ms));
  }
}
