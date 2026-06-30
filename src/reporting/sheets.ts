import { google } from 'googleapis';
import type { XtmLifecycleStatus } from '../detection/types.js';
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
 * Column schema v2 (contracts/sheets.md). `_job_key` (M) is the hidden upsert key.
 * Retained for the v1→v2 legacy path and the v2→v3 migration detection — the LIVE shape is v3.
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

const NEW_COLS = V2_HEADER.slice(8); // I–M appended when upgrading a v1 (8-col) sheet to v2

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
 * Google Sheets sink (contracts/sheets.md). Upserts by `_job_key` (col M) so a
 * job never produces duplicate rows (Constitution VII / FR-017); rows lacking a
 * `_job_key` are historical/manual and are NEVER claimed or overwritten (FR-026).
 */
export class SheetSink {
  constructor(private readonly api: SheetsApi) {}

  /**
   * Ensure the sheet has the current v3 header, migrating older shapes in place. Idempotent:
   * a no-op once the header is v3, so it is safe to run on every process start.
   *
   * - empty            → write the full v3 header.
   * - v3 (14 cols, N=_job_key)  → no-op (must not insert/rewrite again on subsequent starts).
   * - v2 (13 cols, M=_job_key)  → insert a blank File WWC column at I (index 8) FIRST so existing
   *   data cells shift right and `_job_key` lands at N, THEN rewrite the header as v3 — historical
   *   rows keep their data aligned (the upsert keys off N afterward).
   * - v1 (8 cols)      → append I–M to reach v2 (legacy cold path; a later start lifts it to v3).
   * - anything else    → fail loud rather than overwrite an unrecognized sheet (FR-022).
   */
  async ensureHeader(): Promise<void> {
    const header = await this.api.getHeader();
    if (header.length === 0) {
      await this.api.setHeader(V3_HEADER);
      return;
    }
    if (header.length >= 14 && header[13] === '_job_key') return; // already v3 — idempotent
    if (header.length === 13 && header[12] === '_job_key') {
      // v2 → v3: open the File WWC slot at column I, THEN rewrite the header (order matters so
      // historical data cells shift right with the insert before the header is relabeled).
      await this.api.insertColumn(8);
      await this.api.setHeader(V3_HEADER);
      return;
    }
    if (header.length === 8) {
      // v1 → v2: keep the user's 8 columns, append I–M (a later start migrates v2 → v3).
      await this.api.setHeader([...header, ...NEW_COLS]);
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
      range: `${this.tab}!N:N`,
    });
    return ((r.data.values ?? []) as string[][]).map((row) => row[0] ?? '');
  }

  async writeRow(rowNum: number, values: string[]): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A${rowNum}:N${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });
  }

  async appendRow(values: string[]): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A:N`,
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
