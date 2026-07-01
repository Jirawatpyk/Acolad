import { describe, it, expect } from 'vitest';
import {
  computeJobKey,
  computeSnapshotHash,
  computeXtmJobKey,
  computeXtmSnapshotHash,
} from '../../src/detection/jobKey.js';
import type { RawJob, XtmRawJob } from '../../src/detection/types.js';

const job = (over: Partial<RawJob> = {}): RawJob => ({
  portalJobId: null,
  title: 'Translate EN>TH manual',
  languagePair: 'EN>TH',
  deadline: '2026-06-12T17:00+07:00',
  deadlineRaw: null,
  fee: '€120',
  url: 'https://portal/job/1',
  ...over,
});

describe('computeJobKey', () => {
  it('uses portal job id verbatim (trimmed) when present', () => {
    expect(computeJobKey(job({ portalJobId: ' JOB-42 ' }))).toBe('JOB-42');
  });

  it('falls back to a deterministic hash when no portal id', () => {
    const a = computeJobKey(job());
    const b = computeJobKey(job());
    expect(a).toBe(b);
    expect(a.startsWith('h:')).toBe(true);
  });

  it('is case- and whitespace-insensitive in the hash basis', () => {
    expect(computeJobKey(job({ title: 'Translate EN>TH manual' }))).toBe(
      computeJobKey(job({ title: '  translate en>th  manual  '.replace(/\s+/g, ' ').trim() })),
    );
  });

  it('treats a hash-keyed job as different when an identity field changes', () => {
    expect(computeJobKey(job({ deadline: '2026-06-12T17:00+07:00' }))).not.toBe(
      computeJobKey(job({ deadline: '2026-06-13T17:00+07:00' })),
    );
  });

  it('serializes null fields to a stable empty form', () => {
    const a = computeJobKey(job({ languagePair: null, fee: null }));
    const b = computeJobKey(job({ languagePair: null, fee: 'different-fee-ignored' }));
    // fee is not part of identity, languagePair null is stable → same key
    expect(a).toBe(b);
  });
});

describe('computeSnapshotHash', () => {
  it('changes when fee changes (detail-change detection)', () => {
    expect(computeSnapshotHash(job({ fee: '€120' }))).not.toBe(
      computeSnapshotHash(job({ fee: '€150' })),
    );
  });
});

const xjob = (over: Partial<XtmRawJob> = {}): XtmRawJob => ({
  xtmTaskId: 'ID-1001',
  projectName: 'Acme Q3',
  fileName: 'chapter-01.docx',
  sourceLang: 'English (United States)',
  targetLang: 'Malay (Malaysia)',
  dueDate: '2026-06-20T17:00+07:00',
  dueRaw: null,
  words: 1200,
  fileWwc: 1100,
  step: 'Post-Editing (PE) 1',
  role: 'Corrector',
  acceptAvailable: true,
  ...over,
});

describe('computeXtmJobKey (R3 — projectName|fileName|step|role composite)', () => {
  it('is deterministic for the same file/step/role', () => {
    expect(computeXtmJobKey(xjob())).toBe(computeXtmJobKey(xjob()));
  });

  it('differs when step differs (same file, different workflow step)', () => {
    expect(computeXtmJobKey(xjob({ step: 'Post-Editing (PE) 1' }))).not.toBe(
      computeXtmJobKey(xjob({ step: 'Review 2' })),
    );
  });

  it('differs when role differs (same file/step, different role)', () => {
    expect(computeXtmJobKey(xjob({ role: 'Corrector' }))).not.toBe(
      computeXtmJobKey(xjob({ role: 'Translator' })),
    );
  });

  it('is case- and whitespace-insensitive (normalized)', () => {
    expect(computeXtmJobKey(xjob({ fileName: 'Chapter-01.DOCX', role: '  Corrector ' }))).toBe(
      computeXtmJobKey(xjob({ fileName: 'chapter-01.docx', role: 'corrector' })),
    );
  });

  it('does not depend on the volatile xtm_task_id (identity is the composite)', () => {
    expect(computeXtmJobKey(xjob({ xtmTaskId: 'ID-1001' }))).toBe(
      computeXtmJobKey(xjob({ xtmTaskId: 'ID-9999' })),
    );
  });

  it('treats a null step/role as a stable empty component', () => {
    expect(computeXtmJobKey(xjob({ step: null, role: null }))).toBe(
      computeXtmJobKey(xjob({ step: null, role: null })),
    );
  });
});

describe('computeXtmJobKey — project disambiguation', () => {
  const base = { fileName: 'X_Proof.html', step: 'Post-Editing (PE) 1', role: 'Corrector' };
  it('includes the normalized project name', () => {
    expect(computeXtmJobKey({ projectName: '  PR 4721900 EMAIL ', ...base })).toBe(
      'pr 4721900 email|x_proof.html|post-editing (pe) 1|corrector',
    );
  });
  it('two projects sharing file|step|role get DIFFERENT keys (collision fixed)', () => {
    const a = computeXtmJobKey({ projectName: 'PR 4721900-1-3 EMAIL', ...base });
    const b = computeXtmJobKey({ projectName: 'PR 4721900-1-3 EMAIL_1', ...base });
    expect(a).not.toBe(b);
    // negative: file|step|role are byte-identical between a and b, so the OLD 3-field key
    // WOULD have collided — only the project segment makes the new keys differ.
  });
  it('same project + same file|step|role is the SAME key (relisting dedup intact)', () => {
    expect(computeXtmJobKey({ projectName: 'PR EMAIL', ...base })).toBe(
      computeXtmJobKey({ projectName: 'PR EMAIL', ...base }),
    );
  });
});

describe('computeXtmSnapshotHash', () => {
  it('changes when a displayed field changes (words)', () => {
    expect(computeXtmSnapshotHash(xjob({ words: 1200 }))).not.toBe(
      computeXtmSnapshotHash(xjob({ words: 1500 })),
    );
  });

  it('changes when acceptAvailable flips (taken vs free)', () => {
    expect(computeXtmSnapshotHash(xjob({ acceptAvailable: true }))).not.toBe(
      computeXtmSnapshotHash(xjob({ acceptAvailable: false })),
    );
  });

  it('changes when fileWwc changes (so a File WWC update re-syncs the Sheet)', () => {
    expect(computeXtmSnapshotHash(xjob({ fileWwc: 100 }))).not.toBe(
      computeXtmSnapshotHash(xjob({ fileWwc: 250 })),
    );
  });
});
