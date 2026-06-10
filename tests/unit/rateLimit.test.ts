import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/runtime/rateLimiter.js';
import { computeNextDelay, jitter } from '../../src/runtime/scheduler.js';
import { ColdStartHistory } from '../../src/runtime/coldStartHistory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('RateLimiter (FR-011)', () => {
  it('counts requests in the sliding window and reports atCap', () => {
    const rl = new RateLimiter(3, 3_600_000);
    const t = 1_000_000;
    rl.record(t);
    rl.record(t);
    expect(rl.atCap(t)).toBe(false);
    rl.record(t);
    expect(rl.atCap(t)).toBe(true);
    expect(rl.count(t)).toBe(3);
  });

  it('prunes requests older than the window', () => {
    const rl = new RateLimiter(3, 1000);
    rl.record(0);
    rl.record(0);
    rl.record(0);
    expect(rl.atCap(0)).toBe(true);
    // After the window, all pruned.
    expect(rl.count(2000)).toBe(0);
  });

  it('reports ms until a slot frees up at cap', () => {
    const rl = new RateLimiter(1, 1000);
    rl.record(500);
    expect(rl.msUntilSlot(600)).toBe(900); // 500 + 1000 - 600
    expect(rl.msUntilSlot(1600)).toBe(0);
  });
});

describe('computeNextDelay (start-to-start, SC-001b)', () => {
  it('absorbs cycle work time so starts are spaced by interval', () => {
    // interval 25s, cycle took 5s, no jitter -> wait 20s
    expect(computeNextDelay({ intervalMs: 25_000, cycleDurationMs: 5_000, jitterMs: 0 })).toBe(
      20_000,
    );
  });

  it('keeps the real request gap >= 20s when the cycle is fast', () => {
    // Fast 2s cycle: delay + cycle time must still be at least the 20s floor.
    const d = computeNextDelay({ intervalMs: 25_000, cycleDurationMs: 2_000, jitterMs: -5_000 });
    expect(d + 2_000).toBeGreaterThanOrEqual(20_000);
  });

  it('never returns a negative delay even when the cycle outran the interval', () => {
    const d = computeNextDelay({ intervalMs: 25_000, cycleDurationMs: 40_000, jitterMs: 5_000 });
    expect(d).toBeGreaterThanOrEqual(0);
  });

  it('clamps desired spacing into [20s, 30s]', () => {
    // Huge jitter cannot push spacing past 30s.
    const d = computeNextDelay({ intervalMs: 25_000, cycleDurationMs: 0, jitterMs: 100_000 });
    expect(d).toBeLessThanOrEqual(30_000);
  });
});

describe('jitter', () => {
  it('maps [0,1) to [-spread, +spread]', () => {
    expect(jitter(5000, 0.5)).toBe(0);
    expect(jitter(5000, 0)).toBe(-5000);
    expect(jitter(5000, 1)).toBe(5000);
  });
});

describe('ColdStartHistory (FR-015)', () => {
  it('flags a repeat cold start within 7 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acolad-csh-'));
    try {
      const h = new ColdStartHistory(dir);
      expect(h.record('2026-06-10T00:00:00.000Z')).toBe(false);
      expect(h.record('2026-06-12T00:00:00.000Z')).toBe(true);
      // Fresh instance reads persisted history.
      const h2 = new ColdStartHistory(dir);
      expect(h2.record('2026-07-20T00:00:00.000Z')).toBe(false); // >7 days after last
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
