import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

/**
 * Capture HTML + screenshot of the current page for diagnostics (Constitution V).
 * Secrets are sanitized before writing (FR-012): login form input values are
 * masked and any configured secret strings are scrubbed from the HTML.
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

    await page.screenshot({ path: join(dir, 'screenshot.png'), fullPage: true });
    return dir;
  } catch {
    // Evidence capture must never crash the bot.
    return undefined;
  }
}

export function sanitizeHtml(html: string, secrets: string[]): string {
  let out = html;
  // Mask any value="..." on password/email inputs.
  out = out.replace(
    /(<input[^>]*type=["'](?:password|email)["'][^>]*value=["'])[^"']*(["'])/gi,
    '$1[REDACTED]$2',
  );
  // Scrub concrete secret strings.
  for (const s of secrets) {
    if (s && out.includes(s)) out = out.split(s).join('[REDACTED]');
  }
  return out;
}
