import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import { acquireSingleInstanceLock } from '../../src/runtime/singleInstance.js';

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

describe('acquireSingleInstanceLock', () => {
  it('acquires a free port; a second acquire is refused and calls onRefused', async () => {
    const port = await freePort();
    const release = await acquireSingleInstanceLock({ port, retryMs: 0 });
    const onRefused = vi.fn(async () => {});
    await expect(acquireSingleInstanceLock({ port, retryMs: 0, onRefused })).rejects.toThrow();
    expect(onRefused).toHaveBeenCalledTimes(1);
    await release();
  });

  it('re-acquires after release', async () => {
    const port = await freePort();
    await (
      await acquireSingleInstanceLock({ port, retryMs: 0 })
    )();
    const release2 = await acquireSingleInstanceLock({ port, retryMs: 0 });
    await release2(); // succeeded → no throw
  });
});
