import { createServer, type Server } from 'node:net';

export interface SingleInstanceOpts {
  /** localhost TCP port used as the lock token. */
  port: number;
  /** how long to retry on EADDRINUSE before giving up (rides out an old instance's shutdown). */
  retryMs: number;
  /** called once, right before rejecting, so a refusal can page the dead-man switch. */
  onRefused?: () => Promise<void>;
  /** injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Acquire a single-instance lock by binding 127.0.0.1:<port>. The OS frees the port
 * when this process dies (no stale-lock handling). On EADDRINUSE it retries for
 * `retryMs` to ride out an old instance's shutdown; still held → awaits onRefused()
 * then rejects. Returns an async release().
 */
export async function acquireSingleInstanceLock(
  opts: SingleInstanceOpts,
): Promise<() => Promise<void>> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.retryMs;
  for (;;) {
    try {
      const server = await listen(opts.port);
      return () => close(server);
    } catch (err) {
      const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (inUse && Date.now() < deadline) {
        await sleep(500);
        continue;
      }
      await opts.onRefused?.();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Sentinel server: destroy any real connection — it exists only to hold the port.
    const server = createServer((sock) => sock.destroy());
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
