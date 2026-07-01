/** Base class for all portal interaction failures (contracts/portal-adapter.md). */
export abstract class PortalError extends Error {
  abstract readonly kind: string;
}

export class LoginFailedError extends PortalError {
  readonly kind = 'login_failed';
}
export class CaptchaDetectedError extends PortalError {
  readonly kind = 'captcha_detected';
}
export class SessionExpiredError extends PortalError {
  readonly kind = 'session_expired';
}
export class LayoutChangedError extends PortalError {
  readonly kind = 'layout_changed';
  constructor(
    message: string,
    /** Path to captured evidence directory, if any. */
    readonly evidencePath?: string,
  ) {
    super(message);
  }
}
export class PortalTimeoutError extends PortalError {
  readonly kind = 'portal_timeout';
}
export class PaginationDetectedError extends PortalError {
  readonly kind = 'pagination_detected';
  constructor(
    message: string,
    readonly evidencePath?: string,
  ) {
    super(message);
  }
}

/**
 * Raised when an Accept action completed without a readable success signal
 * (FR-011). The adapter NEVER reports `accepted` on a guess — an unconfirmed
 * accept is surfaced as this error internally and reflected as
 * `AcceptResult.failed`, recorded as `accept_failed` + system alert.
 */
export class AcceptUnconfirmedError extends PortalError {
  readonly kind = 'accept_unconfirmed';
  constructor(
    message: string,
    /** Path to captured evidence (screenshot/HTML) for the unconfirmed accept. */
    readonly evidencePath?: string,
  ) {
    super(message);
  }
}

/** Why XTM logged a session out — read from `logout.jsp?type=…` (live recon). */
export type LogoutKind = 'kicked_by_other' | 'expired' | 'unknown';

/**
 * Read the logout reason from a `logout.jsp?type=…` URL (live-recon confirmed).
 * Lives in the portal layer because it parses a portal-specific URL contract.
 * The `type` value is anchored with `(?:&|$)` so a longer code that merely starts
 * with a known token (e.g. `SESSION_EXPIRED_FORCED`) does NOT false-match.
 */
export function classifyLogout(url: string): LogoutKind {
  if (/[?&]type=LOGGED_OFF_BY_ANOTHER_USER(?:&|$)/i.test(url)) return 'kicked_by_other';
  if (/[?&]type=SESSION_EXPIRED(?:&|$)/i.test(url)) return 'expired';
  return 'unknown';
}

/**
 * Thrown by the client when it lands logged-out and the loop's policy says to
 * YIELD rather than re-login (a competing human/session holds the shared account).
 * Deliberately extends Error (NOT PortalError): it is not a portal failure and
 * must never be swept into the portal_down / login-lockout handling.
 */
export class SessionYieldError extends Error {
  readonly kind = 'session_yield';
  constructor(readonly logoutKind: LogoutKind) {
    super(`yielding XTM account to another session (logout: ${logoutKind})`);
  }
}

/** One eligible job to bulk-accept (contracts/xtm-portal-adapter.md). */
export interface AcceptTarget {
  jobKey: string;
  targetLang: string;
  /** Cell values to locate THIS row deterministically (not a volatile nth index). */
  projectName: string;
  fileName: string;
  step: string | null;
  role: string | null;
}

/**
 * Per-jobKey outcome of a bulk accept, re-derived from re-reading Active
 * (FR-024). A bulk action fans out to one result per attempted jobKey so the
 * orchestration can record lifecycle per row.
 */
export type AcceptResult =
  // `at` = FR-024-confirmed timestamp (after the re-read); `clickedAt` = when the
  // confirm-click fired (before the re-read). Both feed the V16/V16b latency split.
  | { jobKey: string; outcome: 'accepted'; at: string; clickedAt?: string }
  | { jobKey: string; outcome: 'missing' } // snatched / no longer acceptable
  | { jobKey: string; outcome: 'failed'; reason: string }; // success not confirmable
