/**
 * Resolve when `p` settles or `ms` elapses, whichever is first. On timeout (or if
 * `p` rejects) it resolves `undefined` — it NEVER rejects, so it is safe to use on
 * shutdown/cleanup paths where a hung close must not block process exit.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([p.catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
