import { describe, it, expect } from 'vitest';
import { determineAcceptOutcomes } from '../../src/portal/xtmAccept.js';
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
