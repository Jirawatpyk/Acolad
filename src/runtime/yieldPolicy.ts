import type { LogoutKind } from '../portal/errors.js';

/**
 * Pure yield-decision helpers (no I/O — TDD, fully unit-tested). The loop owns
 * the yield state machine; these functions hold the rules. See
 * docs/superpowers/specs/2026-06-26-xtm-auto-yield-design.md.
 */

/** Read the logout reason from a `logout.jsp?type=…` URL (live-recon confirmed). */
export function classifyLogout(url: string): LogoutKind {
  if (/type=LOGGED_OFF_BY_ANOTHER_USER/i.test(url)) return 'kicked_by_other';
  if (/type=SESSION_EXPIRED/i.test(url)) return 'expired';
  return 'unknown';
}

/**
 * Should a logged-out page trigger a YIELD (vs a normal re-login)?
 * - kicked_by_other → always yield (deterministic: someone else logged in).
 * - expired/unknown → yield only if we were authenticated within `windowMs`
 *   (a suspiciously fast expiry implies a competing login burst); otherwise it
 *   is a genuine expiry and we should re-login.
 */
export function shouldYieldOnLogout(a: {
  kind: LogoutKind;
  lastAuthSuccessMs: number;
  nowMs: number;
  windowMs: number;
}): boolean {
  if (a.kind === 'kicked_by_other') return true;
  return a.lastAuthSuccessMs > 0 && a.nowMs - a.lastAuthSuccessMs < a.windowMs;
}

/** Still within the post-yield cooldown? (0 = not yielding.) */
export function inCooldown(yieldUntilMs: number, nowMs: number): boolean {
  return yieldUntilMs > nowMs;
}

/** Has the current yield episode exceeded the hard cap → escalate + page. */
export function yieldStuck(episodeStartedMs: number, nowMs: number, maxMinutes: number): boolean {
  return episodeStartedMs > 0 && nowMs - episodeStartedMs >= maxMinutes * 60_000;
}
