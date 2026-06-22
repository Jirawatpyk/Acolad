import { google } from 'googleapis';
import type { XtmLifecycleStatus } from '../detection/types.js';
import type { SendOutcome } from './googleChat.js';

export type SheetStatus =
  | 'New'
  | 'Accepted'
  | 'Missing'
  | 'Accept failed'
  | 'Skipped'
  | 'Closed'
  | 'Removed';

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
  step: string | null;
  role: string | null;
  acceptedAt: string | null;
  note: string | null;
}

/** Column schema v2 (contracts/sheets.md). `_job_key` (M) is the hidden upsert key. */
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

const NEW_COLS = V2_HEADER.slice(8); // I–M added when upgrading a v1 sheet

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
  };
  return map[s];
}

/**
 * Human-readable Bangkok-local date for the Sheet ("DD/MM/YYYY HH:mm"). The bot
 * stores timestamps as ISO (UTC `...Z` or `+07:00`); the Sheet should show the local
 * wall-clock without the T / Z / offset / millisecond noise. Empty values become '';
 * an unparseable value passes through unchanged (never throws) so an odd raw due
 * string is preserved rather than blanked.
 */
export function formatSheetDate(value: string | null): string {
  if (!value) return '';
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  const d = new Date(t + 7 * 3_600_000); // shift to Asia/Bangkok (+07:00), then read UTC parts
  const p = (n: number): string => String(n).padStart(2, '0');
  const date = `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  // A date-only input (no time component) must not gain a spurious "07:00" from the
  // +07 shift of UTC-midnight — show just the date.
  const hasTime = value.includes('T') || /\d:\d/.test(value);
  return hasTime ? `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : date;
}

function rowToValues(r: SheetRow): string[] {
  return [
    formatSheetDate(r.receivedDate),
    r.status,
    r.projectName,
    r.fileName,
    r.sourceLang ?? '',
    r.targetLang ?? '',
    formatSheetDate(r.dueDate),
    r.words === null ? '' : String(r.words),
    r.step ?? '',
    r.role ?? '',
    formatSheetDate(r.acceptedAt),
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
  /** Column M (`_job_key`) values including the header, for upsert lookup. */
  getKeyColumn(): Promise<string[]>;
  /** Overwrite a data row A:M (1-based). */
  writeRow(rowNum: number, values: string[]): Promise<void>;
  /** Append a new data row A:M. */
  appendRow(values: string[]): Promise<void>;
}

/**
 * Google Sheets sink (contracts/sheets.md). Upserts by `_job_key` (col M) so a
 * job never produces duplicate rows (Constitution VII / FR-017); rows lacking a
 * `_job_key` are historical/manual and are NEVER claimed or overwritten (FR-026).
 */
export class SheetSink {
  constructor(private readonly api: SheetsApi) {}

  /** Ensure the sheet has the v2 header, upgrading a v1 (8-col) sheet in place. */
  async ensureHeader(): Promise<void> {
    const header = await this.api.getHeader();
    if (header.length === 0) {
      await this.api.setHeader(V2_HEADER);
      return;
    }
    if (header.length >= 13 && header[12] === '_job_key') return; // already v2
    if (header.length === 8) {
      // v1 → v2: keep the user's 8 columns, append I–M.
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
 * transient. Ensures the v2 header once per process before the first write.
 */
export interface SheetSender {
  send(row: SheetRow): Promise<SendOutcome>;
  /**
   * Best-effort: ensure the v2 header exists up front (once per process) so an
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
      range: `${this.tab}!M:M`,
    });
    return ((r.data.values ?? []) as string[][]).map((row) => row[0] ?? '');
  }

  async writeRow(rowNum: number, values: string[]): Promise<void> {
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A${rowNum}:M${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [values] },
    });
  }

  async appendRow(values: string[]): Promise<void> {
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `${this.tab}!A:M`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [values] },
    });
  }
}
