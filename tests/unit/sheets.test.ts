import { describe, it, expect } from 'vitest';
import {
  SheetSink,
  GoogleSheetSender,
  V2_HEADER,
  formatSheetDate,
  type SheetsApi,
  type SheetRow,
} from '../../src/reporting/sheets.js';

/** In-memory fake of the row/header operations (rows[0] = header). */
class FakeSheets implements SheetsApi {
  rows: string[][];
  constructor(initial: string[][] = []) {
    this.rows = initial.map((r) => [...r]);
  }
  async getHeader(): Promise<string[]> {
    return this.rows[0] ? [...this.rows[0]] : [];
  }
  async setHeader(values: string[]): Promise<void> {
    this.rows[0] = [...values];
  }
  async getKeyColumn(): Promise<string[]> {
    return this.rows.map((r) => r[12] ?? '');
  }
  async writeRow(rowNum: number, values: string[]): Promise<void> {
    this.rows[rowNum - 1] = [...values];
  }
  async appendRow(values: string[]): Promise<void> {
    this.rows.push([...values]);
  }
}

const row = (over: Partial<SheetRow> = {}): SheetRow => ({
  jobKey: 'a.docx|pe 1|corrector',
  receivedDate: '2026-06-19T10:00:00+07:00',
  status: 'New',
  projectName: 'Acme',
  fileName: 'a.docx',
  sourceLang: 'English (USA)',
  targetLang: 'Malay (Malaysia)',
  dueDate: '2026-06-20',
  words: 120,
  step: 'PE 1',
  role: 'Corrector',
  acceptedAt: null,
  note: null,
  ...over,
});

describe('SheetSink.ensureHeader (v1->v2 migration, FR-016)', () => {
  it('writes the full v2 header on an empty sheet', async () => {
    const api = new FakeSheets();
    await new SheetSink(api).ensureHeader();
    expect(api.rows[0]).toEqual(V2_HEADER);
    expect(api.rows[0]?.[12]).toBe('_job_key');
  });

  it('upgrades a v1 (8-column) header by appending I-M, preserving the user columns', async () => {
    const v1 = [
      'Received date',
      'Status',
      'Project name',
      'File',
      'Source language',
      'Target languages',
      'Due date',
      'Words',
    ];
    const api = new FakeSheets([v1]);
    await new SheetSink(api).ensureHeader();
    expect(api.rows[0]?.slice(0, 8)).toEqual(v1); // user columns untouched
    expect(api.rows[0]).toHaveLength(13);
    expect(api.rows[0]?.[12]).toBe('_job_key');
  });

  it('is a no-op when the header is already v2', async () => {
    const api = new FakeSheets([V2_HEADER]);
    await new SheetSink(api).ensureHeader();
    expect(api.rows[0]).toEqual(V2_HEADER);
  });

  it('fails loud on an unrecognized header rather than overwriting', async () => {
    const weird = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']; // 10 cols, no _job_key
    const api = new FakeSheets([weird]);
    await expect(new SheetSink(api).ensureHeader()).rejects.toThrow();
  });
});

describe('SheetSink.upsertRow (upsert by job_key, Constitution VII / FR-017)', () => {
  it('appends a new row for an unseen job_key', async () => {
    const api = new FakeSheets([V2_HEADER]);
    await new SheetSink(api).upsertRow(row());
    expect(api.rows).toHaveLength(2);
    expect(api.rows[1]?.[1]).toBe('New'); // Status col B
    expect(api.rows[1]?.[12]).toBe('a.docx|pe 1|corrector'); // _job_key col M
  });

  it('updates the existing row in place (no duplicate) on a status change', async () => {
    const api = new FakeSheets([V2_HEADER]);
    const sink = new SheetSink(api);
    await sink.upsertRow(row({ status: 'New' }));
    await sink.upsertRow(row({ status: 'Accepted', acceptedAt: '2026-06-19T10:00:05+07:00' }));
    expect(api.rows).toHaveLength(2); // still one data row
    expect(api.rows[1]?.[1]).toBe('Accepted');
    expect(api.rows[1]?.[10]).toBe('19/06/2026 10:00'); // Accepted at col K — readable Bangkok local
  });

  it('never claims a historical row that has no job_key (FR-026)', async () => {
    // A manually-entered legacy row (no _job_key in column M).
    const legacy = ['2026-06-01', 'Done', 'Old', 'old.docx', '', '', '', '', '', '', '', '', ''];
    const api = new FakeSheets([V2_HEADER, legacy]);
    await new SheetSink(api).upsertRow(row());
    expect(api.rows).toHaveLength(3); // legacy untouched, new row appended
    expect(api.rows[1]).toEqual(legacy);
    expect(api.rows[2]?.[12]).toBe('a.docx|pe 1|corrector');
  });

  it('serializes null fields as empty cells and words as text', async () => {
    const api = new FakeSheets([V2_HEADER]);
    await new SheetSink(api).upsertRow(row({ sourceLang: null, words: null, note: 'snatched' }));
    expect(api.rows[1]?.[4]).toBe(''); // source
    expect(api.rows[1]?.[7]).toBe(''); // words
    expect(api.rows[1]?.[11]).toBe('snatched'); // note col L
  });

  it('writes human-readable Bangkok dates (not raw ISO) for received/due/accepted', async () => {
    const api = new FakeSheets([V2_HEADER]);
    await new SheetSink(api).upsertRow(
      row({
        receivedDate: '2026-06-22T10:11:25.007Z', // UTC → +07
        dueDate: '2026-06-22T21:38+07:00',
        acceptedAt: '2026-06-22T10:12:00.000Z',
      }),
    );
    expect(api.rows[1]?.[0]).toBe('22/06/2026 17:11'); // Received date col A
    expect(api.rows[1]?.[6]).toBe('22/06/2026 21:38'); // Due date col G
    expect(api.rows[1]?.[10]).toBe('22/06/2026 17:12'); // Accepted at col K
  });
});

describe('formatSheetDate (readable Bangkok-local dates)', () => {
  it('formats a UTC ISO timestamp to Bangkok DD/MM/YYYY HH:mm', () => {
    expect(formatSheetDate('2026-06-22T10:11:25.007Z')).toBe('22/06/2026 17:11');
  });

  it('formats a +07:00 ISO timestamp without shifting it twice', () => {
    expect(formatSheetDate('2026-06-22T21:38+07:00')).toBe('22/06/2026 21:38');
  });

  it('returns empty for null/empty and passes an unparseable value through unchanged', () => {
    expect(formatSheetDate(null)).toBe('');
    expect(formatSheetDate('')).toBe('');
    expect(formatSheetDate('not-a-date')).toBe('not-a-date');
  });
});

describe('GoogleSheetSender.ensureReady (proactive header so an empty sheet is still headed)', () => {
  it('writes the v2 header up front with no data rows', async () => {
    const api = new FakeSheets();
    const sender = new GoogleSheetSender(new SheetSink(api));
    expect(await sender.ensureReady()).toBe('ok');
    expect(api.rows[0]).toEqual(V2_HEADER);
    expect(api.rows).toHaveLength(1); // header only — no job logged
  });

  it('ensures the header only once per process (idempotent across ensureReady + send)', async () => {
    const api = new FakeSheets();
    let getHeaderCalls = 0;
    const origGet = api.getHeader.bind(api);
    api.getHeader = async () => {
      getHeaderCalls++;
      return origGet();
    };
    const sender = new GoogleSheetSender(new SheetSink(api));
    await sender.ensureReady();
    await sender.ensureReady();
    await sender.send(row());
    expect(getHeaderCalls).toBe(1); // header checked exactly once
    expect(api.rows).toHaveLength(2); // header + the one upserted row
  });

  it('maps a 403 (permission) to permanent so the outbox does not silently drop it', async () => {
    const api = new FakeSheets();
    api.getHeader = async () => {
      throw Object.assign(new Error('forbidden'), { code: 403 });
    };
    const sender = new GoogleSheetSender(new SheetSink(api));
    expect(await sender.ensureReady()).toBe('permanent');
  });

  it('maps a 5xx/transient to transient (retry next cycle)', async () => {
    const api = new FakeSheets();
    api.getHeader = async () => {
      throw Object.assign(new Error('backend error'), { code: 503 });
    };
    const sender = new GoogleSheetSender(new SheetSink(api));
    expect(await sender.ensureReady()).toBe('transient');
  });
});
