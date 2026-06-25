import type { DB } from './db.js';
import type { AppConfig } from '../config/index.js';

export type OutboxChannel = 'chat' | 'sheets' | 'team';

export interface OutboxRow {
  outbox_id: number;
  event_id: string;
  channel: OutboxChannel;
  payload_json: string;
  status: 'pending' | 'sent' | 'dead';
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  sent_at: string | null;
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Permanent failures (webhook revoked) retry slowly, not toward the dead cap (FR-018). */
const PERMANENT_RETRY_MS = 30 * 60_000;

/**
 * Notification outbox (FR-013/FR-018). Every notifiable event — job or system —
 * is enqueued here in the same transaction as the state change. A separate
 * dispatcher claims due rows and marks them sent immediately after a 2xx
 * (at-least-once; window documented in plan Complexity Tracking).
 */
/** Build an Outbox from config — one place wires the retry/dead-age knobs. */
export function createOutbox(db: DB, cfg: AppConfig): Outbox {
  return new Outbox(db, cfg.OUTBOX_RETRY_CAP, cfg.OUTBOX_DEAD_AFTER_HOURS);
}

export class Outbox {
  constructor(
    private readonly db: DB,
    private readonly retryCap: number,
    private readonly deadAfterHours: number,
  ) {}

  /** Idempotent enqueue (unique on event_id+channel). Returns false if already queued. */
  enqueue(
    eventId: string,
    payloadJson: string,
    nowIso: string,
    channel: OutboxChannel = 'chat',
  ): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox (event_id, channel, payload_json, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(eventId, channel, payloadJson, nowIso, nowIso);
    return res.changes > 0;
  }

  due(nowIso: string): OutboxRow[] {
    return this.db
      .prepare(`SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY outbox_id`)
      .all(nowIso) as OutboxRow[];
  }

  markSent(outboxId: number, nowIso: string): void {
    this.db
      .prepare(`UPDATE outbox SET status = 'sent', sent_at = ? WHERE outbox_id = ?`)
      .run(nowIso, outboxId);
  }

  /**
   * Record a failed attempt. Returns 'dead' when the row exhausts the retry cap
   * or has aged past deadAfterHours, else 'pending' with backoff applied.
   */
  recordFailure(row: OutboxRow, nowMs: number): 'pending' | 'dead' {
    const attempts = row.attempts + 1;
    const ageMs = nowMs - Date.parse(row.created_at);
    const expired = ageMs >= this.deadAfterHours * 3_600_000;
    if (attempts >= this.retryCap || expired) {
      this.db.prepare(`UPDATE outbox SET status = 'dead', attempts = ? WHERE outbox_id = ?`).run(
        attempts,
        row.outbox_id,
      );
      return 'dead';
    }
    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
    const next = new Date(nowMs + backoff).toISOString();
    this.db
      .prepare(`UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE outbox_id = ?`)
      .run(attempts, next, row.outbox_id);
    return 'pending';
  }

  /**
   * Record a permanent-channel failure (webhook revoked/removed — 401/403/404).
   * The row stays pending and is retried slowly (every 30 min) without counting
   * toward the dead cap, so a configuration fix lets queued events flush rather
   * than being discarded (FR-018). The out-of-band alert is the heartbeat /fail.
   */
  recordPermanentFailure(row: OutboxRow, nowMs: number): void {
    const nowIso = new Date(nowMs).toISOString();
    const next = new Date(nowMs + PERMANENT_RETRY_MS).toISOString();
    // Refresh created_at so the dead-age clock does not carry over from the
    // (possibly long) permanent period: if the channel later returns a transient
    // error, the row gets a fresh retry budget instead of being aged-out as dead.
    this.db
      .prepare(`UPDATE outbox SET next_attempt_at = ?, created_at = ? WHERE outbox_id = ?`)
      .run(next, nowIso, row.outbox_id);
  }

  /** Ops: requeue dead rows back to pending (npm run outbox:requeue). */
  requeueDead(nowIso: string): number {
    const res = this.db
      .prepare(`UPDATE outbox SET status = 'pending', attempts = 0, next_attempt_at = ? WHERE status = 'dead'`)
      .run(nowIso);
    return res.changes;
  }

  countByStatus(status: OutboxRow['status']): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status = ?').get(status) as {
      n: number;
    };
    return row.n;
  }

  /**
   * Counts dead rows whose channel is NOT the given channel. Used to gate the
   * Healthchecks /fail ping: a dead team-channel row (daily report delivery
   * failure) surfaces via the onDead system alert but should NOT trigger paging
   * (Constitution IV — reporting outages never block the on-call).
   */
  countDeadExcludingChannel(channel: OutboxChannel): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'dead' AND channel <> ?")
      .get(channel) as { n: number };
    return row.n;
  }

}

