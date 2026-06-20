import { describe, it, expect } from 'vitest';
import { computeCatchRate } from '../../src/runtime/catchRateReport.js';

const MALAY = ['Malay (Malaysia)'];
// Columns: A..M; B(1)=Status, F(5)=Target, M(12)=_job_key. Data rows only (no header).
const r = (status: string, target: string, key = 'k'): string[] => {
  const row = Array<string>(13).fill('');
  row[1] = status;
  row[5] = target;
  row[12] = key;
  return row;
};

describe('computeCatchRate (SC-001)', () => {
  it('counts Accepted / (Accepted + Missing + Accept failed) over Malay rows', () => {
    const rows = [
      r('Accepted', 'Malay (Malaysia)', 'a'),
      r('Accepted', 'Malay (Malaysia)', 'b'),
      r('Missing', 'Malay (Malaysia)', 'c'),
      r('Accept failed', 'Malay (Malaysia)', 'd'),
    ];
    const cr = computeCatchRate(rows, MALAY);
    expect(cr.accepted).toBe(2);
    expect(cr.missing).toBe(1);
    expect(cr.failed).toBe(1);
    expect(cr.ratePct).toBeCloseTo(50);
  });

  it('ignores non-Malay rows', () => {
    const rows = [r('Accepted', 'Malay (Malaysia)', 'a'), r('Missing', 'Thai', 'b')];
    const cr = computeCatchRate(rows, MALAY);
    expect(cr.accepted).toBe(1);
    expect(cr.missing).toBe(0); // Thai missing not counted
    expect(cr.ratePct).toBeCloseTo(100);
  });

  it('ignores historical rows that have no _job_key (FR-026)', () => {
    const rows = [r('Accepted', 'Malay (Malaysia)', 'a'), r('Missing', 'Malay (Malaysia)', '')];
    const cr = computeCatchRate(rows, MALAY);
    expect(cr.accepted).toBe(1);
    expect(cr.missing).toBe(0);
  });

  it('counts Closed as a successful accept, ignores New/Skipped/Removed', () => {
    const rows = [
      r('New', 'Malay (Malaysia)', 'a'),
      r('Skipped', 'Malay (Malaysia)', 'b'),
      r('Removed', 'Malay (Malaysia)', 'c'),
      r('Closed', 'Malay (Malaysia)', 'd'), // accepted job that completed → still a catch
      r('Accepted', 'Malay (Malaysia)', 'e'),
    ];
    const cr = computeCatchRate(rows, MALAY);
    expect(cr.accepted).toBe(2); // Accepted + Closed
    expect(cr.missing + cr.failed).toBe(0); // New/Skipped/Removed not in the denominator
    expect(cr.ratePct).toBeCloseTo(100);
  });

  it('returns a null rate when no jobs have been decided', () => {
    const cr = computeCatchRate([r('New', 'Malay (Malaysia)', 'a')], MALAY);
    expect(cr.ratePct).toBeNull();
  });
});
