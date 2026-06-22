/**
 * XTM Active-grid fixtures (feature 002). Faithful to the real recon structure
 * (state/evidence/xtm-recon-*): the grid is `table#TaskListingTable` with a
 * 15-column row; data rows carry the per-row kebab `button[data-testid=
 * "context-menu-button"]` (header rows do not). nth-child column order is the
 * confirmed one — Project(2) File(5) Source(6) Target(7) Step(9) Role(11) with
 * data-testid cells for due/words/progress. Anonymized (no real customer data).
 */

export interface XtmRowSpec {
  /** Data rows carry the kebab; set false to emit a non-data (header-like) row. */
  kebab?: boolean;
  project?: string;
  fileWwc?: string;
  customer?: string;
  file?: string;
  source?: string;
  target?: string;
  due?: string;
  step?: string;
  stepType?: string;
  role?: string;
  segments?: string;
  words?: string;
}

export function xtmRow(spec: XtmRowSpec = {}): string {
  const kebab = spec.kebab ?? true;
  const td1 = kebab
    ? '<td><button data-testid="context-menu-button" aria-label="More actions">⋮</button></td>'
    : '<td></td>';
  return (
    `<tr class="listingTable__tableRow--nG61D">${td1}` +
    `<td>${spec.project ?? ''}</td>` +
    `<td>${spec.fileWwc ?? ''}</td>` +
    `<td>${spec.customer ?? ''}</td>` +
    `<td>${spec.file ?? ''}</td>` +
    `<td>${spec.source ?? ''}</td>` +
    `<td>${spec.target ?? ''}</td>` +
    `<td><span data-testid="dueDate-fullDate">${spec.due ?? ''}</span></td>` +
    `<td>${spec.step ?? ''}</td>` +
    `<td>${spec.stepType ?? ''}</td>` +
    `<td>${spec.role ?? ''}</td>` +
    `<td>${spec.segments ?? ''}</td>` +
    `<td><span data-testid="words-container">${spec.words ?? ''}</span></td>` +
    `<td><span data-testid="progress-container-filler"></span></td>` +
    `<td><button aria-haspopup="dialog" aria-label="Details">i</button></td>` +
    `</tr>`
  );
}

/** A complete Malay corrector task row (the auto-accept target shape). */
export function malayRow(over: Partial<XtmRowSpec> = {}): string {
  return xtmRow({
    project: 'Newswire Release 4712942',
    fileWwc: '17',
    file: '4712942-1-21 (ID-1b270f065098)_captions.json',
    source: 'English (USA)',
    target: 'Malay (Malaysia)',
    due: '18-Jun-2026 19:25',
    step: 'Post-Editing (PE) 1',
    stepType: 'CAT Tool Step',
    role: 'Corrector',
    segments: 'All: 1 - 5',
    words: '37',
    ...over,
  });
}

/** A non-Malay row (must be parsed but is not eligible). */
export function thaiRow(over: Partial<XtmRowSpec> = {}): string {
  return xtmRow({
    project: 'Newswire Release 4712942',
    fileWwc: '21',
    file: '4712942-1-22 (ID-aa11bb22cc33)_body.html',
    source: 'English (USA)',
    target: 'Thai',
    due: '18-Jun-2026 19:25',
    step: 'Post-Editing (PE) 1',
    stepType: 'CAT Tool Step',
    role: 'Corrector',
    segments: 'All: 1 - 9',
    words: '120',
    ...over,
  });
}

export function xtmActivePage(
  rows: string[],
  opts: { state?: string; total?: number; shown?: number } = {},
): string {
  const state = opts.state ?? 'ACTIVE';
  const total = opts.total ?? rows.length;
  // `shown` = the last item index on THIS page (footer "1 - shown of total").
  // Defaults to total so existing fixtures are unchanged; set shown < total to
  // simulate a paginated grid (more items exist on later pages).
  const end = opts.shown ?? total;
  const lo = total === 0 ? 0 : 1;
  return (
    `<!DOCTYPE html><html><head><title>Tasks</title></head>` +
    `<body id="internal" ng-app="xtm.tasks">` +
    `<input type="hidden" id="tasksState" value="${state}">` +
    `<div id="taskListing" role="tabpanel"><h1 id="${state}">Active tasks</h1>` +
    `<table id="TaskListingTable">` +
    `<thead class="table__tableHeader--22GT1"><tr class="listingTable__headRow--OEmzU">` +
    `<th></th><th>Project</th><th>File WWC</th><th>Customer</th><th>File</th>` +
    `<th>Source</th><th>Target</th><th>Date due</th><th>Step</th><th>Step type</th>` +
    `<th>Role</th><th>Segments</th><th>Words</th><th>Progress</th><th></th></tr></thead>` +
    `<tbody class="table__tableBody--1Pixi">${rows.join('')}</tbody>` +
    `</table>` +
    `<div data-testid="listing-section-footer"><span class="itemsCount__itemCount--1BMuy">${lo} - ${end} of ${total}</span></div>` +
    `<div class="en_GB" id="context-menus-container"></div>` +
    `</div></body></html>`
  );
}

/** Active tab, genuinely empty (footer "0 - 0 of 0", container present). */
export function xtmEmptyActivePage(): string {
  return xtmActivePage([], { total: 0 });
}

/** Structural container/state marker absent — must fail loud (LayoutChangedError). */
export function xtmBrokenActivePage(): string {
  return `<!DOCTYPE html><html><body><div>unexpected XTM layout</div></body></html>`;
}

/** Container present but footer claims rows while tbody is empty (still loading). */
export function xtmLoadingActivePage(): string {
  return xtmActivePage([], { total: 3 });
}

/** The XTM login shell with the (client-rendered) form fields present. */
export function xtmLoginPage(): string {
  return (
    `<!DOCTYPE html><html><body class="loginPage template template-AMPLEXOR" ng-app="xtm.login">` +
    `<div class="login-body"><div class="login-view">` +
    `<input type="text" name="userId" placeholder="Username">` +
    `<input type="password" name="password" placeholder="Password">` +
    `<button type="submit">Log in</button>` +
    `</div></div></body></html>`
  );
}

/** The authenticated inbox shell — no login markers. */
export function xtmLoggedInPage(): string {
  return (
    `<!DOCTYPE html><html><body id="root" class="xtm-app" ng-app="xtm.tasks">` +
    `<input type="hidden" id="uust" value="sometoken">` +
    `<input type="hidden" id="sessionTimeOut" value="3600">` +
    `<iframe id="myInboxIframe" src="my-inbox-start.action"></iframe>` +
    `</body></html>`
  );
}

/** Login page that also presents a CAPTCHA challenge. */
export function xtmChallengePage(): string {
  return (
    `<!DOCTYPE html><html><body class="loginPage" ng-app="xtm.login">` +
    `<div class="login-view"><input type="password" name="password"></div>` +
    `<iframe src="https://www.google.com/recaptcha/api2/anchor" title="reCAPTCHA"></iframe>` +
    `</body></html>`
  );
}
