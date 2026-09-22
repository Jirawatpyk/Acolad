/**
 * T066 — SC-008: killing, blocking or breaking the sign-in of the Straker side leaves the
 * XTM side unchanged in uptime, restart count, polling cadence and alert count.
 *
 * ## What this file establishes, and what it does not — read this before trusting it
 *
 * SC-008 names four quantities, and **two of them are facts about processes under PM2**
 * that no in-process test can observe. A test cannot watch a process not restart. So this
 * file does not claim to demonstrate SC-008 whole, and the tasks that finish the job are
 * V12 and V14 — restart each bot in turn on the host and compare PM2's uptime and restart
 * counters, against the seven-day XTM baseline RP-3 captures.
 *
 * **Establishes, by running real code:**
 *
 * 1. *The one seam that actually exists.* `src/runtime/xtmPollLoop.ts` imports
 *    `combinedTotalRows` from `src/straker/combinedSummary.ts` — a deliberate, recorded
 *    exception (plan §Scope decision, owner-approved 2026-09-16), and the only path by
 *    which a Straker fault can reach the live XTM bot at all. These tests break the Straker
 *    record in three ways underneath a **real `XtmPollLoop`** and require its cycle result,
 *    its liveness signals, its Sheet writes, its job rows and its outbox — alert rows
 *    included — to be byte-identical to a control run against a healthy record.
 * 2. *Nothing else is shared in process.* A whole assembled Straker bot runs a cycle beside
 *    a real, open XTM database and leaves that database and its directory untouched.
 * 3. *The lock is per-port and a refusal is contained.* A Straker bot starting, refusing and
 *    stopping leaves a separately held port bound and usable throughout, and its refusal
 *    surfaces as `SingleInstanceRefused` rather than as anything that escapes.
 * 4. *No second seam can be added silently.* Directory-wide import guards in both
 *    directions, pinning the two recorded exceptions by name.
 *
 * **Does NOT establish:**
 *
 * - Process uptime or restart count. Those are PM2's, and the test harness has neither.
 * - Polling cadence in wall-clock terms. What is compared here is the number of cycles
 *   completed and their outcomes, which is cadence's *content*, not its timing; a shared
 *   machine can still slow both bots down and nothing here would see it.
 * - The real port pair (XTM 47811, Straker 47812). The live XTM bot holds 47811 on this
 *   host, so binding it in a test would either fail or fight the running bot. That the two
 *   configured ports differ, and that Straker refuses to take XTM's, is asserted at the
 *   configuration level in `tests/unit/straker/config.test.ts`.
 * - Anything about the two bots in separate processes, which is how they really run. Every
 *   test here puts them in ONE process, which is strictly harder: shared module state,
 *   a shared event loop and an escaping throw are all possible here and impossible in
 *   production. Passing under the harder condition is worth something; it is not the same
 *   thing as having watched the real pair.
 * - The account and the request budget, which ARE shared (spec §Assumptions enumerates
 *   them deliberately) and are not isolation at all.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import type { AppConfig } from '../../../src/config/index.js';
import type { XtmJobSnapshot, XtmRawJob } from '../../../src/detection/types.js';
import type { LogoutKind } from '../../../src/portal/errors.js';
import type { XtmPortalClient } from '../../../src/portal/xtmClient.js';
import type { ChatSender, SendOutcome } from '../../../src/reporting/googleChat.js';
import type { SheetRow, SheetSender } from '../../../src/reporting/sheets.js';
import { openDatabase, type DB } from '../../../src/state/db.js';
import { XtmPollLoop } from '../../../src/runtime/xtmPollLoop.js';
import { loadStrakerBotConfig } from '../../../src/straker/config.js';
import type { StrakerSenders } from '../../../src/straker/dispatcher.js';
import {
  assembleStrakerBot,
  SingleInstanceRefused,
  startStrakerBot,
  type StrakerAssembly,
  type StrakerPortal,
} from '../../../src/straker/main.js';
import { openStrakerDatabase, StrakerStore } from '../../../src/straker/strakerStore.js';
import type { RawOffer } from '../../../src/straker/probe.js';
import { idleCycle, recordingPinger, silentLogger } from './testDoubles.js';

/** 10:00 Bangkok, Tuesday 15 September 2026 — a working day past the 09:00 report hour. */
const NOW_ISO = '2026-09-15T03:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);

const dirs: string[] = [];
const openDbs: DB[] = [];
const openAssemblies: StrakerAssembly[] = [];
const openServers: Server[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  while (openAssemblies.length > 0) {
    try {
      openAssemblies.pop()?.close();
    } catch {
      // Already closed by the test; closing twice is harmless.
    }
  }
  while (openDbs.length > 0) openDbs.pop()?.close();
  while (openServers.length > 0) {
    const server = openServers.pop();
    if (server !== undefined) await new Promise<void>((done) => server.close(() => done()));
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 1. The one seam: the live XTM bot's 09:00 report reads the Straker record
// ===========================================================================

/**
 * A snapshot of everything about an XTM cycle that SC-008 could plausibly move.
 *
 * Captured as one object so the comparison is "identical to the control" rather than a
 * list of individually chosen assertions — the point being that a Straker fault must move
 * *nothing*, and a hand-picked list is a list of the things someone thought of.
 */
interface XtmObservables {
  readonly cycleResults: boolean[];
  readonly aliveSignals: number;
  readonly failingSignals: number;
  readonly sheetRows: number;
  readonly jobRows: number;
  /** Every queued outgoing message, by channel — `chat` is where system alerts land. */
  readonly outboxByChannel: Record<string, number>;
  /** Whether the 09:00 report was produced at all. Its absence would be the loudest change. */
  readonly dailyReportEnqueued: boolean;
}

const xtmCfg = (over: Partial<AppConfig> = {}): AppConfig =>
  ({
    ACCEPT_ENABLED: false,
    ACCEPT_LANGUAGES: ['Malay (Malaysia)'],
    ACCEPT_MAX_WORDS: 0,
    ACCEPT_MAX_PER_CYCLE: 0,
    ACCEPT_MAX_WORDS_PER_DAY: 3500,
    activeMaxPerDay: 3500,
    ACCEPT_EFFORT_METRIC: 'words',
    ACCEPT_SCHEDULE_ENABLED: true,
    unit: { adj: 'word', noun: 'words' },
    OUTBOX_RETRY_CAP: 10,
    OUTBOX_DEAD_AFTER_HOURS: 6,
    LOGIN_MAX_RETRY: 3,
    LOGIN_LOCKOUT_MINUTES: 15,
    workdays: new Set([1, 2, 3, 4, 5]),
    hoursStartMin: 9 * 60,
    XTM_ACOLAD_OFFERS_URL: 'https://xtm.example.test/active',
    ...over,
  }) as AppConfig;

const xtmJob = (over: Partial<XtmRawJob> = {}): XtmRawJob => ({
  xtmTaskId: 'ID-1',
  projectName: 'P',
  fileName: 'a.docx',
  sourceLang: 'English (USA)',
  targetLang: 'Malay (Malaysia)',
  dueDate: '2026-09-17T17:00:00+07:00',
  dueRaw: '17/09/2026 17:00',
  words: 100,
  fileWwc: 90,
  step: 'PE 1',
  role: 'Corrector',
  acceptAvailable: true,
  ...over,
});

class StubXtmClient implements XtmPortalClient {
  snapshot: XtmJobSnapshot = {
    jobs: [xtmJob()],
    malformed: [],
    capturedAt: NOW_ISO,
    pollCycleId: 'c1',
    emptyListConfirmed: false,
  };
  ensureLoggedIn = vi.fn(async () => {});
  async fetchJobSnapshot(
    _id: string,
    _opts?: { decideRelogin?: (kind: LogoutKind) => boolean },
  ): Promise<XtmJobSnapshot> {
    return this.snapshot;
  }
  async acceptEligibleTasks(): Promise<[]> {
    return [];
  }
  captureAcceptMenu = vi.fn(async () => 'state/evidence/none');
  async readClosedKeys(): Promise<Set<string>> {
    return new Set();
  }
  async maybeRecycle(): Promise<void> {}
  async dispose(): Promise<void> {}
}

const okChat: ChatSender = {
  async send(): Promise<SendOutcome> {
    return 'ok';
  },
  async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
    return { outcome: 'ok', status: 200 };
  },
};

class CapturingSheet implements SheetSender {
  rows: SheetRow[] = [];
  async send(row: SheetRow): Promise<SendOutcome> {
    this.rows.push(row);
    return 'ok';
  }
  async ensureReady(): Promise<SendOutcome> {
    return 'ok';
  }
}

function countByChannel(db: DB): Record<string, number> {
  const rows = db
    .prepare('SELECT channel, COUNT(*) AS n FROM outbox GROUP BY channel ORDER BY channel')
    .all() as { channel: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.channel, r.n]));
}

/**
 * Run the real XTM loop for `cycles` turns with `STRAKER_STATE_DIR` pointing wherever the
 * caller says, and report everything observable about it.
 *
 * The Straker directory is supplied through the environment because that is how the loop
 * finds it: `xtmPollLoop.ts` calls `combinedTotalRows` without a `strakerStateDir`, so it
 * falls through to `STRAKER_STATE_DIR` and then to the documented default. Passing it any
 * other way here would be testing a call the bot does not make.
 */
async function runXtm(strakerStateDir: string, cycles = 2): Promise<XtmObservables> {
  vi.stubEnv('STRAKER_STATE_DIR', strakerStateDir);
  vi.stubEnv('STRAKER_MAX_WORDS_PER_DAY', '2000');
  vi.stubEnv('STRAKER_DTP_MAX_WORDS_PER_DAY', '30000');

  const stateDir = tempDir('xtm-isolation-');
  const db = openDatabase(stateDir, NOW_ISO).db;
  openDbs.push(db);
  // XTM holds work, so its 09:00 card goes out whatever state the Straker record is in.
  // Since FR-018 was amended (2026-09-22) a card with no XTM work is sent only when the
  // combined line is a warning — which a broken Straker record rightly produces and a healthy
  // one does not. Without XTM work the control would send nothing and every broken record
  // would send a card, so "identical to control" would compare a report against no report.
  db.prepare(
    `INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash,
                       project_name, file_name, due_date, words, lifecycle_status)
     VALUES ('held-xtm', 'held-xtm', 'visible', @at, @at, 'h', 'P', 'held.xlf',
             '2026-09-16T17:00:00+07:00', 300, 'accepted')`,
  ).run({ at: NOW_ISO });

  const pinger = recordingPinger();
  const sheet = new CapturingSheet();
  const clock = { nowMs: () => NOW_MS, nowIso: () => NOW_ISO };
  const loop = new XtmPollLoop(
    db,
    new StubXtmClient(),
    xtmCfg({ STATE_DIR: stateDir } as Partial<AppConfig>),
    { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    clock,
    { chatSender: okChat, teamChatSender: okChat, sheetSender: sheet, heartbeat: pinger },
  );

  const cycleResults: boolean[] = [];
  for (let i = 0; i < cycles; i += 1) cycleResults.push(await loop.runOnce());

  const daily = db
    .prepare("SELECT COUNT(*) AS n FROM outbox WHERE event_id LIKE 'daily:%'")
    .get() as { n: number };

  return {
    cycleResults,
    aliveSignals: pinger.pings.filter((p) => p === 'ok').length,
    failingSignals: pinger.pings.filter((p) => p === 'fail').length,
    sheetRows: sheet.rows.length,
    jobRows: (db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n,
    outboxByChannel: countByChannel(db),
    dailyReportEnqueued: daily.n > 0,
  };
}

/** The Straker record as it looks when the bot is running normally: a real, held job. */
function healthyStrakerRecord(): string {
  const dir = join(tempDir('straker-healthy-'), 'straker');
  mkdirSync(dir, { recursive: true });
  const opened = openStrakerDatabase(dir, NOW_MS);
  new StrakerStore(opened.db).hold({
    objId: 'offer-1',
    effortWords: 120,
    kind: 'translation',
    deadlineMs: Date.parse('2026-09-17T17:00:00+07:00'),
    heldSinceMs: NOW_MS,
  });
  opened.db.close();
  return dir;
}

describe('SC-008 — a broken Straker record cannot move the live XTM bot', () => {
  /**
   * This is the ONLY code path by which the Straker side reaches the XTM side, and it was
   * added on purpose after FR-018 turned out to be unsatisfiable without it: the combined
   * two-portal view has to appear in the 09:00 report, because that report is the only
   * daily summary anyone reads.
   *
   * `combinedTotalRows` promises never to throw, and `dailyReport.ts` is throw-safe at its
   * call site as well — belt and braces, because PR #14 fixed a bug in this very report that
   * took the whole XTM poll loop down. Two guarantees, and until now neither was tested from
   * the loop's side. What follows breaks the Straker record three ways and requires the XTM
   * cycle to come out identical each time.
   */
  it('produces the same cycle, the same signals and the same alerts as a healthy record does', async () => {
    const control = await runXtm(healthyStrakerRecord());

    // Guard the guard: a control that never produced a report would make every comparison
    // below vacuous, since a missing report is exactly what a Straker fault might cause.
    expect(control.dailyReportEnqueued).toBe(true);
    expect(control.cycleResults).toEqual([true, true]);
    expect(control.failingSignals).toBe(0);

    const missing = await runXtm(join(tmpdir(), 'straker-never-existed-at-all'));
    expect(missing).toEqual(control);

    const corruptDir = join(tempDir('straker-corrupt-'), 'straker');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'straker.db'), 'this is not a database');
    const corrupt = await runXtm(corruptDir);
    expect(corrupt).toEqual(control);

    // A directory that exists and holds no record at all — what the host looks like before
    // the Straker bot has ever run, which is the state at the moment of release.
    const empty = join(tempDir('straker-empty-'), 'straker');
    mkdirSync(empty, { recursive: true });
    expect(await runXtm(empty)).toEqual(control);
  });

  it('still says the Straker record was unreadable, rather than quietly dropping the line', async () => {
    // Identical-to-control is necessary and not sufficient: a report that silently omitted
    // the combined section would also be identical in every count above. What must not
    // happen is the reader being left to think the two portals summed to what XTM alone
    // committed.
    const stateDir = tempDir('xtm-isolation-text-');
    const db = openDatabase(stateDir, NOW_ISO).db;
    openDbs.push(db);
    vi.stubEnv('STRAKER_STATE_DIR', join(tmpdir(), 'straker-never-existed-at-all'));
    vi.stubEnv('STRAKER_MAX_WORDS_PER_DAY', '2000');
    vi.stubEnv('STRAKER_DTP_MAX_WORDS_PER_DAY', '30000');

    const loop = new XtmPollLoop(
      db,
      new StubXtmClient(),
      xtmCfg({ STATE_DIR: stateDir } as Partial<AppConfig>),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { nowMs: () => NOW_MS, nowIso: () => NOW_ISO },
      { chatSender: okChat, teamChatSender: okChat, sheetSender: new CapturingSheet() },
    );
    await loop.runOnce();

    const card = db
      .prepare("SELECT payload_json FROM outbox WHERE event_id LIKE 'daily:%'")
      .get() as { payload_json: string } | undefined;
    expect(card).toBeDefined();
    expect(card?.payload_json).toMatch(/Straker/);
    // **Both of the assertions above are satisfied by the per-portal row alone**
    // (`Straker: record unreadable — …`), so dropping the combined row entirely left this
    // green — which is precisely what this test was written to prevent. The row that must
    // be there is the one saying the two portals could NOT be summed; without it a reader
    // is left to think the total is XTM's figure.
    expect(card?.payload_json).toMatch(/Both portals/);
    expect(card?.payload_json).toMatch(/no combined total/i);
  });
});

// ===========================================================================
// 2. Nothing else is shared: a whole Straker cycle beside a live XTM database
// ===========================================================================

describe('SC-008 — a running Straker bot leaves the XTM record byte for byte as it was', () => {
  /**
   * The three existing bulkhead tests each drive ONE Straker module — the store, the
   * ledger, the outbox — past a real XTM database. What none of them covers is the
   * assembled bot: the reconciler, the dispatcher, the tracker, the transport hooks and the
   * quarantine path all running together, which is what actually executes on the host.
   */
  it('runs a full cycle — claim, record, reconcile, deliver — and touches nothing of XTM’s', async () => {
    const root = tempDir('both-bots-');
    const xtmDir = join(root, 'xtm');
    const strakerDir = join(root, 'straker');
    mkdirSync(xtmDir, { recursive: true });
    mkdirSync(strakerDir, { recursive: true });

    // A real XTM database, opened and migrated the way the live bot opens it, and left OPEN
    // for the whole Straker cycle — two SQLite handles alive in one process at once.
    const xtm = openDatabase(xtmDir, NOW_ISO).db;
    openDbs.push(xtm);
    xtm.prepare("INSERT INTO meta (key, value) VALUES ('isolation-marker', 'untouched')").run();
    const xtmFilesBefore = filesUnder(xtmDir);
    const xtmOutboxBefore = countByChannel(xtm);

    const offer = firstCapturedOffer();
    const claims: string[] = [];
    const portal: StrakerPortal = {
      client: {
        postJson: async (path: string) => {
          claims.push(/job-offers\/([^/]+)\/accept/.exec(path)?.[1] ?? '?');
          return {};
        },
      } as never,
      signIn: async () => ({ vendorId: 'vendor-1' }),
      listOpenOffers: async () => [offer],
      listAssignedWork: async () => [],
      listPurchaseOrders: async () => [],
    };

    const cfg = loadStrakerBotConfig({
      STRAKER_BASE_URL: 'https://vendr.straker.test',
      STRAKER_LOGIN_ID: 'user@example.test',
      STRAKER_PASSWORD: 'pw',
      STRAKER_MAX_WORDS_PER_DAY: '2000',
      STRAKER_DTP_MAX_WORDS_PER_DAY: '30000',
      STRAKER_SHEETS_ID: 'sheet-straker',
      STRAKER_CHAT_WEBHOOK_OFFERS: 'https://chat.example.test/offers',
      GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example.test/ops',
      STRAKER_HEALTHCHECKS_PING_URL: 'https://hc.example.test/straker',
      STRAKER_SINGLE_INSTANCE_PORT: '47906',
      STRAKER_STATE_DIR: strakerDir,
    });
    const accept = async (): Promise<{ ok: true }> => ({ ok: true });
    const senders: StrakerSenders = { offers: accept, tracking: accept, alerts: accept };
    const assembly = assembleStrakerBot(cfg, silentLogger(), {
      portal,
      senders,
      now: () => NOW_MS,
    });
    openAssemblies.push(assembly);

    await assembly.cycle.runOnce();

    // The Straker bot really did a full turn — otherwise "it touched nothing" would be
    // true of a bot that did nothing.
    expect(claims).toEqual([offer.obj_id]);
    expect(assembly.store.listEvents()).not.toEqual([]);

    // And the XTM side is exactly where it was: same files, same rows, same queue.
    expect(filesUnder(xtmDir)).toEqual(xtmFilesBefore);
    expect(countByChannel(xtm)).toEqual(xtmOutboxBefore);
    expect(xtm.prepare("SELECT value FROM meta WHERE key = 'isolation-marker'").get()).toEqual({
      value: 'untouched',
    });
    expect((xtm.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(0);
    // Everything new is under Straker's own directory, and there is something new — an
    // assertion that would otherwise pass against a bot that wrote nowhere at all.
    const appeared = filesUnder(root).filter((p) => !p.startsWith('xtm/'));
    expect(appeared).not.toEqual([]);
    expect(appeared.every((p) => p.startsWith('straker/'))).toBe(true);
  });
});

// ===========================================================================
// 3. The lock is per-port, and a Straker refusal is contained
// ===========================================================================

function hold(port: number): Promise<Server> {
  return new Promise((done, fail) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', fail);
      openServers.push(server);
      done(server);
    });
  });
}

function isBound(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(false)));
  });
}

describe('SC-008 — the Straker lock cannot reach a port that is not its own', () => {
  /**
   * The real pair is XTM 47811 and Straker 47812, and this test deliberately uses neither:
   * the live XTM bot holds 47811 on this host, so a test that bound it would either fail or
   * fight the running bot. The *configured* separation — Straker refusing to start on
   * 47811, and defaulting to 47812 — is asserted in `tests/unit/straker/config.test.ts`.
   *
   * What is left to establish, and what this does, is that the locking mechanism itself is
   * per-port: an occupied neighbour is neither taken nor disturbed, and a Straker bot that
   * cannot start fails in a way that stays inside the Straker bot.
   */
  const NEIGHBOUR = 47_907;
  const STRAKER = 47_908;

  function strakerCfgOn(port: number) {
    return loadStrakerBotConfig({
      STRAKER_BASE_URL: 'https://vendr.straker.test',
      STRAKER_LOGIN_ID: 'user@example.test',
      STRAKER_PASSWORD: 'pw',
      STRAKER_MAX_WORDS_PER_DAY: '2000',
      STRAKER_DTP_MAX_WORDS_PER_DAY: '30000',
      STRAKER_SHEETS_ID: 'sheet-straker',
      STRAKER_CHAT_WEBHOOK_OFFERS: 'https://chat.example.test/offers',
      GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example.test/ops',
      STRAKER_HEALTHCHECKS_PING_URL: 'https://hc.example.test/straker',
      STRAKER_SINGLE_INSTANCE_PORT: String(port),
      STRAKER_STATE_DIR: tempDir('straker-lock-'),
    });
  }

  it('starts, refuses a second instance, and stops — all without disturbing the neighbour', async () => {
    const neighbour = await hold(NEIGHBOUR);
    expect(await isBound(NEIGHBOUR)).toBe(true);

    const first = await startStrakerBot({
      cfg: strakerCfgOn(STRAKER),
      logger: silentLogger(),
      heartbeat: recordingPinger(),
      cycle: idleCycle(),
      lockRetryMs: 0,
    });
    expect(await isBound(NEIGHBOUR)).toBe(true);

    // The block: a second Straker instance is refused, and the refusal is a named error
    // rather than something that escapes as a bare EADDRINUSE or takes the process with it.
    const pinger = recordingPinger();
    await expect(
      startStrakerBot({
        cfg: strakerCfgOn(STRAKER),
        logger: silentLogger(),
        heartbeat: pinger,
        cycle: idleCycle(),
        lockRetryMs: 0,
      }),
    ).rejects.toBeInstanceOf(SingleInstanceRefused);
    // FR-026a: a bot that could not start says so on its own signal, because there is no
    // running loop left to say it from and nobody watches `pm2 status`.
    expect(pinger.pings).toEqual(['fail']);

    // The kill.
    await first.stop();

    // Through all of it the neighbour stayed bound and was never taken. `neighbour` is still
    // this test's server, not something the Straker bot inherited.
    expect(await isBound(NEIGHBOUR)).toBe(true);
    expect(neighbour.listening).toBe(true);
    // And Straker's own port really was released, so this is a lock that was held and let
    // go rather than one that was never taken.
    expect(await isBound(STRAKER)).toBe(false);
  });
});

// ===========================================================================
// 4. No second seam can be added silently
// ===========================================================================

const SRC = fileURLToPath(new URL('../../../src', import.meta.url));

/** Every `.ts` file under a source directory, as absolute forward-slashed paths. */
function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full.replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(at, entry.name), next);
      else out.push(next);
    }
  };
  walk(root, '');
  return out.sort();
}

interface ImportSpecifier {
  /** The importing file, forward-slashed. */
  readonly from: string;
  /** Resolved to a real path for a relative specifier; left alone for a package. */
  readonly to: string;
  /** `import type` / `export type` — erased at compile time, so it can open nothing. */
  readonly typeOnly: boolean;
}

/**
 * Every import in `file`, with relative specifiers resolved to real paths.
 *
 * Resolving beats matching the source text, which is what a text-only guard does: it looks
 * for `from '../state/` and so says nothing about `from '../../src/state/db.js'` — the same
 * import, a different spelling. A guard a spelling can walk past is worse than no guard,
 * because it reports green while checking nothing. (The same reasoning, and the same
 * regex, as `tests/unit/straker/ledger.test.ts`; this is the directory-wide version.)
 */
function importsOf(file: string): ImportSpecifier[] {
  const source = readFileSync(file, 'utf8');

  // **Three spellings, not one.** This guard's own docstring says a guard a spelling can
  // walk past is worse than no guard, because it reports green while checking nothing —
  // and it matched only `… from '…'`. Both `await import('…')` and a bare side-effect
  // `import '…';` went straight through it, which was demonstrated by adding a dynamic
  // import of `state/db.js` to a Straker module and watching this suite stay green.
  const forms: { readonly re: RegExp; readonly spec: number; readonly type?: number }[] = [
    {
      re: /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;'"]*?from\s*['"]([^'"]+)['"]/g,
      spec: 2,
      type: 1,
    },
    // Dynamic. Never type-only: it is a real runtime load, which is the whole concern.
    { re: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, spec: 1 },
    // Side-effect only — no bindings, no `from`. Runs the module for what it does.
    { re: /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g, spec: 1 },
  ];

  const found: ImportSpecifier[] = [];
  for (const form of forms) {
    for (const match of source.matchAll(form.re)) {
      const specifier = match[form.spec] ?? '';
      found.push({
        from: file,
        to: specifier.startsWith('.')
          ? resolve(dirname(file), specifier).replace(/\\/g, '/')
          : specifier,
        typeOnly: form.type !== undefined && match[form.type] !== undefined,
      });
    }
  }
  return found;
}

function importsUnder(dir: string): ImportSpecifier[] {
  return sourcesUnder(dir).flatMap(importsOf);
}

/** `src/…/x.js` → the area name, so a rule can be written about a directory. */
function areaOf(path: string): string | null {
  return /\/src\/([^/]+)\//.exec(path)?.[1] ?? null;
}

describe('SC-008 — the bulkhead, across every file rather than the four that have a guard', () => {
  /**
   * The three existing import guards each protect their own module, which is what let
   * `outcomePolicy.ts` acquire an import of the XTM state layer without anything noticing.
   * These two are directory-wide, in both directions, and they pin the recorded exceptions
   * **by name** — which is the part that matters: an exception nobody can add silently is a
   * different thing from an exception nobody has added yet.
   */
  it('is reading real sources, so an empty walk cannot pass as a clean one', () => {
    // Guard the guard. A file walk that found nothing, or an import regex that matched
    // nothing, would make every assertion below vacuously true.
    expect(sourcesUnder(join(SRC, 'straker')).length).toBeGreaterThan(20);
    expect(importsUnder(join(SRC, 'straker')).length).toBeGreaterThan(50);
    expect(
      importsUnder(join(SRC, 'straker')).some((i) => i.to.endsWith('/src/schedule/effort.js')),
    ).toBe(true);
  });

  it('lets no file under src/straker reach the XTM state or configuration layer at runtime', () => {
    const reaching = importsUnder(join(SRC, 'straker')).filter((i) =>
      /\/src\/(state|config)\//.test(i.to),
    );

    // A `import type` erases at compile time: it cannot open a database, cannot start a
    // transaction and cannot exist at runtime, so it is not a bulkhead breach. A value
    // import of the same module is one. The distinction is the rule; the list below is the
    // exhaustive record of the type-only imports that exist today, so a second one has to
    // be added here deliberately rather than arriving with a pull request.
    expect(reaching.filter((i) => !i.typeOnly)).toEqual([]);
    expect(
      reaching.map((i) => `${i.from.replace(/.*\/src\//, 'src/')} -> ${areaOf(i.to)}`),
    ).toEqual(['src/straker/outcomePolicy.ts -> state']);
  });

  it('lets exactly one XTM module reach into src/straker, and it is the recorded one', () => {
    // FR-018's combined view is why this exception exists (plan §Scope decision, approved
    // 2026-09-16): the daily summary anyone reads is the XTM bot's 09:00 report, so the
    // two-portal figure has to appear there. It is the seam the first describe block in
    // this file exercises, and a SECOND one would be a second way for a Straker fault to
    // reach a bot that has run unattended since June.
    const xtmAreas = [
      'detection',
      'state',
      'portal',
      'reporting',
      'schedule',
      'monitoring',
      'runtime',
      'config',
    ];
    const reaching = xtmAreas
      .flatMap((area) => importsUnder(join(SRC, area)))
      .filter((i) => i.to.includes('/src/straker/'));

    expect(
      reaching.map(
        (i) => `${i.from.replace(/.*\/src\//, 'src/')} -> ${i.to.replace(/.*\/src\//, 'src/')}`,
      ),
    ).toEqual(['src/runtime/xtmPollLoop.ts -> src/straker/combinedSummary.js']);
  });

  it('keeps src/shared belonging to neither bot, which is what makes it shareable', () => {
    // The other recorded exception (plan §Scope decision, 2026-09-15): three pieces both
    // bots now run on. It is only safe while it depends on neither of them — a `shared`
    // module that imported `src/state/` would put the XTM bot's schema behind Straker's
    // outbox, and one that imported `src/straker/` would put Straker in the live bot's
    // logger.
    const reaching = importsUnder(join(SRC, 'shared')).filter((i) =>
      /\/src\/(straker|state|config|runtime|portal|reporting|detection|monitoring)\//.test(i.to),
    );

    expect(reaching).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const OFFERS_DIR = join(process.cwd(), 'fixtures', 'straker', 'offers');

/** One real captured payload, so the Straker cycle above runs on what the portal sends. */
function firstCapturedOffer(): RawOffer & Record<string, unknown> {
  const files = readdirSync(OFFERS_DIR).filter((f) => f.endsWith('.json'));
  const first = files[0];
  if (first === undefined) throw new Error('no captured Straker offers to run the bot on');
  return JSON.parse(readFileSync(join(OFFERS_DIR, first), 'utf8')) as RawOffer &
    Record<string, unknown>;
}

// ===========================================================================================
// T077 / FR-030 (DC-4) — transport lives in ONE file, and now something enforces that
// ===========================================================================================

/**
 * These rules ask the TypeScript **type checker** what a name binds to. Two earlier cuts did
 * not, and both were taken apart by review, which is worth recording because the failures are
 * the interesting part of this guard.
 *
 * *Regex.* A stripper removed comments and string literals before matching, and was
 * desynchronised by apostrophes in prose — "a portal's daily ceiling" in a template literal is
 * enough, and a mis-paired quote swallows real code to the next one. That left **114** measured
 * places in `src/straker` where a genuine `fetch(url)` compiled, ran, and the guard stayed
 * green. The comment defending it claimed a crude stripper "can only make this guard stricter,
 * never laxer", which is backwards: offenders are found by MATCHING text, so removing more text
 * finds fewer of them.
 *
 * *Syntax.* Matching identifiers named `fetch` on the AST fixed the stripping but decided
 * membership by spelling, and spelling is not what a binding is. It missed `const g =
 * globalThis; g.fetch(u)` and `globalThis['fetch'](u)`, and — worse, because it fails the build
 * on correct code — it reported `typeof globalThis.fetch`, `interface P { fetch(u): … }`, a
 * parameter named `fetch` and `const fetch = 1` as uses of the global.
 *
 * *Semantics.* The checker resolves each occurrence to a symbol and asks where that symbol was
 * declared. A reference to the global resolves into TypeScript's own `lib.*.d.ts`; a local
 * binding, a parameter, or a member of somebody's interface does not. All seven cases above
 * come out right, and they do so for the reason that makes them right rather than by a pattern
 * that happens to cover them.
 */
let cachedProgram: ts.Program | null = null;

/**
 * Compiler options for the guard's programs — deliberately NOT the project's tsconfig.
 *
 * The full options took 8 s locally and **81 s on CI**, where the test timed out at 60 s. The
 * cost was `types`: unset, it pulls in every package under `@types`, and `googleapis` alone
 * dominates. All this guard needs is the ambient platform globals, so `types: ['node']` with a
 * minimal `lib` resolves `fetch` identically in about 450 ms — the same answer, eighteen times
 * faster.
 *
 * What keeps the shortcut honest is the positive control below: if this set ever stopped
 * resolving `fetch` the way the real build does, the rule that says `httpClient.ts` must
 * contain a use of the global would fail immediately. That is precisely how the earlier
 * `lib.*.d.ts` mistake was caught.
 */
const GUARD_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  lib: ['lib.es2022.d.ts'],
  types: ['node'],
  skipLibCheck: true,
  noEmit: true,
};

function strakerProgram(): ts.Program {
  // Built once for the whole block: the cost is in creating it, not in querying it.
  cachedProgram ??= ts.createProgram(sourcesUnder(join(SRC, 'straker')), GUARD_OPTIONS);
  return cachedProgram;
}

/**
 * True when every declaration of a symbol is an ambient one from outside `src/` — i.e. the
 * name belongs to the platform rather than to this codebase.
 *
 * Matching `lib.*.d.ts` alone was the obvious rule and it was wrong here: this project sets
 * `lib: ["lib.es2022.d.ts"]` with no DOM, so `fetch` is declared by
 * `@types/node/web-globals/fetch.d.ts`. The positive control caught that immediately — it
 * found zero uses of the global in the one file that certainly uses it, which is exactly the
 * job a positive control exists to do.
 */
/**
 * This project's own `src/`, normalised. `!file.includes('/src/')` was the first spelling and it
 * matches any published `src` segment too — `node_modules/googleapis/build/src/*.d.ts` is a real
 * example in this tree. Fail-open and unreachable for `fetch`, but the intent is "outside THIS
 * project", so it says that.
 */
const PROJECT_SRC = SRC.replace(/\\/g, '/') + '/';

function isPlatformGlobal(symbol: ts.Symbol | undefined): boolean {
  const declarations = symbol?.declarations ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((d) => {
      const file = d.getSourceFile().fileName.replace(/\\/g, '/');
      return file.endsWith('.d.ts') && !file.startsWith(PROJECT_SRC);
    })
  );
}

/**
 * Every reference to the **global** `fetch` in a value position, resolved rather than matched.
 *
 * Type positions are excluded for the reason R11 excludes `import type`: an annotation erases
 * at compile time, so it cannot open a connection, spend the request budget, or exist at
 * runtime. The form matters too, because `httpClient.ts` does not call `fetch(...)` at all — it
 * writes `options.fetchImpl ?? fetch`, taking the global as a fallback for an injected port, so
 * a detector looking only for call sites would have found nothing anywhere and passed happily
 * over a codebase in which every file did the same.
 */
function globalFetchUsesIn(sourceFile: ts.SourceFile, checker: ts.TypeChecker): string[] {
  const found: string[] = [];

  /**
   * `const { fetch } = globalThis` — the shorthand destructure.
   *
   * A review found this walking past the rule while the renamed form `{ fetch: f }` was caught,
   * and the asymmetry is instructive: in the renamed form the identifier `fetch` IS the property
   * name, so it resolves to the global. In the shorthand it is the *binding*, and resolves to
   * the new local — declared in a `.ts` under `src/`, so not a platform symbol. The later
   * `fetch(u)` then resolves to that local too, and nothing in the file looks global at all.
   *
   * So the property has to be looked up on the type being destructured, rather than on the name.
   */
  const shorthandTakesTheGlobal = (node: ts.Identifier): boolean => {
    const element = node.parent;
    if (
      element === undefined ||
      !ts.isBindingElement(element) ||
      element.name !== node ||
      element.propertyName !== undefined
    ) {
      return false;
    }
    const declaration = element.parent.parent;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) {
      return false;
    }
    const source = checker.getTypeAtLocation(declaration.initializer);
    return isPlatformGlobal(source.getProperty('fetch'));
  };

  const visit = (node: ts.Node): void => {
    const named =
      (ts.isIdentifier(node) && node.text === 'fetch') ||
      // `globalThis['fetch']` — the name is a string, not an identifier.
      (ts.isStringLiteral(node) &&
        node.text === 'fetch' &&
        node.parent !== undefined &&
        ts.isElementAccessExpression(node.parent));
    if (named) {
      const inTypePosition =
        ts.findAncestor(node, (a) => ts.isTypeQueryNode(a) || ts.isTypeNode(a)) !== undefined;
      // `typeof fetch === 'function'` — the RUNTIME operator, not the type query. It reads a
      // binding without calling it, so like a type annotation it cannot open a connection or
      // spend the request budget. Excluded deliberately, and recorded here because an earlier
      // cut excluded it, the rewrite dropped the exclusion silently, and a review noticed.
      // A bare `fetch` elsewhere in the same expression is still caught on its own.
      const isFeatureDetect = node.parent !== undefined && ts.isTypeOfExpression(node.parent);
      if (inTypePosition || isFeatureDetect) {
        ts.forEachChild(node, visit);
        return;
      }
      if (isPlatformGlobal(checker.getSymbolAtLocation(node))) {
        found.push(node.getText());
      } else if (ts.isIdentifier(node) && shorthandTakesTheGlobal(node)) {
        found.push('{ fetch }');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Every module specifier a file imports, in all the spellings that reach the runtime, each
 * marked with whether it is **type-only**.
 *
 * The flag is carried rather than dropped because the two rules below need different things.
 * The package allowlist counts every specifier — a dependency is a dependency. The area pin
 * counts only VALUE edges, since `import type` erases at compile time and cannot reach code;
 * R11's one recorded exception (`outcomePolicy.ts -> state`) is exactly such an edge, and a
 * walk that ignored the flag would report it as a bulkhead breach.
 */
interface ModuleEdge {
  readonly spec: string;
  readonly typeOnly: boolean;
}

function moduleSpecifiersIn(file: string, source: string): ModuleEdge[] {
  const found: ModuleEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push({
        spec: node.moduleSpecifier.text,
        typeOnly: node.importClause?.isTypeOnly === true,
      });
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push({ spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const dynamic =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require');
      const first = node.arguments[0];
      // A dynamic import is always a runtime load — that is the whole concern.
      if (dynamic && first !== undefined && ts.isStringLiteral(first)) {
        found.push({ spec: first.text, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true));
  return found;
}

/**
 * The complete set of packages `src/straker` and `src/shared` may depend on — an ALLOWLIST.
 *
 * A denylist of known HTTP clients was the first attempt and it is the wrong shape: it missed
 * `import https from 'https'` (valid, idiomatic, and nothing in the lint config requires the
 * `node:` prefix), `node:http2`, `node:net`, and every client nobody thought to name. An
 * allowlist inverts the burden — a new dependency fails here until someone adds it deliberately.
 */
const ALLOWED_PACKAGES = new Set([
  'better-sqlite3',
  'dotenv',
  'node:fs',
  'node:path',
  'zod',
  // Reaches the network, and allowed on purpose: DC-4 is about the Straker PORTAL transport —
  // everything between a claim decision and the wire. The Sheets client is a reporting
  // destination on the delivery path, governed by the outbox rather than by FR-019's pacing.
  'googleapis',
  // `src/shared` is on this list too, so its dependencies belong here.
  'pino',
  'pino-roll',
]);

/**
 * The first-party areas `src/straker` reaches by VALUE, pinned by name.
 *
 * A relative import is not a package, so the allowlist above cannot see an edge into another
 * area. This does not *close* that hole — two pinned areas already contain live transport
 * (`reporting/googleChat.ts` and `monitoring/heartbeat.ts` both call the global `fetch`), and
 * `src/straker` value-imports `reporting`. What it does is make a NEW edge deliberate. Walking the whole transitive closure was considered and rejected — it reaches nine
 * areas and would fail this test whenever any unrelated part of the XTM bot gained a dependency.
 * Pinning the boundary instead means a NEW edge has to be added here deliberately, which is the
 * one that matters: `src/portal/` would bring Playwright, an HTTP-capable stack, and would have
 * to be argued for on this line first.
 */
const STRAKER_VALUE_AREAS = ['monitoring', 'reporting', 'runtime', 'schedule', 'shared'];

describe('FR-030 (DC-4) — everything between the decision and the wire lives in httpClient.ts', () => {
  /**
   * The invariant held when this guard was written; nothing enforced it. Its sibling R11 has had
   * a walking test since T066, and that asymmetry is what made this worth closing. The hazard is
   * named in `httpClient.ts` itself: a *racing* read added through `getJson` silently joins the
   * `deferrable` class and is shed below 120 remaining (FR-019), so the hot path loses its
   * budget priority with nothing failing and nothing logged.
   */
  const TRANSPORT_FILE = 'src/straker/httpClient.ts';
  const rel = (p: string): string => p.replace(/.*\/src\//, 'src/');
  const read = (f: string): string => readFileSync(f, 'utf8');

  /**
   * Resolve a batch of snippets through the same checker the rules use.
   *
   * One program for all of them, not one each: creating a program is what costs — nine
   * separate ones took four seconds, a single multi-file one takes under half of that in
   * total. Querying it is free by comparison.
   */
  function usesInSnippets(snippets: Readonly<Record<string, string>>): Record<string, string[]> {
    const names = Object.keys(snippets).map((k) => `${k}.ts`);
    const host = ts.createCompilerHost({});
    const original = host.getSourceFile.bind(host);
    const sourceOf = (name: string): string | undefined =>
      snippets[name.replace(/\.ts$/, '').replace(/^.*\//, '')];
    host.getSourceFile = (name, lang, ...rest): ts.SourceFile | undefined => {
      const src = sourceOf(name);
      return src === undefined
        ? original(name, lang, ...rest)
        : ts.createSourceFile(name, src, lang, true);
    };
    host.fileExists = (name): boolean => sourceOf(name) !== undefined || ts.sys.fileExists(name);
    host.readFile = (name): string | undefined => sourceOf(name) ?? ts.sys.readFile(name);

    const program = ts.createProgram(names, GUARD_OPTIONS, host);
    const checker = program.getTypeChecker();
    const out: Record<string, string[]> = {};
    for (const key of Object.keys(snippets)) {
      const sf = program.getSourceFile(`${key}.ts`);
      out[key] = sf === undefined ? ['<snippet did not parse>'] : globalFetchUsesIn(sf, checker);
    }
    return out;
  }

  it('resolves bindings rather than matching names, so neither a bypass nor a false alarm gets through', () => {
    // Guard the guard, and every case here is one an earlier cut of this rule got WRONG — the
    // first four were walked straight past, the next four failed the build on correct code, and
    // the last two are what the regex version could not survive.
    expect(sourcesUnder(join(SRC, 'straker')).length).toBeGreaterThan(20);

    const got = usesInSnippets({
      fallback: 'export const d = (o: { f?: typeof fetch }) => o.f ?? fetch;',
      direct: 'export const r = async (u: string) => fetch(u);',
      alias: 'const g = globalThis; export const r = async (u: string) => g.fetch(u);',
      elementAccess: "export const r = async () => globalThis['fetch']('u');",
      typeOfGlobal: 'export interface D { readonly fetchImpl: typeof globalThis.fetch }',
      interfaceMember: 'export interface P { fetch(u: string): Promise<string> }',
      parameter: 'export function make(fetch: number) { return fetch; }',
      localConst: 'const fetch = 1; export default fetch;',
      stringLiteral: "export const x = { action: 'fetch' };",
      apostropheInProse: "// a portal's ceiling\nexport const y = 1;",
      // Found by a review AFTER the checker rewrite: the renamed form was caught and the
      // shorthand was not, because in the shorthand `fetch` is the BINDING, not the property.
      shorthandDestructure:
        'const { fetch } = globalThis; export const r = (u: string) => fetch(u);',
      renamedDestructure: 'const { fetch: f } = globalThis; export const r = (u: string) => f(u);',
      // And the exclusion the rewrite dropped by accident.
      featureDetect: "export const ok = typeof fetch === 'function';",
    });

    // Uses of the global.
    expect(got['fallback']).toEqual(['fetch']);
    expect(got['direct']).toEqual(['fetch']);
    expect(got['alias']).toEqual(['fetch']);
    expect(got['elementAccess']).toEqual(["'fetch'"]);
    // NOT uses of the global — a rule that fails the build on these is worse than no rule,
    // because the idiom it rejects is the one the transport port is meant to be written in.
    expect(got['typeOfGlobal']).toEqual([]);
    expect(got['interfaceMember']).toEqual([]);
    expect(got['parameter']).toEqual([]);
    expect(got['localConst']).toEqual([]);
    expect(got['stringLiteral']).toEqual([]);
    expect(got['apostropheInProse']).toEqual([]);
    expect(got['shorthandDestructure']).toEqual(['{ fetch }']);
    expect(got['renamedDestructure']).toEqual(['fetch']);
    // A feature detect reads the binding without calling it — it can no more spend the request
    // budget than a type annotation can, which is the line this rule actually draws.
    expect(got['featureDetect']).toEqual([]);
  });

  it('finds the transport where DC-4 says it is, which proves the rule is not passing by accident', () => {
    // If httpClient.ts ever stopped matching, every rule below would pass on an empty set and
    // DC-4 would read as satisfied by a codebase that issues no requests at all.
    const program = strakerProgram();
    const sf = program.getSourceFile(join(SRC, 'straker/httpClient.ts'));
    expect(sf).toBeDefined();
    expect(globalFetchUsesIn(sf as ts.SourceFile, program.getTypeChecker()).length).toBeGreaterThan(
      0,
    );
  });

  it('lets no file under src/straker reach the global fetch except httpClient.ts', () => {
    const program = strakerProgram();
    const checker = program.getTypeChecker();
    const offenders = program
      .getSourceFiles()
      .filter((sf) => sf.fileName.replace(/\\/g, '/').includes('/src/straker/'))
      .filter((sf) => rel(sf.fileName.replace(/\\/g, '/')) !== TRANSPORT_FILE)
      .flatMap((sf) =>
        globalFetchUsesIn(sf, checker).map(
          (how) => `${rel(sf.fileName.replace(/\\/g, '/'))} -> ${how}`,
        ),
      );

    expect(offenders).toEqual([]);
  });

  it('lets src/straker and src/shared depend only on the packages they are recorded as using', () => {
    // A second HTTP client would obey none of FR-019's pacing, and the budget it spent would be
    // invisible to the one that does — so a new package has to be argued for here first.
    const offenders = [...sourcesUnder(join(SRC, 'straker')), ...sourcesUnder(join(SRC, 'shared'))]
      .flatMap((f) =>
        moduleSpecifiersIn(f, read(f))
          .map((edge) => edge.spec)
          .filter((spec) => !spec.startsWith('.') && !ALLOWED_PACKAGES.has(spec))
          .map((spec) => `${rel(f)} -> ${spec}`),
      )
      .sort();

    expect(offenders).toEqual([]);
  });

  it('pins which first-party areas src/straker reaches by value, so a new edge is deliberate', () => {
    // The package allowlist cannot see a relative import, so an HTTP client reached THROUGH
    // another area would pass it. This is the rule that would catch that: `src/portal/` carries
    // Playwright, and adding an edge to it has to be argued for on this line before it compiles.
    // Uses the SAME parser as the package rule above. An earlier cut walked only
    // `ts.isImportDeclaration`, so `export { x } from '../portal/y.js'`, `await import(...)`
    // and `require(...)` — all value edges — were invisible to it, twenty lines below a helper
    // that already handled all three.
    const areas = new Set<string>();
    for (const file of sourcesUnder(join(SRC, 'straker'))) {
      for (const { spec, typeOnly } of moduleSpecifiersIn(file, read(file))) {
        // Type-only edges erase; R11 permits exactly one and it is recorded above.
        if (typeOnly || !spec.startsWith('.')) continue;
        const resolved = resolve(dirname(file), spec).replace(/\\/g, '/');
        if (!resolved.startsWith(PROJECT_SRC)) continue;
        const rest = resolved.slice(PROJECT_SRC.length);
        // A file directly under `src/` (`src/clock.ts`) belongs to no area. Counting it as one
        // rather than skipping it means such an edge cannot go silently uncounted, which the
        // previous `/src/([^/]+)/` match would have done.
        const area = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : 'src (root)';
        if (area !== 'straker') areas.add(area);
      }
    }

    expect([...areas].sort()).toEqual(STRAKER_VALUE_AREAS);
  });
});
