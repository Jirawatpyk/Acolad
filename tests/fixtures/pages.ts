/** HTML fixtures for the portal pages (no live portal available — see R9). */

export const loginPage = `<!doctype html><html lang="en"><body>
  <form data-test="login" action="/login">
    <input type="email" name="email" />
    <input type="password" name="password" />
    <button type="submit">Sign in</button>
  </form>
</body></html>`;

/** Logged-in shell with a job-list container. `rows` are job rows; when empty,
 *  the empty-state marker is shown (mirrors the real portal's offers page). */
export function jobListPage(rows: string): string {
  const empty =
    rows.trim() === '' ? '<p data-test="empty-state-subtitle">No pending offers</p>' : '';
  return `<!doctype html><html lang="en"><body>
    <main>
      <div data-test="job-list" role="list">${rows}</div>
      ${empty}
    </main>
  </body></html>`;
}

export function jobRow(opts: {
  id?: string;
  title?: string;
  langs?: string;
  deadline?: string;
  fee?: string;
  url?: string;
}): string {
  const span = (cls: string, v?: string): string =>
    v === undefined ? '' : `<span class="${cls}">${v}</span>`;
  const link = opts.url ? `<a class="job-link" href="${opts.url}">open</a>` : '';
  return `<div data-test="job-row" role="listitem">
    ${span('job-id', opts.id)}
    ${span('job-title', opts.title)}
    ${span('job-langs', opts.langs)}
    ${span('job-deadline', opts.deadline)}
    ${span('job-fee', opts.fee)}
    ${link}
  </div>`;
}

export const emptyJobListPage = jobListPage('');

/** Shell present but neither rows nor empty-state marker — ambiguous (fail loud). */
export const ambiguousEmptyPage = `<!doctype html><html lang="en"><body><main>
  <div data-test="job-list" role="list"></div>
</main></body></html>`;

/** Page WITHOUT the container marker — must be treated as "failed to read". */
export const brokenLayoutPage = `<!doctype html><html lang="en"><body><main><p>unexpected</p></main></body></html>`;

/** Job list with a pagination indicator present. */
export function paginatedJobListPage(rows: string): string {
  return `<!doctype html><html lang="en"><body><main>
    <div data-test="job-list" role="list">${rows}</div>
    <nav data-test="pagination" aria-label="Pagination"><a href="?page=2">2</a></nav>
  </main></body></html>`;
}

/** A login page presenting a CAPTCHA challenge. */
export const captchaPage = `<!doctype html><html lang="en"><body>
  <form data-test="login"><input type="email" /><input type="password" /></form>
  <iframe title="captcha challenge" src="https://www.google.com/recaptcha/x"></iframe>
</body></html>`;

/**
 * Bare app shell shown before React decides between offers and login — the
 * "Partner portal / Loading..." state captured in production at 03:31. It has
 * NO container, NO login form, NO empty-state marker: only a spinner and the
 * "Loading..." text (the spinner class is goober-hashed, so not selectable).
 * Reading this must be treated as transient (still loading), not a layout change.
 */
export const loadingShellPage = `<!doctype html><html lang="en"><body>
  <div id="root"><main>
    <div class="flex items-center space-x-4">
      <div class="go1858758034 size-8"></div>
      <span class="text-color-primary text-3xl font-bold">Loading...</span>
    </div>
  </main></div>
</body></html>`;

/**
 * Offers shell present, but the list body is still loading — the 22:29
 * production capture. The nav renders before the list, so a visible loader
 * means the absence of rows/empty-state is not yet meaningful. Transient.
 */
export const loadingListPage = `<!doctype html><html lang="en"><body><main>
  <nav data-test="offers-nav"><span data-test="offers-nav-title">Offers</span></nav>
  <div data-test="loader-container">
    <div class="go1858758034 size-8"></div><span>Loading...</span>
  </div>
  <div role="status" aria-live="polite">Loading...</div>
</main></body></html>`;

/**
 * Session expired mid-cycle: navigating to offers redirected to the sign-in
 * page (real portal markers, 09:45 capture). Must be recoverable via re-login,
 * never reported as a layout change (and no evidence noise).
 */
export const sessionExpiredPage = `<!doctype html><html lang="en"><body><main>
  <input data-test="email-input-input" type="email" />
  <input data-test="password-input-input" type="password" />
  <button id="login-submit-button" type="submit">Sign in</button>
</main></body></html>`;
