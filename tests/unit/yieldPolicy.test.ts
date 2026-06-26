import { describe, it, expect } from 'vitest';
import { shouldYieldOnLogout, inCooldown, yieldStuck } from '../../src/runtime/yieldPolicy.js';

describe('shouldYieldOnLogout', () => {
  // "recent" = authenticated 5s ago (< 600s window); "stale" = 1000s ago (> window).
  const recent = { lastAuthSuccessMs: 1_000_000, nowMs: 1_000_000 + 5_000, windowMs: 600_000 };
  const stale = { lastAuthSuccessMs: 1_000_000, nowMs: 2_000_000, windowMs: 600_000 };

  it('always yields when kicked by another user (deterministic), regardless of recency', () => {
    expect(shouldYieldOnLogout({ ...recent, kind: 'kicked_by_other' })).toBe(true);
    expect(shouldYieldOnLogout({ ...stale, kind: 'kicked_by_other' })).toBe(true);
  });

  it('NEVER yields on a genuine SESSION_EXPIRED — re-login instead (recent)', () => {
    // F1: lastAuthSuccessMs is refreshed every cycle, so it is always "recent". A genuine
    // expiry (no competing human) must re-login, not yield — otherwise every real expiry
    // becomes a 10-min false gap + a false "human in use" alert.
    expect(shouldYieldOnLogout({ ...recent, kind: 'expired' })).toBe(false);
  });

  it('NEVER yields on a genuine SESSION_EXPIRED — re-login instead (stale)', () => {
    expect(shouldYieldOnLogout({ ...stale, kind: 'expired' })).toBe(false);
  });

  it('yields on an UNKNOWN logout only when authenticated within the window (recent)', () => {
    expect(shouldYieldOnLogout({ ...recent, kind: 'unknown' })).toBe(true);
  });

  it('does NOT yield on an UNKNOWN logout when the last success is older than the window (stale)', () => {
    expect(shouldYieldOnLogout({ ...stale, kind: 'unknown' })).toBe(false);
  });

  it('does NOT yield on a cold start (no prior success) for an unknown logout', () => {
    expect(
      shouldYieldOnLogout({
        kind: 'unknown',
        lastAuthSuccessMs: 0,
        nowMs: 5_000,
        windowMs: 600_000,
      }),
    ).toBe(false);
  });
});

describe('inCooldown', () => {
  it('is true before the deadline, false at/after it', () => {
    expect(inCooldown(2_000, 1_999)).toBe(true);
    expect(inCooldown(2_000, 2_000)).toBe(false);
    expect(inCooldown(0, 1)).toBe(false); // 0 = not yielding
  });
});

describe('yieldStuck', () => {
  it('is true once the episode has run for >= maxMinutes', () => {
    expect(yieldStuck(0, 9_999_999, 60)).toBe(false); // episode 0 = not yielding
    expect(yieldStuck(1_000, 1_000 + 60 * 60_000 - 1, 60)).toBe(false);
    expect(yieldStuck(1_000, 1_000 + 60 * 60_000, 60)).toBe(true);
  });
});
