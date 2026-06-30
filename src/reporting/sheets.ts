import { google } from 'googleapis';
import type { XtmJobState, XtmLifecycleStatus } from '../detection/types.js';
import type { SendOutcome } from './googleChat.js';
import { formatReadableDate } from './dateFormat.js';

/** Back-compat re-export so existing callers that import `formatSheetDate` still compile. */
export { formatReadableDate as formatSheetDate } from './dateFormat.js';

export type SheetStatus =
  | 'New'
  | 'Accepted'
  | 'Missing'
  | 'Accept failed'
  | 'Skipped'
  | 'Closed'
  | 'Removed'
  | 'Rejected';

export interface SheetRow {
  jobKey: string;
  receivedDate: string;
  status: SheetStatus;
  projectName: string;
  fileName: string;
  sourceLang: string | null;
  targetLang: string | null;
  dueDate: string | null;
  words: number | null;
  fileWwc: number | null;
  step: string | null;
  role: string | null;
  acceptedAt: string | null;
  note: string | null;
}

/**
 * Column schema v2 (contracts/sheets.md). `_job_key` (M) is the hidden upsert key in THIS shape.
 * Retained only for the v2→v3 migration detection (and as a documented reference) — the LIVE shape is v3.
 */
export const V2_HEADER: string[] = [
  'Received date', // A
  'Status', // B
  'Project name', // C
  'File', // D
  'Source language', // E
  'Target languages', // F
  'Due date', // G
  'Words', // H
  'Step', // I
  'Role', // J
  'Accepted at', // K
  'Note', // L
  '_job_key', // M
];

/**
 * Column schema v3 — adds `File WWC` at column I (index 8), right after Words (H); everything from
 * Step onward shifts right one, so `_job_key` is now column N (index 13). This is the current shape.
 */
export const V3_HEADER: string[] = [
  'Received date', // A
  'Status', // B
  'Project name', // C
  'File', // D
  'Source language', // E
  'Target languages', // F
  'Due date', // G
  'Words', // H
  'File WWC', // I (new)
  'Step', // J
  'Role', // K
  'Accepted at', // L
  'Note', // M
  '_job_key', // N
];

// Header-shape landmarks used by ensureHeader's marker-based detection (so a sheet carrying extra
// trailing user columns is still recognized rather than mis-routed to the fail-loud throw).
const FILE_WWC_INDEX = 8; // column I — the v3 marker (blank here means a partial migration to repair)
const JOB_KEY_INDEX_V2 = 12; // column M — `_job_key` position BEFORE File WWC was inserted
const JOB_KEY_INDEX_V3 = 13; // column N — `_job_key` position in the current v3 shape
const V1_COL_COUNT = 8; // the legacy 8-column (A–H) shape, no `_job_key` column

/** 1-based column index → A1 column letter (1→A, 26→Z, 27→AA). */
function columnLetter(n: number): string {
  let letter = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

/**
 * Last column letter of the v3 sheet, derived ONCE from the header width so the range literals in
 * {@link GoogleSheetsApi} (getKeyColumn / writeRow / appendRow) stay in sync — a future header change
 * updates this one place instead of three independent hardcoded letters. Resolves to 'N' today.
 */
export const LAST_COL_LETTER = columnLetter(V3_HEADER.length);

/** Map the internal lifecycle status to the Sheet's display status (Constitution III). */
export function lifecycleToSheetStatus(s: XtmLifecycleStatus): SheetStatus {
  const map: Record<XtmLifecycleStatus, SheetStatus> = {
    new: 'New',
    accepted: 'Accepted',
    skipped: 'Skipped',
    missing: 'Missing',
    accept_failed: 'Accept failed',
    closed: 'Closed',
    removed: 'Removed',
    rejected: 'Rejected',
  };
  return map[s];
}

/** Lifecycle statuses that mean the job has left the Active grid. */
const TERMINAL_ABSENT: ReadonlySet<XtmLifecycleStatus> = new Set(['missing', 'closed', 'removed']);

/**
 * Pure helper that resolves the Sheet Status + Note for a job, applying sticky-Rejected
 * precedence: a gate-Rejected job keeps "Rejected" (plus a "(left Active DD/MM/YYYY HH:mm)"
 * suffix once it exits Active) until it is accepted. Accepted overrides any rejectReason.
 *
 * This is a PURE function — no I/O, no cycle state. It is wired into `toSheetRow` by Task 7.
 */
export function resolveSheetStatusAndNote(
  state: Pick<XtmJobState, 'lifecycleStatus' | 'acceptStatus' | 'rejectReason'>,
  opts: { note: string | null; capturedAtMs: number },
): { status: SheetStatus; note: string | null } {
  if (state.rejectReason !== null && state.acceptStatus !== 'accepted') {
    const left = TERMINAL_ABSENT.has(state.lifecycleStatus)
      ? ` (left Active ${formatReadableDate(new Date(opts.capturedAtMs).toISOString())})`
      : '';
    return { status: 'Rejected', note: `${state.rejectReason}${left}` };
  }
  return { status: lifecycleToSheetStatus(state.lifecycleStatus), note: opts.note };
}

function rowToValues(r: SheetRow): string[] {
  return [
    formatReadableDate(r.receivedDate),
    r.status,
    r.projectName,
    r.fileName,
    r.sourceLang ?? '',
    r.targetLang ?? '',
    formatReadableDate(r.dueDate),
    r.words === null ? '' : String(r.words),
    r.fileWwc === null ? '' : String(r.fileWwc),
    r.step ?? '',
    r.role ?? '',
    formatReadableDate(r.acceptedAt),
    r.note ?? '',
    r.jobKey,
  ];
}

/**
 * Transport abstraction over the Sheet (row/header ops). Injected so the upsert
 * and header-migration LOGIC is unit-tested with an in-memory fake; the real
 * googleapis calls live in {@link GoogleSheetsApi}.
 */
export interface SheetsApi {
  /** Header row (row 1) values, or [] when the sheet is empty. */
  getHeader(): Promise<string[]>;
  /** Overwrite the header row (row 1). */
  setHeader(values: string[]): Promise<void>;
  /** Column N (`_job_key`) values including the header, for upsert lookup. */
  getKeyColumn(): Promise<string[]>;
  /** Overwrite a data row A:N (1-based). */
  writeRow(rowNum: number, values: string[]): Promise<void>;
  /** Append a new data row A:N. */
  appendRow(values: string[]): Promise<void>;
  /**
   * Insert ONE blank column before the 0-based `beforeIndex`, shifting existing cells (header +
   * every data row) right by one. Used once by the v2→v3 migration to open the File WWC slot (I)
   * while keeping historical rows aligned (their `_job_key` shifts M→N).
   */
  insertColumn(beforeIndex: number): Promise<void>;
}

/**
 * Google Sheets sink (contracts/sheets.md). Upserts by `_job_key` (col N) so a
 * job never produces duplicate rows (Constitution VII / FR-017); rows lacking a
 * `_job_key` are historical/manual and are NEVER claimed or overwritten (FR-026).
 */
export class SheetSink {
  constructor(private readonly api: SheetsApi) {}

  /**
   * Ensure the sheet has the current v3 header, migrating older shapes in place. Idempotent:
   * a no-op once the header is fully v3, so it is safe to run on every process start. Detection is
   * MARKER-based (not exact length) so a sheet carrying extra trailing user columns is still
   * recognized rather than mis-routed to the fail-loud throw (which would dead-letter the 'sheets'
   * outbox item and page the heartbeat).
   *
   * - empty                                   → write the full v3 header.
   * - v3 (`_job_key` at N AND 'File WWC' at I) → no-op (must not insert/rewrite on later starts).
   * - partial v3 (`_job_key` at N but I is NOT 'File WWC') → a crash left a blank File WWC label
   *   after insertColumn ran but setHeader did not; relabel ONLY (NO second insertColumn, which
   *   would double-shift the already-shifted data). (Finding #6)
   * - v2 (`_job_key` at M, no 'File WWC' at I; tolerates trailing cols) → insert a blank File WWC
   *   column at I FIRST so existing data cells shift right and `_job_key` lands at N, THEN rewrite
   *   the header as v3 (order matters; the upsert keys off N afterward). (Finding #5)
   * - v1 (8 cols, A–H identical to v3's first 8) → migrate STRAIGHT to v3 in one step. There is no
   *   `_job_key` column to preserve, so NO insertColumn; existing v1 data rows keep their 8 cells
   *   (I–N read empty) and are never claimed by the upsert (FR-026). (Finding #3)
   * - anything else                           → fail loud rather than overwrite (FR-022).
   */
  async ensureHeader(): Promise<void> {
    const header = await this.api.getHeader();
    if (header.length === 0) {
      await this.api.setHeader(V3_HEADER);
      return;
    }
    if (header[JOB_KEY_INDEX_V3] === '_job_key') {
      // v3-shaped (`_job_key` at N). Fully migrated only if the File WWC marker is also present at I.
      if (header[FILE_WWC_INDEX] === 'File WWC') return; // already v3 — idempotent no-op
      // Partial migration (insertColumn ran, setHeader did not): relabel only — do NOT insert again.
      await this.api.setHeader(V3_HEADER);
      return;
    }
    if (header[JOB_KEY_INDEX_V2] === '_job_key') {
      // v2 (`_job_key` still at M, File WWC not yet inserted): open the slot at I, THEN relabel so
      // historical data cells shift right (their `_job_key` M→N) before the header is rewritten.
      await this.api.insertColumn(FILE_WWC_INDEX);
      await this.api.setHeader(V3_HEADER);
      return;
    }
    if (header.length === V1_COL_COUNT) {
      // v1 → v3 in one step: A–H labels match v3's first 8, no `_job_key` to preserve (no insert).
      await this.api.setHeader(V3_HEADER);
      return;
    }
    // Anything else: do not overwrite an unrecognized sheet — fail loud (FR-022).
    throw new Error(`unrecognized sheet header (${header.length} cols): ${header.join(' | ')}`);
  }

  /** Append for a new job_key; update in place for an existing one (upsert). */
  async upsertRow(row: SheetRow): Promise<void> {
    const values = rowToValues(row);
    const keys = await this.api.getKeyColumn(); // index 0 = header
    const idx = keys.indexOf(row.jobKey);
    if (idx === -1) await this.api.appendRow(values);
    else await this.api.writeRow(idx + 1, values);
  }
}

/**
 * Sends a queued Sheets row (the outbox 'sheets' channel target — mirrors
 * ChatSender). Maps googleapis errors to the dispatcher's retry semantics:
 * 401/403 (auth/permission) → permanent; everything else (5xx/429/network) →
 * transient. Ensures the v3 header once per process before the first write.
 */
export interface SheetSender {
  send(row: SheetRow): Promise<SendOutcome>;
  /**
   * Best-effort: ensure the v3 header exists up front (once per process) so an
   * empty Active list still leaves a headed sheet — without waiting for the first
   * job. No-op after the first success. Called by the poll loop each cycle.
   */
  ensureReady?(): Promise<SendOutcome>;
}

/** googleapis error → dispatcher retry semantics: 401/403 permanent, else transient. */
function classifyError(err: unknown): SendOutcome {
  const e = err as { code?: number; status?: number };
  const code = e.code ?? e.status;
  return code === 401 || code === 403 ? 'permanent' : 'transient';
}

export class GoogleSheetSender implements SheetSender {
  private headerEnsured = false;
  constructor(private readonly sink: SheetSink) {}

  async ensureReady(): Promise<SendOutcome> {
    try {
      if (!this.headerEnsured) {
        await this.sink.ensureHeader();
        this.headerEnsured = true;
      }
      return 'ok';
    } catch (err) {
      return classifyError(err);
    }
  }

  async send(row: SheetRow): Promise<SendOutcome> {
    const ready = await this.ensureReady();
    if (ready !== 'ok') return ready; // header not in place yet → retry via outbox
    try {
      await this.sink.upsertRow(row);
      return 'ok';
    } catch (err) {
      return classifyError(err);
    }
  }
}

/** Real googleapis-backed SheetsApi (service account, least-privilege scope). */
export class GoogleSheetsApi implements SheetsApi {
  private readonly sheets;
  constructor(
    private readonly spreadsheetId: string,
    private readonly tab: string,
    keyFile: string,
  ) {
    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  async getHeader(): Promise<string[]> {
    const r = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A1:Z1`,
    });
    return (r.data.values?.[0] as string[] | undefined) ?? [];
  }

  async setHeader(values: string[]): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });
  }

  async getKeyColumn(): Promise<string[]> {
    const r = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!${LAST_COL_LETTER}:${LAST_COL_LETTER}`,
    });
    return ((r.data.values ?? []) as string[][]).map((row) => row[0] ?? '');
  }

  async writeRow(rowNum: number, values: string[]): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A${rowNum}:${LAST_COL_LETTER}${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });
  }

  async appendRow(values: string[]): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A:${LAST_COL_LETTER}`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
  }

  /**
   * Insert one blank column before the 0-based `beforeIndex` via batchUpdate/insertDimension
   * (COLUMNS), shifting every existing cell right. Needs the tab's numeric sheetId, fetched once
   * (matched by title) and cached. `inheritFromBefore:false` so the new column takes default
   * formatting rather than copying the Words column's.
   */
  async insertColumn(beforeIndex: number): Promise<void> {
    const sheetId = await this.resolveSheetId();
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: beforeIndex,
                endIndex: beforeIndex + 1,
              },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });
  }

  private cachedSheetId: number | undefined;
  /** The tab's numeric sheetId (matched by title), cached after the first lookup. */
  private async resolveSheetId(): Promise<number> {
    if (this.cachedSheetId !== undefined) return this.cachedSheetId;
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.spreadsheetId });
    const match = (meta.data.sheets ?? []).find((s) => s.properties?.title === this.tab);
    const id = match?.properties?.sheetId;
    if (id === undefined || id === null) {
      throw new Error(`sheet tab not found for insertColumn: ${this.tab}`);
    }
    this.cachedSheetId = id;
    return id;
  }
}
