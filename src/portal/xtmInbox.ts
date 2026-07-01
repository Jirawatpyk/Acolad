import type { Frame, Page } from 'playwright';
import { z } from 'zod';
import { XTM } from './selectors.js';
import {
  LayoutChangedError,
  PortalTimeoutError,
  PaginationDetectedError,
  type GridDriftObservers,
} from './errors.js';
import { computeXtmJobKey } from '../detection/jobKey.js';
import { BKK_OFFSET_MS } from '../schedule/bangkokCalendar.js';
import type { XtmRawJob, XtmJobSnapshot } from '../detection/types.js';

/**
 * Either a Page or a Frame works — production reads the Active grid inside
 * `iframe#myInboxIframe` (a Frame); tests load a fixture into a Page. Both expose
 * `.locator()`, which is all this parser needs.
 */
export type GridScope = Frame | Page;

/** Minimal structural DOM shape — avoids pulling the whole DOM lib into Node. */
interface Queryable {
  querySelector(q: string): { textContent: string | null } | null;
}

export interface XtmReadTimeoutsMs {
  /** Wait for the grid container / state marker to attach. */
  settle: number;
  /** Wait for the first row to attach once the container is present. */
  content: number;
}

const DEFAULT_READ_TIMEOUTS: XtmReadTimeoutsMs = { settle: 15_000, content: 10_000 };

// project_name + file_name MUST be present (else quarantine, FR-022). Everything
// else is best-effort/nullable so a missing optional column never drops a job.
const rawXtmJobSchema = z.object({
  projectName: z.string().trim().min(1),
  fileName: z.string().trim().min(1),
  xtmTaskId: z.string().trim().min(1).nullable(),
  sourceLang: z.string().trim().min(1).nullable(),
  targetLang: z.string().trim().min(1).nullable(),
  dueDate: z.string().nullable(),
  dueRaw: z.string().nullable(),
  words: z.number().int().nonnegative().nullable(),
  fileWwc: z.number().int().nonnegative().nullable(),
  step: z.string().trim().min(1).nullable(),
  role: z.string().trim().min(1).nullable(),
  acceptAvailable: z.boolean(),
});

/** Digits-only word count ("1,200" / "37 words" -> number); null when absent. */
export function parseXtmWords(raw: string | null): number | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  if (digits === '') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/**
 * Weighted-word-count parser for File WWC — DECIMAL-TOLERANT, unlike {@link parseXtmWords}
 * (which strips ALL non-digits and is correct for the always-integer Words column). File WWC is
 * a WEIGHTED count that CAN render fractional (e.g. en_GB "1,234.5"): the digits-only parser
 * would read that as 12345 — a ~10x inflation — and `z.number().int()` would accept it silently.
 * So here we strip thousands separators (comma / NBSP / spaces) but KEEP the decimal point,
 * parseFloat, then round to an integer. The DB column is INTEGER and live values are integers,
 * so the rounding only bites on the rare fractional render — and it kills the 10x bug. Null when
 * absent. NOTE: en_GB uses "." for the decimal and "," for thousands (recon-confirmed); a comma-
 * decimal locale is not expected here and is out of scope (would need a locale-aware parser).
 */
export function parseXtmWwc(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.]/g, '');
  if (cleaned === '' || cleaned === '.') return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Pull the XTM `ID-<hex>` token out of the File cell (reference only — not the key). */
export function extractXtmTaskId(fileCell: string | null): string | null {
  if (!fileCell) return null;
  const m = fileCell.match(/ID-([0-9a-z]+)/i);
  return m ? `ID-${m[1]}` : null;
}

/** Best-effort ISO-8601 +07:00 normalization of the Due cell; null when unparseable. */
export function normalizeXtmDue(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + BKK_OFFSET_MS);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}+07:00`;
}

/** Footer range ("1 - 50 of 120" -> {end:50, total:120}); null when unparseable. */
export function parseItemsRange(footer: string | null): { end: number; total: number } | null {
  if (!footer) return null;
  // Drop thousands separators (comma / NBSP / narrow-NBSP) so a grouped total like
  // "1 - 50 of 1,200" is not truncated to 1. Digits-only match otherwise, so the
  // locale word ("of"/"von"/...) never matters.
  const m = footer.replace(/[,\s]/g, '').match(/(\d+)-(\d+)\D+(\d+)/);
  return m ? { end: Number(m[2]), total: Number(m[3]) } : null;
}

/** Total item count from the footer ("1 - 2 of 2" -> 2); null when unparseable. */
export function parseItemsTotal(footer: string | null): number | null {
  return parseItemsRange(footer)?.total ?? null;
}

/**
 * Header-layout assertion (finding #8). The grid cell selectors are POSITIONAL
 * (`td:nth-child(N)`); since projectName (col 2) is part of the job KEY, a column
 * inserted/moved would silently shift every positional read and corrupt IDENTITY
 * (re-accept everything / misclassify everything), not just display. Before scraping a
 * grid's rows, verify the identity-bearing headers (centralized in `selectors.ts`
 * `expectedHeaders`) sit at their expected columns by header TEXT (trim, case-insensitive
 * `contains`). Any mismatch → fail loud (LayoutChangedError + evidence) so the existing
 * error→system-alert path pages on-call, rather than a silent wrong-key scrape (CLAUDE.md:
 * "selector/marker หาย, locale เปลี่ยน → เก็บ evidence + system alert — ห้ามเดา parse").
 *
 * Asserts ONLY when header cells are actually rendered: an absent OR partial <thead> is left to
 * the caller's existing empty-vs-loading classifier (a still-loading grid can render its shell —
 * or only the first few headers — before the rest), so we never page on a transient. A column
 * that DID render but carries the WRONG label is the unambiguous drift signal this guards: a
 * MISSING <th> (index past the rendered cells) is treated as not-yet-rendered and skipped, so a
 * short header never trips a false LayoutChangedError.
 */
async function assertHeaderLayout(
  scope: GridScope,
  gridContainer: string,
  expected: ReadonlyArray<readonly [number, string]>,
  gridLabel: string,
  captureEvidence?: (reason: string) => Promise<string | undefined>,
): Promise<void> {
  const headerTexts = await scope
    .locator(`${gridContainer} thead tr`)
    .first()
    .locator('th')
    .allTextContents();
  if (headerTexts.length === 0) return; // no header rendered yet — not this guard's failure mode
  const norm = (s: string): string => s.trim().toLowerCase();
  const mismatches: string[] = [];
  for (const [col, label] of expected) {
    const cell = headerTexts[col - 1];
    // A column the header has not rendered yet (index past the present <th>s) reads `undefined` —
    // treat it as a transient partial render and skip, NOT as a wrong label (which would page on a
    // mid-load snapshot). Only a PRESENT <th> with the wrong text is the structural-drift signal.
    if (cell === undefined) continue;
    if (!norm(cell).includes(label.toLowerCase())) {
      mismatches.push(`col ${col}: expected "${label}", got "${cell.trim()}"`);
    }
  }
  if (mismatches.length > 0) {
    const evidencePath = await captureEvidence?.('layout_changed');
    throw new LayoutChangedError(
      `${gridLabel} grid header layout drifted — positional selectors would read the wrong ` +
        `cells and corrupt job identity: ${mismatches.join('; ')}`,
      evidencePath,
    );
  }
}

/**
 * Read the Active (IN_PROGRESS) task grid from the inbox frame (contracts/
 * xtm-portal-adapter.md). Fails loud (LayoutChangedError) when the structural
 * container / state marker is missing — the line between "genuinely empty" and
 * "failed to read" (FR-016). Uses the items-count footer to tell a truly empty
 * tab (total 0) from a still-loading one (total > 0 but no rows yet → transient).
 */
export async function readActiveSnapshot(
  scope: GridScope,
  pollCycleId: string,
  capturedAt: string,
  captureEvidence: (reason: string) => Promise<string | undefined>,
  timeouts: XtmReadTimeoutsMs = DEFAULT_READ_TIMEOUTS,
): Promise<XtmJobSnapshot> {
  const container = scope.locator(XTM.active.gridContainer).first();

  await scope
    .locator(`${XTM.active.gridContainer}, ${XTM.active.stateMarker}`)
    .first()
    .waitFor({ state: 'attached', timeout: timeouts.settle })
    .catch(() => undefined);

  // The grid container AND the ACTIVE state marker must both be present, else we
  // cannot trust we are reading the right tab — fail loud rather than guess.
  const onActive = (await scope.locator(XTM.active.stateMarker).count()) > 0;
  if ((await container.count()) === 0 || !onActive) {
    const evidencePath = await captureEvidence('layout_changed');
    throw new LayoutChangedError(
      'XTM Active grid container or ACTIVE state marker not found',
      evidencePath,
    );
  }

  // #8: verify the positional columns are where we expect BEFORE trusting any td:nth-child
  // read (project at col 2 is part of the job key — a shift corrupts identity). Fails loud.
  await assertHeaderLayout(
    scope,
    XTM.active.gridContainer,
    XTM.active.expectedHeaders,
    'Active',
    captureEvidence,
  );

  await scope
    .locator(`${XTM.active.gridContainer} tbody tr`)
    .first()
    .waitFor({ state: 'attached', timeout: timeouts.content })
    .catch(() => undefined);

  // Scrape data rows only — rows that carry the per-row kebab (header/placeholder
  // rows do not), keyed by fixed column position (locale- and hash-independent).
  const allRows = await scope.locator(`${XTM.active.gridContainer} tbody tr`).evaluateAll(
    (rows, sel) => {
      const text = (el: Queryable, q: string): string | null => {
        const n = el.querySelector(q);
        return n && n.textContent ? n.textContent.trim() : null;
      };
      return (rows as unknown as Queryable[]).map((el) => ({
        hasKebab: el.querySelector(sel.kebab) !== null,
        project: text(el, sel.project),
        file: text(el, sel.file),
        source: text(el, sel.source),
        target: text(el, sel.target),
        dueRaw: text(el, sel.due),
        step: text(el, sel.step),
        role: text(el, sel.role),
        wordsRaw: text(el, sel.words),
        fileWwcRaw: text(el, sel.fileWwc),
      }));
    },
    {
      kebab: XTM.active.rowKebab,
      project: XTM.active.cell.project,
      file: XTM.active.cell.file,
      source: XTM.active.cell.source,
      target: XTM.active.cell.target,
      due: XTM.active.cell.dueDate,
      step: XTM.active.cell.step,
      role: XTM.active.cell.role,
      words: XTM.active.cell.words,
      fileWwc: XTM.active.cell.fileWwc,
    },
  );
  // A rendered DATA row (non-empty project/file) that carries no per-row kebab means
  // the row markup changed — fail loud (FR-016), never silently drop real rows to
  // no-data (which would mask a layout/pagination break as a self-healing transient).
  if (allRows.some((r) => !r.hasKebab && (r.project || r.file))) {
    const evidencePath = await captureEvidence('layout_changed');
    throw new LayoutChangedError(
      'Active grid rows are present but missing the per-row kebab anchor',
      evidencePath,
    );
  }
  const scraped = allRows.filter((r) => r.hasKebab);

  const jobs: XtmRawJob[] = [];
  const malformed: unknown[] = [];
  for (const row of scraped) {
    const candidate = {
      projectName: row.project,
      fileName: row.file,
      xtmTaskId: extractXtmTaskId(row.file),
      sourceLang: row.source,
      targetLang: row.target,
      dueDate: normalizeXtmDue(row.dueRaw),
      dueRaw: row.dueRaw,
      words: parseXtmWords(row.wordsRaw),
      // File WWC is a WEIGHTED count (CAN be fractional) read from a POSITIONAL cell
      // (selectors.ts active.cell.fileWwc = td:nth-child(3) — recon-confirmed at col 3 on the
      // LIVE Active grid; a column inserted BEFORE index 3 would silently shift it). Parse with
      // the decimal-tolerant parseXtmWwc — NOT parseXtmWords — or "1,234.5" inflates ~10x. This
      // field is logging-only + null-tolerant, so a single null must NOT fail loud (would page on
      // a cosmetic field); a layout shift surfaces via the project/file fail-loud guards instead.
      fileWwc: parseXtmWwc(row.fileWwcRaw),
      step: row.step,
      role: row.role,
      // D6 (operator-confirmed): acceptability is NOT in the grid cells — it is the
      // presence of the "Accept task" menu item (replaced by "Finish task" once we own
      // the job, which stays in Active). The bulk grid scrape cannot open every row's
      // kebab, so this stays an optimistic placeholder HERE; the AUTHORITATIVE value is
      // computed for the target rows in the post-accept re-read (xtmClient), which
      // determineAcceptOutcomes consumes. detect/log/notify does not use this field.
      // (The re-read menu-check IS now wired — xtmClient.reReadActive → readAcceptAvailability —
      // and the bulk DOM is confirmed; this placeholder is only ever the grid-scrape value.)
      acceptAvailable: true,
    };
    const parsed = rawXtmJobSchema.safeParse(candidate);
    if (parsed.success) jobs.push(parsed.data);
    else malformed.push(row);
  }

  // FR-009: the bot reads exactly ONE page. If the footer's last-shown index is
  // below the total, later pages exist and their jobs would be silently dropped —
  // fail loud (the spec assumes a single page; revisit before scaling read scope).
  // ONLY when rows were actually observed: a still-loading grid can show a footer
  // total before its rows render (e.g. "0 - 0 of N"), and that transient must fall
  // through to finalizeSnapshot's empty-vs-loading classifier, not a hard pagination error.
  if (scraped.length > 0) {
    const footerForRange = await scope
      .locator(XTM.active.itemsCount)
      .first()
      .textContent()
      .catch(() => null);
    const range = parseItemsRange(footerForRange);
    if (range && range.end < range.total) {
      const evidencePath = await captureEvidence('pagination');
      throw new PaginationDetectedError(
        `Active grid paginated: showing ${range.end} of ${range.total} — page 2+ would be missed`,
        evidencePath,
      );
    }
  }

  return finalizeSnapshot(scope, jobs, malformed, capturedAt, pollCycleId, captureEvidence);
}

async function finalizeSnapshot(
  scope: GridScope,
  jobs: XtmRawJob[],
  malformed: unknown[],
  capturedAt: string,
  pollCycleId: string,
  captureEvidence: (reason: string) => Promise<string | undefined>,
): Promise<XtmJobSnapshot> {
  // Disambiguate empty vs still-loading via the authoritative count footer.
  if (jobs.length === 0 && malformed.length === 0) {
    const footer = await scope
      .locator(XTM.active.itemsCount)
      .first()
      .textContent()
      .catch(() => null);
    const total = parseItemsTotal(footer);
    if (total === null) {
      const evidencePath = await captureEvidence('layout_changed');
      throw new LayoutChangedError(
        'Active grid present but no rows and no items-count footer',
        evidencePath,
      );
    }
    if (total > 0) {
      // Footer claims rows but none rendered yet — transient, retry next cycle.
      throw new PortalTimeoutError('Active grid loaded but rows not present yet (count > 0)');
    }
    return { jobs, malformed, capturedAt, pollCycleId, emptyListConfirmed: true };
  }

  return { jobs, malformed, capturedAt, pollCycleId, emptyListConfirmed: false };
}

/**
 * Read the job keys currently in the Closed tab (FR-014). Used only when an
 * accepted job disappears from Active, to tell Closed from Removed. Returns an
 * empty set when the grid is genuinely empty; the Closed grid shares the Active
 * column positions (indices 1–11), so the same file/step/role cells apply.
 *
 * VERIFIED 2026-06-30 (live recon): the Closed grid DOES carry File WWC at col 3 and matches
 * Active through Role (file=5/step=9/role=11; Closed is 12 cols, dropping Words/Progress to the
 * RIGHT of Role, beyond what we read here) — so the borrowed Active selectors are correct. Were
 * XTM to later drop File WWC from Closed, step/role would shift LEFT by one, the borrowed selectors
 * would read the wrong cells, and the recomputed key would never match the Active `_job_key` → a
 * finished job would silently misclassify as "removed" (and, with held-derived capacity, fail to
 * return its quota). As a future-proof NON-DESTABILIZING
 * drift detector: when Closed data rows are present (kebab + non-empty file) but EVERY such row
 * reads null step AND null role — the systematic-mismatch signature — capture sanitized evidence
 * and emit a WARN. We do NOT throw/page: a throw here strands the Closed-vs-Removed decision and
 * pages on a cosmetic mismatch, a worse failure mode than the bug. A single odd row never trips
 * it (the all-rows check requires every candidate row to be null).
 */
export async function readClosedKeys(
  scope: GridScope,
  observers: GridDriftObservers = {},
): Promise<Set<string>> {
  await scope
    .locator(XTM.closed.gridContainer)
    .first()
    .waitFor({ state: 'attached', timeout: 10_000 })
    .catch(() => undefined);
  // #8: same positional-shift guard as the Active scrape — the Closed grid borrows Active's
  // td:nth-child positions, so a header drift would silently read the wrong key columns.
  await assertHeaderLayout(
    scope,
    XTM.closed.gridContainer,
    XTM.closed.expectedHeaders,
    'Closed',
    observers.captureEvidence,
  );
  const scraped = await scope.locator(`${XTM.closed.gridContainer} tbody tr`).evaluateAll(
    (rows, sel) => {
      const cell = (el: Queryable, q: string): string | null => {
        const n = el.querySelector(q);
        return n && n.textContent ? n.textContent.trim() : null;
      };
      return (rows as unknown as Queryable[])
        .filter((r) => r.querySelector(sel.kebab) !== null)
        .map((el) => ({
          project: cell(el, sel.project),
          file: cell(el, sel.file),
          step: cell(el, sel.step),
          role: cell(el, sel.role),
        }));
    },
    {
      kebab: XTM.closed.rowKebab,
      project: XTM.closed.cell.project,
      file: XTM.closed.cell.file,
      // Closed-specific step/role (centralized in selectors.ts). Same strings as Active TODAY,
      // but keyed off XTM.closed.* so a future Closed-only layout fix lives in one place.
      step: XTM.closed.cell.step,
      role: XTM.closed.cell.role,
    },
  );
  const keys = new Set<string>();
  let candidateCount = 0;
  let allStepRoleNull = true;
  let allProjectNull = true;
  for (const r of scraped) {
    // A Closed row with no file cell is malformed — never key on an empty file
    // (a degenerate '' key could falsely match another empty-file row).
    if (!r.file || r.file.trim() === '') continue;
    candidateCount++;
    // #2a (truthy fix): cell() returns '' (not null) for a whitespace-only cell, so the old
    // `!== null` check let an all-WHITESPACE column slip past the drift guard. A TRUTHY check
    // counts ''/whitespace as "drifted" — empty step/role OR empty project both trip the WARN.
    if (r.step || r.role) allStepRoleNull = false;
    if (r.project) allProjectNull = false;
    keys.add(
      computeXtmJobKey({
        projectName: r.project ?? '',
        fileName: r.file,
        step: r.step,
        role: r.role,
      }),
    );
  }
  // Systematic selector drift — two signatures to watch for:
  //   (a) step AND role both null on every candidate row: the Closed grid may have dropped
  //       File WWC (col 3), shifting step/role left by one so the borrowed Active selectors
  //       land off the row (e.g. td:9/td:11 fall past the last cell).
  //   (b) project null on every candidate row: the project column (td:2) may have moved or
  //       been omitted, so every key is computed with an empty project string and will never
  //       match the Active _job_key (which carries the real project name).
  // Both cases cause recomputed Closed keys to diverge from Active keys → finished jobs
  // would misclassify as "removed". Fail loud-but-soft: evidence + WARN, never throw.
  if (candidateCount > 0 && (allStepRoleNull || allProjectNull)) {
    const evidencePath = await observers.captureEvidence?.('closed_layout_drift');
    observers.logger?.warn(
      {
        module: 'xtmInbox',
        action: 'readClosedKeys',
        outcome: 'layout_drift',
        rows: candidateCount,
        allStepRoleNull,
        allProjectNull,
        evidencePath,
      },
      'Closed rows present but key columns read null across ALL rows — the Closed grid layout ' +
        'may have drifted (step/role all null: File WWC column likely omitted; project all null: ' +
        'project column moved or missing). Recomputed keys will not match Active. ' +
        'VERIFY closed.cell selectors against live Closed-grid HTML.',
    );
  }

  // NOTE (reverted #2b cross-keying): a prior fix wave added a "Closed has rows but ZERO recomputed
  // keys match any disappeared-accepted key → throw LayoutChangedError" escalation here. It was
  // removed: zero cross-key match CANNOT distinguish a wrong-but-non-null column drift from a
  // legitimately Removed job (an accepted job that was cancelled is ABSENT from the Closed tab,
  // which still holds OTHER finished rows — candidateCount > 0, matched = 0). That made a routine
  // cancellation page on-call AND abort the cycle before upsertMany/accept, so the job stayed
  // 'accepted' and re-entered the disappeared set every cycle → a persistent auto-accept outage
  // and sustained paging. As the doc above states, a throw here strands the Closed-vs-Removed
  // decision and pages on a cosmetic mismatch — a worse failure mode than the bug. The #8 header
  // guard (a real structural column shift) and the #2a all-null WARN remain the drift signals.
  return keys;
}
