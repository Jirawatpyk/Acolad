import type { LogoutKind } from '../portal/errors.js';

/**
 * Pure yield-decision helpers (no I/O — TDD, fully unit-tested). The loop owns
 * the yield state machine; these functions hold the rules. See
 * docs/superpowers/specs/2026-06-26-xtm-auto-yield-design.md.
 */

/**
 * Should a logged-out page trigger a YIELD (vs a normal re-login)?
 * - kicked_by_other → always yield (deterministic: someone else logged in).
 * - expired → NEVER yield. A genuine `SESSION_EXPIRED` (no competing human) must
 *   re-login. The old recency heuristic was always-true here because
 *   `lastAuthSuccessMs` is refreshed every cycle, so every real expiry produced a
 *   ~10-min false gap + a false "account in use" alert (F1). The recon gives us a
 *   deterministic expiry signal — trust it.
 * - unknown → recency heuristic: only yield if we were authenticated within
 *   `windowMs` (a suspiciously fast logout of unknown cause implies a competing
 *   login burst); otherwise re-login.
 */
export function shouldYieldOnLogout(a: {
  kind: LogoutKind;
  lastAuthSuccessMs: number;
  nowMs: number;
  windowMs: number;
}): boolean {
  if (a.kind === 'kicked_by_other') return true;
  if (a.kind === 'expired') return false;
  // unknown
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
