import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { readActiveSnapshot } from '../../src/portal/xtmInbox.js';
import { LayoutChangedError, PortalTimeoutError } from '../../src/portal/errors.js';
import {
  xtmActivePage,
  xtmEmptyActivePage,
  xtmBrokenActivePage,
  xtmLoadingActivePage,
  malayRow,
  thaiRow,
  xtmRow,
} from '../fixtures/xtmPages.js';

// Short waits so "still loading" fixtures don't burn the production 10-15s budgets.
const FAST = { settle: 400, content: 300 };

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  page = await browser.newPage();
});
afterEach(async () => {
  await page.close();
});

const noEvidence = async (): Promise<string | undefined> => undefined;

async function snapshotOf(html: string) {
  await page.setContent(html);
  return readActiveSnapshot(page, 'cycle-1', '2026-06-19T10:00:00+07:00', noEvidence, FAST);
}

describe('readActiveSnapshot (XTM Active grid)', () => {
  it('parses Malay + non-Malay rows into RawJob with mapped columns', async () => {
    const snap = await snapshotOf(xtmActivePage([malayRow(), thaiRow()]));
    expect(snap.jobs).toHaveLength(2);
    const [malay, thai] = snap.jobs;
    expect(malay?.projectName).toBe('Newswire Release 4712942');
    expect(malay?.fileName).toBe('4712942-1-21 (ID-1b270f065098)_captions.json');
    expect(malay?.xtmTaskId).toBe('ID-1b270f065098');
    expect(malay?.sourceLang).toBe('English (USA)');
    expect(malay?.targetLang).toBe('Malay (Malaysia)');
    expect(malay?.step).toBe('Post-Editing (PE) 1');
    expect(malay?.role).toBe('Corrector');
    expect(malay?.words).toBe(37);
    expect(malay?.dueRaw).toBe('18-Jun-2026 19:25');
    expect(thai?.targetLang).toBe('Thai');
    expect(snap.malformed).toHaveLength(0);
    expect(snap.emptyListConfirmed).toBe(false);
  });

  it('ignores the header row (no kebab) — only data rows become jobs', async () => {
    const snap = await snapshotOf(xtmActivePage([malayRow()]));
    expect(snap.jobs).toHaveLength(1);
  });

  it('quarantines a row with an empty project/file as malformed (FR-022)', async () => {
    const broken = xtmRow({ project: '', file: '', target: 'Malay (Malaysia)' });
    const snap = await snapshotOf(xtmActivePage([malayRow(), broken], { total: 2 }));
    expect(snap.jobs).toHaveLength(1);
    expect(snap.malformed).toHaveLength(1);
  });

  it('confirms a genuinely empty Active tab (footer 0 of 0)', async () => {
    const snap = await snapshotOf(xtmEmptyActivePage());
    expect(snap.jobs).toHaveLength(0);
    expect(snap.emptyListConfirmed).toBe(true);
  });

  it('fails loud when the grid container/state marker is missing (FR-016)', async () => {
    await expect(snapshotOf(xtmBrokenActivePage())).rejects.toBeInstanceOf(LayoutChangedError);
  });

  it('treats "footer says N>0 but no rows" as transient, not empty (no false alarm)', async () => {
    await expect(snapshotOf(xtmLoadingActivePage())).rejects.toBeInstanceOf(PortalTimeoutError);
  });

  it('does not depend on translated display text for row identity (structural)', async () => {
    // A row whose target is a different language string is still parsed (eligibility
    // is decided later); the parser must not key off "Malay".
    const snap = await snapshotOf(xtmActivePage([thaiRow({ target: 'Vietnamese' })]));
    expect(snap.jobs).toHaveLength(1);
    expect(snap.jobs[0]?.targetLang).toBe('Vietnamese');
  });
});
