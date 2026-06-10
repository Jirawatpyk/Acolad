/**
 * Central selector registry (R9). ALL portal DOM coupling lives here so that a
 * layout change is fixed in one file. Selectors are structural (data-* / roles),
 * not text-based, so a locale change does not silently break parsing — when a
 * marker is missing the adapter fails loud (LayoutChangedError) rather than
 * guessing.
 *
 * NOTE: the portal had no live jobs when this was written. These selectors are
 * the planned contract used by fixtures; evidence-first mode captures the real
 * first job so they can be confirmed/adjusted against production HTML.
 */
export const SELECTORS = {
  login: {
    email:
      '[data-test="email-input-input"], #email-input, input[type="email"], input[name="email"]',
    password:
      '[data-test="password-input-input"], #password-input, input[type="password"], input[name="password"]',
    submit: '#login-submit-button, button[type="submit"], input[type="submit"]',
  },
  // Presence of this marker proves the offers page shell loaded (real portal:
  // data-test="offers-nav"). Absence => LayoutChangedError, NOT "empty list".
  jobList: {
    container: '[data-test="offers-nav"], [data-test="job-list"], #job-list, main [role="list"]',
    // Explicit "no offers" marker on the real portal.
    emptyState: '[data-test="empty-state-subtitle"], [data-test="empty-state"]',
    // Best-effort offer-card selector. The portal had NO offers when this was
    // written, so the exact per-offer selector is unconfirmed (R9). If offers
    // appear and none of these match, readJobSnapshot fails loud + captures
    // evidence (rather than reporting a false "empty"), which surfaces the real
    // selector to adopt here.
    row: '[data-test^="offer-card"], [data-test^="card-offer"], [data-test^="offer-row"], [data-test="job-row"], [role="listitem"]',
    field: {
      id: '[data-test*="offer-id"], [data-test="job-id"], .job-id',
      title:
        '[data-test*="offer-title"], [data-test*="project-name"], [data-test="job-title"], .job-title',
      languagePair: '[data-test*="lang"], [data-test="job-langs"], .job-langs',
      deadline:
        '[data-test*="deadline"], [data-test*="due"], [data-test="job-deadline"], .job-deadline',
      fee: '[data-test*="fee"], [data-test*="price"], [data-test*="amount"], [data-test="job-fee"], .job-fee',
      link: 'a[data-test*="offer"], a[data-test="job-link"], a.job-link',
    },
    // Multi-page indicators — presence means we may not see all jobs (FR-009).
    pagination: '[data-test*="pagination"], .pagination, nav[aria-label*="age"]',
  },
  // Presence of any of these means the portal demands a human (no auto-bypass).
  challenge: 'iframe[src*="recaptcha"], iframe[title*="captcha"], [data-test="2fa"], #captcha',
  // Marker that we are on the login screen (presence of the password field).
  // Used to detect "not authenticated" and mid-session expiry. A job-list page
  // has no password field, so this never false-positives there.
  loggedOutMarker:
    '[data-test="password-input-input"], #login-submit-button, input[type="password"]',
} as const;
