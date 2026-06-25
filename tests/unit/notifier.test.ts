import { describe, it, expect } from 'vitest';
import {
  formatBangkok,
  renderNewJob,
  renderRelistedJob,
  renderColdStartSummary,
  renderSystemAlert,
} from '../../src/reporting/notifier.js';
import type { AppearanceEvent, JobState } from '../../src/detection/types.js';

const job = (over: Partial<JobState> = {}): JobState => ({
  jobKey: 'J1',
  portalJobId: 'J1',
  title: 'Translate EN>TH',
  languagePair: 'EN>TH',
  deadline: null,
  deadlineRaw: null,
  fee: null,
  url: null,
  status: 'visible',
  firstSeenAt: '2026-06-10T03:00:00.000Z',
  lastSeenAt: '2026-06-10T03:00:00.000Z',
  snapshotHash: 'h',
  consecutiveMisses: 0,
  ...over,
});

const ev = (over: Partial<AppearanceEvent> = {}): AppearanceEvent => ({
  jobKey: 'J1',
  eventType: 'first_seen',
  occurredAt: '2026-06-10T03:00:00.000Z',
  pollCycleId: 'c1',
  job: job(),
  ...over,
});

describe('formatBangkok', () => {
  it('renders ISO 8601 with +07:00 offset (FR-014)', () => {
    // 03:00 UTC -> 10:00 Bangkok
    expect(formatBangkok('2026-06-10T03:00:00.000Z')).toBe('2026-06-10T10:00+07:00');
  });
});

describe('renderNewJob', () => {
  it('shows — for missing optional fields (FR-004 best-effort)', () => {
    const msg = renderNewJob(ev());
    expect(msg).toContain('🆕 New job on Acolad');
    expect(msg).toContain('Fee: —');
    expect(msg).toContain('Link: —');
  });
});

describe('renderRelistedJob', () => {
  it('includes the original first-seen time', () => {
    const msg = renderRelistedJob(
      ev({ eventType: 'relisted', firstSeenAt: '2026-06-09T03:00:00.000Z' }),
    );
    expect(msg).toContain('🔁 Job relisted');
    expect(msg).toContain('2026-06-09T10:00+07:00');
  });
});

describe('renderColdStartSummary', () => {
  it('handles the empty (0 jobs) case', () => {
    expect(renderColdStartSummary([], '2026-06-10T03:00:00.000Z')).toContain('no jobs on portal');
  });

  it('reports count for a few jobs', () => {
    const jobs = [job({ title: 'A' }), job({ title: 'B' }), job({ title: 'C' })];
    const msg = renderColdStartSummary(jobs, '2026-06-10T03:00:00.000Z');
    expect(msg).toContain('found 3 existing job(s)');
  });

  it('truncates at 20 rows with an overflow line for 25 jobs', () => {
    const jobs = Array.from({ length: 25 }, (_, i) => job({ title: `Job ${i}` }));
    const msg = renderColdStartSummary(jobs, '2026-06-10T03:00:00.000Z');
    expect(msg).toContain('found 25 existing job(s)');
    expect(msg).toContain('…and 5 more');
    expect((msg.match(/•/g) ?? []).length).toBe(20);
  });
});

describe('renderSystemAlert', () => {
  it('includes severity, cause, impact, and required action', () => {
    const msg = renderSystemAlert({
      severity: 'critical',
      title: 'Login failed',
      cause: 'password rejected 3 times',
      impact: 'Monitoring paused (lockout)',
      action: 'Update ACOLAD_PASSWORD then npm run deploy',
      occurredAt: '2026-06-10T03:00:00.000Z',
    });
    expect(msg).toContain('[CRITICAL]');
    expect(msg).toContain('Update ACOLAD_PASSWORD');
  });
});
