import type { Frame, Page } from 'playwright';
import { XTM } from './selectors.js';
import { AcceptUnconfirmedError, type AcceptTarget, type AcceptResult } from './errors.js';
import type { XtmRawJob } from '../detection/types.js';
import { computeXtmJobKey } from '../detection/jobKey.js';

type Scope = Frame | Page;

const ACCEPT_TIMEOUT_MS = 15_000;

/**
 * FR-024: resolve each target's outcome from the AUTHORITATIVE re-read of Active
 * after the accept action — never from the transient click/toast. Pure.
 *   - target gone from re-read            → missing (snatched before/at accept)
 *   - target present, not acceptable      → accepted (we own it now)
 *   - target present, still acceptable     → failed (the accept did not take)
 * This attributes bulk/partial outcomes per job and is restart-safe (a re-read on
 * the next cycle yields the same truth, so no job is re-accepted — supports FR-008).
 */
export function determineAcceptOutcomes(
  targets: AcceptTarget[],
  reRead: XtmRawJob[],
  at: string,
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
      return {
        jobKey: t.jobKey,
        outcome: 'failed',
        reason: 'still acceptable after accept (not claimed)',
      };
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
}

/**
 * Bulk-accept all eligible (Malay) tasks via the row menu, then resolve each
 * target's outcome by re-reading Active (FR-024). The accept path is the kebab →
 * "Accept task" → "Accept all tasks for this language in this group" (R4, confirmed
 * from recon screenshots). The exact submenu DOM + success signal are confirmed
 * evidence-first on the first real job; until then any deviation FAILS LOUD
 * (AcceptUnconfirmedError + evidence) and the targets are recorded `failed` — the
 * adapter NEVER assumes an accept succeeded (FR-011).
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
  // Stamp each group's confirm-click moment BEFORE the re-read so click latency
  // (V16) excludes the re-read cost that outcome latency (V16b) includes — keyed
  // per job so a later group's click never overwrites an earlier group's latency.
  const clickedAtByJob = new Map<string, string>();
  for (const [lang, group] of byLang) {
    try {
      await openBulkAcceptForLanguage(scope, lang);
      const groupClickedAt = deps.nowIso();
      for (const t of group) clickedAtByJob.set(t.jobKey, groupClickedAt);
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
  // One authoritative re-read of Active attributes every claimed target (FR-024).
  const reRead = await deps.reReadActive();
  const outcomes = determineAcceptOutcomes(attempted, reRead, deps.nowIso()).map((o) => {
    const clickedAt = clickedAtByJob.get(o.jobKey);
    return o.outcome === 'accepted' && clickedAt !== undefined ? { ...o, clickedAt } : o;
  });
  return [...outcomes, ...failed];
}

/** Drive the row menu to the bulk "for this language in this group" option. */
async function openBulkAcceptForLanguage(scope: Scope, targetLang: string): Promise<void> {
  // Open the kebab of a data row whose target language matches (so the bulk
  // "for this language" claims the right group).
  const rows = scope.locator(`${XTM.active.gridContainer} tbody tr`);
  const count = await rows.count();
  let opened = false;
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const kebab = row.locator(XTM.accept.rowKebab).first();
    if ((await kebab.count()) === 0) continue; // header/placeholder row
    const cell = (await row.locator(XTM.active.cell.target).first().textContent())?.trim() ?? '';
    if (cell.toLowerCase() === targetLang.trim().toLowerCase()) {
      await kebab.click({ timeout: ACCEPT_TIMEOUT_MS });
      opened = true;
      break;
    }
  }
  if (!opened) {
    throw new AcceptUnconfirmedError(`no Active row matching target language "${targetLang}"`);
  }

  const menu = scope.locator(XTM.accept.menuContainer);
  // "Accept task" submenu parent — absent (e.g. shows "Finish task") means the job
  // is not acceptable; fail loud rather than click the wrong item (locale-dependent).
  const acceptTask = menu.getByText(XTM.accept.acceptTaskItemText, { exact: true }).first();
  if ((await acceptTask.count()) === 0) {
    throw new AcceptUnconfirmedError(`"${XTM.accept.acceptTaskItemText}" menu item not found`);
  }
  await acceptTask.hover({ timeout: ACCEPT_TIMEOUT_MS });

  const bulk = menu.getByText(XTM.accept.bulkForLanguageInGroupText, { exact: true }).first();
  if ((await bulk.count()) === 0) {
    throw new AcceptUnconfirmedError('bulk "for this language in this group" option not found');
  }
  await bulk.click({ timeout: ACCEPT_TIMEOUT_MS });
  // A confirmation dialog may follow; its exact selector is captured evidence-first
  // on the first real accept. The FR-024 re-read is the source of truth regardless.
}
