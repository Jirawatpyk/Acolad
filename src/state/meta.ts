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
    return v === undefined ? fallback : Number(v);
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
}
