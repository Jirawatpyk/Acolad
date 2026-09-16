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
 *    `combinedReportRows` from `src/straker/combinedSummary.ts` — a deliberate, recorded
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
 * finds it: `xtmPollLoop.ts` calls `combinedReportRows` without a `strakerStateDir`, so it
 * falls through to `STRAKER_STATE_DIR` and then to the documented default. Passing it any
 * other way here would be testing a call the bot does not make.
 */
async function runXtm(strakerStateDir: string, cycles = 2): Promise<XtmObservables> {
  vi.stubEnv('STRAKER_STATE_DIR', strakerStateDir);
  vi.stubEnv('STRAKER_MAX_WORDS_PER_DAY', '2000');

  const stateDir = tempDir('xtm-isolation-');
  const db = openDatabase(stateDir, NOW_ISO).db;
  openDbs.push(db);

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
   * `combinedReportRows` promises never to throw, and `dailyReport.ts` is throw-safe at its
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
          claims.push(/job-offers\/([^/]+)\/claim/.exec(path)?.[1] ?? '?');
          return {};
        },
      } as never,
      signIn: async () => ({ vendorId: 'vendor-1' }),
      listOpenOffers: async () => [offer],
      listAssignedWork: async () => [],
    };

    const cfg = loadStrakerBotConfig({
      STRAKER_BASE_URL: 'https://vendr.straker.test',
      STRAKER_LOGIN_ID: 'user@example.test',
      STRAKER_PASSWORD: 'pw',
      STRAKER_MAX_WORDS_PER_DAY: '2000',
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
 * Strip comments before looking for anything.
 *
 * The R11 guard above gets away without this because import syntax is distinctive enough
 * that prose cannot imitate it. A bare `fetch` is not: `claim.ts`, `main.ts` and
 * `pollCycle.ts` all use the word in their own comments — "a detail fetch or a file
 * listing", "fetch → diff → gate → act" — and a guard that counted those would fail on
 * three files that issue no request at all, then get "fixed" by weakening it. That is how a
 * guard stops guarding.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * References to the global `fetch` in a **value** position.
 *
 * `typeof fetch` is excluded for precisely the reason `import type` is excluded from the
 * R11 rule: a type annotation erases at compile time, so it cannot open a connection, spend
 * the request budget, or exist at runtime. A value reference to the same global can do all
 * three — and the form matters, because `httpClient.ts` does not call `fetch(...)` at all.
 * It writes `options.fetchImpl ?? fetch`, taking the global as a fallback for an injected
 * port, so a detector looking for a call site would have found nothing and passed happily
 * over a codebase where every file did the same.
 *
 * `.fetch(` is excluded too: a method on an injected port is the DI seam, not the wire.
 */
function globalFetchUsesIn(source: string): string[] {
  // String literals are stripped as well as comments, and that is not belt-and-braces:
  // `pollCycle.ts` logs `action: 'fetch'` as the name of a loop step. A detector that
  // counted it would report the poll cycle as touching the wire, and the obvious "fix"
  // would have been to exclude pollCycle.ts — quietly exempting the file the rule most
  // needs to cover.
  // Deliberately simple literal matching (no escaped-quote handling): these sources contain
  // no string with an embedded quote near the word `fetch`, and a crude stripper that errs
  // toward removing MORE text can only make this guard stricter, never laxer.
  const code = withoutComments(source)
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``');
  return [...code.matchAll(/(?<![.\w])(typeof\s+)?fetch(?![\w])/g)]
    .filter((m) => m[1] === undefined)
    .map(() => 'fetch');
}

/** Transport libraries: importing one outside the one file is the same breach as calling one. */
function transportImportsIn(source: string): string[] {
  const re = /from\s+['"](node:https?|undici|axios|got|node-fetch)['"]/g;
  return [...withoutComments(source).matchAll(re)].map((m) => m[1] ?? '');
}

describe('FR-030 (DC-4) — everything between the decision and the wire lives in httpClient.ts', () => {
  /**
   * The invariant held when this guard was written; nothing enforced it. Its sibling R11 has
   * had a walking test since T066, and that asymmetry is what made this worth closing. The
   * hazard is named in `httpClient.ts` itself: adding a *racing* read through `getJson`
   * silently joins the `deferrable` class and is shed below 120 remaining (FR-019), so the
   * hot path loses its budget priority with nothing failing and nothing logged.
   *
   * DC-4's payoff is concrete rather than tidy — a future third portal of the same family is
   * meant to start by copying one file.
   */
  const TRANSPORT_FILE = 'src/straker/httpClient.ts';
  const rel = (p: string): string => p.replace(/.*\/src\//, 'src/');

  it('is reading real sources and the detector actually detects, so a clean pass means something', () => {
    // Guard the guard. A broken walk or a broken regex would make every rule below vacuously
    // true, which is the failure a guard is least able to report about itself.
    expect(sourcesUnder(join(SRC, 'straker')).length).toBeGreaterThan(20);

    expect(globalFetchUsesIn('const doFetch = options.fetchImpl ?? fetch;')).toEqual(['fetch']);
    expect(globalFetchUsesIn('const r = await fetch(url);')).toEqual(['fetch']);
    expect(globalFetchUsesIn('readonly fetchImpl?: typeof fetch;')).toEqual([]);
    expect(globalFetchUsesIn('await this.client.fetch(url);')).toEqual([]);
    expect(globalFetchUsesIn('// fetch -> diff -> gate -> act')).toEqual([]);
    // The case that actually caught this detector out, kept as a regression.
    expect(globalFetchUsesIn("logger.info({ action: 'fetch' });")).toEqual([]);
    expect(transportImportsIn("import got from 'got';")).toEqual(['got']);
  });

  it('finds the transport where DC-4 says it is, which proves the rule is not passing by accident', () => {
    // If httpClient.ts ever stopped matching, every rule below would pass on an empty set and
    // DC-4 would read as satisfied by a codebase that issues no requests at all.
    expect(
      globalFetchUsesIn(readFileSync(join(SRC, 'straker/httpClient.ts'), 'utf8')).length,
    ).toBeGreaterThan(0);
  });

  it('lets no file under src/straker reach the global fetch except httpClient.ts', () => {
    const offenders = sourcesUnder(join(SRC, 'straker'))
      .filter((f) => rel(f) !== TRANSPORT_FILE)
      .flatMap((f) => globalFetchUsesIn(readFileSync(f, 'utf8')).map(() => rel(f)));

    expect(offenders).toEqual([]);
  });

  it('pins the one type-only reference by name, so a second cannot arrive unnoticed', () => {
    // `main.ts` types its injectable port as `typeof fetch` so a test can hand the assembly a
    // fake. That erases at compile time and is not a breach — but recording it by name is
    // what makes it an exception somebody added deliberately rather than one nobody noticed,
    // which is the same reason R11 pins `outcomePolicy.ts -> state`.
    const typeOnly = sourcesUnder(join(SRC, 'straker'))
      .filter((f) => rel(f) !== TRANSPORT_FILE)
      .filter((f) =>
        /(?<![.\w])typeof\s+fetch(?![\w])/.test(withoutComments(readFileSync(f, 'utf8'))),
      )
      .map(rel);

    expect(typeOnly).toEqual(['src/straker/main.ts']);
  });

  it('lets no file under src/straker import a transport library except httpClient.ts', () => {
    // The other half of "everything between the decision and the wire". A second HTTP client
    // would obey none of FR-019's pacing, and the budget it spent would be invisible to the
    // one that does.
    const offenders = sourcesUnder(join(SRC, 'straker'))
      .filter((f) => rel(f) !== TRANSPORT_FILE)
      .flatMap((f) =>
        transportImportsIn(readFileSync(f, 'utf8')).map((lib) => `${rel(f)} -> ${lib}`),
      );

    expect(offenders).toEqual([]);
  });
});
