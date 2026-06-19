import { formatBangkok } from './notifier.js';
import type { XtmJobState } from '../detection/types.js';

const dash = (v: string | number | null | undefined): string =>
  v !== null && v !== undefined && v !== '' ? String(v) : '—';

const langs = (job: XtmJobState): string => `${dash(job.sourceLang)} → ${dash(job.targetLang)}`;
const due = (job: XtmJobState): string => dash(job.dueDate ?? job.dueRaw);

/**
 * 🆕 New detected job (contracts/notifications.md). Sent for every detected job
 * (any language). `statusNote` is computed by the orchestration so it reflects
 * the real action (eligible+accepting / eligible+accept-disabled / not Malay).
 */
export function renderXtmNewJob(job: XtmJobState, capturedAt: string, statusNote: string): string {
  return [
    '🆕 งานใหม่บน XTM',
    `โปรเจกต์: ${dash(job.projectName)}`,
    `ไฟล์: ${dash(job.fileName)}`,
    `ภาษา: ${langs(job)}`,
    `ครบกำหนด: ${due(job)} | คำ: ${dash(job.words)} | ขั้น: ${dash(job.step)} (${dash(job.role)})`,
    `สถานะ: ${statusNote}`,
    `เวลา: ${formatBangkok(capturedAt)}`,
  ].join('\n');
}

/** ✅ Accept succeeded (one message per job_key, never batched). */
export function renderXtmAccepted(job: XtmJobState): string {
  return [
    '✅ รับงานแล้ว (XTM)',
    `โปรเจกต์: ${dash(job.projectName)}`,
    `ไฟล์: ${dash(job.fileName)} | ${langs(job)}`,
    `ครบกำหนด: ${due(job)} | คำ: ${dash(job.words)}`,
    `รับเมื่อ: ${job.acceptedAt ? formatBangkok(job.acceptedAt) : '—'}`,
  ].join('\n');
}

/**
 * ⚠️ Accept failed or snatched. `missing` = snatched (info, no human action
 * needed); `failed` = could not confirm (needs a human to check XTM).
 */
export function renderXtmAcceptFailed(
  job: XtmJobState,
  outcome: 'failed' | 'missing',
  reason: string | null,
  at: string,
): string {
  const cause =
    outcome === 'missing'
      ? 'โดนแย่ง/ถูกรับไปแล้วก่อนกดทัน'
      : `กดแล้วยืนยันไม่สำเร็จ — ${dash(reason)}`;
  const needHuman = outcome === 'failed' ? 'ใช่ — เข้าไปดูใน XTM' : 'ไม่จำเป็น (งานหลุดไปแล้ว)';
  return [
    '⚠️ กดรับไม่สำเร็จ (XTM)',
    `โปรเจกต์: ${dash(job.projectName)} | ไฟล์: ${dash(job.fileName)}`,
    langs(job),
    `สาเหตุ: ${cause}`,
    `ต้องตรวจสอบ: ${needHuman}`,
    `เวลา: ${formatBangkok(at)}`,
  ].join('\n');
}

const COLD_START_MAX_ROWS = 20;

/** 📋 One-time summary of pre-existing jobs at startup (FR-005), with Malay count. */
export function renderXtmColdStartSummary(jobs: XtmJobState[], _occurredAt: string): string {
  if (jobs.length === 0) {
    return '📋 เริ่มระบบเฝ้า XTM — ยังไม่มีงานค้างใน Active ระบบเฝ้าต่อ 24/7';
  }
  const eligible = jobs.filter((j) => j.eligible).length;
  const shown = jobs.slice(0, COLD_START_MAX_ROWS);
  const rows = shown
    .map((j) => `• ${dash(j.projectName)} / ${dash(j.fileName)} | ${langs(j)} | ส่ง ${due(j)}`)
    .join('\n');
  const more =
    jobs.length > COLD_START_MAX_ROWS ? `\n…และอีก ${jobs.length - COLD_START_MAX_ROWS} งาน` : '';
  return `📋 เริ่มระบบเฝ้า XTM — พบงานค้าง ${jobs.length} รายการ (มาเลย์ ${eligible})\n${rows}${more}`;
}
