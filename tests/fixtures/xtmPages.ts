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

/**
 * A HYPOTHETICAL Closed-grid row with the File WWC column (Active col 3) OMITTED — used to
 * document and exercise the readClosedKeys layout-drift detector (finding #2). NOT recon-
 * confirmed: the live Closed-grid column set is unknown (see selectors.ts `closed.cell` VERIFY
 * note). With File WWC gone the trailing columns shift LEFT by one, so the borrowed Active
 * selectors land off the row — `closed.cell.file` (td:5) reads Source, and step (td:9) / role
 * (td:11) fall PAST the last cell → null. That "non-empty file but null step AND role across all
 * rows" signature is exactly the systematic-drift signal the detector watches for. Columns here:
 * kebab(1) project(2) customer(3) file(4) source(5) target(6) due(7) step(8).
 */
export function xtmClosedRowNoWwc(over: Partial<XtmRowSpec> = {}): string {
  const kebab = over.kebab ?? true;
  const td1 = kebab
    ? '<td><button data-testid="context-menu-button" aria-label="More actions">⋮</button></td>'
    : '<td></td>';
  return (
    `<tr class="listingTable__tableRow--nG61D">${td1}` +
    `<td>${over.project ?? 'Newswire Release 4712942'}</td>` +
    `<td>${over.customer ?? 'Acme'}</td>` +
    `<td>${over.file ?? '4712942-1-21 (ID-1b270f065098)_captions.json'}</td>` +
    `<td>${over.source ?? 'English (USA)'}</td>` +
    `<td>${over.target ?? 'Malay (Malaysia)'}</td>` +
    `<td><span data-testid="dueDate-fullDate">${over.due ?? '18-Jun-2026 19:25'}</span></td>` +
    `<td>${over.step ?? 'Post-Editing (PE) 1'}</td>` +
    `</tr>`
  );
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

/**
 * A data row that carries a WORKING per-row kebab → dropdown menu, faithful to the
 * real XTM accept DOM (recon 2026-06-22): the kebab `button[data-testid=
 * "context-menu-button"]` opens an INLINE `[data-dropdown-menu="true"]` div holding
 * `li[data-dropdown-menu-item]` entries with stable id prefixes —
 * `TASK_LISTING_ACCEPT_GROUP_TASK_<id>` ("Accept task", claimable) or
 * `TASK_LISTING_FINISH_TASK_<id>` ("Finish task", already ours). The claimable menu
 * also embeds the FR-006 bulk item `TASK_LISTING_ACCEPT_ALL_TASKS_OF_THIS_LANGUAGE_
 * IN_THIS_GROUP_<id>`. The inline script toggles exactly the clicked row's menu
 * (and closes any other open one) so a scope-level `[data-dropdown-menu]` query —
 * the way production reads it — sees only the intended row's menu, which is what
 * lets a real-Chromium test exercise the target-keyed row locator end to end.
 */
export function xtmMenuRow(
  id: string,
  menu: 'accept' | 'finish',
  over: Partial<XtmRowSpec> = {},
): string {
  const base = over.target === 'Malay (Malaysia)' || over.target === undefined ? malayRow : xtmRow;
  // Render the standard cells (Malay shape by default) but inject a menu after the kebab.
  const rowHtml = over.target && over.target !== 'Malay (Malaysia)' ? xtmRow(over) : base(over);
  const items =
    menu === 'accept'
      ? `<li data-dropdown-menu-item="true" id="TASK_LISTING_ACCEPT_GROUP_TASK_${id}">Accept task` +
        `<ul><li data-dropdown-menu-item="true" id="TASK_LISTING_ACCEPT_ALL_TASKS_OF_THIS_LANGUAGE_IN_THIS_GROUP_${id}">Accept all tasks for this language in this group</li></ul>` +
        `</li>`
      : `<li data-dropdown-menu-item="true" id="TASK_LISTING_FINISH_TASK_${id}">Finish task</li>`;
  // The menu starts CLOSED — it carries NO `data-dropdown-menu="true"` marker yet, so a
  // scope-level `[data-dropdown-menu]` query sees nothing until the kebab opens it. This
  // mirrors production, where the inline dropdown is RENDERED only while open (closed rows
  // have no menu DOM at all) — keeping the menuContainer.first() query unambiguous.
  const menuDiv = `<div data-menu-id="menu-${id}" style="position:fixed;top:0;left:0;width:200px;height:120px"><ul>${items}</ul></div>`;
  // Mark the kebab so the toggle script can find its sibling menu, and inject the menu
  // div right after the kebab button (still inside td:nth-child(1)).
  return rowHtml.replace(
    '<button data-testid="context-menu-button" aria-label="More actions">⋮</button>',
    `<button data-testid="context-menu-button" aria-label="More actions" data-menu-for="menu-${id}">⋮</button>${menuDiv}`,
  );
}

/**
 * Inline toggle script for {@link xtmMenuRow} menus: clicking a kebab OPENS its own menu
 * (adds `data-dropdown-menu="true"`, which is how production marks an open dropdown) and
 * CLOSES any other open one (removes the marker). Mirrors the SPA's single-open-menu
 * behaviour, so a scope-level `[data-dropdown-menu].first()` always resolves to exactly
 * the intended row's open menu. Placed once per page; harmless when no menu rows exist.
 */
const MENU_TOGGLE_SCRIPT =
  `<script>document.addEventListener('click',function(e){` +
  `var btn=e.target.closest('[data-menu-for]');` +
  `var open=document.querySelectorAll('[data-dropdown-menu="true"]');` +
  `var id=btn?btn.getAttribute('data-menu-for'):null;` +
  `var m=id?document.querySelector('[data-menu-id="'+id+'"]'):null;` +
  `var wasOpen=m&&m.getAttribute('data-dropdown-menu')==='true';` +
  `open.forEach(function(x){x.removeAttribute('data-dropdown-menu');});` +
  `if(btn&&m&&!wasOpen)m.setAttribute('data-dropdown-menu','true');` +
  `});</script>`;

/**
 * The canonical Active-grid header labels in column order (recon-confirmed). The
 * header-layout assertion (`assertHeaderLayout`, finding #8) reads these and verifies the
 * identity-bearing columns sit where the positional `td:nth-child(N)` selectors expect.
 * Pass a different array via `xtmActivePage`'s `headerLabels` to simulate a column
 * insert/move (e.g. a column inserted before Project shifts every later header right by one).
 */
export const XTM_ACTIVE_HEADER_LABELS = [
  '',
  'Project',
  'File WWC',
  'Customer',
  'File',
  'Source',
  'Target',
  'Date due',
  'Step',
  'Step type',
  'Role',
  'Segments',
  'Words',
  'Progress',
  '',
] as const;

export function xtmActivePage(
  rows: string[],
  opts: { state?: string; total?: number; shown?: number; headerLabels?: readonly string[] } = {},
): string {
  const state = opts.state ?? 'ACTIVE';
  const total = opts.total ?? rows.length;
  // `shown` = the last item index on THIS page (footer "1 - shown of total").
  // Defaults to total so existing fixtures are unchanged; set shown < total to
  // simulate a paginated grid (more items exist on later pages).
  const end = opts.shown ?? total;
  const lo = total === 0 ? 0 : 1;
  // Header row drives the layout assertion (#8). Defaults to the canonical labels so
  // existing fixtures are unchanged; override to simulate a shifted/inserted column.
  const headerCells = (opts.headerLabels ?? XTM_ACTIVE_HEADER_LABELS)
    .map((h) => `<th>${h}</th>`)
    .join('');
  return (
    `<!DOCTYPE html><html><head><title>Tasks</title></head>` +
    `<body id="internal" ng-app="xtm.tasks">` +
    `<input type="hidden" id="tasksState" value="${state}">` +
    `<div id="taskListing" role="tabpanel"><h1 id="${state}">Active tasks</h1>` +
    `<table id="TaskListingTable">` +
    `<thead class="table__tableHeader--22GT1"><tr class="listingTable__headRow--OEmzU">` +
    `${headerCells}</tr></thead>` +
    `<tbody class="table__tableBody--1Pixi">${rows.join('')}</tbody>` +
    `</table>` +
    `<div data-testid="listing-section-footer"><span class="itemsCount__itemCount--1BMuy">${lo} - ${end} of ${total}</span></div>` +
    `<div class="en_GB" id="context-menus-container"></div>` +
    `</div>${MENU_TOGGLE_SCRIPT}</body></html>`
  );
}

/**
 * Active header labels with one column inserted before Project — every later header shifts
 * RIGHT by one, so Project lands at col 3 (not 2). Used to exercise the header-layout
 * assertion (#8): a positional read keyed off the OLD column numbers would silently read the
 * wrong cells, and since projectName (col 2) is part of the job KEY, identity would corrupt.
 */
export function xtmHeaderInsertedBeforeProject(): string[] {
  return ['', 'Inserted Column', ...XTM_ACTIVE_HEADER_LABELS.slice(1)];
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
