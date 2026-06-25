import { describe, it, expect } from 'vitest';
import {
  bangkokDate,
  dueDailyReport,
  buildDailyReportCard,
} from '../../src/reporting/dailyReport.js';
import type { XtmJobState } from '../../src/detection/types.js';

// ---------------------------------------------------------------------------
// bangkokDate — TZ-independence via +7h shift on UTC arithmetic
// ---------------------------------------------------------------------------
describe('bangkokDate', () => {
  it('UTC 18:00 on 24 Jun is Bangkok 01:00 on 25 Jun (next day)', () => {
    // 2026-06-24T18:00:00Z → +7 → 2026-06-25T01:00:00 local → date '2026-06-25'
    expect(bangkokDate(Date.parse('2026-06-24T18:00:00Z'))).toBe('2026-06-25');
  });

  it('UTC 00:00 on 25 Jun is Bangkok 07:00 on 25 Jun (same day)', () => {
    expect(bangkokDate(Date.parse('2026-06-25T00:00:00Z'))).toBe('2026-06-25');
  });

  it('UTC 16:59 on 24 Jun is Bangkok 23:59 on 24 Jun (still same day)', () => {
    expect(bangkokDate(Date.parse('2026-06-24T16:59:59Z'))).toBe('2026-06-24');
  });
});

// ---------------------------------------------------------------------------
// dueDailyReport
// ---------------------------------------------------------------------------
describe('dueDailyReport', () => {
  const T08_BKK = Date.parse('2026-06-25T01:00:00Z'); // 08:00 Bangkok (UTC+7)
  const T10_BKK = Date.parse('2026-06-25T03:00:00Z'); // 10:00 Bangkok (UTC+7)

  it('returns false when Bangkok hour < 09 (before the trigger window)', () => {
    expect(dueDailyReport(T08_BKK, null)).toBe(false);
  });

  it('returns true at 10:00 Bangkok when lastSentDate is yesterday', () => {
    expect(dueDailyReport(T10_BKK, '2026-06-24')).toBe(true);
  });

  it('returns false at 10:00 Bangkok when lastSentDate is today (already sent)', () => {
    expect(dueDailyReport(T10_BKK, '2026-06-25')).toBe(false);
  });

  it('returns true when lastSentDate is null and Bangkok hour >= 09', () => {
    expect(dueDailyReport(T10_BKK, null)).toBe(true);
  });

  it('respects a custom hour threshold', () => {
    // 10:00 BKK but threshold is 11 → not yet due
    expect(dueDailyReport(T10_BKK, null, 11)).toBe(false);
    // 10:00 BKK with threshold 10 → due
    expect(dueDailyReport(T10_BKK, null, 10)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildDailyReportCard
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse('2026-06-25T03:00:00Z'); // 10:00 Bangkok
const XTM_URL = 'https://xtm.example.com/tasks';

const makeJob = (over: Partial<XtmJobState> = {}): XtmJobState => ({
  jobKey: 'K1',
  xtmTaskId: 'T1',
  projectName: 'Project Alpha',
  fileName: 'chapter1.docx',
  sourceLang: 'English (USA)',
  targetLang: 'Malay (Malaysia)',
  dueDate: '2026-06-30T00:00:00Z',
  dueRaw: null,
  words: 1500,
  step: 'PE 1',
  role: 'Corrector',
  eligible: true,
  lifecycleStatus: 'accepted',
  acceptStatus: 'accepted',
  acceptedAt: '2026-06-25T02:00:00Z',
  status: 'visible',
  firstSeenAt: '2026-06-24T10:00:00Z',
  lastSeenAt: '2026-06-25T03:00:00Z',
  snapshotHash: 'abc123',
  consecutiveMisses: 0,
  ...over,
});

type AnyEntry = { cardId: string; card: AnyCard };
type AnyCard = { header: { title: string; subtitle?: string }; sections: AnySection[] };
type AnySection = { widgets: AnyWidget[] };
type AnyWidget = {
  decoratedText?: { topLabel?: string; text: string };
  buttonList?: { buttons: { text: string; onClick: { openLink: { url: string } } }[] };
};

function firstEntry(result: { cardsV2: unknown[] }): AnyEntry {
  const entry = result.cardsV2[0] as AnyEntry | undefined;
  if (!entry) throw new Error('cardsV2 is empty');
  return entry;
}

describe('buildDailyReportCard', () => {
  it('header title includes job count for 2 jobs', () => {
    const j1 = makeJob({ jobKey: 'K1', projectName: 'Alpha', fileName: 'a.docx' });
    const j2 = makeJob({ jobKey: 'K2', projectName: 'Beta', fileName: 'b.docx' });
    const card = buildDailyReportCard([j1, j2], NOW_MS, XTM_URL);
    const entry = firstEntry(card);
    expect(entry.card.header.title).toBe('📋 Jobs in Progress (2)');
  });

  it('header subtitle is the Bangkok date string', () => {
    const card = buildDailyReportCard([makeJob()], NOW_MS, XTM_URL);
    const entry = firstEntry(card);
    expect(entry.card.header.subtitle).toBe('2026-06-25');
  });

  it('card ID includes the Bangkok date', () => {
    const card = buildDailyReportCard([makeJob()], NOW_MS, XTM_URL);
    const entry = firstEntry(card);
    expect(entry.cardId).toBe('daily-2026-06-25');
  });

  it('each row label is the project name and value contains fileName', () => {
    const j = makeJob({ projectName: 'My Project', fileName: 'report.xlf' });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL);
    const entry = firstEntry(card);
    const rowSection = entry.card.sections[0]!;
    const widget = rowSection.widgets[0] as AnyWidget;
    expect(widget.decoratedText?.topLabel).toBe('My Project');
    expect(widget.decoratedText?.text).toContain('report.xlf');
  });

  it('row value contains "due" keyword and formatted date', () => {
    const j = makeJob({ dueDate: '2026-06-30T00:00:00Z' });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL);
    const entry = firstEntry(card);
    const widget = entry.card.sections[0]!.widgets[0] as AnyWidget;
    expect(widget.decoratedText?.text).toContain('due');
    expect(widget.decoratedText?.text).toContain('30/06/2026');
  });

  it('row value contains words count', () => {
    const j = makeJob({ words: 1500 });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL);
    const entry = firstEntry(card);
    const widget = entry.card.sections[0]!.widgets[0] as AnyWidget;
    expect(widget.decoratedText?.text).toContain('1500');
  });

  it('button links to XTM URL', () => {
    const card = buildDailyReportCard([makeJob()], NOW_MS, XTM_URL);
    const entry = firstEntry(card);
    // Button section is the last section
    const sections = entry.card.sections;
    const lastSection = sections[sections.length - 1]!;
    const btn = lastSection.widgets[0] as AnyWidget;
    expect(btn.buttonList?.buttons[0]?.onClick.openLink.url).toBe(XTM_URL);
  });

  it('empty list → title (0) and single "No jobs in progress" row', () => {
    const card = buildDailyReportCard([], NOW_MS, XTM_URL);
    const entry = firstEntry(card);
    expect(entry.card.header.title).toBe('📋 Jobs in Progress (0)');
    const widget = entry.card.sections[0]!.widgets[0] as AnyWidget;
    expect(widget.decoratedText?.text).toBe('No jobs in progress');
  });

  it('null/empty projectName falls back to dash', () => {
    const j = makeJob({ projectName: '' });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL);
    const entry = firstEntry(card);
    const widget = entry.card.sections[0]!.widgets[0] as AnyWidget;
    expect(widget.decoratedText?.topLabel).toBe('—');
  });

  it('null dueDate falls back gracefully (no crash)', () => {
    const j = makeJob({ dueDate: null, dueRaw: null });
    // should not throw
    expect(() => buildDailyReportCard([j], NOW_MS, XTM_URL)).not.toThrow();
  });
});
