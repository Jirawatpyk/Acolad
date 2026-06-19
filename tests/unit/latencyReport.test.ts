import { describe, it, expect } from 'vitest';
import {
  computeLatencyMetrics,
  CLICK_LATENCY_BUDGET_MS,
  OUTCOME_LATENCY_BUDGET_MS,
} from '../../src/runtime/latencyReport.js';

const cycle = (ms: number) => JSON.stringify({ action: 'cycle', outcome: 'ok', latencyMs: ms });
const send = (ms: number) => JSON.stringify({ action: 'send', outcome: 'ok', latencyMs: ms });
const accept = (clickMs: number, outcomeMs: number) =>
  JSON.stringify({
    action: 'accept',
    outcome: 'ok',
    clickLatencyMs: clickMs,
    outcomeLatencyMs: outcomeMs,
  });

describe('computeLatencyMetrics (T050 — SC-002 + V16/V16b accept latency)', () => {
  it('returns zeroed metrics and PASS verdicts when there are no samples', () => {
    const r = computeLatencyMetrics([]);
    expect(r.cycle.count).toBe(0);
    expect(r.acceptClick.count).toBe(0);
    expect(r.acceptOutcome.count).toBe(0);
    // No data → not a failure (nothing has violated the budget yet).
    expect(r.acceptClickPass).toBe(true);
    expect(r.acceptOutcomePass).toBe(true);
  });

  it('skips non-JSON lines and entries without a numeric latency', () => {
    const r = computeLatencyMetrics([
      'not json',
      '',
      JSON.stringify({ action: 'cycle' }),
      cycle(100),
    ]);
    expect(r.cycle.count).toBe(1);
    expect(r.cycle.p95).toBe(100);
  });

  it('computes p95 of cycle and send latencies separately', () => {
    const lines = [...Array(20).keys()].map((i) => cycle((i + 1) * 100)); // 100..2000
    lines.push(send(50), send(70), send(90));
    const r = computeLatencyMetrics(lines);
    expect(r.cycle.count).toBe(20);
    expect(r.cycle.p95).toBe(1900); // ceil(0.95*20)-1 = index 18 → 1900
    expect(r.send.count).toBe(3);
  });

  it('separates accept click latency (V16) from outcome latency (V16b)', () => {
    const r = computeLatencyMetrics([accept(1200, 8000), accept(3000, 45000)]);
    expect(r.acceptClick.count).toBe(2);
    expect(r.acceptOutcome.count).toBe(2);
    expect(r.acceptClick.p95).toBe(3000);
    expect(r.acceptOutcome.p95).toBe(45000);
  });

  it('flags a click-latency budget breach (p95 > 5s) as FAIL but keeps outcome PASS', () => {
    const r = computeLatencyMetrics([accept(6000, 20000), accept(7000, 30000)]);
    expect(r.acceptClick.p95).toBeGreaterThan(CLICK_LATENCY_BUDGET_MS);
    expect(r.acceptClickPass).toBe(false);
    expect(r.acceptOutcome.p95).toBeLessThanOrEqual(OUTCOME_LATENCY_BUDGET_MS);
    expect(r.acceptOutcomePass).toBe(true);
  });

  it('flags an outcome-latency budget breach (p95 > 60s) as FAIL', () => {
    const r = computeLatencyMetrics([accept(2000, 75000)]);
    expect(r.acceptClickPass).toBe(true);
    expect(r.acceptOutcomePass).toBe(false);
  });
});
