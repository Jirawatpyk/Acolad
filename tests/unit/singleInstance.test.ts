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

  it('retries on EADDRINUSE and acquires once the holder releases mid-retry', async () => {
    const port = await freePort();
    const release1 = await acquireSingleInstanceLock({ port, retryMs: 0 });
    let released = false;
    // Injected sleep stands in for the 500ms backoff; on the first retry it frees the port,
    // so the next listen() succeeds — the exact "ride out the old instance's shutdown" path.
    const sleep = vi.fn(async () => {
      if (!released) {
        released = true;
        await release1();
      }
    });
    const release2 = await acquireSingleInstanceLock({ port, retryMs: 5000, sleep });
    expect(sleep).toHaveBeenCalled();
    await release2();
  });

  it('does not call onRefused on a successful acquire', async () => {
    const port = await freePort();
    const onRefused = vi.fn(async () => {});
    const release = await acquireSingleInstanceLock({ port, retryMs: 0, onRefused });
    expect(onRefused).not.toHaveBeenCalled();
    await release();
  });
});
