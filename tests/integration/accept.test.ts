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
    const out = determineAcceptOutcomes([target(raw)], reRead, AT);
    expect(out).toEqual([{ jobKey: target(raw).jobKey, outcome: 'accepted', at: AT }]);
  });

  it('marks a target that vanished from Active as missing (snatched)', () => {
    const raw = xraw();
    const out = determineAcceptOutcomes([target(raw)], [], AT);
    expect(out).toEqual([{ jobKey: target(raw).jobKey, outcome: 'missing' }]);
  });

  it('marks a target still acceptable after the action as failed', () => {
    const raw = xraw();
    const reRead = [xraw({ acceptAvailable: true })]; // still claimable → our accept didn't take
    const out = determineAcceptOutcomes([target(raw)], reRead, AT);
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
    const out = determineAcceptOutcomes(targets, reRead, AT);
    expect(out.find((o) => o.jobKey === target(a).jobKey)?.outcome).toBe('accepted');
    expect(out.find((o) => o.jobKey === target(b).jobKey)?.outcome).toBe('missing');
    expect(out.find((o) => o.jobKey === target(c).jobKey)?.outcome).toBe('failed');
  });

  it('returns an empty result for no targets', () => {
    expect(determineAcceptOutcomes([], [xraw()], AT)).toEqual([]);
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
