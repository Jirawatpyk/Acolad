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

/** One eligible job to bulk-accept (contracts/xtm-portal-adapter.md). */
export interface AcceptTarget {
  jobKey: string;
  targetLang: string;
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
