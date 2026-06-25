import { buildCard } from './chatCard.js';
import { formatReadableDate } from './dateFormat.js';
import type { XtmJobState } from '../detection/types.js';

// Sanitise a string to safe cardId characters (letters, digits, dashes).
const toCardId = (raw: string): string => raw.replace(/[^A-Za-z0-9]/g, '-').replace(/-{2,}/g, '-');

const langPair = (job: XtmJobState): string =>
  `${job.sourceLang ?? '—'} → ${job.targetLang ?? '—'}`;
const dueForJob = (job: XtmJobState): string | null => job.dueDate ?? job.dueRaw ?? null;

/**
 * 🆕 New detected job (English cardsV2). `statusNote` is computed by the
 * orchestration so it reflects the real action (eligible+accepting /
 * eligible+accept-disabled / not Malay). `xtmUrl` becomes the button link.
 */
export function renderXtmNewJob(
  job: XtmJobState,
  _capturedAt: string,
  statusNote: string,
  xtmUrl: string,
): { cardsV2: unknown[] } {
  return buildCard({
    cardId: `new-${toCardId(job.jobKey)}`,
    headerTitle: '🆕 New Job · XTM',
    rows: [
      { label: 'Project', value: job.projectName ?? null },
      { label: 'File', value: job.fileName ?? null },
      { label: 'Language', value: langPair(job) },
      { label: 'Due', value: formatReadableDate(dueForJob(job)) || null },
      {
        label: 'Words',
        value: job.words !== null && job.words !== undefined ? String(job.words) : null,
      },
      { label: 'Step', value: job.step ? `${job.step} (${job.role ?? '—'})` : null },
      { label: 'Status', value: statusNote },
    ],
    buttonText: 'Open in XTM',
    buttonUrl: xtmUrl,
  });
}

/**
 * 🔁 A job that disappeared and came back (relisted) — keeps the original
 * first-seen. `xtmUrl` becomes the button link.
 */
export function renderXtmRelisted(
  job: XtmJobState,
  firstSeenAt: string | undefined,
  _capturedAt: string,
  xtmUrl: string,
): { cardsV2: unknown[] } {
  return buildCard({
    cardId: `relisted-${toCardId(job.jobKey)}`,
    headerTitle: '🔁 Job Relisted · XTM',
    ...(firstSeenAt ? { headerSubtitle: `First seen ${formatReadableDate(firstSeenAt)}` } : {}),
    rows: [
      { label: 'Project', value: job.projectName ?? null },
      { label: 'File', value: job.fileName ?? null },
      { label: 'Language', value: langPair(job) },
      { label: 'Due', value: formatReadableDate(dueForJob(job)) || null },
      {
        label: 'Words',
        value: job.words !== null && job.words !== undefined ? String(job.words) : null,
      },
      { label: 'Step', value: job.step ? `${job.step} (${job.role ?? '—'})` : null },
    ],
    buttonText: 'Open in XTM',
    buttonUrl: xtmUrl,
  });
}

/** ✅ Accept succeeded (one message per job_key, never batched). */
export function renderXtmAccepted(job: XtmJobState, xtmUrl: string): { cardsV2: unknown[] } {
  return buildCard({
    cardId: `accepted-${toCardId(job.jobKey)}`,
    headerTitle: '✅ Job Accepted · XTM',
    rows: [
      { label: 'Project', value: job.projectName ?? null },
      { label: 'File', value: job.fileName ?? null },
      { label: 'Language', value: langPair(job) },
      { label: 'Due', value: formatReadableDate(dueForJob(job)) || null },
      {
        label: 'Words',
        value: job.words !== null && job.words !== undefined ? String(job.words) : null,
      },
      { label: 'Accepted', value: formatReadableDate(job.acceptedAt ?? null) || null },
    ],
    buttonText: 'Open in XTM',
    buttonUrl: xtmUrl,
  });
}

/**
 * ⚠️ Accept failed or snatched. `missing` = snatched (info, no human action
 * needed); `failed` = could not confirm (needs a human to check XTM).
 */
export function renderXtmAcceptFailed(
  job: XtmJobState,
  outcome: 'failed' | 'missing',
  reason: string | null,
  _at: string,
  xtmUrl: string,
): { cardsV2: unknown[] } {
  const cause =
    outcome === 'missing'
      ? 'snatched before we could accept'
      : `clicked but could not confirm — ${reason ?? '—'}`;
  const action = outcome === 'failed' ? 'Yes — check XTM' : 'No (job already gone)';
  const headerTitle = outcome === 'failed' ? '⚠️ Accept Failed · XTM' : '⚠️ Job Snatched · XTM';
  return buildCard({
    cardId: `acceptfailed-${toCardId(job.jobKey)}`,
    headerTitle,
    rows: [
      { label: 'Project', value: job.projectName ?? null },
      { label: 'File', value: job.fileName ?? null },
      { label: 'Language', value: langPair(job) },
      { label: 'Cause', value: cause },
      { label: 'Action', value: action },
    ],
    buttonText: 'Open in XTM',
    buttonUrl: xtmUrl,
  });
}

/** 📋 One-time summary of pre-existing jobs at startup (FR-005), with Malay count. */
export function renderXtmColdStartSummary(
  jobs: XtmJobState[],
  _occurredAt: string,
  cycleId: string,
  xtmUrl: string,
): { cardsV2: unknown[] } {
  if (jobs.length === 0) {
    return buildCard({
      cardId: `coldstart-${toCardId(cycleId)}`,
      headerTitle: '📋 XTM Monitor Started',
      headerSubtitle: 'No open jobs in Active — monitoring 24/7',
      rows: [],
      buttonText: 'Open in XTM',
      buttonUrl: xtmUrl,
    });
  }
  const eligibleCount = jobs.filter((j) => j.eligible).length;
  // Pass ALL jobs as rows — buildCard caps at 20 and appends "…and N more" itself.
  const rows = jobs.map((j) => ({
    label: `${j.projectName ?? '—'} / ${j.fileName ?? '—'}`,
    value: `${langPair(j)} · due ${formatReadableDate(dueForJob(j)) || '—'}`,
  }));
  return buildCard({
    cardId: `coldstart-${toCardId(cycleId)}`,
    headerTitle: '📋 XTM Monitor Started',
    headerSubtitle: `${jobs.length} open job(s) — Malay-eligible: ${eligibleCount}`,
    rows,
    buttonText: 'Open in XTM',
    buttonUrl: xtmUrl,
  });
}
