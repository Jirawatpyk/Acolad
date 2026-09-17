import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStrakerBotConfig, type StrakerBotConfig } from '../../../src/straker/config.js';
import { assembleStrakerBot, type StrakerPortal } from '../../../src/straker/main.js';
import type { StrakerSenders } from '../../../src/straker/dispatcher.js';
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
    STRAKER_DTP_MAX_WORDS_PER_DAY: '30000',
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
  /** What the portal lists right now. Assignable, because a real one changes between cycles. */
  listing: readonly RawOffer[];
  /** Offer ids the bot actually claimed, in the order they were sent. */
  readonly claims: string[];
}

/** A portal that lists what it is given and accepts every claim, recording which arrived. */
function portalListing(offers: readonly RawOffer[] = []): FakePortal {
  const claims: string[] = [];
  let listing = offers;
  return {
    get listing() {
      return listing;
    },
    set listing(next: readonly RawOffer[]) {
      listing = next;
    },
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
    listOpenOffers: async () => listing,
    // Overridden by the one test that asserts reconciliation is reached; everywhere else a
    // pass finds the portal holding nothing, which is the ordinary case.
    listAssignedWork: async () => [],
  };
}

const open: { close(): void }[] = [];

/**
 * Senders that accept everything and go nowhere.
 *
 * Passed by default, because the alternative is not "no delivery" — it is the assembly
 * building the REAL Google Chat and Sheets clients and a test reaching for the network
 * against a made-up hostname. That was happening until T056a made delivery real: harmless
 * only because the DNS lookup failed quickly.
 */
function inertSenders(): StrakerSenders {
  const accept = async (): Promise<{ ok: true }> => ({ ok: true });
  return { offers: accept, tracking: accept, alerts: accept };
}

function assemble(cfg: StrakerBotConfig, portal: StrakerPortal) {
  const assembly = assembleStrakerBot(cfg, silentLogger(), {
    portal,
    senders: inertSenders(),
    now: () => NOW,
  });
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

  /**
   * A DTP offer, built from a captured translation payload by nulling `target_lang`.
   *
   * Synthesised rather than captured because the real one — the 956-word job of
   * 2026-09-17 — was never written to disk: the bot threw while parsing it, which is the
   * incident. Every other field is the portal's own.
   */
  function dtpOffer(words: number, objId = 'dtp-1'): RawOffer {
    return {
      ...captured()['aj-265:th'],
      obj_id: objId,
      target_lang: null,
      words,
    } as unknown as RawOffer;
  }

  it('measures a DTP offer at the DTP rate, not at the translation rate', async () => {
    // The two rates are both DERIVED from their own ceiling over the 9-hour working day,
    // so this fixes them at 2000/9 = 222.2 and 30000/9 = 3333.3 w/h. From 10:00 to the
    // fixture's 23:20 deadline there are 8 working hours, which buys 1,777 words at the
    // translation rate and 26,666 at the DTP rate. A 5,000-word DTP job therefore lands
    // squarely between them: claimed if the gate reads the right rate, skipped as
    // `deadline_unreachable` if it reaches for translation's.
    const cfg = loadStrakerBotConfig(
      env({ STRAKER_MAX_WORDS_PER_DAY: '2000', STRAKER_DTP_MAX_WORDS_PER_DAY: '30000' }),
    );
    const portal = portalListing([dtpOffer(5000)]);
    const bot = assemble(cfg, portal);

    await bot.cycle.runOnce();

    expect(portal.claims).toEqual(['dtp-1']);
    expect(bot.store.heldWork().map((w) => w.kind)).toEqual(['monolingual']);
  });

  it('measures a DTP offer at the DTP rate rather than a rate of its own', async () => {
    // The mirror of the test above, and the mutation guard the translation side already
    // had: drive the DTP ceiling down so its derived rate is 90/9 = 10 w/h, giving 80
    // words of working time. 85 words is inside the DTP ceiling — so this is not a
    // capacity refusal — but outside what 10 w/h reaches. A hard-coded rate, or
    // translation's 222.2, claims it.
    const cfg = loadStrakerBotConfig(
      env({ STRAKER_MAX_WORDS_PER_DAY: '2000', STRAKER_DTP_MAX_WORDS_PER_DAY: '90' }),
    );
    const portal = portalListing([dtpOffer(85)]);
    const bot = assemble(cfg, portal);

    await bot.cycle.runOnce();

    expect(portal.claims).toEqual([]);
    expect(bot.store.listEvents()[0]).toMatchObject({
      eventType: 'skip',
      skipReason: 'deadline_unreachable',
    });
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
      // Sent rather than due: since T056a the cycle drains the queue before it returns, so
      // `due` is empty by design. What this test is about has not changed — both the event
      // and its outbox row are in the one file the config named — so it asserts the rows
      // are there rather than that they are still waiting.
      expect(new StrakerOutbox(reopened.db).countByStatus('sent')).toBeGreaterThan(0);
      expect(new StrakerOutbox(reopened.db).due(NOW)).toEqual([]);
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
    // A `system` alert with a `condition` the notifier has a card for. It was
    // `kind: 'db_quarantined'` with no condition and no timestamp, which the alerts sender
    // refuses on its first line — so this row was queued, retried and dead-lettered. That
    // is why `alerts.test.ts` now round-trips it through the real sender rather than
    // stopping, as this test does, at "a row was queued".
    expect(JSON.parse(queued[0]?.payloadJson ?? '{}')).toMatchObject({
      kind: 'system',
      condition: 'db_quarantined',
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

  it('resumes the sighting count instead of writing back into a closed appearance', async () => {
    const cfg = loadStrakerBotConfig(env({ STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-us>ms-my' }));
    const offer = captured()['aj-265:ms-my'] as RawOffer;
    const portal = portalListing();
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
    const portal = portalListing();
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
    const portal = portalListing();
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

describe('assembleStrakerBot — the outcomes actually reach a destination (T056a, FR-016)', () => {
  /**
   * Phase 4 built a tracking sink, a notifier, a reconciler and a dispatcher. Every one of
   * them passed its own tests while the running bot delivered **nothing**: outcomes were
   * queued durably into `straker_outbox` and no code read that table. The task breakdown
   * had no owner for the drain, which is the fourth time in this feature that a capability
   * was complete, correct and unreachable.
   *
   * So these tests assert delivery end to end — a captured payload goes in at the portal
   * and a rendered card comes out at a fake Chat transport — rather than asserting that a
   * dispatcher exists. Mutating the flush call away must fail here, or the seam is still
   * unowned.
   */
  interface Delivered {
    readonly offers: unknown[];
    readonly tracking: unknown[];
    readonly alerts: unknown[];
  }

  function recordingSenders(): StrakerSenders & { readonly got: Delivered } {
    const got: Delivered = { offers: [], tracking: [], alerts: [] };
    const make = (into: unknown[]) => async (payload: unknown) => {
      into.push(payload);
      return { ok: true } as const;
    };
    return {
      get got() {
        return got;
      },
      offers: make(got.offers),
      tracking: make(got.tracking),
      alerts: make(got.alerts),
    };
  }

  it('delivers a won offer to the announcement channel and the tracking record', async () => {
    const offer = captured()['aj-265:ms-my'] as RawOffer;
    const cfg = loadStrakerBotConfig(env());
    const senders = recordingSenders();
    const bot = assembleStrakerBot(cfg, silentLogger(), {
      portal: portalListing([offer]),
      senders,
      now: () => NOW,
    });
    open.push(bot);

    await bot.cycle.runOnce();

    // Queued AND drained. Before T056a the row existed and this list was empty.
    expect(senders.got.offers).toHaveLength(1);
    expect(senders.got.offers[0]).toMatchObject({
      objId: offer.obj_id,
      outcome: 'won',
      occurredAtMs: NOW,
    });
    expect(bot.outbox.countByStatus('sent')).toBeGreaterThan(0);
    expect(bot.outbox.due(NOW)).toEqual([]);
  });

  it('gives the announcement everything the card needs, not just an identity', async () => {
    // The payload shape is a seam too: `pollCycle.ts` writes it and `notifier.ts` refuses
    // one without a timestamp. A cycle that queued the old shape would have every row
    // rejected by its sender, retried, and dead-lettered — delivery that looks wired and
    // silently is not.
    const offer = captured()['aj-265:ms-my'] as RawOffer & Record<string, unknown>;
    const senders = recordingSenders();
    const bot = assembleStrakerBot(loadStrakerBotConfig(env()), silentLogger(), {
      portal: portalListing([offer]),
      senders,
      now: () => NOW,
    });
    open.push(bot);

    await bot.cycle.runOnce();

    expect(senders.got.offers[0]).toMatchObject({
      languageDirection: 'en-us>ms-my',
      effortWords: offer['words'],
      deadlineMs: Date.parse(`${String(offer['due_at'])}+07:00`),
    });
  });

  it('routes a skip that alerts to the operations channel, named as a condition', async () => {
    // `effort_unknown` is FR-023a's case: a skip that also alerts, because it means the
    // assumption that the list carries what the decision needs has failed.
    const offer = { ...(captured()['aj-265:ms-my'] as Record<string, unknown>) };
    delete offer['words'];
    const senders = recordingSenders();
    const bot = assembleStrakerBot(loadStrakerBotConfig(env()), silentLogger(), {
      portal: portalListing([offer as RawOffer]),
      senders,
      now: () => NOW,
    });
    open.push(bot);

    await bot.cycle.runOnce();

    expect(senders.got.alerts).toHaveLength(1);
    expect(senders.got.alerts[0]).toMatchObject({
      kind: 'offer',
      condition: 'offer_effort_unknown',
      occurredAtMs: NOW,
    });
  });

  it('reconciles on the very first cycle, which is FR-016a’s "on start"', async () => {
    // The reconciler is due on its first call by design, so one call per cycle satisfies
    // both halves of FR-016a. What this catches is the call never being made at all.
    const assigned: unknown[] = [];
    const portal = portalListing([]);
    const bot = assembleStrakerBot(loadStrakerBotConfig(env()), silentLogger(), {
      portal: {
        ...portal,
        listAssignedWork: async (vendorId: string) => {
          assigned.push(vendorId);
          return [];
        },
      },
      senders: recordingSenders(),
      now: () => NOW,
    });
    open.push(bot);

    await bot.cycle.runOnce();

    expect(assigned).toEqual(['vendor-1']);
  });

  it('keeps polling when delivery fails, because the race matters more than the telling', async () => {
    // A destination being down must not stop the bot claiming. The outcome stays queued —
    // that is what the outbox is for — and the cycle still reports success, because the
    // heartbeat answers "is this bot still racing", not "did Chat accept our card".
    const offer = captured()['aj-265:ms-my'] as RawOffer;
    const down: StrakerSenders = {
      offers: () => Promise.reject(new Error('chat is down')),
      tracking: () => Promise.reject(new Error('sheets is down')),
      alerts: () => Promise.reject(new Error('chat is down')),
    };
    const bot = assembleStrakerBot(loadStrakerBotConfig(env()), silentLogger(), {
      portal: portalListing([offer]),
      senders: down,
      now: () => NOW,
    });
    open.push(bot);

    await expect(bot.cycle.runOnce()).resolves.toBe(true);
    expect(bot.outbox.countByStatus('pending')).toBeGreaterThan(0);
    expect(bot.outbox.countByStatus('sent')).toBe(0);
  });
});

describe('an outcome that died undelivered reaches a human (S2, I-1)', () => {
  /**
   * The outbox's own docstring says "**Dead is visible, not lost**: a dead row still holds
   * its payload and `requeueDead` brings it back, which is what an operator does after
   * fixing a webhook." None of that was true.
   *
   * Nothing surfaced the count: `withDelivery` discarded the whole `FlushSummary`, so a
   * dead row changed neither the heartbeat nor any alert. And `requeueDead` had no caller
   * anywhere — `npm run outbox:requeue` opens the XTM database. So a won claim whose
   * announcement died after a six-hour Chat outage left the team owing work nobody was told
   * about, permanently, and reconciliation will not re-announce it because the work *is*
   * held, so there is nothing missing to find.
   *
   * The live XTM bot has gated its heartbeat on the dead backlog since 001. This is the
   * same rule, which DC-3 wants anyway.
   */
  function alwaysFailing(): StrakerSenders {
    const refuse = async () => ({ ok: false, reason: 'destination is down' }) as const;
    return { offers: refuse, tracking: refuse, alerts: refuse };
  }

  it('fails the cycle while an outcome is sitting dead, so the dead-man switch pages', async () => {
    const offer = captured()['aj-265:ms-my'] as RawOffer;
    const cfg = loadStrakerBotConfig(env());
    const bot = assembleStrakerBot(cfg, silentLogger(), {
      portal: portalListing([offer]),
      senders: alwaysFailing(),
      now: () => NOW,
      // One failure is fatal, so a single flush produces the backlog this is about.
      outboxOptions: { retryCap: 1 },
    });
    open.push(bot);

    const ok = await bot.cycle.runOnce();

    expect(bot.outbox.countByStatus('dead')).toBeGreaterThan(0);
    // The claim itself succeeded — this is delivery, not the race, failing. It still has to
    // page, because an outcome nobody was told about is the thing the outbox exists for.
    expect(ok).toBe(false);
  });

  it('recovers on its own once the backlog is requeued, without a restart', async () => {
    const offer = captured()['aj-265:ms-my'] as RawOffer;
    const cfg = loadStrakerBotConfig(env());
    let down = true;
    const senders: StrakerSenders = {
      offers: async () => (down ? { ok: false, reason: 'down' } : { ok: true }),
      tracking: async () => (down ? { ok: false, reason: 'down' } : { ok: true }),
      alerts: async () => (down ? { ok: false, reason: 'down' } : { ok: true }),
    };
    const bot = assembleStrakerBot(cfg, silentLogger(), {
      portal: portalListing([offer]),
      senders,
      now: () => NOW,
      outboxOptions: { retryCap: 1 },
    });
    open.push(bot);

    await bot.cycle.runOnce();
    down = false;
    // What `npm run straker:outbox:requeue` does — the operator action the docstring
    // promises and that had no implementation.
    expect(bot.outbox.requeueDead(NOW)).toBeGreaterThan(0);

    await expect(bot.cycle.runOnce()).resolves.toBe(true);
    expect(bot.outbox.countByStatus('dead')).toBe(0);
  });
});
