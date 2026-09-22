import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../../src/monitoring/logger.js';
import { loadStrakerBotConfig, type StrakerBotConfig } from '../../../src/straker/config.js';
import type { StrakerSenders } from '../../../src/straker/dispatcher.js';
import {
  assembleStrakerBot,
  createDailyReportStep,
  type StrakerPortal,
} from '../../../src/straker/main.js';
import { STRAKER_DB_FILENAME } from '../../../src/straker/strakerStore.js';

/**
 * A1 — Straker's 09:00 report, driven through the assembled bot (`assembleStrakerBot`).
 *
 * The builder is pure and unit-tested; what only the assembly can show is the wiring: that the
 * step runs on the bot's own turn, is gated by the working-day calendar, reaches the offers
 * room through the outbox, and is decided once per day — across a restart too, since PM2
 * restarts are routine on this host. A capability built and tested but never called is the
 * failure this feature has already had three times (`file-split-agents-leave-unowned-seams`).
 */

const tempDirs: string[] = [];
const open: { close(): void }[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function config(stateDir: string): StrakerBotConfig {
  return loadStrakerBotConfig({
    STRAKER_BASE_URL: 'https://vendr.straker.ai',
    STRAKER_LOGIN_ID: 'user@example.test',
    STRAKER_PASSWORD: 'pw',
    STRAKER_MAX_WORDS_PER_DAY: '3500',
    STRAKER_DTP_MAX_WORDS_PER_DAY: '30000',
    STRAKER_SHEETS_ID: 'sheet-straker',
    STRAKER_CHAT_WEBHOOK_OFFERS: 'https://chat.example.test/offers',
    GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example.test/ops',
    STRAKER_HEALTHCHECKS_PING_URL: 'https://hc.example.test/straker',
    STRAKER_SINGLE_INSTANCE_PORT: '47905',
    STRAKER_STATE_DIR: stateDir,
  });
}

/** A portal with nothing listed and nothing assigned — the report is all that can happen. */
function quietPortal(): StrakerPortal {
  return {
    client: { postJson: async () => ({}) } as never,
    signIn: async () => ({ vendorId: 'vendor-1' }),
    listOpenOffers: async () => [],
    listAssignedWork: async () => [],
    listPurchaseOrders: async () => [],
  };
}

interface Harness {
  readonly stateDir: string;
  /** Payloads the offers room received, in order. */
  readonly offersPosted: unknown[];
  readonly logs: { fields: Record<string, unknown>; msg: string }[];
  setNow(iso: string): void;
  assemble(): ReturnType<typeof assembleStrakerBot>;
}

function harness(): Harness {
  const stateDir = mkdtempSync(join(tmpdir(), 'straker-daily-'));
  tempDirs.push(stateDir);
  const offersPosted: unknown[] = [];
  const logs: { fields: Record<string, unknown>; msg: string }[] = [];
  const record =
    () =>
    (fields: object, msg?: string): void => {
      logs.push({ fields: fields as Record<string, unknown>, msg: msg ?? '' });
    };
  const logger: Logger = { info: record(), warn: record(), error: record() };
  let now = Date.parse('2026-09-22T08:00:00+07:00');
  const senders: StrakerSenders = {
    offers: async (payload) => {
      offersPosted.push(payload);
      return { ok: true };
    },
    alerts: async () => ({ ok: true }),
    tracking: async () => ({ ok: true }),
  };
  return {
    stateDir,
    offersPosted,
    logs,
    setNow: (iso) => {
      now = Date.parse(iso);
    },
    assemble: () => {
      const assembly = assembleStrakerBot(config(stateDir), logger, {
        portal: quietPortal(),
        senders,
        now: () => now,
      });
      open.push(assembly);
      return assembly;
    },
  };
}

/**
 * Give the report something to say: a won claim this fortnight. An event rather than held
 * work, because reconciliation against this portal (which lists nothing) could release a hold.
 */
function seedWork(bot: ReturnType<typeof assembleStrakerBot>, atIso: string): void {
  const at = Date.parse(atIso);
  bot.store.recordEvent({
    objId: 'offer-1',
    eventType: 'claim',
    outcome: 'won',
    effortWords: 1_200,
    deadlineMs: Date.parse('2026-09-22T17:00:00+07:00'),
    occurredAtMs: at,
  });
}

function dailyRows(stateDir: string): string[] {
  const db = new Database(join(stateDir, STRAKER_DB_FILENAME), { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT event_id FROM straker_outbox WHERE event_id LIKE 'daily:%' AND channel = 'offers'",
      )
      .all() as { event_id: string }[];
    return rows.map((r) => r.event_id);
  } finally {
    db.close();
  }
}

const reportsIn = (posted: readonly unknown[]): unknown[] =>
  posted.filter((p) => (p as { kind?: unknown }).kind === 'daily_report');

describe('Straker daily report — sent once per working day at 09:00 Bangkok', () => {
  it('stays quiet before 09:00, sends at 09:00, and does not send again that day', async () => {
    const h = harness();
    const bot = h.assemble();
    seedWork(bot, '2026-09-21T10:00:00+07:00');

    h.setNow('2026-09-22T08:59:00+07:00');
    await bot.cycle.runOnce();
    expect(dailyRows(h.stateDir)).toEqual([]);

    h.setNow('2026-09-22T09:00:00+07:00');
    await bot.cycle.runOnce();
    expect(dailyRows(h.stateDir)).toEqual(['daily:2026-09-22']);
    const reports = reportsIn(h.offersPosted);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: 'daily_report', date: '2026-09-22' });

    h.setNow('2026-09-22T13:00:00+07:00');
    await bot.cycle.runOnce();
    expect(reportsIn(h.offersPosted)).toHaveLength(1);
    expect(dailyRows(h.stateDir)).toHaveLength(1);
  });

  it('does not send on a weekend', async () => {
    const h = harness();
    const bot = h.assemble();
    seedWork(bot, '2026-09-25T10:00:00+07:00');

    h.setNow('2026-09-26T10:00:00+07:00'); // Saturday
    await bot.cycle.runOnce();

    expect(dailyRows(h.stateDir)).toEqual([]);
  });

  it('does not send on a Thai public holiday', async () => {
    const h = harness();
    const bot = h.assemble();
    seedWork(bot, '2026-10-12T10:00:00+07:00');

    h.setNow('2026-10-13T10:00:00+07:00'); // Tuesday — King Bhumibol Memorial Day
    await bot.cycle.runOnce();

    expect(dailyRows(h.stateDir)).toEqual([]);
  });

  it('does not send twice after a restart on the same state directory', async () => {
    const h = harness();
    const first = h.assemble();
    seedWork(first, '2026-09-21T10:00:00+07:00');
    h.setNow('2026-09-22T09:05:00+07:00');
    await first.cycle.runOnce();
    expect(reportsIn(h.offersPosted)).toHaveLength(1);
    first.close();

    const second = h.assemble();
    h.setNow('2026-09-22T09:30:00+07:00');
    await second.cycle.runOnce();

    expect(reportsIn(h.offersPosted)).toHaveLength(1);
    expect(dailyRows(h.stateDir)).toEqual(['daily:2026-09-22']);
    // Decided by the durable mark, not merely deduplicated by the queue: the second process
    // never built or queued a report at all.
    const queued = h.logs.filter(
      (l) => l.fields['module'] === 'dailyReport' && l.fields['outcome'] === 'enqueued',
    );
    expect(queued).toHaveLength(1);
  });

  it('sends again the next working day', async () => {
    const h = harness();
    const bot = h.assemble();
    seedWork(bot, '2026-09-21T10:00:00+07:00');

    h.setNow('2026-09-22T09:05:00+07:00');
    await bot.cycle.runOnce();
    h.setNow('2026-09-23T09:05:00+07:00');
    await bot.cycle.runOnce();

    expect(dailyRows(h.stateDir)).toEqual(['daily:2026-09-22', 'daily:2026-09-23']);
  });

  it('skips a day with nothing to say, logs that it did, and decides the day once', async () => {
    const h = harness();
    const bot = h.assemble();

    h.setNow('2026-09-22T09:05:00+07:00');
    await bot.cycle.runOnce();
    await bot.cycle.runOnce();

    expect(dailyRows(h.stateDir)).toEqual([]);
    const skipped = h.logs.filter(
      (l) =>
        l.fields['module'] === 'dailyReport' &&
        l.fields['action'] === 'daily_report' &&
        l.fields['outcome'] === 'skipped',
    );
    // Once, not once per ten-second turn until midnight.
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.fields['date']).toBe('2026-09-22');
  });
});

describe('createDailyReportStep — a broken report never takes the loop down', () => {
  const NOW = Date.parse('2026-09-22T09:05:00+07:00');

  function step(store: Parameters<typeof createDailyReportStep>[0]['store']) {
    const logs: Record<string, unknown>[] = [];
    const log = (fields: object): void => void logs.push(fields as Record<string, unknown>);
    const enqueued: string[] = [];
    const runner = createDailyReportStep({
      store,
      outbox: { enqueue: (id: string) => (enqueued.push(id), { enqueued: true }) } as never,
      logger: { info: log, warn: log, error: log },
      calendar: { hoursStartMin: 9 * 60, workdays: new Set([1, 2, 3, 4, 5]) },
      ceilings: { translation: 3_500, monolingual: 30_000 },
    });
    return { runner, logs, enqueued };
  }

  it('logs the fault, queues nothing, and leaves the day undecided so the next turn retries', () => {
    const flags: string[] = [];
    const { runner, logs, enqueued } = step({
      metaFlagSetAt: () => null,
      setMetaFlag: (key: string) => (flags.push(key), true),
      heldWork: () => {
        throw new Error('no such table: held_work');
      },
      listEvents: () => [],
      transaction: <T>(fn: () => T): T => fn(),
    });

    expect(() => runner.runIfDue(NOW)).not.toThrow();

    expect(enqueued).toEqual([]);
    expect(flags).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ module: 'dailyReport', action: 'daily_report', outcome: 'error' }),
    );
  });

  it('does not mark the day decided when the queue write fails inside the transaction', () => {
    // Rolled back together: a mark without a row would lose the report for the day.
    const flags: string[] = [];
    const store = {
      metaFlagSetAt: () => null,
      setMetaFlag: (key: string) => (flags.push(key), true),
      heldWork: () => [
        {
          objId: 'a',
          effortWords: 100,
          kind: 'translation' as const,
          deadlineMs: NOW + 3_600_000,
          heldSinceMs: NOW - 3_600_000,
          releasedAtMs: null,
        },
      ],
      listEvents: () => [],
      transaction: <T>(fn: () => T): T => fn(),
    };
    const logs: Record<string, unknown>[] = [];
    const log = (fields: object): void => void logs.push(fields as Record<string, unknown>);
    const runner = createDailyReportStep({
      store,
      outbox: {
        enqueue: () => {
          throw new Error('disk full');
        },
      },
      logger: { info: log, warn: log, error: log },
      calendar: { hoursStartMin: 9 * 60, workdays: new Set([1, 2, 3, 4, 5]) },
      ceilings: { translation: 3_500, monolingual: 30_000 },
    });

    expect(() => runner.runIfDue(NOW)).not.toThrow();
    expect(flags).toEqual([]);
    expect(logs.some((l) => l['outcome'] === 'error')).toBe(true);
  });
});
