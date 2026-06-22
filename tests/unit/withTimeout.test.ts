import { describe, it, expect } from 'vitest';
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
});
