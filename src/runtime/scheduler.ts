/**
 * Fixed-rate, start-to-start delay (SC-001b / contracts/config.md). Given when
 * the cycle started, the base interval, and how long the cycle took, returns
 * the sleep before the next cycle so that successive cycle *starts* are spaced
 * by `interval` (work time is absorbed). Jitter is applied then the result is
 * clamped to [minGapMs, maxGapMs] of real spacing.
 */
export function computeNextDelay(params: {
  intervalMs: number;
  cycleDurationMs: number;
  jitterMs: number;
  minGapMs?: number;
  maxGapMs?: number;
}): number {
  const { intervalMs, cycleDurationMs, jitterMs } = params;
  const minGap = params.minGapMs ?? 20_000;
  const maxGap = params.maxGapMs ?? 30_000;

  // Desired spacing between starts, with jitter, clamped to the spacing bounds.
  const desiredSpacing = clamp(intervalMs + jitterMs, minGap, maxGap);
  // Subtract the time the cycle already consumed (start-to-start).
  const delay = desiredSpacing - cycleDurationMs;
  // But never let the real gap between requests drop below minGap.
  const minDelay = Math.max(0, minGap - cycleDurationMs);
  return Math.max(minDelay, delay);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Deterministic-friendly jitter in [-spreadMs, +spreadMs] from a [0,1) source. */
export function jitter(spreadMs: number, rand: number): number {
  return Math.round((rand * 2 - 1) * spreadMs);
}
