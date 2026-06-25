import type { AppearanceEvent, JobState } from '../detection/types.js';

/** Render an ISO-8601 instant in Asia/Bangkok as YYYY-MM-DDTHH:mm+07:00 (FR-014). */
export function formatBangkok(iso: string): string {
  const d = new Date(iso);
  // Asia/Bangkok is a fixed +07:00 offset (no DST).
  const shifted = new Date(d.getTime() + 7 * 3_600_000);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}` +
    `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}+07:00`
  );
}

const dash = (v: string | null | undefined): string => (v && v !== '' ? v : '—');

function jobLines(job: JobState): string {
  return [
    `Job: ${job.title}`,
    `ID: ${dash(job.portalJobId ?? job.jobKey)}`,
    `Language pair: ${dash(job.languagePair)}`,
    `Deadline: ${dash(job.deadline ?? job.deadlineRaw)}`,
    `Fee: ${dash(job.fee)}`,
    `Link: ${dash(job.url)}`,
  ].join('\n');
}

export function renderNewJob(ev: AppearanceEvent): string {
  return `🆕 New job on Acolad\n${jobLines(ev.job)}\nDetected: ${formatBangkok(ev.occurredAt)}`;
}

export function renderRelistedJob(ev: AppearanceEvent): string {
  const since = ev.firstSeenAt ? ` (previously seen ${formatBangkok(ev.firstSeenAt)})` : '';
  return `🔁 Job relisted${since}\n${jobLines(ev.job)}\nDetected: ${formatBangkok(ev.occurredAt)}`;
}

const COLD_START_MAX_ROWS = 20;

export function renderColdStartSummary(jobs: JobState[], _occurredAt: string): string {
  if (jobs.length === 0) {
    return '📋 Monitoring started — no jobs on portal yet. Watching 24/7';
  }
  const shown = jobs.slice(0, COLD_START_MAX_ROWS);
  const rows = shown
    .map((j) => `• ${j.title} | ${dash(j.languagePair)} | due ${dash(j.deadline ?? j.deadlineRaw)}`)
    .join('\n');
  const more =
    jobs.length > COLD_START_MAX_ROWS ? `\n…and ${jobs.length - COLD_START_MAX_ROWS} more` : '';
  return `📋 Monitoring started — found ${jobs.length} existing job(s)\n${rows}${more}`;
}

export interface SystemAlertFields {
  severity: 'warn' | 'critical';
  title: string;
  cause: string;
  impact: string;
  action: string;
  occurredAt: string;
}

export function renderSystemAlert(f: SystemAlertFields): string {
  const sev = f.severity === 'critical' ? 'CRITICAL' : 'WARN';
  return [
    `🚨 [${sev}] ${f.title}`,
    `Cause: ${f.cause}`,
    `Impact: ${f.impact}`,
    `Action: ${f.action}`,
    `Time: ${formatBangkok(f.occurredAt)}`,
  ].join('\n');
}

export function renderSystemRecovered(
  subject: string,
  downDuration: string,
  occurredAt: string,
): string {
  return `✅ Recovered: ${subject} (was down for ${downDuration})\nTime: ${formatBangkok(occurredAt)}`;
}

/** Render the Chat message for a job appearance event. */
export function renderAppearance(ev: AppearanceEvent): string {
  return ev.eventType === 'relisted' ? renderRelistedJob(ev) : renderNewJob(ev);
}
