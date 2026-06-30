import { describe, it, expect } from 'vitest';
import {
  SheetSink,
  GoogleSheetSender,
  V2_HEADER,
  V3_HEADER,
  formatSheetDate,
  lifecycleToSheetStatus,
  type SheetsApi,
  type SheetRow,
} from '../../src/reporting/sheets.js';

/**
 * In-memory fake of the row/header operations (rows[0] = header). `_job_key` is column N
 * (index 13) in the v3 schema. `calls` records mutating ops in order so a test can assert the
 * v2→v3 migration runs insertColumn(8) BEFORE setHeader(V3_HEADER) (and not at all when v3).
 */
class FakeSheets implements SheetsApi {
  rows: string[][];
  calls: string[] = [];
  constructor(initial: string[][] = []) {
    this.rows = initial.map((r) => [...r]);
  }
  async getHeader(): Promise<string[]> {
    return this.rows[0] ? [...this.rows[0]] : [];
  }
  async setHeader(values: string[]): Promise<void> {
    this.calls.push(`setHeader(${values.length})`);
    this.rows[0] = [...values];
  }
  async getKeyColumn(): Promise<string[]> {
    return this.rows.map((r) => r[13] ?? '');
  }
  async writeRow(rowNum: number, values: string[]): Promise<void> {
    this.rows[rowNum - 1] = [...values];
  }
  async appendRow(values: string[]): Promise<void> {
    this.rows.push([...values]);
  }
  async insertColumn(beforeIndex: number): Promise<void> {
    this.calls.push(`insertColumn(${beforeIndex})`);
    this.rows = this.rows.map((r) => {
      const copy = [...r];
      copy.splice(beforeIndex, 0, '');
      return copy;
    });
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
  fileWwc: 17,
  step: 'PE 1',
  role: 'Corrector',
  acceptedAt: null,
  note: null,
  ...over,
});

describe('SheetSink.ensureHeader (v3 migration, FR-016)', () => {
  it('writes the full v3 header on an empty sheet', async () => {
    const api = new FakeSheets();
    await new SheetSink(api).ensureHeader();
    expect(api.rows[0]).toEqual(V3_HEADER);
    expect(api.rows[0]?.[8]).toBe('File WWC'); // new column I
    expect(api.rows[0]?.[13]).toBe('_job_key'); // now column N
  });

  it('v2 → v3: inserts a blank File WWC column at I, THEN rewrites the header (in that order)', async () => {
    // A live v2 sheet: 13-col header (_job_key at M) + a historical data row.
    const v2DataRow = [
      '01/06/2026 10:00', // A received
      'Accepted', // B status
      'Old Project', // C project
      'old.docx', // D file
      'English (USA)', // E source
      'Malay (Malaysia)', // F target
      '02/06/2026', // G due
      '500', // H words
      'PE 1', // I step (v2)
      'Corrector', // J role (v2)
      '01/06/2026 10:05', // K accepted at (v2)
      'a note', // L note (v2)
      'old.docx|pe 1|corrector', // M _job_key (v2)
    ];
    const api = new FakeSheets([V2_HEADER, v2DataRow]);
    await new SheetSink(api).ensureHeader();

    // Order matters: open the slot, then relabel.
    expect(api.calls).toEqual(['insertColumn(8)', 'setHeader(14)']);
    expect(api.rows[0]).toEqual(V3_HEADER);
    // The historical row keeps its data aligned: a blank File WWC at I (8) and its
    // _job_key shifted M → N (12 → 13).
    expect(api.rows[1]?.[7]).toBe('500'); // Words still at H
    expect(api.rows[1]?.[8]).toBe(''); // blank File WWC at I
    expect(api.rows[1]?.[9]).toBe('PE 1'); // Step shifted I → J
    expect(api.rows[1]?.[13]).toBe('old.docx|pe 1|corrector'); // _job_key now at N
  });

  it('is idempotent: a no-op when the header is already v3 (no insert, no setHeader)', async () => {
    const api = new FakeSheets([V3_HEADER]);
    await new SheetSink(api).ensureHeader();
    expect(api.calls).toEqual([]); // neither insertColumn nor setHeader fired
    expect(api.rows[0]).toEqual(V3_HEADER);
  });

  it('is idempotent across restarts: a second ensureHeader after a v2→v3 migration does nothing more', async () => {
    const api = new FakeSheets([V2_HEADER, ['', '', '', '', '', '', '', '', '', '', '', '', 'k']]);
    const sink = new SheetSink(api);
    await sink.ensureHeader();
    const afterFirst = [...api.calls];
    await sink.ensureHeader(); // simulate the next process start
    expect(api.calls).toEqual(afterFirst); // no further insert/setHeader
  });

  it('v1 → v3: migrates an 8-column header straight to v3 in one step (no broken v2 intermediate, Finding #3)', async () => {
    // v1 A–H labels are identical to V3's first 8, so relabeling to V3_HEADER is correct.
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
    // One step to v3: setHeader(V3_HEADER) and NO insertColumn (there is no _job_key to preserve).
    expect(api.calls).toEqual(['setHeader(14)']);
    expect(api.rows[0]).toEqual(V3_HEADER);
    // Idempotent on the resulting v3 — a later start does nothing more.
    await new SheetSink(api).ensureHeader();
    expect(api.calls).toEqual(['setHeader(14)']);
  });

  it('v2 with a trailing user column (14 cols, _job_key still at M) migrates to v3 — does not throw (Finding #5)', async () => {
    // Pre-PR18 this >=13 shape was tolerated; an exact ===13 check would mis-route it to the
    // fail-loud throw → outbox retries forever → dead → heartbeat pages.
    const v2Trailing = [...V2_HEADER, 'Extra notes']; // _job_key at M (12), user col at N (13)
    const api = new FakeSheets([v2Trailing]);
    await new SheetSink(api).ensureHeader();
    expect(api.calls).toEqual(['insertColumn(8)', 'setHeader(14)']);
    expect(api.rows[0]).toEqual(V3_HEADER);
  });

  it('repairs a partial v2→v3 migration: 14 cols, _job_key at N but a BLANK File WWC header — relabels only, no second insertColumn (Finding #6)', async () => {
    // Crash between insertColumn(8) and setHeader: the v2 header got a blank cell shoved in at
    // index 8 (so _job_key shifted M→N) but was never relabeled. header[13]==='_job_key' MATCHES
    // the old length-based guard, yet header[8] is blank, not 'File WWC' → must relabel, not re-shift.
    const partial = [...V2_HEADER.slice(0, 8), '', ...V2_HEADER.slice(8)];
    expect(partial).toHaveLength(14);
    expect(partial[8]).toBe(''); // blank File WWC label
    expect(partial[13]).toBe('_job_key'); // _job_key already shifted to N
    const api = new FakeSheets([partial]);
    await new SheetSink(api).ensureHeader();
    expect(api.calls).toEqual(['setHeader(14)']); // relabel ONLY — no second insertColumn (would double-shift)
    expect(api.rows[0]).toEqual(V3_HEADER);
    // Idempotent afterward.
    await new SheetSink(api).ensureHeader();
    expect(api.calls).toEqual(['setHeader(14)']);
  });

  it('fails loud on an unrecognized header rather than overwriting (10 cols, no _job_key)', async () => {
    const weird = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']; // 10 cols, no _job_key
    const api = new FakeSheets([weird]);
    await expect(new SheetSink(api).ensureHeader()).rejects.toThrow();
  });

  it('fails loud on a genuinely unrecognized header (5 random cols) (Finding #5)', async () => {
    const weird = ['a', 'b', 'c', 'd', 'e']; // 5 cols, no _job_key anywhere
    const api = new FakeSheets([weird]);
    await expect(new SheetSink(api).ensureHeader()).rejects.toThrow();
  });
});

describe('SheetSink.upsertRow (upsert by job_key, Constitution VII / FR-017)', () => {
  it('appends a new row for an unseen job_key, with File WWC at I and _job_key at N', async () => {
    const api = new FakeSheets([V3_HEADER]);
    await new SheetSink(api).upsertRow(row({ fileWwc: 427 }));
    expect(api.rows).toHaveLength(2);
    expect(api.rows[1]?.[1]).toBe('New'); // Status col B
    expect(api.rows[1]?.[7]).toBe('120'); // Words col H
    expect(api.rows[1]?.[8]).toBe('427'); // File WWC col I
    expect(api.rows[1]?.[13]).toBe('a.docx|pe 1|corrector'); // _job_key col N
  });

  it('updates the existing row in place (no duplicate) on a status change', async () => {
    const api = new FakeSheets([V3_HEADER]);
    const sink = new SheetSink(api);
    await sink.upsertRow(row({ status: 'New' }));
    await sink.upsertRow(row({ status: 'Accepted', acceptedAt: '2026-06-19T10:00:05+07:00' }));
    expect(api.rows).toHaveLength(2); // still one data row
    expect(api.rows[1]?.[1]).toBe('Accepted');
    expect(api.rows[1]?.[11]).toBe('19/06/2026 10:00'); // Accepted at col L — readable Bangkok local
  });

  it('never claims a historical row that has no job_key (FR-026)', async () => {
    // A manually-entered legacy row (no _job_key in column N).
    const legacy = [
      '2026-06-01',
      'Done',
      'Old',
      'old.docx',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ];
    const api = new FakeSheets([V3_HEADER, legacy]);
    await new SheetSink(api).upsertRow(row());
    expect(api.rows).toHaveLength(3); // legacy untouched, new row appended
    expect(api.rows[1]).toEqual(legacy);
    expect(api.rows[2]?.[13]).toBe('a.docx|pe 1|corrector');
  });

  it('serializes null fields as empty cells and words/File WWC as text', async () => {
    const api = new FakeSheets([V3_HEADER]);
    await new SheetSink(api).upsertRow(
      row({ sourceLang: null, words: null, fileWwc: null, note: 'snatched' }),
    );
    expect(api.rows[1]?.[4]).toBe(''); // source
    expect(api.rows[1]?.[7]).toBe(''); // words
    expect(api.rows[1]?.[8]).toBe(''); // File WWC
    expect(api.rows[1]?.[12]).toBe('snatched'); // note col M
  });

  it('serializes a File WWC of 0 as "0" (a real value, not blank)', async () => {
    const api = new FakeSheets([V3_HEADER]);
    await new SheetSink(api).upsertRow(row({ fileWwc: 0 }));
    expect(api.rows[1]?.[8]).toBe('0');
  });

  it('writes human-readable Bangkok dates (not raw ISO) for received/due/accepted', async () => {
    const api = new FakeSheets([V3_HEADER]);
    await new SheetSink(api).upsertRow(
      row({
        receivedDate: '2026-06-22T10:11:25.007Z', // UTC → +07
        dueDate: '2026-06-22T21:38+07:00',
        acceptedAt: '2026-06-22T10:12:00.000Z',
      }),
    );
    expect(api.rows[1]?.[0]).toBe('22/06/2026 17:11'); // Received date col A
    expect(api.rows[1]?.[6]).toBe('22/06/2026 21:38'); // Due date col G
    expect(api.rows[1]?.[11]).toBe('22/06/2026 17:12'); // Accepted at col L
  });
});

describe('formatSheetDate re-export (back-compat shim — full cases live in dateFormat.test.ts)', () => {
  it('re-export resolves to the same implementation (smoke)', () => {
    expect(formatSheetDate('2026-06-22T10:11:25.007Z')).toBe('22/06/2026 17:11');
  });
});

describe('GoogleSheetSender.ensureReady (proactive header so an empty sheet is still headed)', () => {
  it('writes the v3 header up front with no data rows', async () => {
    const api = new FakeSheets();
    const sender = new GoogleSheetSender(new SheetSink(api));
    expect(await sender.ensureReady()).toBe('ok');
    expect(api.rows[0]).toEqual(V3_HEADER);
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

describe('lifecycleToSheetStatus', () => {
  it('maps rejected → Rejected', () => {
    expect(lifecycleToSheetStatus('rejected')).toBe('Rejected');
  });
});

// V2_HEADER is retained for the migration detection path — keep a guard so it is not deleted.
describe('schema constants', () => {
  it('V2_HEADER is the 13-col shape with _job_key at M and V3_HEADER inserts File WWC at I', () => {
    expect(V2_HEADER).toHaveLength(13);
    expect(V2_HEADER[12]).toBe('_job_key');
    expect(V3_HEADER).toHaveLength(14);
    expect(V3_HEADER[8]).toBe('File WWC');
    expect(V3_HEADER[13]).toBe('_job_key');
  });
});
