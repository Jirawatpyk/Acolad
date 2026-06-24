import type { Frame, Locator, Page } from 'playwright';
import { XTM } from './selectors.js';
import { AcceptUnconfirmedError, type AcceptTarget, type AcceptResult } from './errors.js';
import type { XtmRawJob } from '../detection/types.js';
import { computeXtmJobKey } from '../detection/jobKey.js';

type Scope = Frame | Page;

const ACCEPT_TIMEOUT_MS = 15_000;

/**
 * FR-024: resolve each target's outcome from the AUTHORITATIVE re-read of Active
 * after the accept action — never from the transient click/toast. Pure.
 *   - target gone from re-read                                      → missing (snatched before/at accept)
 *   - target present, not acceptable                                → accepted (we own it now)
 *   - target present, still acceptable + key IN clickedKeys         → failed (the accept did not take)
 *   - target present, still acceptable + key NOT IN clickedKeys     → missing (retriable: row never
 *       reached — group already-owned or not rendered; reset accept_status to 'none', not terminal)
 * This attributes bulk/partial outcomes per job and is restart-safe (a re-read on
 * the next cycle yields the same truth, so no job is re-accepted — supports FR-008).
 */
export function determineAcceptOutcomes(
  targets: AcceptTarget[],
  reRead: XtmRawJob[],
  at: string,
  /** Keys (computeXtmJobKey) of jobs whose language group actually received a
   *  confirm-click. Used to distinguish a genuine failed accept (clicked → still
   *  claimable) from a never-reached target (not clicked → retriable 'missing'). */
  clickedKeys: Set<string>,
  /** When the confirm-click fired (V16). Carried on accepted results for the
   *  latency split; omitted by callers that don't measure it (e.g. unit tests). */
  clickedAt?: string,
): AcceptResult[] {
  const byKey = new Map<string, XtmRawJob>();
  for (const r of reRead) byKey.set(computeXtmJobKey(r), r);
  return targets.map((t): AcceptResult => {
    const found = byKey.get(t.jobKey);
    if (!found) return { jobKey: t.jobKey, outcome: 'missing' };
    if (found.acceptAvailable) {
      // Still claimable: only a genuine FAILED accept if we actually clicked this target's
      // group. A never-clicked target (row not rendered / group already-owned) is retriable
      // → 'missing' (resets accept_status to 'none' for the robustness re-attempt), NOT a
      // terminal accept_failed alert.
      return clickedKeys.has(t.jobKey)
        ? {
            jobKey: t.jobKey,
            outcome: 'failed',
            reason: 'still acceptable after accept (not claimed)',
          }
        : { jobKey: t.jobKey, outcome: 'missing' };
    }
    return clickedAt
      ? { jobKey: t.jobKey, outcome: 'accepted', at, clickedAt }
      : { jobKey: t.jobKey, outcome: 'accepted', at };
  });
}

export interface AcceptDeps {
  /** Re-read the Active list for the FR-024 post-state. */
  reReadActive: () => Promise<XtmRawJob[]>;
  captureEvidence: (reason: string) => Promise<string | undefined>;
  nowIso: () => string;
  /** Log the real (redaction-safe) cause of an accept-menu failure, if available. */
  logError?: (err: unknown) => void;
  /**
   * Timeout (ms) for waiting on the target row to attach to the DOM inside
   * openBulkAcceptForLanguage. Defaults to ACCEPT_TIMEOUT_MS (15 s) in production.
   * Inject a short value (e.g. 200 ms) in tests covering the absent-row case so CI
   * does not burn one full timeout budget per test (I3 fix).
   */
  rowAttachTimeoutMs?: number;
}

/**
 * Bulk-accept all eligible (Malay) tasks via the row menu, then resolve each
 * target's outcome by re-reading Active (FR-024). The accept path is the kebab →
 * "Accept task" (stable-id submenu parent) → "Accept all tasks for this language in
 * this group" — CONFIRMED from the 2026-06-22 recon (see selectors.ts). Any deviation
 * on a live job FAILS LOUD (AcceptUnconfirmedError + evidence) and the targets are
 * recorded `failed`; the adapter NEVER assumes an accept succeeded (FR-011). The
 * authoritative per-job outcome comes from the re-read's menu probe, not the click.
 *
 * Guarded by ACCEPT_ENABLED upstream; with accept off this is never invoked.
 */
export async function acceptEligibleTasks(
  scope: Scope,
  targets: AcceptTarget[],
  deps: AcceptDeps,
): Promise<AcceptResult[]> {
  if (targets.length === 0) return [];

  // The bulk action claims "Accept all tasks for THIS language in this group", so
  // each distinct eligible language needs its own menu pass. Grouping keeps a
  // multi-language ACCEPT_LANGUAGES correct (today it is Malay-only, but a second
  // language must not be silently stranded as failed — the pre-fix bug used only
  // targets[0].targetLang).
  const byLang = new Map<string, AcceptTarget[]>();
  for (const t of targets) {
    const lang = t.targetLang ?? '';
    const group = byLang.get(lang);
    if (group) group.push(t);
    else byLang.set(lang, [t]);
  }

  const failed: AcceptResult[] = [];
  const rowAttachTimeoutMs = deps.rowAttachTimeoutMs ?? ACCEPT_TIMEOUT_MS;
  // Stamp each group's confirm-click moment BEFORE the re-read so click latency
  // (V16) excludes the re-read cost that outcome latency (V16b) includes — keyed
  // per job so a later group's click never overwrites an earlier group's latency.
  const clickedAtByJob = new Map<string, string>();
  for (const [, group] of byLang) {
    try {
      const opened = await openBulkAcceptForLanguage(scope, group, rowAttachTimeoutMs);
      if (opened === 'clicked') {
        // Stamp the confirm-click moment ONLY when a click actually happened, so the V16
        // click-latency split is never fabricated for an already-owned (no-click) group.
        const groupClickedAt = deps.nowIso();
        for (const t of group) clickedAtByJob.set(t.jobKey, groupClickedAt);
        // Post-click DOM (e.g. a confirmation dialog) — evidence-first so a confirm step
        // can be wired. Best-effort; never blocks the re-read.
        await deps.captureEvidence('post_accept_click');
      }
      // 'already-owned' → a prior bulk grabbed this group; no click, no latency stamp —
      // the FR-024 re-read reconciles those rows to 'accepted'.
    } catch (err) {
      deps.logError?.(err); // surface the real cause (which step/selector) — redacted by the logger
      const evidencePath = await deps.captureEvidence('accept_unconfirmed');
      // Bounded reason only — the raw Playwright message must NOT reach Sheets/Chat
      // (contracts/sheets.md "Note = evidence ref only"); the screenshot/HTML holds detail.
      const reason = `accept menu path not found; evidence: ${evidencePath ?? 'n/a'}`;
      // Never assume success — mark this language's targets failed.
      for (const t of group) failed.push({ jobKey: t.jobKey, outcome: 'failed' as const, reason });
    }
  }

  const attempted = targets.filter((t) => !failed.some((f) => f.jobKey === t.jobKey));
  // No menu opened (every language failed) → skip the re-read (rate budget, FR-027).
  if (attempted.length === 0) return failed;

  // Never assume success — mark every attempted target failed with a bounded reason +
  // evidence (the raw cause stays in the screenshot/HTML, not Sheets/Chat).
  const failAllAttempted = async (label: string): Promise<AcceptResult[]> => {
    const evidencePath = await deps.captureEvidence('accept_unconfirmed');
    const reason = `${label}; evidence: ${evidencePath ?? 'n/a'}`;
    return [
      ...attempted.map((t) => ({ jobKey: t.jobKey, outcome: 'failed' as const, reason })),
      ...failed,
    ];
  };

  // One authoritative re-read of Active attributes every claimed target (FR-024). The
  // re-read itself can throw (layout/pagination/timeout); never let that crash the cycle.
  let reRead;
  try {
    reRead = await deps.reReadActive();
  } catch (err) {
    deps.logError?.(err);
    return failAllAttempted('post-accept re-read failed');
  }
  // A wholesale-empty re-read right after accepting is far more likely a grid race (the
  // grid shell renders "0 - 0 of 0" before its data XHR) than every target being snatched
  // at once — and accepted jobs STAY in Active (menu flips to "Finish task"), so a real
  // accept never empties the list. Classify conservatively as FAILED (re-checkable +
  // alerts), never the lossy 'missing' that resets accept_status to 'none' and re-attempts.
  if (reRead.length === 0) {
    return failAllAttempted('post-accept re-read returned no rows (likely grid race)');
  }
  const clickedKeys = new Set(clickedAtByJob.keys());
  const outcomes = determineAcceptOutcomes(attempted, reRead, deps.nowIso(), clickedKeys).map(
    (o) => {
      const clickedAt = clickedAtByJob.get(o.jobKey);
      return o.outcome === 'accepted' && clickedAt !== undefined ? { ...o, clickedAt } : o;
    },
  );
  return [...outcomes, ...failed];
}

/**
 * D6 (operator-confirmed): read TRUE per-row acceptability for the given target jobs
 * by OPENING each matching row's kebab and checking for the "Accept task" item
 * (acceptTaskItem — the locale-independent id prefix). Present ⇒ still claimable
 * (acceptAvailable=true); absent (the job stays in Active but its menu now shows
 * "Finish task" because we own it) ⇒ acceptAvailable=false. The grid cells do NOT
 * expose this, so the FR-024 post-accept re-read uses this to tell an accepted job
 * (we own it) from a failed one (still claimable). Opening/closing a menu issues no
 * portal request (local DOM) so it is rate-free (FR-011); Escape closes each menu
 * WITHOUT acting on the task. Bounded to the target rows (≤ ACCEPT_MAX_PER_CYCLE).
 */
export async function readAcceptAvailability(
  scope: Scope,
  page: Page,
  jobKeys: Set<string>,
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (jobKeys.size === 0) return result;
  const rows = scope.locator(`${XTM.active.gridContainer} tbody tr`);
  const count = await rows.count();
  for (let i = 0; i < count && result.size < jobKeys.size; i++) {
    const row = rows.nth(i);
    const kebab = row.locator(XTM.accept.rowKebab).first();
    if ((await kebab.count()) === 0) continue; // header/placeholder row
    const fileName = (await row.locator(XTM.active.cell.file).first().textContent())?.trim() ?? '';
    if (!fileName) continue;
    const step = (await row.locator(XTM.active.cell.step).first().textContent())?.trim() || null;
    const role = (await row.locator(XTM.active.cell.role).first().textContent())?.trim() || null;
    const key = computeXtmJobKey({ fileName, step, role });
    if (!jobKeys.has(key) || result.has(key)) continue;
    await kebab.click({ timeout: ACCEPT_TIMEOUT_MS });
    const openMenu = scope.locator(XTM.accept.menuContainer).first();
    await openMenu.waitFor({ state: 'visible', timeout: ACCEPT_TIMEOUT_MS }).catch(() => undefined);
    // Scope to the open menu container so items from OTHER rows' menus (same id prefix,
    // still in the DOM from a prior open) cannot satisfy the count (C1b fix: mirrors
    // the scope guard added to openBulkAcceptForLanguage).
    result.set(key, (await openMenu.locator(XTM.accept.acceptTaskItem).count()) > 0);
    await page.keyboard.press('Escape').catch(() => undefined); // close menu — NO action on the task
  }
  return result;
}

/**
 * Drive the row menu to the bulk "for this language in this group" option. The bulk is
 * group-level (one click claims the whole language group) but ownership is per-row, so
 * we walk the group's TARGETS (whose jobKeys we already know) and, for EACH, locate its
 * data row DETERMINISTICALLY by its File/Step/Role cell text (rowForTarget) rather than a
 * volatile nth() index — XTM's grid auto-refreshes (a data XHR) mid-scan, reindexing rows,
 * so an index-based scan would point at the wrong row and could miss a still-claimable
 * target entirely (the lost-Malay-jobs bug; see [[xtm-accept-d6-finish-task]]). For the
 * first target whose row is still claimable ("Accept task" present) we drive the bulk; one
 * click claims the whole language group. Returns:
 *   - 'clicked'        → a claimable target row was found and the bulk was clicked
 *   - 'already-owned'  → no claimable target row this pass (every target's row is already
 *                        ours, or no target row is currently rendered) → no click; the
 *                        FR-024 re-read reconciles owned rows to 'accepted' and a
 *                        not-rendered target to retriable 'missing'
 * Throws AcceptUnconfirmedError (fail loud) only when a matching target row IS rendered but
 * exposes neither "Accept task" nor "Finish task" (an unexpected menu — never guess).
 */
async function openBulkAcceptForLanguage(
  scope: Scope,
  group: AcceptTarget[],
  rowAttachTimeoutMs: number,
): Promise<'clicked' | 'already-owned'> {
  let ownedSeen = false;
  let anyRowFound = false;
  for (const t of group) {
    const row = rowForTarget(scope, t);
    // Wait for THIS target's row to attach (it may not be rendered yet, or it was
    // snatched). A missing row is NOT "owned" — skip it (the re-read classifies it).
    // rowAttachTimeoutMs is injectable (AcceptDeps.rowAttachTimeoutMs) so tests covering
    // the absent-row case do not burn the full 15s production budget (I3 fix).
    const attached = await row
      .waitFor({ state: 'attached', timeout: rowAttachTimeoutMs })
      .then(() => true)
      .catch(() => false);
    if (!attached) continue; // this target's row hasn't rendered / is gone — skip (NOT owned)
    anyRowFound = true;
    const kebab = row.locator(XTM.accept.rowKebab).first();
    if ((await kebab.count()) === 0) continue;
    await kebab.click({ timeout: ACCEPT_TIMEOUT_MS }); // open this row's menu
    // Scope all subsequent menu-item queries to the OPEN menu container
    // ([data-dropdown-menu="true"]) so items from OTHER rows' still-in-DOM menus
    // (which may share the same id prefix) cannot be picked up by a page-level
    // first(). This is the correct scope regardless of whether the portal renders
    // menus inline (recon 2026-06-22) or in a portal container.
    const openMenu = scope.locator(XTM.accept.menuContainer).first();
    await openMenu.waitFor({ state: 'visible', timeout: ACCEPT_TIMEOUT_MS }).catch(() => undefined);
    // Claimable row (stable-id "Accept task" submenu parent present)? → drive the bulk.
    // Query scoped to the open menu so a hidden accept item from another row is invisible.
    if ((await openMenu.locator(XTM.accept.acceptTaskItem).count()) > 0) {
      await openMenu
        .locator(XTM.accept.acceptTaskItem)
        .first()
        .hover({ timeout: ACCEPT_TIMEOUT_MS });
      // FR-006 bulk option (CONFIRMED recon 2026-06-22) — click by stable id,
      // also scoped to the open menu to avoid cross-row id collision.
      const bulk = openMenu.locator(XTM.accept.bulkForLanguageInGroupItem).first();
      if ((await bulk.count()) === 0) {
        throw new AcceptUnconfirmedError('bulk "for this language in this group" option not found');
      }
      await bulk.click({ timeout: ACCEPT_TIMEOUT_MS });
      // A confirmation dialog may follow; its selector is captured evidence-first on the
      // first real accept. The FR-024 re-read is the source of truth regardless.
      return 'clicked'; // one click claims the whole language group
    }
    // Not claimable on this row — already ours ("Finish task")? Note it and try the next
    // target rather than giving up on the group. Also scoped to the open menu.
    if ((await openMenu.locator(XTM.accept.finishTaskItem).count()) > 0) ownedSeen = true;
    await kebab.click({ timeout: ACCEPT_TIMEOUT_MS }).catch(() => undefined); // toggle-close before the next target
  }
  if (ownedSeen) return 'already-owned'; // a target row is present and already ours
  if (!anyRowFound) return 'already-owned'; // no target row present this pass -> retriable via classification
  throw new AcceptUnconfirmedError(
    'matching target rows present but neither "Accept task" nor "Finish task" found',
  );
}

/**
 * Build an anchored, regex-escaped exact-match pattern for a cell's text content.
 * Playwright's `hasText` with a RegExp anchored `^…$` matches the element's
 * NORMALIZED text (whitespace collapsed) exactly — preventing a shorter string from
 * being a substring of a longer cell value and causing `.first()` to pick the wrong
 * row (C1 fix). The pattern is case-insensitive, mirroring `computeXtmJobKey` which
 * is exact and trimmed.
 */
function exact(s: string): RegExp {
  return new RegExp(`^${s.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
}

/**
 * Stable locator for a target's data row by its File+Step+Role cell text (the jobKey
 * basis), so a mid-pass auto-refresh that reindexes rows cannot point us at the wrong row.
 * Uses EXACT (anchored) text matching — not substring — so a cell value that is a
 * prefix/substring of another row's cell cannot accidentally match (C1 fix).
 */
function rowForTarget(scope: Scope, t: AcceptTarget): Locator {
  let row = scope
    .locator(`${XTM.active.gridContainer} tbody tr`)
    .filter({ has: scope.locator(XTM.active.cell.file, { hasText: exact(t.fileName) }) });
  if (t.step)
    row = row.filter({ has: scope.locator(XTM.active.cell.step, { hasText: exact(t.step) }) });
  if (t.role)
    row = row.filter({ has: scope.locator(XTM.active.cell.role, { hasText: exact(t.role) }) });
  return row.first();
}
