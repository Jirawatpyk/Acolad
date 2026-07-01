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
  xtmHeaderInsertedBeforeProject,
  xtmHeaderPartial,
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

  // ── #8: header-layout verification — catch a column shift before trusting positional reads ──
  it('#8: fails loud (LayoutChangedError) when a column is inserted before Project (header drift)', async () => {
    // The cell selectors are positional (td:nth-child(N)). A column inserted before Project
    // shifts every later cell right by one; since projectName (col 2) is part of the job KEY,
    // a silent shift would corrupt identity (re-accept everything / misclassify everything).
    // The header assertion must catch the drift BEFORE scraping and fail loud.
    await page.setContent(
      xtmActivePage([malayRow()], { total: 1, headerLabels: xtmHeaderInsertedBeforeProject }),
    );
    await expect(
      readActiveSnapshot(page, 'cycle-1', '2026-06-19T10:00:00+07:00', noEvidence, FAST),
    ).rejects.toBeInstanceOf(LayoutChangedError);
  });

  it('#8: captures evidence on a header-layout drift so the error path pages on-call', async () => {
    const captureEvidence = vi.fn(async () => 'state/evidence/layout_changed-2026');
    await page.setContent(
      xtmActivePage([malayRow()], { total: 1, headerLabels: xtmHeaderInsertedBeforeProject }),
    );
    await expect(
      readActiveSnapshot(page, 'cycle-1', '2026-06-19T10:00:00+07:00', captureEvidence, FAST),
    ).rejects.toBeInstanceOf(LayoutChangedError);
    expect(captureEvidence).toHaveBeenCalledWith('layout_changed');
  });

  it('#8 (MINOR): does NOT throw on a present-but-INCOMPLETE Active header (fewer th than expected)', async () => {
    // A transient partial render: only Project (col 2) + File WWC (col 3) headers exist; the later
    // checked columns (File/Step/Role) have no <th> yet. A missing th must be skipped, NOT read as
    // undefined → false LayoutChangedError. The body row is complete, so the scrape proceeds.
    const snap = await snapshotOf(xtmActivePage([malayRow()], { headerLabels: xtmHeaderPartial }));
    expect(snap.jobs).toHaveLength(1);
  });

  it('#8: proceeds normally when the header layout is intact (no false positive)', async () => {
    // Canonical header → identity columns are where the positional selectors expect → scrape OK.
    const snap = await snapshotOf(xtmActivePage([malayRow()]));
    expect(snap.jobs).toHaveLength(1);
    expect(snap.jobs[0]?.projectName).toBe('Newswire Release 4712942');
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

  it('emits a layout-drift WARN + evidence when ALL Closed rows have a null project cell', async () => {
    // Project-null drift: malayRow({ project: '' }) → project cell textContent is empty
    // so cell() returns null; but step/role columns remain populated (File WWC at col 3 keeps
    // step=col9/role=col11 aligned). Therefore allStepRoleNull stays false, but allProjectNull
    // stays true → the new branch of the drift condition must fire the WARN.
    const warn = vi.fn();
    const captureEvidence = vi.fn(async () => 'evidence/closed_project_drift.html');
    await page.setContent(xtmActivePage([malayRow({ project: '' })]));
    const keys = await readClosedKeys(page, { logger: { warn }, captureEvidence });

    expect(keys.size).toBe(1); // key is still emitted (project defaults to '' in computeXtmJobKey)
    expect(captureEvidence).toHaveBeenCalledWith('closed_layout_drift');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      module: 'xtmInbox',
      action: 'readClosedKeys',
      outcome: 'layout_drift',
    });
  });

  it('does NOT include an Active-job key when the Closed grid has a different project for the same file/step/role (negative match)', async () => {
    // With projectName in the key (Task 1), a Closed row keyed projectB|file|step|role
    // must NOT match an Active job keyed projectA|file|step|role — ensuring a cross-project
    // file-name collision never causes a finished job from one project to suppress a Removed
    // alert from another.
    const activeKey = computeXtmJobKey({
      projectName: 'Project Alpha',
      fileName: '4712942-1-21 (ID-1b270f065098)_captions.json',
      step: 'Post-Editing (PE) 1',
      role: 'Corrector',
    });
    // Closed grid contains the same file/step/role but under "Project Beta".
    await page.setContent(xtmActivePage([malayRow({ project: 'Project Beta' })]));
    const keys = await readClosedKeys(page);
    expect(keys.has(activeKey)).toBe(false);
  });

  // ── #2a: truthy drift detector — whitespace-only project counts as "drifted" ──
  it('#2a: fires the drift signal when EVERY project cell is whitespace-only (truthy check)', async () => {
    // A whitespace-only project ('  ') trims to '' — cell() returns '' (a TRUTHY-then-trimmed
    // value, NOT null), so the old `r.project !== null` check kept allProjectNull=false and the
    // WARN never fired. The truthy fix counts '' as drifted → the WARN + evidence fire.
    const warn = vi.fn();
    const captureEvidence = vi.fn(async () => 'evidence/closed_ws_project.html');
    await page.setContent(xtmActivePage([malayRow({ project: '  ' })]));
    await readClosedKeys(page, { logger: { warn }, captureEvidence });
    expect(captureEvidence).toHaveBeenCalledWith('closed_layout_drift');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      module: 'xtmInbox',
      action: 'readClosedKeys',
      outcome: 'layout_drift',
    });
  });

  // ── #8: header-layout verification also guards the Closed scrape ──
  it('#8: fails loud (LayoutChangedError) when the Closed grid header drifts (Project not at col 2)', async () => {
    const captureEvidence = vi.fn(async () => 'state/evidence/layout_changed-closed');
    await page.setContent(
      xtmActivePage([malayRow()], { headerLabels: xtmHeaderInsertedBeforeProject }),
    );
    await expect(readClosedKeys(page, { captureEvidence })).rejects.toBeInstanceOf(
      LayoutChangedError,
    );
    expect(captureEvidence).toHaveBeenCalledWith('layout_changed');
  });

  // ── reverted #2b: zero cross-key match is the NORMAL Removed case, NOT drift — never throw ──
  it('returns the Closed key set WITHOUT throwing even when no row matches any prior job (zero cross-key match = routine Removed, not drift)', async () => {
    // A cancelled accepted job → its key is absent from the Closed tab, which still holds OTHER
    // finished rows (V10b). The reverted cross-key escalation must NOT turn this routine case into
    // a LayoutChangedError: readClosedKeys returns the keys and never pages. The #8 header guard
    // (real structural drift) and the #2a all-null WARN remain the only drift signals.
    const captureEvidence = vi.fn(async () => undefined);
    await page.setContent(xtmActivePage([malayRow({ project: 'Some Other Finished Project' })]));
    const keys = await readClosedKeys(page, { captureEvidence });
    expect(keys.size).toBe(1); // key emitted normally
    expect(captureEvidence).not.toHaveBeenCalled(); // no evidence-as-alert, no page
  });

  // ── #8 (MINOR): tolerate a present-but-incomplete header — only a WRONG label at a rendered
  // column is drift; a missing <th> is a transient partial render, not a layout shift. ──
  it('#8: does NOT throw on a present-but-INCOMPLETE Closed header (fewer th than expected — transient partial render)', async () => {
    // Only the first identity columns rendered (Project, File WWC); cols 5/9/11 have no <th> yet.
    // A missing th must be treated as not-yet-rendered (skip), not read as undefined → false drift.
    await page.setContent(xtmActivePage([malayRow()], { headerLabels: xtmHeaderPartial }));
    const keys = await readClosedKeys(page);
    expect(keys.size).toBe(1); // scrape proceeds, no false LayoutChangedError
  });
});
