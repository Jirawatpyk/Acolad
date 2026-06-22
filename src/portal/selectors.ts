/**
 * XTM Cloud selector registry (feature 002, R9). ALL portal DOM coupling lives
 * here so a layout change is fixed in one file. Selectors are structural
 * (id / data-* / aria-controls), not display-text, so a locale change does not
 * silently break parsing — a missing marker fails loud (LayoutChangedError)
 * rather than guessing. Confirmed against real recon evidence + adversarial review.
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
  // CONFIRMED from a real eligible Malay job's menu DOM (recon 2026-06-22,
  // release 25.6.0, state/evidence/...-accept_menu_recon):
  //  - The row kebab opens a dropdown rendered INLINE inside `#taskListing` as
  //    `[data-dropdown-menu="true"]` (a fixed-positioned div), NOT in the
  //    `#context-menus-container` portal — that portal stays EMPTY (the earlier
  //    assumption was wrong; targeting it found nothing).
  //  - Menu items are `li[data-dropdown-menu-item="true"]` with STABLE ids
  //    `TASK_LISTING_<ACTION>_<taskId>`. The acceptable-job action is
  //    `TASK_LISTING_ACCEPT_GROUP_TASK_<taskId>` (label "Accept task", carries a
  //    chevron ⇒ it is a SUBMENU parent). Keying off this id prefix is
  //    locale-independent — preferred over the en_GB label text.
  //
  // D6 RESOLVED (operator-confirmed 2026-06-22): after WE accept, the job STAYS in
  // Active but its menu's "Accept task" item is replaced by "Finish task". So
  // acceptAvailable = PRESENCE of acceptTaskItem (TASK_LISTING_ACCEPT_GROUP_TASK_)
  // in that row's menu — claimable when present, owned-by-us when absent. This needs
  // NO separate "Finish task" selector (the accept item's ABSENCE is the signal) and
  // makes determineAcceptOutcomes correct: present+acceptable=failed,
  // present+not-acceptable=accepted, gone=snatched. The grid cells do not expose it,
  // so it must be read by opening the row kebab — computed for the TARGET rows in the
  // post-accept re-read, not the bulk grid scrape (see [[xtm-accept-d6-finish-task]]).
  //
  // BULK OPTION CONFIRMED (recon 2026-06-22): hovering acceptTaskItem expands a submenu
  // of 6 accept variants; FR-006 uses bulkForLanguageInGroupItem ("Accept all tasks for
  // this language in this group", id prefix TASK_LISTING_ACCEPT_ALL_TASKS_OF_THIS_LANGUAGE_IN_THIS_GROUP_).
  // With the menu container, accept item, bulk item, and D6 acceptAvailable all confirmed,
  // the accept path is SELECTOR-COMPLETE — ACCEPT_ENABLED may be turned on via the runbook
  // (start ACCEPT_MAX_PER_CYCLE=1) once a human signs off on auto-accepting on the shared account.
  accept: {
    rowKebab: 'button[data-testid="context-menu-button"]', // open row menu (row-scoped)
    // The open dropdown renders inline (fixed position) — NOT the empty portal.
    menuContainer: '[data-dropdown-menu="true"]',
    menuItem: 'li[data-dropdown-menu-item="true"]',
    // Acceptable-job signal — locale-independent id prefix (label "Accept task").
    // Presence on a row's open menu ⇒ the job is claimable; absence ⇒ not (D6).
    acceptTaskItem: '[id^="TASK_LISTING_ACCEPT_GROUP_TASK_"]',
    acceptTaskItemText: 'Accept task', // en_GB label (reference only; code matches acceptTaskItem id)
    // Owned-by-us signal — the menu item that REPLACES "Accept task" after WE accept
    // (CONFIRMED 2026-06-22 via scripts/verify-reread.mjs on an accepted row; the live id
    // is plural TASK_LISTING_FINISH_TASKS_<n>, so the prefix matches). Presence ⇒ this row
    // is already ours, NOT a failed accept — used to avoid re-attempting/false-failing a
    // job a prior bulk grabbed.
    finishTaskItem: '[id^="TASK_LISTING_FINISH_TASK"]',
    finishTaskItemText: 'Finish task', // en_GB label (reference only)
    // FR-006 bulk option — CONFIRMED from the expanded submenu. Hovering acceptTaskItem
    // reveals 6 variants; this is the "all tasks for this language in this group" one.
    bulkForLanguageInGroupItem:
      '[id^="TASK_LISTING_ACCEPT_ALL_TASKS_OF_THIS_LANGUAGE_IN_THIS_GROUP_"]',
    bulkForLanguageInGroupText: 'Accept all tasks for this language in this group', // CONFIRMED en_GB label
  },
} as const;

/**
 * Exact target-language display string for eligibility (D5). Locale-dependent
 * (the UI is en_GB now), so it lives in config (ACCEPT_LANGUAGES), compared to
 * the Active target cell. The parser must fail loud on an unrecognized language
 * rather than silently treating a non-match as "not Malay" (fail-silent risk).
 */
export const XTM_MALAY_TARGET_DISPLAY_DEFAULT = 'Malay (Malaysia)';
