import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';
import { Dispatcher } from '../../src/reporting/dispatcher.js';
import type { ChatSender, SendOutcome } from '../../src/reporting/googleChat.js';
import type { SheetSender, SheetRow } from '../../src/reporting/sheets.js';

const NOW = '2026-06-19T10:00:00.000Z';
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const okChat: ChatSender = {
  async send(): Promise<SendOutcome> {
    return 'ok';
  },
  async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
    return { outcome: 'ok', status: 200 };
  },
};

class FakeSheetSender implements SheetSender {
  rows: SheetRow[] = [];
  outcome: SendOutcome = 'ok';
  async send(row: SheetRow): Promise<SendOutcome> {
    this.rows.push(row);
    return this.outcome;
  }
}

const sheetRow = (): SheetRow => ({
  jobKey: 'k',
  receivedDate: NOW,
  status: 'New',
  projectName: 'P',
  fileName: 'a.docx',
  sourceLang: null,
  targetLang: 'Malay (Malaysia)',
  dueDate: null,
  words: 10,
  step: null,
  role: null,
  acceptedAt: null,
  note: null,
});

let db: DB;
const dirs: string[] = [];
function fresh(): Outbox {
  const d = mkdtempSync(join(tmpdir(), 'acolad-so-'));
  dirs.push(d);
  db = openDatabase(d, NOW).db;
  return new Outbox(db, 10, 6);
}
afterEach(() => {
  db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Sheets outbox routing (T040/T038, FR-018)', () => {
  it('routes a sheets-channel row to the SheetSender and marks it sent', async () => {
    const outbox = fresh();
    outbox.enqueue('ev1', JSON.stringify({ op: 'append', row: sheetRow() }), NOW, 'sheets');
    const sheet = new FakeSheetSender();
    const summary = await new Dispatcher(outbox, { chat: okChat, sheet }, noopLogger, {}).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(sheet.rows).toHaveLength(1);
    expect(summary.sent).toBe(1);
    expect(outbox.countByStatus('sent')).toBe(1);
  });

  it('retries (never loses) a sheets row on a transient failure', async () => {
    const outbox = fresh();
    outbox.enqueue('ev1', JSON.stringify({ row: sheetRow() }), NOW, 'sheets');
    const sheet = new FakeSheetSender();
    sheet.outcome = 'transient';
    const summary = await new Dispatcher(outbox, { chat: okChat, sheet }, noopLogger, {}).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(summary.transientFailures).toBe(1);
    expect(outbox.countByStatus('pending')).toBe(1); // still queued
    expect(outbox.countByStatus('sent')).toBe(0);
  });

  it('flushes chat and sheets together; one does not block the other', async () => {
    const outbox = fresh();
    outbox.enqueue('e-chat', JSON.stringify({ text: 'hi' }), NOW, 'chat');
    outbox.enqueue('e-sheet', JSON.stringify({ row: sheetRow() }), NOW, 'sheets');
    const sheet = new FakeSheetSender();
    const summary = await new Dispatcher(outbox, { chat: okChat, sheet }, noopLogger, {}).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(summary.sent).toBe(2);
  });

  it('drops a sheets row (no wedge) when no SheetSender is configured', async () => {
    const outbox = fresh();
    outbox.enqueue('ev1', JSON.stringify({ row: sheetRow() }), NOW, 'sheets');
    const summary = await new Dispatcher(outbox, { chat: okChat }, noopLogger, {}).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(summary.dead).toBe(1);
    expect(outbox.countByStatus('pending')).toBe(0);
  });
});
