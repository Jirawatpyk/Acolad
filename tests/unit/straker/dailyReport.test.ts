/**
 * A1 — Straker's own 09:00 daily report (owner decision 2026-09-22, FR-018 amended).
 *
 * Until now the only daily summary of Straker work was a companion row on the XTM card, in the
 * XTM room. Straker's team reads Straker's room, so the summary moves there — and gets the same
 * shape the XTM report has: what is due today against each ceiling, what is overdue, what is in
 * progress, plus the fortnightly win rate that used to ride on the XTM card.
 *
 * Everything here is pure: held work, events, a clock and a calendar in; a payload (or "nothing
 * to say") out. The scheduling and the queue are tested through the assembled bot in
 * `tests/integration/straker/dailyReport.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { CardRow } from '../../../src/reporting/chatCard.js';
import type { ClaimEvent, HeldWork, SkipEvent } from '../../../src/straker/strakerStore.js';
import { computeWinRate } from '../../../src/straker/winRate.js';
import type { WorkIdentity } from '../../../src/straker/workKey.js';
import {
  WIN_RATE_ROW_LABEL,
  WIN_RATE_WINDOW_DAYS,
  formatWinRateRow,
  winRatePeriod,
} from '../../../src/straker/winRateRow.js';
import {
  STRAKER_DAILY_REPORT_KIND,
  buildStrakerDailyReport,
  parseStrakerDailyReport,
  renderStrakerDailyReport,
  type StrakerDailyReportInput,
} from '../../../src/straker/dailyReport.js';

// September 2026 carries no Thai public holiday. Tue 22 · Wed 23 · Mon 21.
const NOW = Date.parse('2026-09-22T09:30:00+07:00'); // Tuesday, just after 09:00
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const CALENDAR = { hoursStartMin: 9 * 60, workdays: new Set([1, 2, 3, 4, 5]), holidays: new Map() };
const CEILINGS = { translation: 3_500, monolingual: 30_000 };

function held(over: Partial<HeldWork> & Pick<HeldWork, 'objId'>): HeldWork {
  return {
    effortWords: 1_000,
    kind: 'translation',
    deadlineMs: Date.parse('2026-09-22T17:00:00+07:00'),
    heldSinceMs: NOW - DAY,
    releasedAtMs: null,
    ...over,
  };
}

function identity(title: string, jobRef: string, service: string): WorkIdentity {
  return { title, jobRef, service, workKey: `${jobRef}|ms-my|${service}` };
}

const claim = (objId: string, outcome: ClaimEvent['outcome'], atMs = NOW - HOUR): ClaimEvent => ({
  objId,
  eventType: 'claim',
  outcome,
  effortWords: 4,
  deadlineMs: NOW + DAY,
  occurredAtMs: atMs,
});
const skip = (objId: string, atMs = NOW - HOUR): SkipEvent => ({
  objId,
  eventType: 'skip',
  skipReason: 'ineligible_language',
  occurredAtMs: atMs,
});

function input(over: Partial<StrakerDailyReportInput> = {}): StrakerDailyReportInput {
  return { held: [], events: [], nowMs: NOW, calendar: CALENDAR, ceilings: CEILINGS, ...over };
}

function rowOf(rows: readonly CardRow[], label: string): CardRow | undefined {
  return rows.find((r) => r.label === label);
}

describe('buildStrakerDailyReport — what the 09:00 card says', () => {
  it('reports the Bangkok date it covers and names itself', () => {
    const report = buildStrakerDailyReport(input({ held: [held({ objId: 'a' })] }));

    expect(report?.kind).toBe(STRAKER_DAILY_REPORT_KIND);
    expect(report?.date).toBe('2026-09-22');
  });

  it('sums work due today against each ceiling, translation and DTP apart', () => {
    const report = buildStrakerDailyReport(
      input({
        held: [
          held({ objId: 't1', effortWords: 1_200 }),
          // Due tomorrow BEFORE 09:00 — its work is today's (effective deadline day, the key
          // the ledger itself uses), so it belongs in today's figure.
          held({
            objId: 't2',
            effortWords: 300,
            deadlineMs: Date.parse('2026-09-23T08:00:00+07:00'),
          }),
          // Due tomorrow afternoon — not today's.
          held({
            objId: 't3',
            effortWords: 5_000,
            deadlineMs: Date.parse('2026-09-23T17:00:00+07:00'),
          }),
          held({ objId: 'd1', effortWords: 956, kind: 'monolingual' }),
        ],
      }),
    );

    expect(rowOf(report?.rows ?? [], 'Due today · translation')?.value).toBe(
      '1500 words (cap 3500/day)',
    );
    // DTP is its own budget; adding it to translation would report one ordinary DTP job as a
    // breach of a ceiling it was never charged to.
    expect(rowOf(report?.rows ?? [], 'Due today · DTP')?.value).toBe('956 words (cap 30000/day)');
  });

  it('flags overdue work — held past its deadline — on its own row and on the item', () => {
    const report = buildStrakerDailyReport(
      input({
        held: [
          held({
            objId: 'late',
            effortWords: 700,
            deadlineMs: Date.parse('2026-09-21T17:00:00+07:00'),
            identity: identity('Late.docx', 'AJ-290', 'translation'),
          }),
          held({ objId: 'fine' }),
        ],
      }),
    );

    const overdue = rowOf(report?.rows ?? [], 'Overdue');
    expect(overdue).toEqual({ emoji: '⚠️', label: 'Overdue', value: '1 job(s) · 700 words' });
    const item = report?.rows.find((r) => r.label.startsWith('Late.docx'));
    expect(item?.emoji).toBe('⚠️');
  });

  it('has no overdue row when nothing is late', () => {
    const report = buildStrakerDailyReport(input({ held: [held({ objId: 'a' })] }));

    expect(rowOf(report?.rows ?? [], 'Overdue')).toBeUndefined();
  });

  it('names each job by file, job reference and service, with its words and deadline', () => {
    const report = buildStrakerDailyReport(
      input({
        held: [
          held({
            objId: 'a',
            effortWords: 1_234,
            identity: identity('NBA - NTRY Hangtag.xlsx', 'AJ-310', 'translation'),
          }),
        ],
      }),
    );

    expect(rowOf(report?.rows ?? [], 'NBA - NTRY Hangtag.xlsx · AJ-310 · translation')?.value).toBe(
      '22/09/2026 17:00 · 1234w',
    );
  });

  it('marks DTP items and falls back to the offer id for work held without an identity', () => {
    const report = buildStrakerDailyReport(
      input({ held: [held({ objId: 'offer-9', kind: 'monolingual', deadlineMs: null })] }),
    );

    expect(rowOf(report?.rows ?? [], 'Offer offer-9')?.value).toBe('— · 1000w · DTP');
  });

  it('lists the five nearest deadlines first and counts the rest', () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      held({
        objId: `o${String(i)}`,
        deadlineMs: Date.parse('2026-09-22T17:00:00+07:00') + (6 - i) * DAY,
        identity: identity(`f${String(i)}.docx`, `AJ-${String(i)}`, 'translation'),
      }),
    );

    const rows = buildStrakerDailyReport(input({ held: items }))?.rows ?? [];
    const listed = rows.filter((r) => r.label.includes('.docx')).map((r) => r.label);

    expect(listed).toEqual([
      'f6.docx · AJ-6 · translation',
      'f5.docx · AJ-5 · translation',
      'f4.docx · AJ-4 · translation',
      'f3.docx · AJ-3 · translation',
      'f2.docx · AJ-2 · translation',
    ]);
    expect(rows.some((r) => r.value === '(+2 more)')).toBe(true);
  });

  it('says so plainly when nothing is in progress but the win rate still has something to say', () => {
    const report = buildStrakerDailyReport(
      input({ events: [claim('a', 'won'), claim('b', 'lost')] }),
    );

    expect(report).not.toBeNull();
    expect(report?.rows.some((r) => r.value === 'No jobs in progress')).toBe(true);
    expect(rowOf(report?.rows ?? [], WIN_RATE_ROW_LABEL)?.value).toContain('1 won of 2');
  });

  it('carries the fourteen-day win rate, and only events inside that window', () => {
    const report = buildStrakerDailyReport(
      input({
        held: [held({ objId: 'a' })],
        events: [
          claim('a', 'won'),
          claim('older', 'lost', NOW - (WIN_RATE_WINDOW_DAYS - 1) * DAY),
          claim('ancient', 'lost', NOW - (WIN_RATE_WINDOW_DAYS + 1) * DAY),
        ],
      }),
    );

    expect(rowOf(report?.rows ?? [], WIN_RATE_ROW_LABEL)?.value).toContain('1 won of 2');
  });
});

describe('buildStrakerDailyReport — nothing to say is a reason not to speak', () => {
  it('returns null when nothing is held and the win rate has no races and no turn-aways', () => {
    expect(buildStrakerDailyReport(input())).toBeNull();
  });

  it('ignores a record whose only events fall outside the window', () => {
    expect(
      buildStrakerDailyReport(input({ events: [claim('old', 'won', NOW - 30 * DAY)] })),
    ).toBeNull();
  });

  it('still reports when the only news is offers our own rules turned away (FR-017a)', () => {
    const report = buildStrakerDailyReport(input({ events: [skip('a'), skip('b')] }));

    expect(rowOf(report?.rows ?? [], WIN_RATE_ROW_LABEL)?.value).toContain('2 turned away');
  });

  it('still reports when work is held even with no win-rate news', () => {
    expect(buildStrakerDailyReport(input({ held: [held({ objId: 'a' })] }))).not.toBeNull();
  });
});

describe('the report as a payload on the queue, and as a card', () => {
  it('survives the queue: what is built parses back to the same report', () => {
    const report = buildStrakerDailyReport(input({ held: [held({ objId: 'a' })] }));
    const parsed = parseStrakerDailyReport(JSON.parse(JSON.stringify(report)));

    expect(parsed).toEqual({ ok: true, value: report });
  });

  it('refuses a payload that is not a daily report rather than rendering half a card', () => {
    expect(parseStrakerDailyReport({ kind: 'daily_report', date: 'yesterday', rows: [] }).ok).toBe(
      false,
    );
    expect(
      parseStrakerDailyReport({ kind: 'daily_report', date: '2026-09-22', rows: 'x' }).ok,
    ).toBe(false);
    expect(
      parseStrakerDailyReport({ kind: 'daily_report', date: '2026-09-22', rows: [{ value: 'x' }] })
        .ok,
    ).toBe(false);
    expect(parseStrakerDailyReport({ kind: 'daily_report', date: '2026-09-22', rows: [] }).ok).toBe(
      false,
    );
  });

  it('renders a card titled with the portal and the Bangkok date', () => {
    const report = buildStrakerDailyReport(input({ held: [held({ objId: 'a' })] }));
    if (report === null) throw new Error('expected a report');

    const card = renderStrakerDailyReport(report) as unknown as {
      cardsV2: { cardId: string; card: { header: { title: string } } }[];
    };

    expect(card.cardsV2[0]?.card.header.title).toBe('📋 Straker Daily Report — 22/09/2026');
    expect(card.cardsV2[0]?.cardId).toBe('straker-daily-2026-09-22');
  });
});

describe('formatWinRateRow — one formatter for every surface that shows the rate', () => {
  const PERIOD_LABEL = 'the last 14 days';
  const rowFor = (events: Parameters<typeof computeWinRate>[0]): CardRow =>
    formatWinRateRow(computeWinRate(events), PERIOD_LABEL);

  it('reports the rate, the numerator and the denominator — never a bare percentage', () => {
    const row = rowFor([claim('a', 'won'), claim('b', 'lost'), claim('c', 'lost')]);

    expect(row.label).toBe(WIN_RATE_ROW_LABEL);
    expect(row.value).toContain('33.3%');
    expect(row.value).toContain('1 won of 3');
  });

  it('says n/a rather than 0% when nothing was genuinely winnable', () => {
    const row = rowFor([skip('a'), skip('b')]);

    expect(row.value).toContain('n/a');
    expect(row.value).not.toContain('0.0%');
    // The turn-away count is the only figure there is, so it travels on the n/a line too.
    expect(row.value).toContain('2 turned away');
  });

  it('reports offers turned away beside the rate, because one number hides the other', () => {
    expect(rowFor([claim('a', 'won'), claim('b', 'lost'), skip('c'), skip('d')]).value).toContain(
      '2 turned away',
    );
  });

  it('says the figure is a lower bound while claims are still unresolved', () => {
    expect(rowFor([claim('a', 'won'), claim('b', 'unknown')]).value).toMatch(/lower bound/i);
  });

  it('marks a small sample as a weak signal, which is what SC-004 turns on', () => {
    expect(rowFor([claim('a', 'won'), claim('b', 'lost')]).value).toMatch(/weak signal/i);
  });

  it('pins the window at fourteen days and measures back from now', () => {
    // Shortening it puts the figure below the weak-signal threshold forever; lengthening it
    // stops describing a baseline anyone acted on.
    expect(WIN_RATE_WINDOW_DAYS).toBe(14);
    expect(winRatePeriod(NOW)).toEqual({
      fromMs: NOW - 14 * DAY,
      toMs: NOW,
      label: 'the last 14 days',
    });
  });
});
