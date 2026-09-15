import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStrakerBotConfig, type StrakerBotConfig } from '../../../src/straker/config.js';
import { assembleStrakerBot, type StrakerPortal } from '../../../src/straker/main.js';
import type { RawOffer } from '../../../src/straker/probe.js';
import { StrakerOutbox } from '../../../src/straker/outbox.js';
import { openStrakerDatabase, StrakerStore } from '../../../src/straker/strakerStore.js';
import { silentLogger } from './testDoubles.js';

/**
 * What `main()` actually builds — asserted, rather than read.
 *
 * Everything between `loadStrakerBotConfig` and `startStrakerBot` used to live inside
 * `main()`, where no test could reach it, and a reviewer proved the cost twice over: with
 * the whole suite green and `tsc` clean, `extractOffers` could be replaced by `() => []`
 * and the ledger's ceiling by a hard-coded 999_999. Both are wiring — a value carried from
 * configuration to the component that uses it — and wiring is exactly what a unit test of
 * either end cannot see. This is the third capability in this feature to ship built,
 * tested and unreachable because the seam between two files belonged to nobody.
 *
 * So these tests drive the **assembled** cycle: real parser, real gate, real ledger, real
 * store on a real SQLite file in a temp directory, against payloads read off disk from
 * `fixtures/straker/offers/`. Only the portal is a double, because only the network is.
 */

const OFFERS_DIR = join(process.cwd(), 'fixtures', 'straker', 'offers');

/** The captured payloads, by their `job_ref`, so a test can name the one it means. */
function captured(): Record<string, RawOffer & Record<string, unknown>> {
  const byRef: Record<string, RawOffer & Record<string, unknown>> = {};
  for (const file of readdirSync(OFFERS_DIR).filter((f) => f.endsWith('.json'))) {
    const payload = JSON.parse(readFileSync(join(OFFERS_DIR, file), 'utf8')) as Record<
      string,
      unknown
    >;
    byRef[`${String(payload['job_ref'])}:${String(payload['target_lang'])}`] = payload as RawOffer &
      Record<string, unknown>;
  }
  return byRef;
}

/** 10:00 Bangkok on Tuesday 15 September 2026 — a working moment, before every fixture's due. */
const NOW = Date.parse('2026-09-15T10:00:00+07:00');

const tempDirs: string[] = [];

function env(overrides: Record<string, string> = {}): Record<string, string> {
  const stateDir = mkdtempSync(join(tmpdir(), 'straker-assembly-'));
  tempDirs.push(stateDir);
  return {
    STRAKER_BASE_URL: 'https://vendr.straker.ai',
    STRAKER_LOGIN_ID: 'user@example.test',
    STRAKER_PASSWORD: 'pw',
    STRAKER_MAX_WORDS_PER_DAY: '2000',
    STRAKER_SHEETS_ID: 'sheet-straker',
    STRAKER_CHAT_WEBHOOK_OFFERS: 'https://chat.example.test/offers',
    GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example.test/ops',
    STRAKER_HEALTHCHECKS_PING_URL: 'https://hc.example.test/straker',
    STRAKER_SINGLE_INSTANCE_PORT: '47904',
    STRAKER_STATE_DIR: stateDir,
    ...overrides,
  };
}

interface FakePortal extends StrakerPortal {
  readonly claims: string[];
}

/** A portal that lists what it is given and accepts every claim, recording which arrived. */
function portalListing(offers: readonly RawOffer[]): FakePortal {
  const claims: string[] = [];
  return {
    get claims() {
      return claims;
    },
    client: {
      postJson: async (path: string) => {
        claims.push(/job-offers\/([^/]+)\/claim/.exec(path)?.[1] ?? '?');
        return {};
      },
    } as never,
    signIn: async () => ({ vendorId: 'vendor-1' }),
    listOpenOffers: async () => offers,
  };
}

const open: { close(): void }[] = [];

function assemble(cfg: StrakerBotConfig, portal: StrakerPortal) {
  const assembly = assembleStrakerBot(cfg, silentLogger(), { portal, now: () => NOW });
  open.push(assembly);
  return assembly;
}

afterEach(() => {
  // Windows will not unlink a file that still has an open handle, so the database is closed
  // before the directory goes — and closing twice is harmless, which the last test relies on.
  while (open.length > 0) open.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('assembleStrakerBot — the offer parser main() wires in is the real one', () => {
  it('claims a captured offer and records the effort and deadline the payload carried', async () => {
    // Kills `extractOffers: () => []` (nothing is claimed) and equally kills a placeholder
    // that returns fabricated values: the recorded effort is compared against the number in
    // the file, and the deadline against the file's own `due_at` read as Bangkok.
    const offer = captured()['aj-265:ms-my'];
    expect(offer).toBeDefined();
    const cfg = loadStrakerBotConfig(env());
    const portal = portalListing([offer as RawOffer]);
    const bot = assemble(cfg, portal);

    await expect(bot.cycle.runOnce()).resolves.toBe(true);

    expect(portal.claims).toEqual([offer?.obj_id]);
    const events = bot.store.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'claim',
      outcome: 'won',
      effortWords: offer?.['words'],
      deadlineMs: Date.parse(`${String(offer?.['due_at'])}+07:00`),
    });
  });

  it('honours the exclusion list from configuration, so the lever reaches the running parser', async () => {
    const offer = captured()['aj-265:ms-my'];
    const cfg = loadStrakerBotConfig(env({ STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-us>ms-my' }));
    const portal = portalListing([offer as RawOffer]);
    const bot = assemble(cfg, portal);

    await bot.cycle.runOnce();

    expect(portal.claims).toEqual([]);
    expect(bot.store.listEvents()[0]).toMatchObject({
      eventType: 'skip',
      skipReason: 'ineligible_language',
    });
  });
});

describe('assembleStrakerBot — the ledger ceiling is the configured one', () => {
  it('stops claiming once the day’s configured word ceiling is reached', async () => {
    // Kills a hard-coded ceiling: with 999_999 in place of `cfg.maxWordsPerDay`, both
    // two-word offers are claimed and this fails. The throughput is pinned rather than
    // derived so the feasibility check cannot be what refuses the second one.
    const all = captured();
    const first = all['aj-265:th'];
    const second = all['aj-265:ms-my'];
    const cfg = loadStrakerBotConfig(
      env({ STRAKER_MAX_WORDS_PER_DAY: '3', STRAKER_THROUGHPUT_WORDS_PER_HOUR: '100' }),
    );
    const portal = portalListing([first as RawOffer, second as RawOffer]);
    const bot = assemble(cfg, portal);

    await bot.cycle.runOnce();

    expect(portal.claims).toHaveLength(1);
    const skips = bot.store.listEvents().filter((e) => e.eventType === 'skip');
    expect(skips.map((s) => s.skipReason)).toEqual(['ceiling_reached']);
    expect(skips).toHaveLength(1);
  });

  it('measures feasibility at the configured throughput, not at one of its own', async () => {
    // One word per hour against a two-word job due the same evening is unreachable. A
    // hard-coded throughput — or one derived from the wrong figure — claims it anyway.
    const offer = captured()['aj-265:ms-my'];
    const cfg = loadStrakerBotConfig(env({ STRAKER_THROUGHPUT_WORDS_PER_HOUR: '0.1' }));
    const portal = portalListing([offer as RawOffer]);
    const bot = assemble(cfg, portal);

    await bot.cycle.runOnce();

    expect(portal.claims).toEqual([]);
    expect(bot.store.listEvents()[0]).toMatchObject({
      eventType: 'skip',
      skipReason: 'deadline_unreachable',
    });
  });
});

describe('assembleStrakerBot — one database, under the configured state directory', () => {
  it('writes the claim and its announcement into the same file, which survives the process', async () => {
    // The outbox and the store are constructed from two separate expressions in the
    // composition root. Handing one of them a different handle would leave every outcome
    // queued somewhere the dispatcher never looks — FR-016 lost in the wiring.
    const offer = captured()['aj-265:ms-my'];
    const cfg = loadStrakerBotConfig(env());
    const bot = assemble(cfg, portalListing([offer as RawOffer]));

    await bot.cycle.runOnce();
    bot.close();

    const reopened = openStrakerDatabase(cfg.stateDir, NOW);
    try {
      expect(new StrakerStore(reopened.db).listEvents()).toHaveLength(1);
      expect(new StrakerOutbox(reopened.db).due(NOW)).toHaveLength(1);
    } finally {
      reopened.db.close();
    }
  });
});

describe('assembleStrakerBot — a quarantined state file reaches a human', () => {
  it('queues an alert, rather than only writing a log line nobody watches', () => {
    // The Straker ceiling is derived entirely from held work, so a quarantine does not just
    // lose history: `heldWork()` comes back empty, the day's committed workload reads as
    // zero, and every offer fits for the rest of the day. That is a bot claiming past its
    // capacity while looking perfectly healthy. An `error` line in a rotating file is not
    // how anyone finds out — the XTM bot raises a real alert for the same event, and this
    // is where Straker's equivalent is joined up.
    const cfg = loadStrakerBotConfig(env());
    writeFileSync(join(cfg.stateDir, 'straker.db'), 'this is not a database');

    const bot = assemble(cfg, portalListing([]));

    expect(bot.quarantinedCopyPath).not.toBeNull();
    const queued = bot.outbox.due(NOW);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.channel).toBe('alerts');
    expect(queued[0]?.eventId).toMatch(/^db_quarantined:/);
    expect(JSON.parse(queued[0]?.payloadJson ?? '{}')).toMatchObject({
      kind: 'db_quarantined',
      heldWorkLost: true,
    });
  });

  it('queues nothing on an ordinary start, so the alert means what it says', () => {
    const bot = assemble(loadStrakerBotConfig(env()), portalListing([]));

    expect(bot.quarantinedCopyPath).toBeNull();
    expect(bot.outbox.due(NOW)).toEqual([]);
  });
});

describe('assembleStrakerBot — the sighting tracker survives a restart', () => {
  /**
   * The tracker is in-memory state with a durable twin: `offer_sightings` keys every row on
   * `(obj_id, sighting)`, and the sighting number comes from the tracker's own count. Boot
   * it empty and that count restarts at 1 for an offer already stored at 2 — so the next
   * `recordSighting` does not open a new row, it **reaches back into a closed one** and
   * moves its `last_seen_at_ms` past the moment the offer was declared gone. The row that
   * was genuinely open is then never closed by anything, because the tracker no longer
   * knows it exists.
   *
   * SC-000 measures offer lifetime from exactly these rows, and a bot restarted mid-day is
   * an ordinary event — a deploy is one.
   */
  const at = (iso: string): number => Date.parse(iso);

  function assembleAt(cfg: StrakerBotConfig, portal: StrakerPortal, clock: () => number) {
    const assembly = assembleStrakerBot(cfg, silentLogger(), { portal, now: clock });
    open.push(assembly);
    return assembly;
  }

  /** A portal whose listing the test changes between cycles, as a real one does. */
  function switchablePortal(): StrakerPortal & { listing: RawOffer[] } {
    const state = { listing: [] as RawOffer[] };
    return {
      get listing() {
        return state.listing;
      },
      set listing(next: RawOffer[]) {
        state.listing = next;
      },
      client: { postJson: async () => ({}) } as never,
      signIn: async () => ({ vendorId: 'vendor-1' }),
      listOpenOffers: async () => state.listing,
    };
  }

  it('resumes the sighting count instead of writing back into a closed appearance', async () => {
    const cfg = loadStrakerBotConfig(env({ STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-us>ms-my' }));
    const offer = captured()['aj-265:ms-my'] as RawOffer;
    const portal = switchablePortal();
    let clock = at('2026-09-15T10:00:00+07:00');

    const before = assembleAt(cfg, portal, () => clock);
    portal.listing = [offer];
    await before.cycle.runOnce(); // first appearance
    clock = at('2026-09-15T10:00:30+07:00');
    portal.listing = [];
    await before.cycle.runOnce(); // gone — appearance 1 closes
    clock = at('2026-09-15T10:01:00+07:00');
    portal.listing = [offer];
    await before.cycle.runOnce(); // back — appearance 2 opens
    const closedFirst = before.store.sightingsOf(offer.obj_id)[0];
    before.close();

    // The restart.
    clock = at('2026-09-15T10:02:00+07:00');
    const after = assembleAt(cfg, portal, () => clock);
    await after.cycle.runOnce();

    const rows = after.store.sightingsOf(offer.obj_id);
    expect(rows.map((r) => r.sighting)).toEqual([1, 2]);
    // The closed appearance is a finished measurement. Nothing after the restart may touch
    // it — a `last_seen_at_ms` later than the `not_found_at_ms` beside it is not a longer
    // lifetime, it is a row that cannot be true.
    expect(rows[0]?.lastSeenAtMs).toBe(closedFirst?.lastSeenAtMs);
    expect(rows[0]?.notFoundAtMs).toBe(at('2026-09-15T10:00:30+07:00'));
    expect(rows[1]?.notFoundAtMs).toBeNull();

    // And the appearance that really is open was carried forward as a live one, not merely
    // numbered: when it ends, it ends with the time it was last seen AFTER the restart.
    // A row's `last_seen_at_ms` is written when the appearance closes, so this is the only
    // point at which "the tracker resumed the right live entry" becomes observable.
    clock = at('2026-09-15T10:02:30+07:00');
    portal.listing = [];
    await after.cycle.runOnce();

    const ended = after.store.sightingsOf(offer.obj_id)[1];
    expect(ended?.lastSeenAtMs).toBe(at('2026-09-15T10:02:00+07:00'));
    expect(ended?.notFoundAtMs).toBe(clock);
    expect(ended?.firstSeenAtMs).toBe(at('2026-09-15T10:01:00+07:00'));
  });

  it('numbers an offer that returns AFTER the restart as its next appearance', async () => {
    // The case the live list alone cannot answer. At restart this offer is not listed, so
    // there is no open appearance to carry forward — only the *history* says it has already
    // appeared once. Drop that half and the returning offer is numbered 1 again, landing
    // straight on top of the closed row: its `last_seen_at_ms` moves past its own
    // `not_found_at_ms`, and the second appearance is never recorded at all.
    const cfg = loadStrakerBotConfig(env({ STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-us>ms-my' }));
    const offer = captured()['aj-265:ms-my'] as RawOffer;
    const portal = switchablePortal();
    let clock = at('2026-09-15T10:00:00+07:00');

    const before = assembleAt(cfg, portal, () => clock);
    portal.listing = [offer];
    await before.cycle.runOnce();
    clock = at('2026-09-15T10:00:30+07:00');
    portal.listing = [];
    await before.cycle.runOnce(); // appearance 1 closes — nothing is live at the restart
    before.close();

    clock = at('2026-09-15T10:01:00+07:00');
    const after = assembleAt(cfg, portal, () => clock);
    portal.listing = [offer];
    await after.cycle.runOnce();

    const rows = after.store.sightingsOf(offer.obj_id);
    expect(rows.map((r) => r.sighting)).toEqual([1, 2]);
    expect(rows[0]?.notFoundAtMs).toBe(at('2026-09-15T10:00:30+07:00'));
    expect(rows[0]?.lastSeenAtMs).toBe(at('2026-09-15T10:00:00+07:00'));
    expect(rows[1]?.firstSeenAtMs).toBe(clock);
    expect(rows[1]?.notFoundAtMs).toBeNull();
  });

  it('can still close an appearance that began before the restart', async () => {
    const cfg = loadStrakerBotConfig(env({ STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-us>ms-my' }));
    const offer = captured()['aj-265:ms-my'] as RawOffer;
    const portal = switchablePortal();
    let clock = at('2026-09-15T10:00:00+07:00');

    const before = assembleAt(cfg, portal, () => clock);
    portal.listing = [offer];
    await before.cycle.runOnce();
    before.close();

    clock = at('2026-09-15T10:00:30+07:00');
    const after = assembleAt(cfg, portal, () => clock);
    portal.listing = [];
    await after.cycle.runOnce();

    // Booted empty, the tracker holds nothing to vanish, so this appearance stays open for
    // ever and its lifetime is never measured at all.
    const rows = after.store.sightingsOf(offer.obj_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notFoundAtMs).toBe(clock);
  });
});
