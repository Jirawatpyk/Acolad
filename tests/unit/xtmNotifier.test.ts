import { describe, it, expect } from 'vitest';
import {
  renderXtmNewJob,
  renderXtmAccepted,
  renderXtmAcceptFailed,
  renderXtmColdStartSummary,
} from '../../src/reporting/xtmNotifier.js';
import type { XtmJobState } from '../../src/detection/types.js';

const xstate = (over: Partial<XtmJobState> = {}): XtmJobState => ({
  jobKey: 'k',
  xtmTaskId: 'ID-1',
  projectName: 'Acme Q3',
  fileName: 'chapter-01.docx',
  sourceLang: 'English (USA)',
  targetLang: 'Malay (Malaysia)',
  dueDate: null,
  dueRaw: '18-Jun-2026 19:25',
  words: 120,
  step: 'Post-Editing (PE) 1',
  role: 'Corrector',
  eligible: true,
  lifecycleStatus: 'new',
  acceptStatus: 'none',
  acceptedAt: null,
  status: 'visible',
  firstSeenAt: '2026-06-19T03:00:00.000Z',
  lastSeenAt: '2026-06-19T03:00:00.000Z',
  snapshotHash: 'h',
  consecutiveMisses: 0,
  ...over,
});

describe('XTM notifier (contracts/notifications.md, FR-019)', () => {
  it('renders a new-job message with XTM fields + the status note', () => {
    const msg = renderXtmNewJob(xstate(), '2026-06-19T03:00:00.000Z', 'เข้าเกณฑ์มาเลย์ (MS)');
    expect(msg).toContain('🆕 งานใหม่บน XTM');
    expect(msg).toContain('Acme Q3');
    expect(msg).toContain('chapter-01.docx');
    expect(msg).toContain('English (USA) → Malay (Malaysia)');
    expect(msg).toContain('เข้าเกณฑ์มาเลย์ (MS)');
    expect(msg).toMatch(/\+07:00/);
  });

  it('renders a non-Malay new-job with a dash for unknown fields', () => {
    const msg = renderXtmNewJob(
      xstate({ targetLang: 'Thai', words: null, step: null }),
      '2026-06-19T03:00:00.000Z',
      'ไม่ใช่มาเลย์ — บันทึกไว้เฉย ๆ',
    );
    expect(msg).toContain('→ Thai');
    expect(msg).toContain('—'); // dash for null words/step
  });

  it('renders an accepted message (✅) with the accepted-at time', () => {
    const msg = renderXtmAccepted(xstate({ acceptedAt: '2026-06-19T03:00:05.000Z' }));
    expect(msg).toContain('✅ รับงานแล้ว');
    expect(msg).toContain('chapter-01.docx');
    expect(msg).toMatch(/10:00/); // 03:00 UTC -> 10:00 +07:00
  });

  it('renders a snatched (missing) message that needs no human action', () => {
    const msg = renderXtmAcceptFailed(xstate(), 'missing', null, '2026-06-19T03:00:00.000Z');
    expect(msg).toContain('⚠️ กดรับไม่สำเร็จ');
    expect(msg).toContain('โดนแย่ง');
    expect(msg).toMatch(/ไม่จำเป็น/);
  });

  it('renders an accept-failed message that DOES need human action + reason', () => {
    const msg = renderXtmAcceptFailed(
      xstate(),
      'failed',
      'ยืนยันสำเร็จไม่ได้',
      '2026-06-19T03:00:00.000Z',
    );
    expect(msg).toContain('⚠️ กดรับไม่สำเร็จ');
    expect(msg).toContain('ยืนยันสำเร็จไม่ได้');
    expect(msg).toMatch(/ใช่/);
  });

  it('renders a cold-start summary with the Malay-eligible count', () => {
    const jobs = [
      xstate({ jobKey: 'a', eligible: true }),
      xstate({ jobKey: 'b', eligible: false, targetLang: 'Thai' }),
      xstate({ jobKey: 'c', eligible: true }),
    ];
    const msg = renderXtmColdStartSummary(jobs, '2026-06-19T03:00:00.000Z');
    expect(msg).toContain('📋');
    expect(msg).toContain('3'); // total
    expect(msg).toMatch(/มาเลย์.*2|2.*มาเลย์/); // 2 eligible
  });

  it('renders the empty cold-start summary', () => {
    const msg = renderXtmColdStartSummary([], '2026-06-19T03:00:00.000Z');
    expect(msg).toContain('📋');
  });
});
