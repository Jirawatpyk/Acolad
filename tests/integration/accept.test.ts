import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Frame, type Page } from 'playwright';
import {
  determineAcceptOutcomes,
  acceptEligibleTasks,
  type AcceptDeps,
} from '../../src/portal/xtmAccept.js';
import type { AcceptTarget } from '../../src/portal/errors.js';
import type { XtmRawJob } from '../../src/detection/types.js';
import { computeXtmJobKey } from '../../src/detection/jobKey.js';
import { XTM } from '../../src/portal/selectors.js';
import { xtmActivePage, xtmMenuRow } from '../fixtures/xtmPages.js';

const AT = '2026-06-19T10:00:05+07:00';

const xraw = (over: Partial<XtmRawJob> = {}): XtmRawJob => ({
  xtmTaskId: 'ID-1',
  projectName: 'P',
  fileName: 'a.docx',
  sourceLang: 'English (USA)',
  targetLang: 'Malay (Malaysia)',
  dueDate: null,
  dueRaw: null,
  words: 10,
  step: 'PE 1',
  role: 'Corrector',
  acceptAvailable: true,
  ...over,
});

const target = (raw: XtmRawJob): AcceptTarget => ({
  jobKey: computeXtmJobKey(raw),
  targetLang: raw.targetLang ?? '',
  fileName: raw.fileName,
  step: raw.step,
  role: raw.role,
});

/** AcceptTarget literal for the stub-frame tests (cells are unused by those stubs). */
const t = (jobKey: string, targetLang: string): AcceptTarget => ({
  jobKey,
  targetLang,
  fileName: `${jobKey}.docx`,
  step: 'PE 1',
  role: 'Corrector',
});

describe('determineAcceptOutcomes (FR-024 — outcome from re-read of Active)', () => {
  it('marks a target that is present but no longer acceptable as accepted', () => {
    const raw = xraw();
    const reRead = [xraw({ acceptAvailable: false })]; // same job, now owned
    const out = determineAcceptOutcomes([target(raw)], reRead, AT, new Set());
    expect(out).toEqual([{ jobKey: target(raw).jobKey, outcome: 'accepted', at: AT }]);
  });

  it('marks a target that vanished from Active as missing (snatched)', () => {
    const raw = xraw();
    const out = determineAcceptOutcomes([target(raw)], [], AT, new Set());
    expect(out).toEqual([{ jobKey: target(raw).jobKey, outcome: 'missing' }]);
  });

  it('marks a target still acceptable after the action as failed', () => {
    // We actually clicked this group; the re-read still shows claimable → genuine failure.
    const raw = xraw();
    const reRead = [xraw({ acceptAvailable: true })]; // still claimable → our accept didn't take
    const key = computeXtmJobKey(raw);
    const clickedKeys = new Set([key]);
    const out = determineAcceptOutcomes([target(raw)], reRead, AT, clickedKeys);
    expect(out[0]?.outcome).toBe('failed');
  });

  it('attributes a bulk/partial result per job (accepted + missing + failed)', () => {
    const a = xraw({ fileName: 'a.docx' });
    const b = xraw({ fileName: 'b.docx' });
    const c = xraw({ fileName: 'c.docx' });
    const targets = [target(a), target(b), target(c)];
    const reRead = [
      xraw({ fileName: 'a.docx', acceptAvailable: false }), // accepted
      // b.docx vanished → missing
      xraw({ fileName: 'c.docx', acceptAvailable: true }), // failed
    ];
    // c.docx is still claimable and its key IS in clickedKeys → genuine failed
    const clickedKeys = new Set([target(c).jobKey]);
    const out = determineAcceptOutcomes(targets, reRead, AT, clickedKeys);
    expect(out.find((o) => o.jobKey === target(a).jobKey)?.outcome).toBe('accepted');
    expect(out.find((o) => o.jobKey === target(b).jobKey)?.outcome).toBe('missing');
    expect(out.find((o) => o.jobKey === target(c).jobKey)?.outcome).toBe('failed');
  });

  it('returns an empty result for no targets', () => {
    expect(determineAcceptOutcomes([], [xraw()], AT, new Set())).toEqual([]);
  });

  // --- Task 2 (A3): never-clicked-but-claimable is retriable 'missing', not terminal 'failed' ---

  it('A3-1: target present + still claimable + clickedKeys EMPTY → missing (retriable, not terminal failed)', () => {
    // A target whose row was never reached (group already-owned, row not rendered)
    // must NOT be labelled terminal 'failed'. It should be 'missing' so accept_status
    // resets to 'none' and the robustness path re-attempts on the next cycle.
    const raw = xraw({ acceptAvailable: true });
    const key = computeXtmJobKey(raw);
    const reRead = [xraw({ acceptAvailable: true })]; // still claimable in re-read
    const out = determineAcceptOutcomes(
      [t(key, 'Malay (Malaysia)')],
      reRead,
      AT,
      new Set() /* no click */,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.outcome).toBe('missing');
  });

  it('A3-2: target present + still claimable + clickedKeys HAS the key → failed (genuine click did not take)', () => {
    // We actually clicked this target's group but it is still claimable in the re-read
    // → the accept genuinely failed; mark 'failed' (terminal alert, no re-attempt).
    const raw = xraw({ acceptAvailable: true });
    const key = computeXtmJobKey(raw);
    const reRead = [xraw({ acceptAvailable: true })];
    const clickedKeys = new Set([key]);
    const out = determineAcceptOutcomes([t(key, 'Malay (Malaysia)')], reRead, AT, clickedKeys);
    expect(out).toHaveLength(1);
    expect(out[0]?.outcome).toBe('failed');
  });

  it('A3-3: target present + NOT claimable (acceptAvailable:false) + empty clickedKeys → accepted', () => {
    // Already-owned group (openBulkAcceptForLanguage returned "already-owned", no click).
    // FR-024 re-read shows acceptAvailable:false → we own it → 'accepted'.
    const raw = xraw({ acceptAvailable: false });
    const key = computeXtmJobKey(raw);
    const reRead = [xraw({ acceptAvailable: false })];
    const out = determineAcceptOutcomes([t(key, 'Malay (Malaysia)')], reRead, AT, new Set());
    expect(out).toHaveLength(1);
    expect(out[0]?.outcome).toBe('accepted');
  });
});

describe('acceptEligibleTasks — accept timeout / menu-not-found (FR-011, T049 mode 3)', () => {
  const targets: AcceptTarget[] = [t('k1', 'Malay (Malaysia)'), t('k2', 'Malay (Malaysia)')];

  // A frame whose grid queries time out, so openBulkAcceptForLanguage throws (the
  // Playwright failure mode for an accept timeout / changed menu). Chainable so the
  // target-keyed rowForTarget locator builds, and the row's waitFor RESOLVES (the row
  // is "attached"); the timeout then fires on the kebab count/click — an error the
  // function does NOT swallow, so it propagates and the caller marks the group failed
  // WITHOUT re-reading (matching the production accept-timeout failure mode).
  const timingOutFrame = (): Frame => {
    const timeout = async (): Promise<never> => {
      throw new Error('Timeout 15000ms exceeded waiting for locator');
    };
    const loc: Record<string, unknown> = {
      first: () => loc,
      nth: () => loc,
      locator: () => loc,
      filter: () => loc,
      count: timeout,
      textContent: timeout,
      click: timeout,
      hover: timeout,
      waitFor: async () => {}, // row attaches; the timeout fires on the kebab query
    };
    return { locator: () => loc } as unknown as Frame;
  };

  it('marks every target failed with a bounded, evidence-only reason and never re-reads', async () => {
    const captured: string[] = [];
    const reReadActive = vi.fn(async (): Promise<XtmRawJob[]> => []);
    const deps: AcceptDeps = {
      reReadActive,
      captureEvidence: async (reason) => {
        captured.push(reason);
        return 'state/evidence/accept_unconfirmed-2026';
      },
      nowIso: () => AT,
    };

    const out = await acceptEligibleTasks(timingOutFrame(), targets, deps);

    // Never assumes success — all targets failed, awaiting the human/next re-read.
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.outcome === 'failed')).toBe(true);
    // Evidence captured once; the re-read is skipped (we bailed before it).
    expect(captured).toEqual(['accept_unconfirmed']);
    expect(reReadActive).not.toHaveBeenCalled();
    // Reason is bounded to an evidence ref — the raw Playwright message must NOT leak
    // (contracts/sheets.md: Note = evidence ref only; Constitution — no secret/raw spill).
    for (const o of out) {
      if (o.outcome !== 'failed') continue;
      expect(o.reason).toContain('evidence:');
      expect(o.reason).toContain('accept_unconfirmed-2026');
      expect(o.reason).not.toContain('Timeout 15000ms');
    }
  });

  it('attempts the accept menu once per distinct language, not just targets[0] (I2)', async () => {
    const captured: string[] = [];
    const reReadActive = vi.fn(async (): Promise<XtmRawJob[]> => []);
    const deps: AcceptDeps = {
      reReadActive,
      captureEvidence: async (reason) => {
        captured.push(reason);
        return 'state/evidence/accept_unconfirmed';
      },
      nowIso: () => AT,
    };
    const out = await acceptEligibleTasks(
      timingOutFrame(),
      [t('k1', 'Malay (Malaysia)'), t('k2', 'Indonesian')],
      deps,
    );
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.outcome === 'failed')).toBe(true);
    // Both language groups get their own menu pass → evidence captured twice (the
    // pre-fix single-group bug captured once and stranded the second language).
    expect(captured).toHaveLength(2);
    expect(reReadActive).not.toHaveBeenCalled(); // every group failed → no re-read
  });

  it('returns an empty result without touching the page for no targets', async () => {
    const deps: AcceptDeps = {
      reReadActive: vi.fn(async () => []),
      captureEvidence: vi.fn(async () => undefined),
      nowIso: () => AT,
    };
    expect(await acceptEligibleTasks(timingOutFrame(), [], deps)).toEqual([]);
    expect(deps.captureEvidence).not.toHaveBeenCalled();
  });

  // A frame stub where openBulkAcceptForLanguage SUCCEEDS (one Malay row; "Accept task"
  // + bulk items present) so the test can drive the post-accept re-read path. The locator
  // is chainable (filter/first/locator all return self) so the target-keyed rowForTarget
  // chain resolves; waitFor resolves so the row counts as 'attached'.
  const acceptingFrame = (): Frame => {
    const loc: Record<string, unknown> = {
      first: () => loc,
      nth: () => loc,
      locator: () => loc,
      filter: () => loc,
      count: async () => 1,
      textContent: async () => 'Malay (Malaysia)',
      click: async () => {},
      hover: async () => {},
      waitFor: async () => {},
    };
    return { locator: () => loc } as unknown as Frame;
  };

  // Per-selector stub: a single Malay row whose menu shows "Finish task" (already ours),
  // NO "Accept task" — openBulkAcceptForLanguage must return 'already-owned', not throw.
  const ownedFrame = (): Frame => {
    const loc = (sel?: string): Record<string, unknown> => ({
      first: () => loc(sel),
      nth: () => loc(sel),
      locator: (s: string) => loc(s),
      filter: () => loc(sel),
      count: async () => (sel === XTM.accept.acceptTaskItem ? 0 : 1),
      textContent: async () => 'Malay (Malaysia)',
      click: async () => {},
      hover: async () => {},
      waitFor: async () => {},
    });
    return { locator: (s: string) => loc(s) } as unknown as Frame;
  };

  // Per-selector stub: a matching row showing NEITHER "Accept task" nor "Finish task".
  const noMenuFrame = (): Frame => {
    const loc = (sel?: string): Record<string, unknown> => ({
      first: () => loc(sel),
      nth: () => loc(sel),
      locator: (s: string) => loc(s),
      filter: () => loc(sel),
      count: async () =>
        sel === XTM.accept.acceptTaskItem || sel === XTM.accept.finishTaskItem ? 0 : 1,
      textContent: async () => 'Malay (Malaysia)',
      click: async () => {},
      hover: async () => {},
      waitFor: async () => {},
    });
    return { locator: (s: string) => loc(s) } as unknown as Frame;
  };

  it('reconciles an already-owned row ("Finish task") to accepted, not a false accept_failed', async () => {
    const key = computeXtmJobKey(xraw());
    const captured: string[] = [];
    const deps: AcceptDeps = {
      reReadActive: vi.fn(async (): Promise<XtmRawJob[]> => [xraw({ acceptAvailable: false })]),
      captureEvidence: async (r) => {
        captured.push(r);
        return 'x';
      },
      nowIso: () => AT,
    };
    const out = await acceptEligibleTasks(ownedFrame(), [t(key, 'Malay (Malaysia)')], deps);
    expect(out).toHaveLength(1);
    expect(out[0]?.outcome).toBe('accepted'); // we own it (prior bulk) → reconciled, not failed
    expect(captured).not.toContain('post_accept_click'); // no click happened → no post-click evidence
  });

  it('fails loud when a matching row shows neither "Accept task" nor "Finish task"', async () => {
    const reReadActive = vi.fn(async (): Promise<XtmRawJob[]> => []);
    const deps: AcceptDeps = {
      reReadActive,
      captureEvidence: async () => 'state/evidence/x',
      nowIso: () => AT,
    };
    const out = await acceptEligibleTasks(noMenuFrame(), [t('k1', 'Malay (Malaysia)')], deps);
    expect(out).toHaveLength(1);
    expect(out[0]?.outcome).toBe('failed'); // fail-loud preserved — never assume success
    expect(reReadActive).not.toHaveBeenCalled(); // group failed → no re-read
  });

  it('classifies a wholesale-empty post-accept re-read as failed, not missing (grid-race guard)', async () => {
    const reReadActive = vi.fn(async (): Promise<XtmRawJob[]> => []); // 0 rows after accept
    const deps: AcceptDeps = {
      reReadActive,
      captureEvidence: async () => 'state/evidence/race',
      nowIso: () => AT,
    };
    const out = await acceptEligibleTasks(acceptingFrame(), [t('k1', 'Malay (Malaysia)')], deps);
    expect(reReadActive).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    // Accepted jobs STAY in Active, so an empty re-read is a grid race — conservative
    // 'failed' (re-checkable + alerts), never the lossy 'missing' that resets to none.
    expect(out[0]?.outcome).toBe('failed');
    if (out[0]?.outcome === 'failed') expect(out[0].reason).toContain('grid race');
  });
});

// ── A1: target-keyed row location on a REAL grid (the lost-Malay-jobs root fix) ──
// The pre-fix code scanned rows by nth(i); an owned row listed FIRST short-circuited
// the group to 'already-owned' and the claimable target never got clicked. The fix
// locates each target's row by its File/Step/Role cell text (rowForTarget), so row
// ORDER no longer matters — it opens the claimable target's own menu and clicks the
// bulk. This runs against a real Chromium page whose kebabs open real inline menus.
describe('acceptEligibleTasks — locates the target row by cell text, not order (A1)', () => {
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

  // The claimable target: a Malay row whose menu shows "Accept task" + the bulk item.
  const claimable = xraw({
    fileName: '4712942-1-21 (ID-1b270f065098)_captions.json',
    step: 'Post-Editing (PE) 1',
    role: 'Corrector',
  });

  it('clicks the bulk for a CLAIMABLE target even when an OWNED Malay row is listed first', async () => {
    // Row order is owned-first, claimable-second — the exact ordering that defeated the
    // old nth() scan (it returned 'already-owned' on the owned row and never clicked).
    await page.setContent(
      xtmActivePage(
        [
          // Owned Malay row FIRST (different file → different jobKey; menu = "Finish task").
          xtmMenuRow('owned111', 'finish', {
            file: 'OTHER-owned (ID-owned111)_done.json',
            step: 'Post-Editing (PE) 1',
            role: 'Corrector',
          }),
          // Claimable target SECOND (menu = "Accept task" + bulk item).
          xtmMenuRow('clm222', 'accept', {
            file: claimable.fileName,
            step: claimable.step ?? '',
            role: claimable.role ?? '',
          }),
        ],
        { total: 2 },
      ),
    );

    const captured: string[] = [];
    // After the bulk click the target is ours → re-read shows acceptAvailable:false.
    const reReadActive = vi.fn(
      async (): Promise<XtmRawJob[]> => [xraw({ ...claimable, acceptAvailable: false })],
    );
    const deps: AcceptDeps = {
      reReadActive,
      captureEvidence: async (reason) => {
        captured.push(reason);
        return undefined;
      },
      nowIso: () => AT,
    };

    const out = await acceptEligibleTasks(page, [target(claimable)], deps);

    // The bulk WAS clicked (post-click evidence fires only on opened==='clicked'), so
    // the owned-first row did NOT short-circuit the group to a false 'already-owned'.
    expect(captured).toContain('post_accept_click');
    expect(reReadActive).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0]?.jobKey).toBe(target(claimable).jobKey);
    expect(out[0]?.outcome).toBe('accepted');
  });

  it('returns already-owned (no false click) when the target row itself is owned', async () => {
    // The target's OWN row shows "Finish task" (a prior bulk grabbed its group). Locating
    // by cell text finds that row; no claimable target row exists → 'already-owned', and
    // the FR-024 re-read reconciles it to 'accepted' — never a false click on a sibling.
    await page.setContent(
      xtmActivePage(
        [
          xtmMenuRow('clm222', 'finish', {
            file: claimable.fileName,
            step: claimable.step ?? '',
            role: claimable.role ?? '',
          }),
        ],
        { total: 1 },
      ),
    );
    const captured: string[] = [];
    const reReadActive = vi.fn(
      async (): Promise<XtmRawJob[]> => [xraw({ ...claimable, acceptAvailable: false })],
    );
    const deps: AcceptDeps = {
      reReadActive,
      captureEvidence: async (reason) => {
        captured.push(reason);
        return undefined;
      },
      nowIso: () => AT,
    };

    const out = await acceptEligibleTasks(page, [target(claimable)], deps);

    expect(captured).not.toContain('post_accept_click'); // owned → no click
    expect(out[0]?.outcome).toBe('accepted'); // reconciled by the re-read
  });

  it('fails loud when the target row is absent (the row never rendered → no false accept) [I3: fast via rowAttachTimeoutMs]', async () => {
    // A DIFFERENT Malay row is present but NOT the target — locating by cell text finds
    // no target row. The function must NOT click a non-target row; it returns
    // 'already-owned' (retriable) and the empty-of-target re-read drives the outcome.
    // I3 fix: pass rowAttachTimeoutMs:200 so the attach-wait is 200ms, not 15s,
    // keeping CI fast without changing production behaviour (AcceptDeps default = 15s).
    await page.setContent(
      xtmActivePage(
        [
          xtmMenuRow('other999', 'accept', {
            file: 'SOMETHING-else (ID-other999)_x.json',
            step: 'Post-Editing (PE) 1',
            role: 'Corrector',
          }),
        ],
        { total: 1 },
      ),
    );
    // Re-read: the target is genuinely gone from Active → 'missing' (retriable).
    const reReadActive = vi.fn(
      async (): Promise<XtmRawJob[]> => [
        xraw({ fileName: 'SOMETHING-else (ID-other999)_x.json', acceptAvailable: true }),
      ],
    );
    const captured: string[] = [];
    const deps: AcceptDeps = {
      reReadActive,
      captureEvidence: async (reason) => {
        captured.push(reason);
        return undefined;
      },
      nowIso: () => AT,
      rowAttachTimeoutMs: 200, // I3: injectable so CI does not burn 15s per absent-row case
    };

    const out = await acceptEligibleTasks(page, [target(claimable)], deps);

    expect(captured).not.toContain('post_accept_click'); // target row absent → never clicked
    expect(out).toHaveLength(1);
    expect(out[0]?.jobKey).toBe(target(claimable).jobKey);
    // Target not in the re-read → missing (retriable), NOT a false accepted/failed.
    expect(out[0]?.outcome).toBe('missing');
  });
});

// ── C1: exact row match guards against substring collision (the "wrong row" bug) ──
// The old substring hasText would match "captions.json" inside "captions.json.bak"
// (or any superstring). With a superstring row listed FIRST, .first() picks the wrong
// row — the exact same root cause as the lost-Malay-jobs bug but at the cell level.
// After the fix, rowForTarget anchors the match (^…$), so only the EXACT cell text
// matches and the superstring row is not a candidate.
describe('acceptEligibleTasks — exact cell text match in rowForTarget (C1)', () => {
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

  // The EXACT target: a claimable Malay row whose File cell is "...captions.json".
  const exactTarget = xraw({
    fileName: 'F1 (ID-aaa)_captions.json',
    step: 'Post-Editing (PE) 1',
    role: 'Corrector',
  });

  it('C1-1: clicks the bulk for the EXACT target row, not the superstring row listed first', async () => {
    // Grid: superstring row FIRST (claimable), exact target SECOND (also claimable).
    // OLD substring match: .filter({hasText:"F1 (ID-aaa)_captions.json"}) matches BOTH rows
    // because the text is a substring of "...captions.json.bak" → .first() picks the wrong row.
    // NEW exact match: only the row whose cell equals "F1 (ID-aaa)_captions.json" matches.
    await page.setContent(
      xtmActivePage(
        [
          // Superstring row FIRST — file name CONTAINS the target name but is not equal.
          xtmMenuRow('sup111', 'accept', {
            file: 'F1 (ID-aaa)_captions.json.bak',
            step: 'Post-Editing (PE) 1',
            role: 'Corrector',
          }),
          // Exact target SECOND — this is the one that must be clicked.
          xtmMenuRow('exact222', 'accept', {
            file: exactTarget.fileName,
            step: exactTarget.step ?? '',
            role: exactTarget.role ?? '',
          }),
        ],
        { total: 2 },
      ),
    );

    const captured: string[] = [];
    // After clicking the exact target's bulk, re-read shows it accepted.
    const reReadActive = vi.fn(
      async (): Promise<XtmRawJob[]> => [xraw({ ...exactTarget, acceptAvailable: false })],
    );
    const deps: AcceptDeps = {
      reReadActive,
      captureEvidence: async (reason) => {
        captured.push(reason);
        return undefined;
      },
      nowIso: () => AT,
      rowAttachTimeoutMs: 2_000, // fast enough for a real Chromium page
    };

    const out = await acceptEligibleTasks(page, [target(exactTarget)], deps);

    // The bulk WAS clicked on the correct (exact) row → post_accept_click evidence fires.
    expect(captured).toContain('post_accept_click');
    expect(reReadActive).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    expect(out[0]?.jobKey).toBe(target(exactTarget).jobKey);
    expect(out[0]?.outcome).toBe('accepted');
  });

  it('C1-2: treats the target as absent when ONLY the superstring row exists (exact match required)', async () => {
    // Grid contains ONLY the superstring row — the exact target is NOT present.
    // With substring match the locator would incorrectly attach to the superstring row.
    // With exact match, no row matches → waitFor times out → target treated as absent.
    await page.setContent(
      xtmActivePage(
        [
          xtmMenuRow('sup111', 'accept', {
            file: 'F1 (ID-aaa)_captions.json.bak', // superstring only — exact target absent
            step: 'Post-Editing (PE) 1',
            role: 'Corrector',
          }),
        ],
        { total: 1 },
      ),
    );

    const reReadActive = vi.fn(
      async (): Promise<XtmRawJob[]> => [
        // The exact target is absent from the re-read as well → outcome: missing
        xraw({ fileName: 'F1 (ID-aaa)_captions.json.bak', acceptAvailable: true }),
      ],
    );
    const captured: string[] = [];
    const deps: AcceptDeps = {
      reReadActive,
      captureEvidence: async (reason) => {
        captured.push(reason);
        return undefined;
      },
      nowIso: () => AT,
      rowAttachTimeoutMs: 200, // fast — exact target not in DOM, attach must time out quickly
    };

    const out = await acceptEligibleTasks(page, [target(exactTarget)], deps);

    // No click on the superstring row (exact match rejected it).
    expect(captured).not.toContain('post_accept_click');
    expect(out).toHaveLength(1);
    expect(out[0]?.jobKey).toBe(target(exactTarget).jobKey);
    // Exact target absent from re-read → missing (retriable).
    expect(out[0]?.outcome).toBe('missing');
  });
});
