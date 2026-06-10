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
