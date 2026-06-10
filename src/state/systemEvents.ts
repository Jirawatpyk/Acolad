import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';

export type SystemEventType = 'system_alert' | 'system_recovered' | 'cold_start_summary';
export type Severity = 'info' | 'warn' | 'critical';

export interface SystemEventInput {
  eventType: SystemEventType;
  severity: Severity;
  dedupKey: string;
  payloadJson: string;
  occurredAt: string;
}

/**
 * System-level events that must be notified but aren't tied to a single job
 * (SYSTEM_ALERT, SYSTEM_RECOVERED, COLD_START_SUMMARY). A unique partial index
 * keeps one active alert per dedup_key so the same problem isn't re-alerted
 * while still open (Constitution IV/VII).
 */
export class SystemEventStore {
  constructor(private readonly db: DB) {}

  /**
   * Create an event. For alerts, returns null when an active alert with the same
   * dedup_key already exists (deduped). Returns the new event_id otherwise.
   */
  create(input: SystemEventInput): string | null {
    const eventId = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO system_events (event_id, event_type, severity, dedup_key, payload_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(eventId, input.eventType, input.severity, input.dedupKey, input.payloadJson, input.occurredAt);
      return eventId;
    } catch (err) {
      // Unique active-alert index violation → already alerted, dedupe.
      if (err instanceof Error && /UNIQUE/i.test(err.message)) return null;
      throw err;
    }
  }

  /** True if an unresolved alert exists for this dedup_key. */
  hasActiveAlert(dedupKey: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM system_events WHERE dedup_key = ? AND event_type = 'system_alert' AND resolved_at IS NULL LIMIT 1`,
      )
      .get(dedupKey);
    return row !== undefined;
  }

  /** Resolve the active alert for a dedup_key. Returns its event_id if one was open. */
  resolve(dedupKey: string, nowIso: string): string | null {
    const row = this.db
      .prepare(
        `SELECT event_id FROM system_events WHERE dedup_key = ? AND event_type = 'system_alert' AND resolved_at IS NULL`,
      )
      .get(dedupKey) as { event_id: string } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE system_events SET resolved_at = ? WHERE event_id = ?').run(nowIso, row.event_id);
    return row.event_id;
  }
}
