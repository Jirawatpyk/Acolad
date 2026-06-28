/**
 * Canonical "deadline day of a job" helpers (F8). The triple
 * `Date.parse(dueDate)` + `Number.isFinite` + `bangkokDateString` was duplicated in
 * three places (the capacity gate, the per-deadline-day store bucket, and the daily
 * report). Centralising it here guarantees they all parse + null-handle identically,
 * so the gate's count, the bucket, and the report can never diverge.
 */
import { bangkokDateString } from './bangkokCalendar.js';

/**
 * The deadline as epoch milliseconds, or `null` when the `dueDate` string is
 * null / empty / unparseable. Single source of truth for "when is this job due".
 */
export function deadlineMsOf(dueDate: string | null): number | null {
  const t = dueDate ? Date.parse(dueDate) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * The Bangkok deadline DAY (`YYYY-MM-DD`) of a job, or `null` for a
 * null / empty / unparseable deadline.
 */
export function deadlineDayOf(dueDate: string | null): string | null {
  const ms = deadlineMsOf(dueDate);
  return ms === null ? null : bangkokDateString(ms);
}
