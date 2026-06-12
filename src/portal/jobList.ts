import type { Page } from 'playwright';
import { z } from 'zod';
import { SELECTORS } from './selectors.js';
import {
  LayoutChangedError,
  PaginationDetectedError,
  PortalTimeoutError,
  SessionExpiredError,
} from './errors.js';
import type { JobSnapshot, RawJob } from '../detection/types.js';

/** Wait budgets for reading a snapshot; injectable so tests don't pay real waits. */
export interface ReadTimeoutsMs {
  /** Wait for the SPA to settle into a known state (offers shell or login). */
  settle: number;
  /** Wait for the list loader to clear once the offers shell is present. */
  loader: number;
  /** Wait for offer rows or the empty-state marker after loading finishes. */
  content: number;
}

const DEFAULT_READ_TIMEOUTS: ReadTimeoutsMs = { settle: 15_000, loader: 15_000, content: 10_000 };

const rawJobSchema = z.object({
  // title is the only strictly-required field; everything else is best-effort (FR-004).
  title: z.string().trim().min(1),
  portalJobId: z.string().trim().min(1).nullable(),
  languagePair: z.string().trim().min(1).nullable(),
  deadline: z.string().nullable(),
  deadlineRaw: z.string().nullable(),
  fee: z.string().trim().min(1).nullable(),
  url: z.string().trim().min(1).nullable(),
});

/** Best-effort ISO-8601 +07:00 normalization; returns null when unparseable. */
export function normalizeDeadline(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 7 * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}+07:00`;
}

interface ScrapedRow {
  portalJobId: string | null;
  title: string | null;
  languagePair: string | null;
  deadlineRaw: string | null;
  fee: string | null;
  url: string | null;
}

/**
 * Read the current job list from an authenticated page (contracts/portal-adapter.md).
 * Fails loud (LayoutChangedError) when the structural container is missing —
 * this is the line between "genuinely empty" and "failed to read" (FR-016).
 * Detects pagination indicators and refuses to silently under-report (FR-009).
 */
export async function readJobSnapshot(
  page: Page,
  pollCycleId: string,
  capturedAt: string,
  captureEvidence: (reason: string) => Promise<string | undefined>,
  timeouts: ReadTimeoutsMs = DEFAULT_READ_TIMEOUTS,
): Promise<JobSnapshot> {
  const container = page.locator(SELECTORS.jobList.container).first();

  // Let the SPA settle into a KNOWN state before judging anything: the offers
  // shell OR the login page. Straight after navigation the DOM is often still
  // the bare "Loading..." app shell (React hasn't decided yet), so reading the
  // container's absence too early misreads a still-loading page as a layout
  // change. Waiting for either anchor lets us disambiguate correctly below.
  await page
    .locator(`${SELECTORS.jobList.container}, ${SELECTORS.loggedOutMarker}`)
    .first()
    .waitFor({ state: 'attached', timeout: timeouts.settle })
    .catch(() => undefined);

  if ((await container.count()) === 0) {
    // No offers shell — disambiguate before crying "layout changed" (these were
    // the overnight false alarms):
    if (await isLoggedOut(page)) {
      // Redirected to sign-in: recoverable by re-login (PortalClient retries).
      throw new SessionExpiredError('redirected to login (session expired)');
    }
    if (await isLoading(page)) {
      // App shell still rendering — transient, retry next cycle (no alert/evidence).
      throw new PortalTimeoutError('offers shell did not finish loading');
    }
    // Settled, authenticated, but the container marker is genuinely absent.
    const evidencePath = await captureEvidence('layout_changed');
    throw new LayoutChangedError('job-list container marker not found', evidencePath);
  }

  // Offers shell is present. Wait for the list body to finish loading before
  // deciding rows-vs-empty: the nav renders before the list, and a visible
  // loader means neither offer rows nor the empty-state marker is meaningful yet.
  await page
    .locator(SELECTORS.jobList.loading)
    .first()
    .waitFor({ state: 'hidden', timeout: timeouts.loader })
    .catch(() => undefined);
  await page
    .locator(`${SELECTORS.jobList.row}, ${SELECTORS.jobList.emptyState}`)
    .first()
    .waitFor({ state: 'attached', timeout: timeouts.content })
    .catch(() => undefined);

  if ((await page.locator(SELECTORS.jobList.pagination).count()) > 0) {
    const evidencePath = await captureEvidence('pagination_detected');
    throw new PaginationDetectedError(
      'pagination indicator present — coverage may be incomplete',
      evidencePath,
    );
  }

  // Minimal structural DOM types so we don't pull the whole "DOM" lib into Node.
  interface Queryable {
    querySelector(
      q: string,
    ): { textContent: string | null; getAttribute(n: string): string | null } | null;
  }
  const scraped = (await page.locator(SELECTORS.jobList.row).evaluateAll(
    (rows, sel) => {
      const text = (el: Queryable, q: string): string | null => {
        const n = el.querySelector(q);
        return n?.textContent?.trim() ?? null;
      };
      const href = (el: Queryable, q: string): string | null => {
        const n = el.querySelector(q);
        return n?.getAttribute('href') ?? null;
      };
      return (rows as unknown as Queryable[]).map((el) => ({
        portalJobId: text(el, sel.id),
        title: text(el, sel.title),
        languagePair: text(el, sel.langs),
        deadlineRaw: text(el, sel.deadline),
        fee: text(el, sel.fee),
        url: href(el, sel.link),
      }));
    },
    {
      id: SELECTORS.jobList.field.id,
      title: SELECTORS.jobList.field.title,
      langs: SELECTORS.jobList.field.languagePair,
      deadline: SELECTORS.jobList.field.deadline,
      fee: SELECTORS.jobList.field.fee,
      link: SELECTORS.jobList.field.link,
    },
  )) as ScrapedRow[];

  const jobs: RawJob[] = [];
  const malformed: unknown[] = [];

  for (const row of scraped) {
    const candidate = {
      title: row.title,
      portalJobId: row.portalJobId,
      languagePair: row.languagePair,
      deadline: normalizeDeadline(row.deadlineRaw),
      deadlineRaw: row.deadlineRaw,
      fee: row.fee,
      url: row.url,
    };
    const parsed = rawJobSchema.safeParse(candidate);
    if (parsed.success) jobs.push(parsed.data);
    else malformed.push(row);
  }

  const emptyStateShown = (await page.locator(SELECTORS.jobList.emptyState).count()) > 0;

  // Fail loud (FR-016): the shell loaded but we found neither offer rows nor the
  // explicit empty-state marker. Before treating this as a layout change, rule
  // out the two benign causes that produced overnight false alarms — a list
  // that is still loading, or a session that expired mid-read. Only a settled,
  // authenticated page with no recognizable offers is a genuine layout change.
  if (jobs.length === 0 && malformed.length === 0 && !emptyStateShown) {
    if (await isLoading(page)) {
      throw new PortalTimeoutError('offers list still loading (no rows, no empty-state yet)');
    }
    if (await isLoggedOut(page)) {
      throw new SessionExpiredError('session expired while reading offers');
    }
    const evidencePath = await captureEvidence('layout_changed');
    throw new LayoutChangedError(
      'offers shell present but no rows and no empty-state marker — unknown offer structure',
      evidencePath,
    );
  }

  return {
    jobs,
    malformed,
    capturedAt,
    pollCycleId,
    emptyListConfirmed: jobs.length === 0 && malformed.length === 0 && emptyStateShown,
  };
}

/** True when the page shows the logged-out marker (session expired mid-cycle). */
export async function isLoggedOut(page: Page): Promise<boolean> {
  return (await page.locator(SELECTORS.loggedOutMarker).count()) > 0;
}

/**
 * True while the offers UI is still loading (spinner/loader visible). Used to
 * distinguish "page not ready yet" from "structure changed" so a slow load is
 * retried as transient instead of raising a CRITICAL layout-changed alert.
 */
export async function isLoading(page: Page): Promise<boolean> {
  const structural = await page
    .locator(SELECTORS.jobList.loading)
    .first()
    .isVisible()
    .catch(() => false);
  if (structural) return true;
  // The pre-render app shell has no stable data-test, only a spinner and this
  // text. The text fallback is safe here: a false "loading" only defers to a
  // transient retry, and a page genuinely stuck loading for 10+ min still
  // escalates out-of-band via the portal_down dead-man switch.
  return page
    .getByText('Loading...', { exact: true })
    .first()
    .isVisible()
    .catch(() => false);
}

/** True when the page demands human verification (CAPTCHA/2FA). */
export async function hasChallenge(page: Page): Promise<boolean> {
  return (await page.locator(SELECTORS.challenge).count()) > 0;
}
