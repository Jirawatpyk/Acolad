import type { Frame, Page } from 'playwright';
import { XTM } from './selectors.js';
import type { AcceptTarget } from './errors.js';

type Scope = Frame | Page;
const RECON_TIMEOUT_MS = 10_000;

export interface AcceptReconDeps {
  /** Persist the captured menu DOM (sanitized) and return the evidence dir. */
  captureEvidence: (reason: string) => Promise<string | undefined>;
}

/**
 * Evidence-only: open the per-row accept menu for a row matching `targetLang` and
 * capture its DOM — HOVER ONLY, it NEVER clicks an accept item, so no task is ever
 * accepted. This is how the live "Accept task" vs "Finish task" per-row signal gets
 * captured so `acceptAvailable` can be computed for real (D4/D6) before auto-accept
 * is enabled. Returns the evidence dir, or undefined if no matching row/kebab.
 *
 * The menu may render in the iframe or a top-document portal (#context-menus-container);
 * capturing the page evidence grabs it wherever it lands. The hover is best-effort to
 * expand the submenu — the kebab-opened menu is already in the capture regardless.
 */
export async function captureAcceptMenuDom(
  scope: Scope,
  targetLang: string,
  deps: AcceptReconDeps,
): Promise<string | undefined> {
  const rows = scope.locator(`${XTM.active.gridContainer} tbody tr`);
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const kebab = row.locator(XTM.accept.rowKebab).first();
    if ((await kebab.count()) === 0) continue; // header/placeholder row
    const cell = (await row.locator(XTM.active.cell.target).first().textContent())?.trim() ?? '';
    if (cell.toLowerCase() !== targetLang.trim().toLowerCase()) continue;

    await kebab.click({ timeout: RECON_TIMEOUT_MS }); // opens the row menu — no action
    // Expand the "Accept task" submenu by HOVER only (never click an accept item).
    const acceptTask = scope
      .locator(XTM.accept.menuContainer)
      .getByText(XTM.accept.acceptTaskItemText, { exact: true })
      .first();
    if ((await acceptTask.count()) > 0) {
      await acceptTask.hover({ timeout: RECON_TIMEOUT_MS }).catch(() => undefined);
    }
    return deps.captureEvidence('accept_menu_recon');
  }
  return undefined;
}

/** Pick the first eligible target's language to recon this cycle. */
export function reconTargetLang(targets: AcceptTarget[]): string | undefined {
  return targets[0]?.targetLang;
}
