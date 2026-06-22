/**
 * Resolve when `p` settles or `ms` elapses, whichever is first. On timeout (or if
 * `p` rejects) it resolves `undefined` — it NEVER rejects, so it is safe to use on
 * shutdown/cleanup paths where a hung close must not block process exit.
 *
 * `onTimeout` (if given) fires only when the timer wins the race — i.e. `p` genuinely
 * hung past `ms`. Use it to surface a hung close loudly: a dispose that times out can
 * mean an orphaned Chromium, which would otherwise be invisible (both timeout and
 * success resolve `undefined`). It does NOT fire when `p` rejects (that is swallowed).
 */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([p.catch(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
