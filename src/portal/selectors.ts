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
    // Loading indicators shown while the offers list is still rendering (real
    // portal: data-test="loader-container"). While one of these is visible, the
    // absence of rows/empty-state is NOT meaningful — readJobSnapshot waits for
    // it to clear and treats a stuck loader as transient, never a layout change.
    // The pre-render app shell has no stable marker, only "Loading..." text —
    // isLoading() falls back to that (see jobList.ts).
    loading: '[data-test="loader-container"], [data-test*="loader"], [data-test*="spinner"]',
  },
  // Presence of any of these means the portal demands a human (no auto-bypass).
  challenge: 'iframe[src*="recaptcha"], iframe[title*="captcha"], [data-test="2fa"], #captcha',
  // Marker that we are on the login screen (presence of the password field).
  // Used to detect "not authenticated" and mid-session expiry. A job-list page
  // has no password field, so this never false-positives there.
  loggedOutMarker:
    '[data-test="password-input-input"], #login-submit-button, input[type="password"]',
} as const;

/**
 * XTM Cloud selector registry (feature 002, R9). Confirmed against real recon
 * evidence (state/evidence/xtm-recon-2026-06-19T07-31-59-976Z/) + adversarial
 * review. The partner SELECTORS above stay until T052.
 *
 * Architecture facts that shape these selectors:
 *  - XTM is an AngularJS SPA; the login form and tab grids render client-side,
 *    so the adapter MUST wait for a rendered marker before reading.
 *  - The task inbox lives INSIDE `iframe#myInboxIframe`. EVERY grid/tab/cell
 *    selector below is relative to that frame — use
 *    `page.frameLocator(XTM.iframe.el)` (or the Frame from contentFrame()).
 *  - DISPLAY label vs internal id are mismatched: label "Active" = aria-controls
 *    IN_PROGRESS = the accept/watch target; label "Planned" = NEW_TASKS (unused).
 *    Selectors key off `aria-controls` / `#tasksState`, never display text.
 *  - Prefer ids + data-testid (locale- and build-stable). CSS-module hash
 *    classes (e.g. `--nG61D`) are build-specific (release 25.6.0) — avoided as
 *    primary; rows are identified structurally (presence of the kebab button).
 *
 * `UNCONFIRMED` markers = not derivable from current evidence (no un-accepted
 * job existed during recon). Those paths MUST fail loud + capture evidence on
 * the first real job rather than guess (Constitution VI, FR-011/FR-022).
 */
export const XTM = {
  base: 'https://xtm.acolad.com/project-manager-gui',

  // Human-verification challenge — XTM has is2FAEnabled=false today, but if any
  // CAPTCHA/2FA ever appears we refuse to proceed (no auto-bypass, Constitution VI).
  challenge: 'iframe[src*="recaptcha"], iframe[title*="captcha" i], [data-test*="2fa" i], #captcha',

  // ── Login (outer page; AngularJS, client-side rendered) ───────────────────
  login: {
    appShell: '[ng-app="xtm.login"]',
    view: '.login-view', // ui-view target where the form renders
    submitEndpoint: '/project-manager-gui/login.serv',
    // Real rendered form (captured 2026-06-19 via scripts/capture-login-dom.ts):
    // the .login-view template loads via XHR and exposes THREE visible fields, each
    // with a stable id/name — client, username, password. The client field is NOT
    // pre-filled; it must be typed with XTM_ACOLAD_Company (AMPLEXOR). Target by id
    // (never positional .first() — the first visible text input is `client`, not
    // `username`, which silently mis-fills and gets the login rejected).
    client: '#client, input[name="client"], [ng-model="loginFormCtrl.formModel.client"]',
    username: '#username, input[name="username"], [ng-model="loginFormCtrl.formModel.username"]',
    password: '#password, input[name="password"], [ng-model="loginFormCtrl.formModel.password"]',
    submit: '.login-view button[type="submit"], .login-view input[type="submit"]',
  },

  // ── Session markers (outer shell) ─────────────────────────────────────────
  session: {
    loggedInToken: '#uust', // non-empty ⇒ authenticated. SECRET — never log.
    loggedInRoot: 'body#root.xtm-app',
    loggedOutShell: 'body.loginPage, [ng-app="xtm.login"]', // seen mid-run ⇒ re-login
    sessionTimeoutSeconds: '#sessionTimeOut', // value "3600"
    csrfBuildId: '#xcbid',
  },

  // ── Inbox iframe — host for ALL grid/tab selectors below ──────────────────
  iframe: {
    el: '#myInboxIframe', // page.waitForSelector then frameLocator/contentFrame
  },

  // ── Tabs (inside the iframe). Key off aria-controls, NOT display text. ─────
  tabs: {
    active: 'a[role="tab"][aria-controls="IN_PROGRESS"]', // display "Active" — target
    planned: 'a[role="tab"][aria-controls="NEW_TASKS"]', // display "Planned" — unused
    closed: 'a[role="tab"][aria-controls="CLOSED_TASKS"]', // display "Closed"
  },

  // ── Active (IN_PROGRESS) grid — D1/D5/D6 ──────────────────────────────────
  active: {
    // Assert we are on the right tab before trusting rows (Planned=PENDING).
    stateMarker: 'input#tasksState[value="ACTIVE"]',
    gridContainer: 'table#TaskListingTable',
    // Presence proves the grid shell rendered (distinguishes empty vs failed).
    gridLoadedMarker: 'table#TaskListingTable thead',
    // Data rows carry the per-row kebab; header/empty rows do not. Identify rows
    // structurally by that button rather than by a build-hashed row class. In
    // code: container.locator('tbody tr').filter({ has: rowKebab }).
    rowKebab: 'button[data-testid="context-menu-button"]',
    rowDetailsButton: '[aria-haspopup="dialog"]', // row-scoped; NOT #RESERVATION (dup id)
    // Authoritative count footer; parse digits only (the word "of" is English).
    itemsCount: '[data-testid="listing-section-footer"]',
    // Per-column cells, scoped to a data row. col 0 = kebab = nth-child(1).
    // Indices 1–11 are identical on Active and Closed (omitted cols are trailing).
    cell: {
      project: 'td:nth-child(2)', // RawJob.projectName
      file: 'td:nth-child(5)', // RawJob.fileName + D2 job-key basis
      source: 'td:nth-child(6)', // RawJob.sourceLang ("English (USA)")
      target: 'td:nth-child(7)', // RawJob.targetLang — compared to Malay (config)
      step: 'td:nth-child(9)', // RawJob.step  (D2 key part)
      role: 'td:nth-child(11)', // RawJob.role  (D2 key part)
      segments: 'td:nth-child(12)',
      // data-testid inner targets (locale/build stable) — Active-only columns:
      dueDate: '[data-testid="dueDate-fullDate"]', // RawJob.dueDate
      words: '[data-testid="words-container"]', // RawJob.words (Active col 13)
      progressFiller: '[data-testid="progress-container-filler"]', // col 14; 0%/grey = not started
    },
  },

  // ── Empty-state vs failed-render (shared) ─────────────────────────────────
  // Empty  = gridContainer + gridLoadedMarker + correct #tasksState present AND
  //          zero kebab rows AND itemsCount begins "0 - 0 of 0".
  // Failed = gridContainer / thead / #tasksState absent ⇒ LayoutChangedError.
  emptyState: {
    // Translatable confirmation only — NEVER the primary detector.
    placeholderText: 'There is no data to display.',
  },

  // ── Closed (FINISHED) grid — D8 ───────────────────────────────────────────
  // Same table#TaskListingTable, 12 columns (no Words/Progress/Details), NO
  // status column. Closed-vs-Removed is decided by presence/absence:
  //   gone from Active & found here ⇒ Closed; gone & absent here ⇒ Removed.
  closed: {
    stateMarker: 'input#tasksState[value="FINISHED"]',
    gridContainer: 'table#TaskListingTable',
    rowKebab: 'button[data-testid="context-menu-button"]',
    itemsCount: '[data-testid="listing-section-footer"]',
    cell: {
      project: 'td:nth-child(2)',
      file: 'td:nth-child(5)', // join key vs the disappeared Active job
      target: 'td:nth-child(7)',
      dueDate: '[data-testid="dueDate-fullDate"]',
    },
  },

  // ── Accept control + success signal — D4/D6 ───────────────────────────────
  // PATH CONFIRMED from recon screenshots + DOM capture: open the row kebab →
  // a Radix dropdown renders into `#context-menus-container` (inside the iframe)
  // → its submenu parent is STATE-DEPENDENT text: "Accept task" for an
  // acceptable job, "Finish task" for an in-progress/finished one. The bot acts
  // ONLY when "Accept task" is present (⇒ this job is acceptable). Expanding it
  // reveals 6 options; the bulk one (FR-006) is "Accept all tasks for this
  // language in this group".
  //
  // These item texts are LOCALE-dependent (UI is en_GB) — treat them as
  // config-adjacent and FAIL LOUD if not found on an eligible job rather than
  // clicking a wrong item. The exact submenu DOM + the success signal still
  // need an evidence-first capture on a real un-accepted Malay job; until then
  // T026 confirms the outcome by RE-READING Active (FR-024), never by trusting
  // the click. ACCEPT_ENABLED stays 0 until that capture lands.
  accept: {
    rowKebab: 'button[data-testid="context-menu-button"]', // open row menu (row-scoped)
    menuContainer: '#context-menus-container', // Radix menu portal (in iframe)
    acceptTaskItemText: 'Accept task', // submenu parent on an acceptable job — FAIL LOUD if absent
    finishTaskItemText: 'Finish task', // same slot when the job is in-progress/done (NOT acceptable)
    bulkForLanguageInGroupText: 'Accept all tasks for this language in this group', // FR-006
    // UNCONFIRMED — success signal: re-fetch of the in-progress list after accept.
    successRefetchEndpoint: '/project-manager-gui/myinbox/getInProgressElements.serv',
    successToast: 'div.xtm-toast, div.Toastify', // HYPOTHESIS — never observed firing
  },
} as const;

/**
 * Exact target-language display string for eligibility (D5). Locale-dependent
 * (the UI is en_GB now), so it lives in config (ACCEPT_LANGUAGES), compared to
 * the Active target cell. The parser must fail loud on an unrecognized language
 * rather than silently treating a non-match as "not Malay" (fail-silent risk).
 */
export const XTM_MALAY_TARGET_DISPLAY_DEFAULT = 'Malay (Malaysia)';
