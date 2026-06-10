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
