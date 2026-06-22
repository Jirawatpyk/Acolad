import { describe, it, expect, vi } from 'vitest';
import { withTimeout } from '../../src/withTimeout.js';

describe('withTimeout', () => {
  it('returns the value when the promise settles in time', async () => {
    expect(await withTimeout(Promise.resolve(42), 1000)).toBe(42);
  });

  it('returns undefined when the promise hangs past the timeout (never rejects)', async () => {
    const hang = new Promise<number>(() => {}); // never resolves
    const start = Date.now();
    const r = await withTimeout(hang, 30);
    expect(r).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('swallows a rejection and resolves undefined', async () => {
    expect(await withTimeout(Promise.reject(new Error('x')), 1000)).toBeUndefined();
  });

  it('clears its timer on the fast-settle path (no leaked timer keeps the loop alive)', async () => {
    vi.useFakeTimers();
    try {
      const r = await withTimeout(Promise.resolve(1), 60_000);
      expect(r).toBe(1);
      expect(vi.getTimerCount()).toBe(0); // the finally cleared the pending setTimeout
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires onTimeout only when the timer wins (not on a fast settle)', async () => {
    const onFast = vi.fn();
    await withTimeout(Promise.resolve('ok'), 1000, onFast);
    expect(onFast).not.toHaveBeenCalled();

    const onHang = vi.fn();
    expect(await withTimeout(new Promise<string>(() => {}), 20, onHang)).toBeUndefined();
    expect(onHang).toHaveBeenCalledTimes(1);
  });

  it('does not fire onTimeout when p rejects (the rejection is swallowed, not a timeout)', async () => {
    const onTimeout = vi.fn();
    expect(await withTimeout(Promise.reject(new Error('x')), 1000, onTimeout)).toBeUndefined();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
