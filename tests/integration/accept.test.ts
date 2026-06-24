import { describe, it, expect, vi } from 'vitest';
import type { Frame } from 'playwright';
import {
  determineAcceptOutcomes,
  acceptEligibleTasks,
  type AcceptDeps,
} from '../../src/portal/xtmAccept.js';
import type { AcceptTarget } from '../../src/portal/errors.js';
import type { XtmRawJob } from '../../src/detection/types.js';
import { computeXtmJobKey } from '../../src/detection/jobKey.js';
import { XTM } from '../../src/portal/selectors.js';

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
      [{ jobKey: key, targetLang: 'Malay (Malaysia)' }],
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
    const out = determineAcceptOutcomes(
      [{ jobKey: key, targetLang: 'Malay (Malaysia)' }],
      reRead,
      AT,
      clickedKeys,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.outcome).toBe('failed');
  });

  it('A3-3: target present + NOT claimable (acceptAvailable:false) + empty clickedKeys → accepted', () => {
    // Already-owned group (openBulkAcceptForLanguage returned "already-owned", no click).
    // FR-024 re-read shows acceptAvailable:false → we own it → 'accepted'.
    const raw = xraw({ acceptAvailable: false });
    const key = computeXtmJobKey(raw);
    const reRead = [xraw({ acceptAvailable: false })];
    const out = determineAcceptOutcomes(
      [{ jobKey: key, targetLang: 'Malay (Malaysia)' }],
      reRead,
      AT,
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.outcome).toBe('accepted');
  });
});

describe('acceptEligibleTasks — accept timeout / menu-not-found (FR-011, T049 mode 3)', () => {
  const targets: AcceptTarget[] = [
    { jobKey: 'k1', targetLang: 'Malay (Malaysia)' },
    { jobKey: 'k2', targetLang: 'Malay (Malaysia)' },
  ];

  // A frame whose first grid query times out, so openBulkAcceptForLanguage throws
  // (the Playwright failure mode for an accept timeout / changed menu).
  const timingOutFrame = (): Frame =>
    ({
      locator: () => ({
        count: async () => {
          throw new Error('Timeout 15000ms exceeded waiting for locator');
        },
      }),
    }) as unknown as Frame;

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
      [
        { jobKey: 'k1', targetLang: 'Malay (Malaysia)' },
        { jobKey: 'k2', targetLang: 'Indonesian' },
      ],
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
  // + bulk items present) so the test can drive the post-accept re-read path.
  const acceptingFrame = (): Frame => {
    const loc = {
      first: () => loc,
      nth: () => loc,
      locator: () => loc,
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
    const loc = (sel?: string): unknown => ({
      first: () => loc(sel),
      nth: () => loc(sel),
      locator: (s: string) => loc(s),
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
    const loc = (sel?: string): unknown => ({
      first: () => loc(sel),
      nth: () => loc(sel),
      locator: (s: string) => loc(s),
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
    const out = await acceptEligibleTasks(
      ownedFrame(),
      [{ jobKey: key, targetLang: 'Malay (Malaysia)' }],
      deps,
    );
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
    const out = await acceptEligibleTasks(
      noMenuFrame(),
      [{ jobKey: 'k1', targetLang: 'Malay (Malaysia)' }],
      deps,
    );
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
    const out = await acceptEligibleTasks(
      acceptingFrame(),
      [{ jobKey: 'k1', targetLang: 'Malay (Malaysia)' }],
      deps,
    );
    expect(reReadActive).toHaveBeenCalledTimes(1);
    expect(out).toHaveLength(1);
    // Accepted jobs STAY in Active, so an empty re-read is a grid race — conservative
    // 'failed' (re-checkable + alerts), never the lossy 'missing' that resets to none.
    expect(out[0]?.outcome).toBe('failed');
    if (out[0]?.outcome === 'failed') expect(out[0].reason).toContain('grid race');
  });
});
