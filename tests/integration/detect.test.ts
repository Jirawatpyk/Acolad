import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';
import { PollCyclePersister } from '../../src/runtime/pollCycle.js';
import { Dispatcher } from '../../src/reporting/dispatcher.js';
import { readJobSnapshot } from '../../src/portal/jobList.js';
import {
  LayoutChangedError,
  PaginationDetectedError,
  PortalTimeoutError,
  SessionExpiredError,
} from '../../src/portal/errors.js';
import type { ChatSender, SendOutcome } from '../../src/reporting/googleChat.js';
import {
  jobListPage,
  jobRow,
  emptyJobListPage,
  brokenLayoutPage,
  paginatedJobListPage,
  ambiguousEmptyPage,
  loadingShellPage,
  loadingListPage,
  sessionExpiredPage,
} from '../fixtures/pages.js';

// Short read timeouts so "still loading" fixtures (whose loaders never clear)
// don't burn the production 10–15s waits in the test suite.
const FAST = { settle: 500, loader: 300, content: 300 };

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

class CapturingSender implements ChatSender {
  messages: string[] = [];
  async send(text: string): Promise<SendOutcome> {
    this.messages.push(text);
    return 'ok';
  }
}

let browser: Browser;
let page: Page;
let dir: string;
let db: DB;
let cycle = 0;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  page = await browser.newPage();
  dir = mkdtempSync(join(tmpdir(), 'acolad-it-'));
  db = openDatabase(dir, '2026-06-10T03:00:00.000Z').db;
  cycle = 0;
});
afterEach(async () => {
  await page.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const noEvidence = async (): Promise<string | undefined> => undefined;

async function snapshotOf(html: string): Promise<ReturnType<typeof readJobSnapshot>> {
  await page.setContent(html);
  cycle += 1;
  const at = new Date(Date.parse('2026-06-10T03:00:00.000Z') + cycle * 60_000).toISOString();
  return readJobSnapshot(page, `cycle-${cycle}`, at, noEvidence);
}

async function runCycle(html: string, sender: CapturingSender): Promise<void> {
  const snapshot = await snapshotOf(html);
  const persister = new PollCyclePersister(db, new Outbox(db, 10, 6), noopLogger);
  persister.persist(snapshot);
  const at = new Date(
    Date.parse('2026-06-10T03:00:00.000Z') + cycle * 60_000 + 5_000,
  ).toISOString();
  await new Dispatcher(new Outbox(db, 10, 6), sender, noopLogger).flush(at, Date.parse(at));
}

describe('detection integration (real Chromium DOM parsing)', () => {
  it('V11: cold start with jobs emits ONE summary, not per-job messages', async () => {
    const sender = new CapturingSender();
    const rows = [
      jobRow({ id: 'J1', title: 'Alpha', langs: 'EN>TH' }),
      jobRow({ id: 'J2', title: 'Beta' }),
    ].join('');
    await runCycle(jobListPage(rows), sender);
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toContain('เริ่มระบบเฝ้างาน');
    expect(sender.messages[0]).toContain('พบงานค้างอยู่ 2 งาน');
  });

  it('V11: cold start on empty portal sends the 0-jobs summary', async () => {
    const sender = new CapturingSender();
    await runCycle(emptyJobListPage, sender);
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toContain('ยังไม่มีงาน');
  });

  it('V1/V2: after baseline, a new job notifies once and is not repeated', async () => {
    const sender = new CapturingSender();
    await runCycle(emptyJobListPage, sender); // baseline
    sender.messages.length = 0;

    const oneJob = jobListPage(
      jobRow({ id: 'J9', title: 'Fresh job', langs: 'EN>TH', url: '/job/9' }),
    );
    await runCycle(oneJob, sender); // V1: new job
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toContain('🆕 งานใหม่บน Acolad');

    await runCycle(oneJob, sender); // V2: still present, no re-notify
    expect(sender.messages).toHaveLength(1);
  });

  it('V3/SC-008: a burst of 25 new jobs yields 25 separate messages', async () => {
    const sender = new CapturingSender();
    await runCycle(emptyJobListPage, sender); // baseline
    sender.messages.length = 0;

    const rows = Array.from({ length: 25 }, (_, i) =>
      jobRow({ id: `J${i}`, title: `Job ${i}` }),
    ).join('');
    await runCycle(jobListPage(rows), sender);
    expect(sender.messages).toHaveLength(25);
    expect(sender.messages.every((m) => m.includes('🆕'))).toBe(true);
  });

  it('V9: a job that disappears for 2 cycles then returns notifies 🔁 with original first-seen', async () => {
    const sender = new CapturingSender();
    const present = jobListPage(jobRow({ id: 'J1', title: 'Recurring' }));
    await runCycle(emptyJobListPage, sender); // baseline empty
    await runCycle(present, sender); // first_seen
    sender.messages.length = 0;
    await runCycle(emptyJobListPage, sender); // miss 1 (flicker)
    await runCycle(emptyJobListPage, sender); // miss 2 -> missing (no message)
    expect(sender.messages).toHaveLength(0);
    await runCycle(present, sender); // relisted
    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]).toContain('🔁 งานกลับมาอีกครั้ง');
  });

  it('malformed rows are quarantined, valid rows still processed (Constitution II)', async () => {
    const sender = new CapturingSender();
    await runCycle(emptyJobListPage, sender); // baseline
    sender.messages.length = 0;

    const rows = [jobRow({ id: 'J1', title: 'Valid' }), jobRow({ id: 'JX' })].join(''); // 2nd has no title
    const snapshot = await snapshotOf(jobListPage(rows));
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.malformed).toHaveLength(1);
  });

  it('missing container marker -> LayoutChangedError (not empty list)', async () => {
    await page.setContent(brokenLayoutPage);
    await expect(
      readJobSnapshot(page, 'c', '2026-06-10T03:00:00.000Z', noEvidence, FAST),
    ).rejects.toBeInstanceOf(LayoutChangedError);
  });

  it('pagination indicator -> PaginationDetectedError (FR-009)', async () => {
    await page.setContent(paginatedJobListPage(jobRow({ id: 'J1', title: 'A' })));
    await expect(
      readJobSnapshot(page, 'c', '2026-06-10T03:00:00.000Z', noEvidence),
    ).rejects.toBeInstanceOf(PaginationDetectedError);
  });

  it('empty list WITH empty-state marker is a confirmed empty (not an error)', async () => {
    await page.setContent(emptyJobListPage);
    const snap = await readJobSnapshot(page, 'c', '2026-06-10T03:00:00.000Z', noEvidence);
    expect(snap.emptyListConfirmed).toBe(true);
    expect(snap.jobs).toHaveLength(0);
  });

  it('shell present but no rows and no empty-state marker -> fail loud (FR-016)', async () => {
    await page.setContent(ambiguousEmptyPage);
    await expect(
      readJobSnapshot(page, 'c', '2026-06-10T03:00:00.000Z', noEvidence, FAST),
    ).rejects.toBeInstanceOf(LayoutChangedError);
  });

  // Regression: overnight 2026-06-11/12 the bot fired CRITICAL "layout changed"
  // alerts for three BENIGN states (still-loading list, still-loading app shell,
  // expired session). None is a layout change; each must be classified so the
  // operator is not woken by false alarms and a real job is not masked by noise.

  it('offers list still loading (loader visible) -> transient, NOT layout changed', async () => {
    await page.setContent(loadingListPage);
    const evidence = vi.fn(noEvidence);
    await expect(
      readJobSnapshot(page, 'c', '2026-06-10T03:00:00.000Z', evidence, FAST),
    ).rejects.toBeInstanceOf(PortalTimeoutError);
    // A transient load must not capture evidence (no disk/alert noise).
    expect(evidence).not.toHaveBeenCalled();
  });

  it('app shell still loading (no container yet) -> transient, NOT layout changed', async () => {
    await page.setContent(loadingShellPage);
    const evidence = vi.fn(noEvidence);
    await expect(
      readJobSnapshot(page, 'c', '2026-06-10T03:00:00.000Z', evidence, FAST),
    ).rejects.toBeInstanceOf(PortalTimeoutError);
    expect(evidence).not.toHaveBeenCalled();
  });

  it('redirected to login (session expired) -> SessionExpiredError, NOT layout changed', async () => {
    await page.setContent(sessionExpiredPage);
    const evidence = vi.fn(noEvidence);
    await expect(
      readJobSnapshot(page, 'c', '2026-06-10T03:00:00.000Z', evidence, FAST),
    ).rejects.toBeInstanceOf(SessionExpiredError);
    expect(evidence).not.toHaveBeenCalled();
  });
});
