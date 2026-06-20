import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { XTM } from './selectors.js';
import { sanitizeHtml } from './htmlSanitize.js';

export { sanitizeHtml };

/**
 * Capture HTML + screenshot of the current page for diagnostics (Constitution V).
 * Secrets are sanitized before writing (FR-012): login form input values are
 * masked and any configured secret strings are scrubbed from the HTML.
 *
 * The task grid AND the accept menu live INSIDE the inbox iframe (a separate
 * document that page.content() does not serialize), so when that iframe is
 * present its inner DOM is captured too — without it, an accept/grid failure
 * leaves no diagnosable evidence of the real selectors.
 */
export async function captureEvidence(
  page: Page,
  stateDir: string,
  reason: string,
  stampIso: string,
  secrets: string[],
): Promise<string | undefined> {
  try {
    const stamp = stampIso.replace(/[:.]/g, '-');
    const dir = join(stateDir, 'evidence', `${stamp}-${reason}`);
    mkdirSync(dir, { recursive: true });

    let html = await page.content();
    html = sanitizeHtml(html, secrets);
    writeFileSync(join(dir, 'page.html'), html, 'utf8');

    // Best-effort: also dump the inbox iframe (grid + accept menu) when present.
    try {
      const handle = await page.$(XTM.iframe.el);
      const frame = handle ? await handle.contentFrame() : null;
      if (frame) {
        const frameHtml = sanitizeHtml(await frame.content(), secrets);
        writeFileSync(join(dir, 'inbox-frame.html'), frameHtml, 'utf8');
      }
    } catch {
      // iframe capture is optional — never let it abort the outer capture.
    }

    await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true });
    return dir;
  } catch {
    // Evidence capture must never crash the bot.
    return undefined;
  }
}
