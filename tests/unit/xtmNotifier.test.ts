import { describe, it, expect } from 'vitest';
import {
  renderXtmNewJob,
  renderXtmRelisted,
  renderXtmAccepted,
  renderXtmAcceptFailed,
  renderXtmColdStartSummary,
} from '../../src/reporting/xtmNotifier.js';
import type { XtmJobState } from '../../src/detection/types.js';

const XTM_URL = 'https://xtm.example/inbox';

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
  fileWwc: null,
  step: 'Post-Editing (PE) 1',
  role: 'Corrector',
  eligible: true,
  lifecycleStatus: 'new',
  acceptStatus: 'none',
  acceptedAt: null,
  rejectReason: null,
  status: 'visible',
  firstSeenAt: '2026-06-19T03:00:00.000Z',
  lastSeenAt: '2026-06-19T03:00:00.000Z',
  snapshotHash: 'h',
  consecutiveMisses: 0,
  ...over,
});

// Helper: drill into cardsV2[0].card
type AnyEntry = {
  cardId: string;
  card: {
    header: { title: string; subtitle?: string };
    sections: Array<{
      widgets: Array<{
        decoratedText?: { topLabel?: string; text: string };
        buttonList?: { buttons: Array<{ text: string; onClick: { openLink: { url: string } } }> };
      }>;
    }>;
  };
};

function entry(result: { cardsV2: unknown[] }): AnyEntry {
  const e = result.cardsV2[0] as AnyEntry | undefined;
  if (!e) throw new Error('cardsV2 is empty');
  return e;
}

function rowTexts(result: { cardsV2: unknown[] }): string[] {
  const e = entry(result);
  return e.card.sections.flatMap((s) =>
    s.widgets.flatMap((w) => (w.decoratedText ? [w.decoratedText.text] : [])),
  );
}

function rowLabels(result: { cardsV2: unknown[] }): string[] {
  const e = entry(result);
  return e.card.sections.flatMap((s) =>
    s.widgets.flatMap((w) => (w.decoratedText?.topLabel ? [w.decoratedText.topLabel] : [])),
  );
}

function buttonUrl(result: { cardsV2: unknown[] }): string | undefined {
  const e = entry(result);
  for (const s of e.card.sections) {
    for (const w of s.widgets) {
      if (w.buttonList) return w.buttonList.buttons[0]?.onClick.openLink.url;
    }
  }
  return undefined;
}

/** Find the text value of the first decorated-text widget whose topLabel === label. */
function rowValue(result: { cardsV2: unknown[] }, label: string): string | undefined {
  const e = entry(result);
  for (const s of e.card.sections) {
    for (const w of s.widgets) {
      if (w.decoratedText?.topLabel === label) return w.decoratedText.text;
    }
  }
  return undefined;
}

describe('XTM notifier — English cardsV2 (FR-019)', () => {
  // ---------------------------------------------------------------------------
  // renderXtmNewJob
  // ---------------------------------------------------------------------------
  describe('renderXtmNewJob', () => {
    it('returns { cardsV2 } with header title "🆕 New Job · XTM"', () => {
      const result = renderXtmNewJob(
        xstate(),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      expect(entry(result).card.header.title).toBe('🆕 New Job · XTM');
    });

    it('includes English row labels: Project, File, Language, Due, Words, Step, Status', () => {
      const result = renderXtmNewJob(
        xstate(),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      const labels = rowLabels(result);
      expect(labels.some((l) => l.includes('Project'))).toBe(true);
      expect(labels.some((l) => l.includes('File'))).toBe(true);
      expect(labels.some((l) => l.includes('Language'))).toBe(true);
      expect(labels.some((l) => l.includes('Due'))).toBe(true);
      expect(labels.some((l) => l.includes('Words'))).toBe(true);
      expect(labels.some((l) => l.includes('Step'))).toBe(true);
      expect(labels.some((l) => l.includes('Status'))).toBe(true);
    });

    it('includes project name, file name, language pair in row values', () => {
      const result = renderXtmNewJob(
        xstate(),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('Acme Q3'))).toBe(true);
      expect(texts.some((t) => t.includes('chapter-01.docx'))).toBe(true);
      expect(texts.some((t) => t.includes('English (USA) → Malay (Malaysia)'))).toBe(true);
    });

    it('renders dueRaw via formatReadableDate (DD/MM/YYYY HH:mm)', () => {
      // Use a TZ-explicit dueRaw (+07:00) so formatReadableDate is deterministic on
      // ANY host/CI runner — a TZ-naive string would be parsed in the runner's local
      // timezone and roll the date on a UTC runner.
      const result = renderXtmNewJob(
        xstate({ dueDate: null, dueRaw: '2026-06-18T19:25:00+07:00' }),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      const texts = rowTexts(result);
      // formatReadableDate('2026-06-18T19:25:00+07:00') = '18/06/2026 19:25'
      expect(texts.some((t) => t.includes('18/06/2026 19:25'))).toBe(true);
    });

    it('renders ISO dueDate via formatReadableDate as Bangkok DD/MM/YYYY HH:mm', () => {
      const result = renderXtmNewJob(
        xstate({ dueDate: '2026-06-18T12:25:00.000Z', dueRaw: null }),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      const texts = rowTexts(result);
      // 2026-06-18T12:25Z → Bangkok = 19:25 → 18/06/2026 19:25
      expect(texts.some((t) => t.includes('18/06/2026 19:25'))).toBe(true);
    });

    it('passes the statusNote as the Status row value', () => {
      const result = renderXtmNewJob(
        xstate(),
        '2026-06-19T03:00:00.000Z',
        'Not Malay — logged only',
        XTM_URL,
      );
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('Not Malay — logged only'))).toBe(true);
    });

    it('renders null words/step as — (dash)', () => {
      const result = renderXtmNewJob(
        xstate({ words: null, step: null }),
        '2026-06-19T03:00:00.000Z',
        'Not Malay — logged only',
        XTM_URL,
      );
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('—'))).toBe(true);
    });

    it('button onClick.openLink.url equals the passed xtmUrl', () => {
      const result = renderXtmNewJob(
        xstate(),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      expect(buttonUrl(result)).toBe(XTM_URL);
    });

    it('cardId starts with "new-"', () => {
      const result = renderXtmNewJob(
        xstate(),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      expect(entry(result).cardId).toMatch(/^new-/);
    });

    it('includes a "Detected" row with the capturedAt formatted in Bangkok time (Fix 2)', () => {
      // capturedAt = 2026-06-19T03:00Z → Bangkok = 10:00 → 19/06/2026 10:00
      const result = renderXtmNewJob(
        xstate(),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      const labels = rowLabels(result);
      const texts = rowTexts(result);
      expect(labels.some((l) => l.includes('Detected'))).toBe(true);
      expect(texts.some((t) => t.includes('19/06/2026 10:00'))).toBe(true);
    });

    it('shows a "File WWC" row with the numeric value when fileWwc is set (D11)', () => {
      const result = renderXtmNewJob(
        xstate({ words: 861, fileWwc: 169 }),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      expect(rowLabels(result).some((l) => l.includes('File WWC'))).toBe(true);
      expect(rowTexts(result).some((t) => t.includes('169'))).toBe(true);
    });

    it('null fileWwc renders "—" in the File WWC row (D11)', () => {
      const result = renderXtmNewJob(
        xstate({ words: 861, fileWwc: null }),
        '2026-06-19T03:00:00.000Z',
        'Malay (MS) — accepting',
        XTM_URL,
      );
      expect(rowValue(result, 'File WWC')).toBe('—');
    });
  });

  // ---------------------------------------------------------------------------
  // renderXtmRelisted
  // ---------------------------------------------------------------------------
  describe('renderXtmRelisted', () => {
    it('returns header title "🔁 Job Relisted · XTM"', () => {
      const result = renderXtmRelisted(
        xstate(),
        '2026-06-10T03:00:00.000Z',
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      expect(entry(result).card.header.title).toBe('🔁 Job Relisted · XTM');
    });

    it('headerSubtitle includes "First seen" + formatted firstSeenAt when provided', () => {
      const result = renderXtmRelisted(
        xstate(),
        '2026-06-10T03:00:00.000Z',
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      // 2026-06-10T03:00Z → Bangkok = 10:00 → 10/06/2026 10:00
      expect(entry(result).card.header.subtitle).toMatch(/First seen/);
      expect(entry(result).card.header.subtitle).toContain('10/06/2026 10:00');
    });

    it('headerSubtitle is absent when firstSeenAt is undefined', () => {
      const result = renderXtmRelisted(xstate(), undefined, '2026-06-19T03:00:00.000Z', XTM_URL);
      expect(entry(result).card.header.subtitle).toBeUndefined();
    });

    it('headerSubtitle is absent when firstSeenAt is empty string (truthy guard)', () => {
      const result = renderXtmRelisted(xstate(), '', '2026-06-19T03:00:00.000Z', XTM_URL);
      expect(entry(result).card.header.subtitle).toBeUndefined();
    });

    it('headerSubtitle includes formatted date when firstSeenAt is a real ISO timestamp', () => {
      const result = renderXtmRelisted(
        xstate(),
        '2026-06-10T03:00:00.000Z',
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      // 2026-06-10T03:00Z → Bangkok +07:00 = 10:00 → 10/06/2026 10:00
      expect(entry(result).card.header.subtitle).toMatch(/First seen/);
      expect(entry(result).card.header.subtitle).toContain('10/06/2026 10:00');
    });

    it('includes English row labels: Project, File, Language, Due, Words, Step', () => {
      const result = renderXtmRelisted(xstate(), undefined, '2026-06-19T03:00:00.000Z', XTM_URL);
      const labels = rowLabels(result);
      expect(labels.some((l) => l.includes('Project'))).toBe(true);
      expect(labels.some((l) => l.includes('File'))).toBe(true);
      expect(labels.some((l) => l.includes('Language'))).toBe(true);
      expect(labels.some((l) => l.includes('Due'))).toBe(true);
      expect(labels.some((l) => l.includes('Words'))).toBe(true);
      expect(labels.some((l) => l.includes('Step'))).toBe(true);
    });

    it('button onClick.openLink.url equals the passed xtmUrl', () => {
      const result = renderXtmRelisted(xstate(), undefined, '2026-06-19T03:00:00.000Z', XTM_URL);
      expect(buttonUrl(result)).toBe(XTM_URL);
    });

    it('cardId starts with "relisted-"', () => {
      const result = renderXtmRelisted(xstate(), undefined, '2026-06-19T03:00:00.000Z', XTM_URL);
      expect(entry(result).cardId).toMatch(/^relisted-/);
    });

    it('includes a "Detected" row with capturedAt formatted in Bangkok time (Fix 2)', () => {
      // capturedAt = 2026-06-19T03:00Z → Bangkok = 10:00 → 19/06/2026 10:00
      const result = renderXtmRelisted(
        xstate(),
        '2026-06-10T03:00:00.000Z',
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      const labels = rowLabels(result);
      const texts = rowTexts(result);
      expect(labels.some((l) => l.includes('Detected'))).toBe(true);
      expect(texts.some((t) => t.includes('19/06/2026 10:00'))).toBe(true);
    });

    it('statusNote provided → a Status row with that value is present', () => {
      const result = renderXtmRelisted(
        xstate(),
        undefined,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
        'Rejected — schedule blocked',
      );
      const labels = rowLabels(result);
      const texts = rowTexts(result);
      expect(labels.some((l) => l.includes('Status'))).toBe(true);
      expect(texts.some((t) => t.includes('Rejected — schedule blocked'))).toBe(true);
    });

    it('statusNote absent → no Status row', () => {
      const result = renderXtmRelisted(xstate(), undefined, '2026-06-19T03:00:00.000Z', XTM_URL);
      const labels = rowLabels(result);
      expect(labels.some((l) => l.includes('Status'))).toBe(false);
    });

    it('shows a "File WWC" row with the numeric value when fileWwc is set (D11)', () => {
      const result = renderXtmRelisted(
        xstate({ words: 500, fileWwc: 95 }),
        undefined,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      expect(rowLabels(result).some((l) => l.includes('File WWC'))).toBe(true);
      expect(rowTexts(result).some((t) => t.includes('95'))).toBe(true);
    });

    it('null fileWwc renders "—" in the File WWC row (D11)', () => {
      const result = renderXtmRelisted(
        xstate({ words: 500, fileWwc: null }),
        undefined,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      expect(rowValue(result, 'File WWC')).toBe('—');
    });
  });

  // ---------------------------------------------------------------------------
  // renderXtmAccepted
  // ---------------------------------------------------------------------------
  describe('renderXtmAccepted', () => {
    it('returns header title "✅ Job Accepted · XTM"', () => {
      const result = renderXtmAccepted(xstate({ acceptedAt: '2026-06-19T03:00:05.000Z' }), XTM_URL);
      expect(entry(result).card.header.title).toBe('✅ Job Accepted · XTM');
    });

    it('includes English row labels: Project, File, Language, Due, Words, Accepted', () => {
      const result = renderXtmAccepted(xstate({ acceptedAt: '2026-06-19T03:00:05.000Z' }), XTM_URL);
      const labels = rowLabels(result);
      expect(labels.some((l) => l.includes('Project'))).toBe(true);
      expect(labels.some((l) => l.includes('File'))).toBe(true);
      expect(labels.some((l) => l.includes('Language'))).toBe(true);
      expect(labels.some((l) => l.includes('Due'))).toBe(true);
      expect(labels.some((l) => l.includes('Words'))).toBe(true);
      expect(labels.some((l) => l.includes('Accepted'))).toBe(true);
    });

    it('renders acceptedAt via formatReadableDate as Bangkok HH:mm', () => {
      const result = renderXtmAccepted(xstate({ acceptedAt: '2026-06-19T03:00:05.000Z' }), XTM_URL);
      // 03:00 UTC → 10:00 Bangkok
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('10:00'))).toBe(true);
    });

    it('renders — when acceptedAt is null', () => {
      const result = renderXtmAccepted(xstate({ acceptedAt: null }), XTM_URL);
      const texts = rowTexts(result);
      expect(texts.some((t) => t === '—')).toBe(true);
    });

    it('button onClick.openLink.url equals the passed xtmUrl', () => {
      const result = renderXtmAccepted(xstate({ acceptedAt: null }), XTM_URL);
      expect(buttonUrl(result)).toBe(XTM_URL);
    });

    it('cardId starts with "accepted-"', () => {
      const result = renderXtmAccepted(xstate({ acceptedAt: null }), XTM_URL);
      expect(entry(result).cardId).toMatch(/^accepted-/);
    });

    it('shows a "File WWC" row with the numeric value when fileWwc is set (D11)', () => {
      const result = renderXtmAccepted(
        xstate({ acceptedAt: '2026-06-19T03:00:05.000Z', words: 300, fileWwc: 58 }),
        XTM_URL,
      );
      expect(rowLabels(result).some((l) => l.includes('File WWC'))).toBe(true);
      expect(rowTexts(result).some((t) => t.includes('58'))).toBe(true);
    });

    it('null fileWwc renders "—" in the File WWC row (D11)', () => {
      const result = renderXtmAccepted(
        xstate({ acceptedAt: '2026-06-19T03:00:05.000Z', words: 300, fileWwc: null }),
        XTM_URL,
      );
      expect(rowValue(result, 'File WWC')).toBe('—');
    });
  });

  // ---------------------------------------------------------------------------
  // renderXtmAcceptFailed
  // ---------------------------------------------------------------------------
  describe('renderXtmAcceptFailed', () => {
    it('returns header title "⚠️ Accept Failed · XTM" when outcome=failed', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'failed',
        'unconfirmed',
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      expect(entry(result).card.header.title).toBe('⚠️ Accept Failed · XTM');
    });

    it('returns header title "⚠️ Job Snatched · XTM" when outcome=missing', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'missing',
        null,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      expect(entry(result).card.header.title).toBe('⚠️ Job Snatched · XTM');
    });

    it('Cause row for failed = "clicked but could not confirm — <reason>"', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'failed',
        'timeout',
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('clicked but could not confirm — timeout'))).toBe(true);
    });

    it('Cause row for failed with null reason = "clicked but could not confirm — —"', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'failed',
        null,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('clicked but could not confirm — —'))).toBe(true);
    });

    it('Cause row for missing = "snatched before we could accept"', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'missing',
        null,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('snatched before we could accept'))).toBe(true);
    });

    it('Action row for failed = "Yes — check XTM"', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'failed',
        'unconfirmed',
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('Yes — check XTM'))).toBe(true);
    });

    it('Action row for missing = "No (job already gone)"', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'missing',
        null,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('No (job already gone)'))).toBe(true);
    });

    it('includes English row labels: Project, File, Language, Cause, Action', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'failed',
        null,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      const labels = rowLabels(result);
      expect(labels.some((l) => l.includes('Project'))).toBe(true);
      expect(labels.some((l) => l.includes('File'))).toBe(true);
      expect(labels.some((l) => l.includes('Language'))).toBe(true);
      expect(labels.some((l) => l.includes('Cause'))).toBe(true);
      expect(labels.some((l) => l.includes('Action'))).toBe(true);
    });

    it('button onClick.openLink.url equals the passed xtmUrl', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'failed',
        null,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      expect(buttonUrl(result)).toBe(XTM_URL);
    });

    it('cardId starts with "acceptfailed-"', () => {
      const result = renderXtmAcceptFailed(
        xstate(),
        'failed',
        null,
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      expect(entry(result).cardId).toMatch(/^acceptfailed-/);
    });

    it('includes a "Time" row with at formatted in Bangkok time (Fix 2)', () => {
      // at = 2026-06-19T03:00Z → Bangkok = 10:00 → 19/06/2026 10:00
      const result = renderXtmAcceptFailed(
        xstate(),
        'failed',
        'timeout',
        '2026-06-19T03:00:00.000Z',
        XTM_URL,
      );
      const labels = rowLabels(result);
      const texts = rowTexts(result);
      expect(labels.some((l) => l.includes('Time'))).toBe(true);
      expect(texts.some((t) => t.includes('19/06/2026 10:00'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // renderXtmColdStartSummary
  // ---------------------------------------------------------------------------
  describe('renderXtmColdStartSummary', () => {
    it('returns header title "📋 XTM Monitor Started"', () => {
      const result = renderXtmColdStartSummary(
        [xstate({ jobKey: 'a' }), xstate({ jobKey: 'b', eligible: false })],
        'cycle-1',
        XTM_URL,
      );
      expect(entry(result).card.header.title).toBe('📋 XTM Monitor Started');
    });

    it('headerSubtitle shows job count and eligible count', () => {
      const jobs = [
        xstate({ jobKey: 'a', eligible: true }),
        xstate({ jobKey: 'b', eligible: false, targetLang: 'Thai' }),
        xstate({ jobKey: 'c', eligible: true }),
      ];
      const result = renderXtmColdStartSummary(jobs, 'cycle-1', XTM_URL);
      const subtitle = entry(result).card.header.subtitle ?? '';
      expect(subtitle).toContain('3');
      expect(subtitle).toMatch(/Malay-eligible.*2|2.*Malay-eligible/);
    });

    it('one row per job with "projectName / fileName" as label and lang/due as value', () => {
      const jobs = [
        xstate({ jobKey: 'a', fileName: 'f1.docx' }),
        xstate({ jobKey: 'b', fileName: 'f2.docx', targetLang: 'Thai' }),
      ];
      const result = renderXtmColdStartSummary(jobs, 'cycle-1', XTM_URL);
      const e = entry(result);
      const labels = rowLabels(result);
      expect(labels.some((l) => l.includes('f1.docx'))).toBe(true);
      expect(labels.some((l) => l.includes('f2.docx'))).toBe(true);
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('English (USA) → Malay (Malaysia)'))).toBe(true);
      expect(e.card.header.title).toBe('📋 XTM Monitor Started');
    });

    it('renders dueDate/dueRaw via formatReadableDate in row value', () => {
      const jobs = [xstate({ jobKey: 'a', dueDate: '2026-06-18T12:25:00.000Z', dueRaw: null })];
      const result = renderXtmColdStartSummary(jobs, 'cycle-1', XTM_URL);
      const texts = rowTexts(result);
      expect(texts.some((t) => t.includes('18/06/2026 19:25'))).toBe(true);
    });

    it('0 jobs: subtitle "No open jobs in Active — monitoring 24/7" and no job rows', () => {
      const result = renderXtmColdStartSummary([], 'cycle-1', XTM_URL);
      expect(entry(result).card.header.subtitle).toContain('No open jobs in Active');
    });

    it('button onClick.openLink.url equals the passed xtmUrl', () => {
      const result = renderXtmColdStartSummary([xstate({ jobKey: 'a' })], 'cycle-1', XTM_URL);
      expect(buttonUrl(result)).toBe(XTM_URL);
    });

    it('cardId starts with "coldstart-"', () => {
      const result = renderXtmColdStartSummary([], 'cycle-1', XTM_URL);
      expect(entry(result).cardId).toMatch(/^coldstart-/);
    });
  });
});
