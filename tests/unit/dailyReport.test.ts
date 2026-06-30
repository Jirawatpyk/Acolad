import { describe, it, expect } from 'vitest';
import { dueDailyReport, buildDailyReportCard } from '../../src/reporting/dailyReport.js';
import { bangkokDateString } from '../../src/schedule/bangkokCalendar.js';
import type { XtmJobState } from '../../src/detection/types.js';

// ---------------------------------------------------------------------------
// bangkokDateString — TZ-independence via +7h shift on UTC arithmetic. (The daily report's
// internal date keying now uses bangkokDateString directly; the old bangkokDate delegate is gone.)
// ---------------------------------------------------------------------------
describe('bangkokDateString (daily-report date keying)', () => {
  it('UTC 18:00 on 24 Jun is Bangkok 01:00 on 25 Jun (next day)', () => {
    // 2026-06-24T18:00:00Z → +7 → 2026-06-25T01:00:00 local → date '2026-06-25'
    expect(bangkokDateString(Date.parse('2026-06-24T18:00:00Z'))).toBe('2026-06-25');
  });

  it('UTC 00:00 on 25 Jun is Bangkok 07:00 on 25 Jun (same day)', () => {
    expect(bangkokDateString(Date.parse('2026-06-25T00:00:00Z'))).toBe('2026-06-25');
  });

  it('UTC 16:59 on 24 Jun is Bangkok 23:59 on 24 Jun (still same day)', () => {
    expect(bangkokDateString(Date.parse('2026-06-24T16:59:59Z'))).toBe('2026-06-24');
  });
});

// ---------------------------------------------------------------------------
// dueDailyReport
// ---------------------------------------------------------------------------
describe('dueDailyReport', () => {
  const WORKDAYS_MON_FRI = new Set([1, 2, 3, 4, 5]); // ISO weekdays: Mon=1..Fri=5
  const NO_HOLIDAYS = new Map<string, string>();

  // Thu 2026-06-25 at various Bangkok times
  const T08_BKK = Date.parse('2026-06-25T01:00:00Z'); // 08:00 Bangkok (UTC+7)
  const T10_BKK = Date.parse('2026-06-25T03:00:00Z'); // 10:00 Bangkok (UTC+7)

  // ---------- existing behaviour (Thursday 2026-06-25 — a working day) ----------

  it('returns false when Bangkok hour < 09 (before the trigger window)', () => {
    expect(dueDailyReport(T08_BKK, null, WORKDAYS_MON_FRI, NO_HOLIDAYS)).toBe(false);
  });

  it('returns true at 10:00 Bangkok when lastSentDate is yesterday', () => {
    expect(dueDailyReport(T10_BKK, '2026-06-24', WORKDAYS_MON_FRI, NO_HOLIDAYS)).toBe(true);
  });

  it('returns false at 10:00 Bangkok when lastSentDate is today (already sent)', () => {
    expect(dueDailyReport(T10_BKK, '2026-06-25', WORKDAYS_MON_FRI, NO_HOLIDAYS)).toBe(false);
  });

  it('returns true when lastSentDate is null and Bangkok hour >= 09', () => {
    expect(dueDailyReport(T10_BKK, null, WORKDAYS_MON_FRI, NO_HOLIDAYS)).toBe(true);
  });

  it('respects a custom hour threshold', () => {
    // 10:00 BKK but threshold is 11 → not yet due
    expect(dueDailyReport(T10_BKK, null, WORKDAYS_MON_FRI, NO_HOLIDAYS, 11)).toBe(false);
    // 10:00 BKK with threshold 10 → due
    expect(dueDailyReport(T10_BKK, null, WORKDAYS_MON_FRI, NO_HOLIDAYS, 10)).toBe(true);
  });

  // ---------- working-day gate (new) ----------

  // TZ-explicit epochs so the test is identical in UTC (CI) and Bangkok (dev machine).
  // Mon 2026-06-22: weekday=1 (ISO Mon=1). Sat 2026-06-20: weekday=6 (ISO Sat=6).
  const MON_09_00 = Date.parse('2026-06-22T09:00:00+07:00'); // Mon 2026-06-22 09:00 BKK
  const MON_08_59 = Date.parse('2026-06-22T08:59:00+07:00'); // Mon 2026-06-22 08:59 BKK
  const MON_10_00 = Date.parse('2026-06-22T10:00:00+07:00'); // Mon 2026-06-22 10:00 BKK
  const SAT_10_00 = Date.parse('2026-06-20T10:00:00+07:00'); // Sat 2026-06-20 10:00 BKK

  it('working weekday at 09:00 BKK (not yet sent) → true', () => {
    expect(dueDailyReport(MON_09_00, null, WORKDAYS_MON_FRI, NO_HOLIDAYS)).toBe(true);
  });

  it('working weekday before 09:00 BKK → false', () => {
    expect(dueDailyReport(MON_08_59, null, WORKDAYS_MON_FRI, NO_HOLIDAYS)).toBe(false);
  });

  it('working weekday already-sent today → false', () => {
    expect(dueDailyReport(MON_10_00, '2026-06-22', WORKDAYS_MON_FRI, NO_HOLIDAYS)).toBe(false);
  });

  it('Saturday at 10:00 BKK (not sent) → false (weekend skipped)', () => {
    expect(dueDailyReport(SAT_10_00, null, WORKDAYS_MON_FRI, NO_HOLIDAYS)).toBe(false);
  });

  it('weekday in holidays map → false (holiday skipped)', () => {
    const holidays = new Map([['2026-06-22', 'Test Holiday']]);
    expect(dueDailyReport(MON_10_00, null, WORKDAYS_MON_FRI, holidays)).toBe(false);
  });

  it('weekday with empty holidays map (uncurated year fail-open) → true', () => {
    // An empty holidays map means the year is uncurated — report still fires.
    // A missed report is worse than an extra one; do NOT suppress on uncurated years.
    expect(dueDailyReport(MON_10_00, null, WORKDAYS_MON_FRI, NO_HOLIDAYS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildDailyReportCard — new tests (Task 1 brief: spec §7 #4, #5, #6)
// ---------------------------------------------------------------------------

// Minimal XtmJobState factory. jobKey = fileName so sort-by-key tie-breaks are deterministic.
const job = (o: Partial<XtmJobState>): XtmJobState =>
  ({
    jobKey: o.fileName ?? 'k',
    xtmTaskId: null,
    projectName: o.projectName ?? 'P',
    fileName: o.fileName ?? 'f',
    sourceLang: null,
    targetLang: 'Malay (Malaysia)',
    dueDate: o.dueDate ?? null,
    dueRaw: o.dueRaw ?? null,
    words: o.words ?? null,
    step: null,
    role: null,
    eligible: true,
    lifecycleStatus: 'accepted',
    acceptStatus: 'accepted',
    acceptedAt: null,
    status: 'visible',
    firstSeenAt: '',
    lastSeenAt: '',
    snapshotHash: '',
    consecutiveMisses: 0,
  }) as XtmJobState;

// TZ-explicit: 2026-06-25 09:00 Bangkok
const NOW = Date.parse('2026-06-25T09:00:00+07:00');
const text = (r: { cardsV2: unknown[] }) => JSON.stringify(r);

it('Due-today headline sums held words whose deadline date is today (night accept incl.)', () => {
  const held = [
    job({ fileName: 'a', dueDate: '2026-06-25T18:00:00+07:00', words: 200 }), // today
    job({ fileName: 'b', dueDate: '2026-06-25T02:00:00+07:00', words: 100 }), // today (already past instant)
    job({ fileName: 'c', dueDate: '2026-06-26T18:00:00+07:00', words: 500 }), // tomorrow
  ];
  const card = text(buildDailyReportCard(held, NOW, 'http://x', 1000));
  expect(card).toContain('Due today');
  expect(card).toContain('300 words'); // 200 + 100, NOT 800
  expect(card).toContain('cap 1000/day');
});

it('Overdue (instant-based) row appears only when a held deadline is past; omitted otherwise', () => {
  const overdue = text(
    buildDailyReportCard(
      [job({ fileName: 'b', dueDate: '2026-06-25T02:00:00+07:00', words: 100 })],
      NOW,
      'http://x',
      1000,
    ),
  );
  expect(overdue).toContain('Overdue');
  const none = text(
    buildDailyReportCard(
      [job({ fileName: 'a', dueDate: '2026-06-25T18:00:00+07:00', words: 200 })],
      NOW,
      'http://x',
      1000,
    ),
  );
  expect(none).not.toContain('Overdue');
});

it('bucket boundary is Bangkok day: 23:59 today counts, next-day 00:00 does not', () => {
  const inDay = text(
    buildDailyReportCard(
      [job({ dueDate: '2026-06-25T23:59:00+07:00', words: 100 })],
      NOW,
      'http://x',
      1000,
    ),
  );
  expect(inDay).toContain('100 words');
  const nextDay = text(
    buildDailyReportCard(
      [job({ dueDate: '2026-06-26T00:00:00+07:00', words: 100 })],
      NOW,
      'http://x',
      1000,
    ),
  );
  expect(nextDay).toContain('0 words');
});

it('is TOTAL: a null and an unparseable deadline + null words never throw and sort last', () => {
  const held = [
    job({ fileName: 'good', dueDate: '2026-06-25T18:00:00+07:00', words: 100 }),
    job({ fileName: 'bad', dueDate: 'not-a-date', words: null }),
    job({ fileName: 'nul', dueDate: null, words: 50 }),
  ];
  expect(() => buildDailyReportCard(held, NOW, 'http://x', 1000)).not.toThrow();
  const card = text(buildDailyReportCard(held, NOW, 'http://x', 1000));
  expect(card).toContain('100 words'); // bad/nul excluded from the sum
});

it('empty held → an explicit "No jobs in progress" row (not just a bare Due-today line)', () => {
  const card = text(buildDailyReportCard([], NOW, 'http://x', 1000));
  expect(card).toContain('No jobs in progress'); // operators can tell empty from a broken card
  expect(card).toContain('0 words');
});

it('In-progress shows top 5 by deadline asc; "(+N more)" only when N>0', () => {
  const five = Array.from({ length: 5 }, (_, i) =>
    job({ fileName: `f${i}`, dueDate: `2026-06-2${5 + i}T18:00:00+07:00`, words: 10 }),
  );
  expect(text(buildDailyReportCard(five, NOW, 'http://x', 1000))).not.toContain('more');
  const six = [...five, job({ fileName: 'f6', dueDate: '2026-07-01T18:00:00+07:00', words: 10 })];
  expect(text(buildDailyReportCard(six, NOW, 'http://x', 1000))).toContain('1 more');
});

it('with 6 held jobs the In-progress list shows the 5 EARLIEST; the LATEST is dropped', () => {
  // Distinct filenames so a substring can't accidentally match another row.
  const six = [
    job({ fileName: 'early0', dueDate: '2026-06-25T18:00:00+07:00', words: 10 }),
    job({ fileName: 'early1', dueDate: '2026-06-26T18:00:00+07:00', words: 10 }),
    job({ fileName: 'early2', dueDate: '2026-06-27T18:00:00+07:00', words: 10 }),
    job({ fileName: 'early3', dueDate: '2026-06-28T18:00:00+07:00', words: 10 }),
    job({ fileName: 'early4', dueDate: '2026-06-29T18:00:00+07:00', words: 10 }),
    job({ fileName: 'latest', dueDate: '2026-06-30T18:00:00+07:00', words: 10 }),
  ];
  const card = text(buildDailyReportCard(six, NOW, 'http://x', 1000));
  for (const f of ['early0', 'early1', 'early2', 'early3', 'early4']) expect(card).toContain(f);
  expect(card).not.toContain('latest'); // latest deadline → dropped past the top-5 slice
  expect(card).toContain('1 more');
});

it('a held job with a non-finite deadline sorts LAST (after a finite-deadline job)', () => {
  // 'bad' has an unparseable deadline → +Infinity → must sort after the finite 'fin' job.
  const held = [
    job({ fileName: 'bad', dueDate: 'garbage', words: 10 }),
    job({ fileName: 'fin', dueDate: '2026-06-25T18:00:00+07:00', words: 10 }),
  ];
  const card = text(buildDailyReportCard(held, NOW, 'http://x', 1000));
  expect(card.indexOf('fin')).toBeLessThan(card.indexOf('bad')); // finite renders first
});

it('cap=0 → "(no cap)" headline', () => {
  expect(
    text(
      buildDailyReportCard(
        [job({ dueDate: '2026-06-25T18:00:00+07:00', words: 100 })],
        NOW,
        'http://x',
        0,
      ),
    ),
  ).toContain('no cap');
});

it('header is "📋 Daily Report — DD/MM/YYYY" in Bangkok format', () => {
  // NOW = 2026-06-25T09:00:00+07:00 → Bangkok date '2026-06-25' → '25/06/2026'
  const card = text(buildDailyReportCard([], NOW, 'http://x', 1000));
  expect(card).toContain('📋 Daily Report — 25/06/2026');
});

// ---------------------------------------------------------------------------
// buildDailyReportCard — migrated structural tests (4-arg signature)
// ---------------------------------------------------------------------------

// TZ-explicit: 2026-06-25 10:00 Bangkok
const NOW_MS = Date.parse('2026-06-25T03:00:00Z');
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
  fileWwc: null,
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

describe('buildDailyReportCard — structural', () => {
  it('card ID includes the Bangkok date', () => {
    const card = buildDailyReportCard([makeJob()], NOW_MS, XTM_URL, 0);
    expect(firstEntry(card).cardId).toBe('daily-2026-06-25');
  });

  it('row label is the project name; value contains fileName', () => {
    const j = makeJob({ projectName: 'My Project', fileName: 'report.xlf' });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL, 0);
    // widgets[0] = Due-today row; job row at widgets[1] (no overdue for Jun 30 job)
    const widget = firstEntry(card).card.sections[0]!.widgets[1] as AnyWidget;
    expect(widget.decoratedText?.topLabel).toBe('My Project');
    expect(widget.decoratedText?.text).toContain('report.xlf');
  });

  it('job row value contains the formatted due date', () => {
    const j = makeJob({ dueDate: '2026-06-30T00:00:00Z' });
    // Bangkok: 2026-06-30T07:00 → '30/06/2026 07:00'
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL, 0);
    const widget = firstEntry(card).card.sections[0]!.widgets[1] as AnyWidget;
    expect(widget.decoratedText?.text).toContain('30/06/2026');
  });

  it('job row value contains words count', () => {
    const j = makeJob({ words: 1500 });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL, 0);
    const widget = firstEntry(card).card.sections[0]!.widgets[1] as AnyWidget;
    expect(widget.decoratedText?.text).toContain('1500');
  });

  it('button links to XTM URL', () => {
    const card = buildDailyReportCard([makeJob()], NOW_MS, XTM_URL, 0);
    const sections = firstEntry(card).card.sections;
    const lastSection = sections[sections.length - 1]!;
    const btn = lastSection.widgets[0] as AnyWidget;
    expect(btn.buttonList?.buttons[0]?.onClick.openLink.url).toBe(XTM_URL);
  });

  it('null/empty projectName falls back to dash', () => {
    const j = makeJob({ projectName: '' });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL, 0);
    const widget = firstEntry(card).card.sections[0]!.widgets[1] as AnyWidget;
    expect(widget.decoratedText?.topLabel).toBe('—');
  });

  it('null dueDate falls back gracefully (no crash)', () => {
    const j = makeJob({ dueDate: null, dueRaw: null });
    expect(() => buildDailyReportCard([j], NOW_MS, XTM_URL, 0)).not.toThrow();
  });

  it('null words renders "—" not "—w" (Fix 8 — null is not a real value)', () => {
    const j = makeJob({ words: null });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL, 0);
    const widget = firstEntry(card).card.sections[0]!.widgets[1] as AnyWidget;
    const t = widget.decoratedText?.text ?? '';
    expect(t).not.toContain('—w');
    expect(t).toContain(' · —');
  });

  it('words=0 renders "0w" (Fix 8 — zero is a real value)', () => {
    const j = makeJob({ words: 0 });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL, 0);
    const widget = firstEntry(card).card.sections[0]!.widgets[1] as AnyWidget;
    expect(widget.decoratedText?.text).toContain('0w');
  });

  it('positive words render with "w" suffix (e.g. 1500w)', () => {
    const j = makeJob({ words: 1500 });
    const card = buildDailyReportCard([j], NOW_MS, XTM_URL, 0);
    const widget = firstEntry(card).card.sections[0]!.widgets[1] as AnyWidget;
    expect(widget.decoratedText?.text).toContain('1500w');
  });
});
