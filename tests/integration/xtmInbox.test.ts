import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { readActiveSnapshot, readClosedKeys, parseXtmWwc } from '../../src/portal/xtmInbox.js';
import { computeXtmJobKey } from '../../src/detection/jobKey.js';
import {
  LayoutChangedError,
  PortalTimeoutError,
  PaginationDetectedError,
} from '../../src/portal/errors.js';
import {
  xtmActivePage,
  xtmEmptyActivePage,
  xtmBrokenActivePage,
  xtmLoadingActivePage,
  malayRow,
  thaiRow,
  xtmRow,
  xtmClosedRowNoWwc,
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
    expect(malay?.fileWwc).toBe(17); // File WWC column (td:nth-child(3))
    expect(malay?.dueRaw).toBe('18-Jun-2026 19:25');
    expect(thai?.targetLang).toBe('Thai');
    expect(thai?.fileWwc).toBe(21);
    expect(snap.malformed).toHaveLength(0);
    expect(snap.emptyListConfirmed).toBe(false);
  });

  it('parses File WWC like Words: digits "427", blank → null, grouped "1,200" → 1200', async () => {
    const snap = await snapshotOf(
      xtmActivePage([
        malayRow({ file: 'a.json', fileWwc: '427' }),
        malayRow({ file: 'b.json', fileWwc: '' }), // blank cell → null
        malayRow({ file: 'c.json', fileWwc: '1,200' }), // thousands separator tolerated
      ]),
    );
    expect(snap.jobs).toHaveLength(3);
    expect(snap.jobs[0]?.fileWwc).toBe(427);
    expect(snap.jobs[1]?.fileWwc).toBeNull();
    expect(snap.jobs[2]?.fileWwc).toBe(1200);
  });

  it('reads a FRACTIONAL File WWC through the snapshot as a rounded int (no ~10x inflation)', async () => {
    // Finding #7(a): a weighted count rendered "1,234.5" must NOT become 12345 (the digits-only
    // words parser stripped the dot). parseXtmWwc keeps the decimal, parseFloats, and rounds.
    const snap = await snapshotOf(
      xtmActivePage([malayRow({ file: 'wwc.json', fileWwc: '1,234.5' })]),
    );
    expect(snap.jobs).toHaveLength(1);
    expect(snap.jobs[0]?.fileWwc).toBe(1235);
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

  it('fails loud when the Active grid is paginated (FR-009 — page 2+ would be missed)', async () => {
    // Footer "1 - 2 of 5": two rows on this page but five total → later pages exist.
    await page.setContent(xtmActivePage([malayRow(), thaiRow()], { total: 5, shown: 2 }));
    await expect(
      readActiveSnapshot(page, 'cycle-1', '2026-06-19T10:00:00+07:00', noEvidence, FAST),
    ).rejects.toBeInstanceOf(PaginationDetectedError);
  });

  it('fails loud when a rendered data row is missing its kebab anchor (markup drift)', async () => {
    // A real data row (project + file present) whose per-row kebab is gone — must NOT
    // be silently dropped to a self-healing transient; the kebab is a structural anchor.
    await page.setContent(
      xtmActivePage([xtmRow({ project: 'Acme', file: 'f.docx', kebab: false })], { total: 1 }),
    );
    await expect(
      readActiveSnapshot(page, 'cycle-1', '2026-06-19T10:00:00+07:00', noEvidence, FAST),
    ).rejects.toBeInstanceOf(LayoutChangedError);
  });

  it('treats a footer-shows-more-but-no-rows grid as loading, not pagination (regression)', async () => {
    // Shell rendered, rows not yet → footer "1 - 2 of 5" but tbody empty. Must be a
    // transient (PortalTimeoutError), NOT a hard PaginationDetectedError.
    await page.setContent(xtmActivePage([], { total: 5, shown: 2 }));
    await expect(
      readActiveSnapshot(page, 'cycle-1', '2026-06-19T10:00:00+07:00', noEvidence, FAST),
    ).rejects.toBeInstanceOf(PortalTimeoutError);
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

// parseXtmWwc is PURE (no Chromium) — kept here so all File WWC behaviour lives with the
// xtmInbox tests. Finding #7(a): File WWC is a WEIGHTED count that CAN be fractional, so it
// needs a decimal-tolerant parser distinct from the always-integer Words parser.
describe('parseXtmWwc (File WWC — decimal-tolerant weighted-count parser)', () => {
  it('rounds a fractional weighted count instead of inflating it ~10x', () => {
    // The bug this fixes: the digits-only words parser drops the dot → "1,234.5" → 12345.
    expect(parseXtmWwc('1,234.5')).toBe(1235); // rounded, NOT 12345
  });
  it('parses an integer weighted count unchanged', () => {
    expect(parseXtmWwc('292')).toBe(292);
  });
  it('parses zero', () => {
    expect(parseXtmWwc('0')).toBe(0);
  });
  it('tolerates a thousands separator', () => {
    expect(parseXtmWwc('1,200')).toBe(1200);
  });
  it('returns null for an empty or absent cell', () => {
    expect(parseXtmWwc('')).toBeNull();
    expect(parseXtmWwc(null)).toBeNull();
  });
});

describe('readClosedKeys (Closed-vs-Removed disambiguation)', () => {
  it('keys valid rows and drops a Closed row with an empty file cell', async () => {
    // The Closed grid shares the Active table structure; one valid row + one with
    // no file. The empty-file row must NOT contribute a degenerate '' key.
    await page.setContent(xtmActivePage([malayRow(), xtmRow({ file: '' })]));
    const keys = await readClosedKeys(page);
    expect(keys.size).toBe(1);
  });

  it('keys a Closed grid that CARRIES File WWC so the key matches Active (happy path, no drift)', async () => {
    // malayRow keeps File WWC at col 3 → step(col 9)/role(col 11) align with Active, so the
    // recomputed Closed key equals the Active _job_key and the drift detector stays silent.
    const warn = vi.fn();
    const captureEvidence = vi.fn(async () => 'evidence/closed.html');
    await page.setContent(xtmActivePage([malayRow()]));
    const keys = await readClosedKeys(page, { logger: { warn }, captureEvidence });
    const expectedKey = computeXtmJobKey({
      projectName: 'Newswire Release 4712942',
      fileName: '4712942-1-21 (ID-1b270f065098)_captions.json',
      step: 'Post-Editing (PE) 1',
      role: 'Corrector',
    });
    expect(keys.has(expectedKey)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(captureEvidence).not.toHaveBeenCalled();
  });

  it('emits a layout-drift WARN + evidence when a Closed grid OMITS File WWC (step/role all null)', async () => {
    // HYPOTHETICAL drift (needs live recon to confirm): with File WWC gone the borrowed Active
    // selectors land off the row — file(td:5) reads Source, step(td:9)/role(td:11) read null.
    // The recomputed key no longer matches Active (a finished job would misclassify as
    // "removed"), so the detector must capture evidence + WARN — but NOT throw or page.
    const warn = vi.fn();
    const captureEvidence = vi.fn(async () => 'evidence/closed_layout_drift.html');
    await page.setContent(xtmActivePage([xtmClosedRowNoWwc()]));
    const keys = await readClosedKeys(page, { logger: { warn }, captureEvidence });

    // The drift still produces a (wrong) key, so it does NOT match the real Active key.
    const realActiveKey = computeXtmJobKey({
      projectName: 'Newswire Release 4712942',
      fileName: '4712942-1-21 (ID-1b270f065098)_captions.json',
      step: 'Post-Editing (PE) 1',
      role: 'Corrector',
    });
    expect(keys.size).toBe(1);
    expect(keys.has(realActiveKey)).toBe(false);

    // Observability fired (no throw): evidence captured + structured WARN.
    expect(captureEvidence).toHaveBeenCalledWith('closed_layout_drift');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      module: 'xtmInbox',
      action: 'readClosedKeys',
      outcome: 'layout_drift',
    });
  });

  it('does NOT fire the drift signal for a single odd row among well-formed rows', async () => {
    // One well-formed Closed row (File WWC present → step/role populated) plus one odd row whose
    // step/role happen to be blank. NOT all rows are null → no systematic-drift signal.
    const warn = vi.fn();
    const captureEvidence = vi.fn(async () => undefined);
    await page.setContent(
      xtmActivePage([malayRow(), malayRow({ file: 'odd.json', step: '', role: '' })]),
    );
    const keys = await readClosedKeys(page, { logger: { warn }, captureEvidence });
    expect(keys.size).toBe(2);
    expect(warn).not.toHaveBeenCalled();
    expect(captureEvidence).not.toHaveBeenCalled();
  });
});
