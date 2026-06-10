import { describe, it, expect } from 'vitest';
import { computeJobKey, computeSnapshotHash } from '../../src/detection/jobKey.js';
import type { RawJob } from '../../src/detection/types.js';

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
