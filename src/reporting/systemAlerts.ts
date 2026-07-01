import type { DB } from '../state/db.js';
import { SystemEventStore } from '../state/systemEvents.js';
import { Outbox } from '../state/outbox.js';
import { buildCard } from './chatCard.js';
import { sanitizeCardId } from './cardText.js';

export interface SystemAlertFields {
  severity: 'warn' | 'critical';
  title: string;
  cause: string;
  impact: string;
  action: string;
  occurredAt: string;
}

export type TriggerKind =
  | 'login_failed'
  | 'captcha'
  | 'layout_changed'
  | 'pagination'
  | 'portal_down'
  | 'outbox_dead'
  | 'cold_start_repeat'
  | 'db_corrupt'
  | 'accept_failed'
  | 'daily_report_dead'
  | 'xtm_yielding'
  | 'yield_stuck'
  | 'holiday_calendar_stale'
  | 'daily_cap_reached'
  | 'held_job_no_deadline';

interface TriggerSpec {
  severity: 'warn' | 'critical';
  title: string;
  impact: string;
  action: string;
  /** Whether this trigger emits a SYSTEM_RECOVERED when the condition clears. */
  hasRecovered: boolean;
  /**
   * Optional builder for metric-aware title/impact/action strings.
   * Called when `unit` + `capVar` are supplied to `raiseAlert`.
   * The static title/impact/action above serve as the words-mode defaults
   * (backward-compatible when the builder is not invoked).
   */
  builder?: (
    unit: { adj: string },
    capVar: string,
  ) => { title: string; impact: string; action: string };
}

/** Action text per trigger (contracts/notifications.md §4). */
const TRIGGERS: Record<TriggerKind, TriggerSpec> = {
  login_failed: {
    severity: 'critical',
    title: 'Login failed',
    impact: 'Monitoring paused (lockout)',
    action:
      'Try logging in manually; if the password changed, update XTM_ACOLAD_Password in .env then run npm run deploy',
    hasRecovered: true,
  },
  captcha: {
    severity: 'critical',
    title: 'CAPTCHA / identity check detected',
    impact: 'Monitoring paused until a human clears the verification',
    action:
      'Log in manually past the CAPTCHA then npm run deploy; if 2FA becomes permanent, revisit the spec assumption',
    hasRecovered: true,
  },
  layout_changed: {
    severity: 'critical',
    title: 'Job list layout changed — cannot be read',
    impact: 'Stopped reading the job list',
    action:
      'Compare the latest state/evidence to the new page, update src/portal/selectors.ts, get npm test green, then npm run deploy',
    hasRecovered: true,
  },
  pagination: {
    severity: 'warn',
    title: 'Pagination indicator detected',
    impact: 'Detection coverage may be incomplete',
    action:
      'Check the live page, revisit the "single page" assumption, and extend the reader if needed',
    hasRecovered: false,
  },
  portal_down: {
    severity: 'warn',
    title: 'Portal unreachable for over 10 minutes',
    impact: 'Polling is throttled with backoff',
    action:
      'Try opening the portal from another machine; if it is genuinely down, do nothing — the bot retries and sends SYSTEM_RECOVERED when it returns',
    hasRecovered: true,
  },
  outbox_dead: {
    severity: 'critical',
    title: 'Notifications stuck — delivery failed',
    impact: 'Some notifications did not reach the team',
    action: 'Check the webhook URL / Chat space permissions, then run npm run outbox:requeue',
    hasRecovered: true,
  },
  cold_start_repeat: {
    severity: 'warn',
    title: 'State store may be lost (cold start repeated within 7 days)',
    impact: 'Possible disk / database-file problem',
    action: 'Check the disk and why the state file disappeared; inspect any .corrupt-* copies',
    hasRecovered: false,
  },
  db_corrupt: {
    severity: 'critical',
    title: 'State store corrupt — reset to cold start',
    impact: 'Prior job history was archived and a fresh store started',
    action: 'Keep the .corrupt-* copy for analysis and check disk health',
    hasRecovered: false,
  },
  // Raised with a per-job dedup key (`accept_failed:<jobKey>`) and never auto-resolved
  // (hasRecovered:false) — so a given job alerts ONCE and a repeat failure of the SAME
  // job is intentionally deduped (avoids per-cycle spam while accept stays unconfirmed).
  // Distinct jobs still each alert. Revisit if per-incident re-alerting is ever needed.
  accept_failed: {
    severity: 'critical',
    title: 'Job accept failed (could not confirm)',
    impact: 'A Malay job that should have been accepted may not be — needs a human check',
    action:
      'Open the latest state/evidence and check XTM whether the job was accepted; if the accept menu changed, update src/portal/selectors.ts',
    hasRecovered: false,
  },
  daily_report_dead: {
    severity: 'warn',
    title: 'Daily report delivery failed',
    impact: "The team's daily in-progress report did not reach the team space",
    action:
      'Check the team webhook (GOOGLE_CHAT_WEBHOOK_TEAM) URL/permissions, then run npm run outbox:requeue',
    hasRecovered: false,
  },
  xtm_yielding: {
    severity: 'warn',
    title: 'Bot paused — XTM account in use',
    impact: 'Monitoring is paused while a teammate (or another session) uses the shared account',
    action:
      'No action needed if a teammate is working in XTM; the bot retries automatically and resumes when the account is free',
    hasRecovered: true,
  },
  yield_stuck: {
    severity: 'critical',
    title: 'Bot paused too long — account still in use',
    impact: 'Monitoring has been paused past the limit; new jobs are not being auto-accepted',
    action:
      'Confirm a teammate is actually using XTM. If not, free the account (log out) or disable the bot (set XTM_YIELD_ENABLED=0 then npm run deploy)',
    hasRecovered: true,
  },
  // Raised by the cycle ONLY when the CURRENT Bangkok year is uncurated — a TOTAL
  // auto-accept outage (every Malay job fail-closes), so it is critical and FAILS the
  // heartbeat (C1) to page on-call, then resolves once the year is curated.
  holiday_calendar_stale: {
    severity: 'critical',
    title: 'Holiday calendar not confirmed for the current year',
    impact:
      'Auto-accept is fully paused — every Malay job is rejected until the current year is curated',
    // Kept ≤120 chars so the card's value-truncation leaves "npm run deploy" visible (the
    // "fully paused" framing already lives in Impact above).
    action:
      'Add the current year to src/schedule/thaiHolidaysData.ts (HOLIDAYS + CURATED_YEARS) then npm run deploy',
    hasRecovered: true,
  },
  // Raised at most once per Bangkok day (dedupKey `daily_cap_reached:<date>`) when the
  // daily word budget is genuinely exhausted — so ops knows "auto-accept paused for the
  // day on budget" (vs "no jobs today"). hasRecovered:false (like accept_failed): it never
  // auto-resolves; the next Bangkok day's dedupKey re-arms it.
  daily_cap_reached: {
    severity: 'warn',
    // Static strings are the words-mode defaults (backward-compatible when raiseAlert
    // is called without unit/capVar, e.g. from the all-triggers test loop).
    title: 'Daily word cap reached — auto-accept paused for today',
    impact: 'No more Malay jobs are auto-accepted until the Bangkok-day counter resets at midnight',
    action:
      'Accept further jobs manually if needed; the cap resets at Bangkok midnight. To raise it, set ACCEPT_MAX_WORDS_PER_DAY in .env then npm run deploy',
    hasRecovered: false,
    builder: (unit, capVar) => ({
      title: `Daily ${unit.adj} cap reached — auto-accept paused for today`,
      impact:
        'No more Malay jobs are auto-accepted until the Bangkok-day counter resets at midnight',
      action: `Accept further jobs manually if needed; the cap resets at Bangkok midnight. To raise it, set ${capVar} in .env then npm run deploy`,
    }),
  },
  // Raised (deduped once per Bangkok day, dedupKey `held_job_no_deadline:<date>`) when a HELD
  // (accepted) job has a null/unparseable deadline so it drops out of the per-deadline-day
  // capacity seed — that day under-counts and a later same-deadline Malay group could over-accept
  // past the cap on the IRREVERSIBLE bulk path. warn (not critical): auto-accept still runs; ops
  // should accept the affected same-day job(s) manually / fix the due date. hasRecovered:false
  // (like daily_cap_reached) — it never auto-resolves; the next Bangkok day's dedupKey re-arms it.
  held_job_no_deadline: {
    severity: 'warn',
    // Static strings are the words-mode defaults.
    title: 'Accepted job has no deadline — capacity may under-count',
    impact: 'A later job due the same day could be over-accepted past the daily word cap',
    action:
      'Open XTM, find the accepted job(s) missing a due date, and accept further same-day jobs manually until the due date is fixed',
    hasRecovered: false,
    builder: (unit, _capVar) => ({
      title: 'Accepted job has no deadline — capacity may under-count',
      impact: `A later job due the same day could be over-accepted past the daily ${unit.adj} cap`,
      action:
        'Open XTM, find the accepted job(s) missing a due date, and accept further same-day jobs manually until the due date is fixed',
    }),
  },
};

/** Build a cardsV2 alert payload for the given fields and dedup key. */
function buildAlertCard(
  spec: TriggerSpec,
  fields: SystemAlertFields,
  dedupKey: string,
): { cardsV2: unknown[] } {
  const emoji = spec.severity === 'critical' ? '🔴' : '⚠️';
  return buildCard({
    cardId: sanitizeCardId(`alert-${dedupKey}`),
    headerTitle: `${emoji} ${spec.title}`,
    rows: [
      { label: 'Impact', value: fields.impact },
      { label: 'Action', value: fields.action },
      { label: 'Detail', value: fields.cause },
    ],
  });
}

/**
 * Raise a system alert through the outbox (never sent directly — Constitution IV).
 * Deduped per trigger via the active-alert index. Returns true if a new alert
 * was enqueued (false if already active).
 *
 * For metric-aware triggers (`daily_cap_reached`, `held_job_no_deadline`) pass
 * `unit` (e.g. `{ adj: 'WWC' }`) and `capVar` (the ACTIVE cap env-var name,
 * e.g. `'ACCEPT_MAX_WWC_PER_DAY'`) so the card names the right knob.
 * When omitted the static words-mode strings are used (backward-compatible).
 */
export function raiseAlert(
  db: DB,
  outbox: Outbox,
  kind: TriggerKind,
  occurredAt: string,
  detail: string,
  extra: Partial<SystemAlertFields> = {},
  /** Override the dedup key (default = kind). Use a per-job key for incidents
   *  that recur per job (e.g. accept_failed) so distinct failures each alert. */
  dedupKey?: string,
  /** Effort-unit label (e.g. `{ adj: 'WWC' }` or `{ adj: 'word' }`). */
  unit?: { adj: string },
  /** Active cap env-var name (e.g. `'ACCEPT_MAX_WWC_PER_DAY'`). */
  capVar?: string,
): boolean {
  const spec = TRIGGERS[kind];
  const built =
    unit != null && capVar != null && spec.builder ? spec.builder(unit, capVar) : undefined;
  const system = new SystemEventStore(db);
  return db.transaction(() => {
    const fields: SystemAlertFields = {
      severity: spec.severity,
      title: built?.title ?? spec.title,
      cause: detail,
      impact: extra.impact ?? built?.impact ?? spec.impact,
      action: extra.action ?? built?.action ?? spec.action,
      occurredAt,
    };
    const resolvedDedup = dedupKey ?? kind;
    const effectiveSpec = built ? { ...spec, title: built.title } : spec;
    const card = buildAlertCard(effectiveSpec, fields, resolvedDedup);
    const payload = JSON.stringify(card);
    const eventId = system.create({
      eventType: 'system_alert',
      severity: spec.severity,
      dedupKey: resolvedDedup,
      payloadJson: payload,
      occurredAt,
    });
    if (!eventId) return false; // already active
    return outbox.enqueue(eventId, payload, occurredAt);
  })();
}

/** Resolve an active alert and enqueue a SYSTEM_RECOVERED if the trigger supports it. */
export function resolveAlert(
  db: DB,
  outbox: Outbox,
  kind: TriggerKind,
  occurredAt: string,
  downDuration: string,
): boolean {
  const spec = TRIGGERS[kind];
  const system = new SystemEventStore(db);
  return db.transaction(() => {
    const resolvedId = system.resolve(kind, occurredAt);
    if (!resolvedId) return false;
    if (!spec.hasRecovered) return false;
    const card = buildCard({
      cardId: sanitizeCardId(`recovered-${kind}-${occurredAt}`),
      headerTitle: `✅ Recovered · ${spec.title}`,
      rows: [{ label: 'Down for', value: downDuration }],
    });
    const payload = JSON.stringify(card);
    const sysId = system.create({
      eventType: 'system_recovered',
      severity: 'info',
      dedupKey: `${kind}:recovered:${occurredAt}`,
      payloadJson: payload,
      occurredAt,
    });
    if (!sysId) return false;
    return outbox.enqueue(sysId, payload, occurredAt);
  })();
}

export { TRIGGERS };
