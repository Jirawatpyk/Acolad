import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import type { AppearanceEvent } from '../detection/types.js';

/** Persists appearance events with a restart-safe dedup index. */
export class AppearanceEventStore {
  constructor(private readonly db: DB) {}

  /**
   * Insert an appearance event, returning its event_id. Returns null if a row
   * with the same (job_key, event_type, poll_cycle_id) already exists — the
   * backstop that keeps retries within a cycle from duplicating (FR-005).
   */
  insert(ev: AppearanceEvent): string | null {
    const eventId = randomUUID();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO appearance_events (event_id, job_key, event_type, occurred_at, poll_cycle_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(eventId, ev.jobKey, ev.eventType, ev.occurredAt, ev.pollCycleId);
    return res.changes > 0 ? eventId : null;
  }
}
