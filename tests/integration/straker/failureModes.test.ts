/**
 * T061/T062/T063 — the failure-mode suite Constitution II makes mandatory: portal sign-in
 * failure, session expiry, request timeout, malformed payload, reporting-destination
 * outage, and process restart mid-cycle.
 *
 * ## Why these run through the REAL transport, and what that is worth
 *
 * Every other integration file here drives the cycle through a portal double — a
 * `StrakerPortal` whose `listOpenOffers` resolves or rejects on command. That is the right
 * shape for asserting what the cycle decides, and it is the wrong shape for asserting what
 * the bot *does when the wire misbehaves*, because it replaces the whole of `httpClient.ts`
 * with a promise. A hung socket, a 401 that has to reach `isSessionExpired`, a 200 whose
 * body is not JSON, a retry sequence and the alert at the end of it — none of them exist
 * above that double.
 *
 * So these tests stub `globalThis.fetch` and let `assembleStrakerBot` build its own portal,
 * exactly as `main()` does. What runs is the real composition root, the real cookie jar and
 * Origin headers, the real 2-second per-attempt deadline, the real backoff-with-jitter, the
 * real transport alert hooks, the real parser, gate, ledger, store, outbox and dispatcher.
 * Only the network is a stub, and it is stubbed at the one seam the production code reaches
 * for — which is also how it reaches the transport-hooks-to-outbox join that no test could
 * touch before, because `StrakerAssemblyDeps` has no `fetchImpl` and injecting a portal
 * skips the hooks the composition root attaches.
 *
 * **No network is possible from here.** The stub answers every route it knows and throws on
 * anything else, so a request this suite did not anticipate fails loudly rather than
 * leaving the process to resolve a real hostname.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadStrakerBotConfig, type StrakerBotConfig } from '../../../src/straker/config.js';
import type { SendOutcome, StrakerSenders } from '../../../src/straker/dispatcher.js';
import { assembleStrakerBot, type StrakerAssembly } from '../../../src/straker/main.js';
import type { RawOffer } from '../../../src/straker/probe.js';
import type { ClaimEvent } from '../../../src/straker/strakerStore.js';
import { silentLogger } from './testDoubles.js';

// ---------------------------------------------------------------------------
// The fake portal: one stubbed `fetch`, routed by path
// ---------------------------------------------------------------------------

const VENDOR = 'vendor-1';

/** 10:00 Bangkok on Tuesday 15 September 2026 — a working moment, before every fixture's due. */
const NOW = Date.parse('2026-09-15T10:00:00+07:00');

/** One request as the fake portal saw it. Enough to assert which door the bot came through. */
interface Exchange {
  readonly method: string;
  /** Path without the query string. */
  readonly path: string;
  readonly query: string;
  readonly body: unknown;
  /** The per-attempt deadline the transport put on the wire, if it put one there at all. */
  readonly signal: AbortSignal | undefined;
  /** Real wall clock, so the gap between two attempts can be measured. */
  readonly atMs: number;
}

type Handler = (exchange: Exchange) => Promise<Response>;
type ClaimHandler = (exchange: Exchange, offerId: string) => Promise<Response>;

interface FakeStraker {
  login: Handler;
  me: Handler;
  offers: Handler;
  claim: ClaimHandler;
  assigned: Handler;
  readonly calls: Exchange[];
  readonly fetch: typeof fetch;
}

/**
 * The budget headers the portal really sends (contract §3, limit 300/min).
 *
 * Sent on every reply on purpose: without them the transport raises a `rate_limit_unknown`
 * warning, the composition root's hooks turn that into a durable alert, and every
 * assertion about what reached the operations channel in this file would be reading that
 * instead of the condition under test.
 */
function budgetHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-ratelimit-limit': '300',
    'x-ratelimit-remaining': '299',
    'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 60),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: budgetHeaders() });
}

/** A reply whose body is not JSON — the portal finished its sentence and it was nonsense. */
function notJson(status = 200): Response {
  return new Response('<html>maintenance</html>', { status, headers: budgetHeaders() });
}

function envelope(items: readonly unknown[]): unknown {
  return { items, total: items.length, limit: 100, offset: 0 };
}

/**
 * A portal that accepts the connection and then goes quiet: it settles only when the
 * request is aborted.
 *
 * The `signal === undefined` branch is the stub refusing to hang the suite in silence. If
 * the composition root ever stops passing a deadline this fails at once and says why,
 * rather than every test in the describe block timing out after a minute.
 */
const goesQuiet: Handler = (exchange) =>
  new Promise<Response>((_resolve, reject) => {
    const { signal } = exchange;
    if (signal === undefined) {
      reject(new Error('STUB: no AbortSignal reached the wire — this request would never end'));
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason as Error));
  });

function fakeStraker(): FakeStraker {
  const calls: Exchange[] = [];
  const handlers = {
    login: (async () => json({})) as Handler,
    me: (async () => json({ member_obj_id: VENDOR })) as Handler,
    offers: (async () => json([])) as Handler,
    claim: (async () => json({})) as ClaimHandler,
    assigned: (async () => json(envelope([]))) as Handler,
  };

  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const exchange: Exchange = {
      method: (init?.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.search,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
      atMs: Date.now(),
    };
    calls.push(exchange);

    if (exchange.path === '/api/vendor/auth/login') return handlers.login(exchange);
    if (exchange.path === '/api/vendor/auth/me') return handlers.me(exchange);
    const claiming = /^\/api\/vendors\/[^/]+\/job-offers\/([^/]+)\/accept$/.exec(exchange.path);
    if (claiming !== null) {
      return handlers.claim(exchange, decodeURIComponent(claiming[1] ?? ''));
    }
    if (/^\/api\/vendors\/[^/]+\/job-offers$/.test(exchange.path)) return handlers.offers(exchange);
    if (/^\/api\/vendors\/[^/]+\/assigned-jobs$/.test(exchange.path)) {
      return handlers.assigned(exchange);
    }
    // Reconciliation also reads where won work waits for a person (2026-09-22).
    if (exchange.path === '/api/hitl/vendor/purchase-orders') return json(envelope([]));
    throw new Error(
      `STUB: nothing routes ${exchange.method} ${exchange.path} — the bot asked for something ` +
        'this suite did not expect, which is itself the finding',
    );
  };

  return Object.assign(handlers, { calls, fetch: impl });
}

type Endpoint = 'login' | 'me' | 'offers' | 'claim';

function isEndpoint(path: string, kind: Endpoint): boolean {
  if (kind === 'login') return path === '/api/vendor/auth/login';
  if (kind === 'me') return path === '/api/vendor/auth/me';
  if (kind === 'claim') return path.endsWith('/accept');
  return /job-offers$/.test(path);
}

/** Requests the bot made to one endpoint family, so a count is an assertion, not a guess. */
function callsTo(portal: FakeStraker, kind: Endpoint): Exchange[] {
  return portal.calls.filter((c) => isEndpoint(c.path, kind));
}

// ---------------------------------------------------------------------------
// The bot under test
// ---------------------------------------------------------------------------

const OFFERS_DIR = join(process.cwd(), 'fixtures', 'straker', 'offers');

/** The captured payloads, by `job_ref:target_lang`, so a test can name the one it means. */
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

function offerFixture(key: string): RawOffer & Record<string, unknown> {
  const payload = captured()[key];
  if (payload === undefined) throw new Error(`no captured offer named ${key}`);
  return payload;
}

interface Delivered {
  readonly offers: Record<string, unknown>[];
  readonly tracking: Record<string, unknown>[];
  readonly alerts: Record<string, unknown>[];
}

interface RecordingSenders extends StrakerSenders {
  readonly got: Delivered;
  /** Flip to make every destination refuse, as an outage does. */
  down: boolean;
}

function recordingSenders(): RecordingSenders {
  const got: Delivered = { offers: [], tracking: [], alerts: [] };
  const state = { down: false };
  const make =
    (into: Record<string, unknown>[]) =>
    async (payload: unknown): Promise<SendOutcome> => {
      if (state.down) return { ok: false, reason: 'destination unavailable' };
      into.push(payload as Record<string, unknown>);
      return { ok: true };
    };
  return {
    got,
    get down() {
      return state.down;
    },
    set down(value: boolean) {
      state.down = value;
    },
    offers: make(got.offers),
    tracking: make(got.tracking),
    alerts: make(got.alerts),
  };
}

const tempDirs: string[] = [];
const open: StrakerAssembly[] = [];
let clock = NOW;

function envFor(stateDir: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    STRAKER_BASE_URL: 'https://vendr.straker.test',
    STRAKER_LOGIN_ID: 'user@example.test',
    STRAKER_PASSWORD: 'pw',
    STRAKER_MAX_WORDS_PER_DAY: '2000',
    STRAKER_DTP_MAX_WORDS_PER_DAY: '30000',
    STRAKER_SHEETS_ID: 'sheet-straker',
    STRAKER_CHAT_WEBHOOK_OFFERS: 'https://chat.example.test/offers',
    GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example.test/ops',
    STRAKER_HEALTHCHECKS_PING_URL: 'https://hc.example.test/straker',
    STRAKER_SINGLE_INSTANCE_PORT: '47905',
    STRAKER_STATE_DIR: stateDir,
    ...overrides,
  };
}

interface Bot {
  readonly cfg: StrakerBotConfig;
  readonly assembly: StrakerAssembly;
  readonly senders: RecordingSenders;
  readonly stateDir: string;
}

/**
 * Assemble the bot the way `main()` does, with the network stubbed underneath it.
 *
 * The order matters and is the point: `createHttpClient` resolves `options.fetchImpl ??
 * fetch` when the client is built, so the global has to be stubbed **before**
 * `assembleStrakerBot` runs. Stubbing it afterwards would leave the real `fetch` captured
 * and the test reaching for a hostname.
 */
function assemble(portal: FakeStraker, overrides: Record<string, string> = {}): Bot {
  vi.stubGlobal('fetch', portal.fetch);
  const stateDir = mkdtempSync(join(tmpdir(), 'straker-failmode-'));
  tempDirs.push(stateDir);
  return reopen(portal, stateDir, overrides);
}

/** A fresh bot over an existing state directory — what a restart is. */
function reopen(
  portal: FakeStraker,
  stateDir: string,
  overrides: Record<string, string> = {},
): Bot {
  vi.stubGlobal('fetch', portal.fetch);
  const cfg = loadStrakerBotConfig(envFor(stateDir, overrides));
  const senders = recordingSenders();
  const assembly = assembleStrakerBot(cfg, silentLogger(), { senders, now: () => clock });
  open.push(assembly);
  return { cfg, assembly, senders, stateDir };
}

beforeEach(() => {
  clock = NOW;
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Windows will not unlink a file that still has an open handle, so every database is
  // closed before its directory goes. Closing twice is harmless.
  while (open.length > 0) {
    try {
      open.pop()?.close();
    } catch {
      // A test that closed the handle deliberately (the crash scenario) already did this.
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Sign-in failure
// ===========================================================================

describe('failure mode: the portal refuses the sign-in', () => {
  it('reads nothing, records nothing, and reports the cycle failed', async () => {
    const portal = fakeStraker();
    portal.login = async () => json({ error: 'invalid credentials' }, 401);
    const bot = assemble(portal);

    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(false);

    // The read is what a failed sign-in must not reach: an unauthenticated offer-list read
    // would come back 401 or, worse, empty — and an empty list that is really "we are not
    // signed in" is the silent zero FR-023 exists to prevent.
    expect(callsTo(portal, 'offers')).toEqual([]);
    expect(bot.assembly.store.listEvents()).toEqual([]);
    expect(bot.assembly.store.trackerState().live).toEqual([]);
  });

  it('holds off on the next cycle rather than re-offering refused credentials', async () => {
    const portal = fakeStraker();
    portal.login = async () => json({ error: 'invalid credentials' }, 401);
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();
    const afterFirst = callsTo(portal, 'login').length;
    await bot.assembly.cycle.runOnce();

    // **This assertion was inverted on 2026-09-16, and the inversion is the fix.** It used
    // to require growth — "tries again on the next cycle rather than holding a dead
    // session" — which is what `session ??= await signIn()` gave: one login attempt per
    // ten-second cycle, about 8,640 a day, indefinitely, against an account whose lockout
    // policy is unknown and with a password RP-1 records as compromised. The reasoning was
    // sound about *never* retrying and silent about *how often*.
    //
    // The poll cycle now backs off, doubling from a minute, and clears the moment a read
    // succeeds. The bot still recovers without a restart — `pollCycleGuards.test.ts` proves
    // that against an advancing clock, which this fixture does not have.
    expect(callsTo(portal, 'login').length).toBe(afterFirst);
  });

  it('posts refused credentials once per session holder, and no more', async () => {
    /**
     * Two, not one, and not three — and the arithmetic is worth knowing because a count of
     * sign-ins is the natural instrument for half the tests in this file.
     *
     * **Two** because `pollCycle.ts` and `reconcile.ts` each hold their own
     * `StrakerSession` and each call `portal.signIn()`. That is by design: they run at
     * different rhythms and a shared session would couple them.
     *
     * It was **three** when this test was first written. `reconcile.ts`'s `read()` answers
     * an expired-session rejection with exactly one re-sign-in, and its guard wrapped the
     * sign-in as well as the read — so a 401 from the **login POST itself** was read as an
     * expired session and the same refused password went straight back out. Fixed
     * 2026-09-16 by moving the sign-in outside that guard; RP-1 records this password as
     * compromised and the portal's lockout policy is unknown, which makes doubling the
     * failed logins the wrong direction to be wrong in.
     */
    const portal = fakeStraker();
    portal.login = async () => json({ error: 'invalid credentials' }, 401);
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();

    expect(callsTo(portal, 'login')).toHaveLength(2);
  });

  it('does not read the offer list when the portal will not say which vendor we are', async () => {
    // FR-022: the vendor id is read back after every sign-in and never pinned. A reply
    // without it is not a session — reading an offer list addressed to `undefined` would be
    // asking for another vendor's work, or for nothing, and both look like "no offers".
    const portal = fakeStraker();
    portal.me = async () => json({});
    const bot = assemble(portal);

    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(false);

    expect(callsTo(portal, 'me').length).toBeGreaterThan(0);
    expect(callsTo(portal, 'offers')).toEqual([]);
  });

  it('raises no operator alert, however long it keeps failing — the liveness signal is the report', async () => {
    // Recorded rather than asserted as good. A sign-in that fails for ever produces an
    // error log line per cycle, `runOnce() === false`, and therefore `heartbeat.fail()` —
    // which pages through Healthchecks inside its 60s/300s window. It produces NO card in
    // the operations channel, so the page says "jobcatch-straker is not alive" and not "the
    // Straker password is wrong". The XTM bot raises a named alert for the same condition
    // (`LOGIN_MAX_RETRY` → lockout alert); this bot has no equivalent.
    //
    // This test exists so that stays a decision. If a login alert is ever added, this is
    // what says so; and until then it pins the other half — that a permanently failing
    // sign-in cannot turn into an alert storm on the channel the live XTM bot shares.
    const portal = fakeStraker();
    portal.login = async () => json({ error: 'invalid credentials' }, 401);
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();
    await bot.assembly.cycle.runOnce();
    await bot.assembly.cycle.runOnce();

    expect(bot.senders.got.alerts).toEqual([]);
    expect(bot.assembly.outbox.countByStatus('pending')).toBe(0);
    expect(bot.assembly.outbox.countByStatus('sent')).toBe(0);
  });
});

// ===========================================================================
// Session expiry
// ===========================================================================

describe('failure mode: the session expires', () => {
  it('signs in again on the next cycle and loses only the cycle the 401 landed in', async () => {
    const offer = offerFixture('aj-265:ms-my');
    const portal = fakeStraker();
    let reads = 0;
    portal.offers = async () => {
      reads += 1;
      return reads === 1 ? json({ error: 'session expired' }, 401) : json([offer]);
    };
    const bot = assemble(portal);

    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(false);
    const afterExpiry = callsTo(portal, 'login').length;
    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(true);

    // Exactly one extra sign-in — not one per read, and not none. A 401 is the only status
    // `isSessionExpired` answers to, which is what keeps a barred account (403) from
    // becoming a sign-in storm. (The reconciler is not due again by the second cycle, so
    // the one new sign-in here is the poll cycle's own.)
    expect(callsTo(portal, 'login')).toHaveLength(afterExpiry + 1);
    expect(callsTo(portal, 'claim')).toHaveLength(1);
    expect(bot.assembly.store.listEvents()[0]).toMatchObject({
      eventType: 'claim',
      outcome: 'won',
    });
  });

  it('does not retry the 401 read at the transport, because waiting does not un-expire a session', async () => {
    const portal = fakeStraker();
    portal.offers = async () => json({ error: 'session expired' }, 401);
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();

    // FR-019b's backoff is for "unreachable, slow, or a server fault". A 401 is an answer,
    // and three more of it would spend the request budget to be told the same thing.
    expect(callsTo(portal, 'offers')).toHaveLength(1);
  });

  it('stops claiming when the session expires between two claims, and the next cycle signs in fresh', async () => {
    // Carrying on would meet the same 401 on every remaining offer and turn one dead
    // session into a burst of alerts about unrelated offers.
    const first = offerFixture('aj-265:th');
    const second = offerFixture('aj-265:ms-my');
    const portal = fakeStraker();
    portal.offers = async () => json([first, second]);
    let claims = 0;
    portal.claim = async () => {
      claims += 1;
      return claims === 1 ? json({ error: 'session expired' }, 401) : json({});
    };
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();

    expect(callsTo(portal, 'claim')).toHaveLength(1);
    const halted = bot.assembly.store
      .listEvents()
      .filter((e) => e.eventType === 'skip' && e.skipReason === 'claiming_halted');
    expect(halted.map((e) => e.objId)).toEqual([second.obj_id]);

    // The next cycle re-opens the session and picks the passed-over offer back up. The
    // first is never re-claimed: it carries a claim event, and R7 is enforced across cycles
    // on exactly that.
    const afterHalt = callsTo(portal, 'login').length;
    await bot.assembly.cycle.runOnce();

    expect(callsTo(portal, 'login')).toHaveLength(afterHalt + 1);
    expect(callsTo(portal, 'claim').map((c) => c.path.split('/')[5])).toEqual([
      first.obj_id,
      second.obj_id,
    ]);
  });
});

// ===========================================================================
// Request timeout — the hung socket, end to end
// ===========================================================================

describe('failure mode: the portal accepts the request and then goes quiet', () => {
  /**
   * The case a transport unit test cannot reach, and the reason T061 names it specially:
   * `httpClient.test.ts` proves what a deadline does once a client has one, with a 5 ms
   * deadline and an injected `sleep`. What it cannot show is the **production numbers** —
   * `createStrakerPortal`'s 2 s per attempt, `DEFAULT_READ_RETRY_POLICY`'s four attempts
   * and its real jittered waits — landing inside the 10 s rhythm they have to share a loop
   * with. That relationship is the thing that would break if anyone raised the deadline,
   * and nothing currently pins it.
   *
   * So this test is deliberately the slow one: it runs the real sequence at real speed,
   * about 9 s of wall clock, and asserts the bound `main.ts` claims for it in prose ("a
   * maximally slow read stretches that turn to ~19.75 s and the bot polls at half rate").
   */
  it('ends the read inside one extra poll interval rather than holding the cycle open', async () => {
    const offer = offerFixture('aj-265:ms-my');
    const portal = fakeStraker();
    portal.offers = async () => json([offer]);
    // Excluded, so the offer is only ever sighted. This test is about what a hung read does
    // to the sighting record, and a claim in the middle of it would be a second subject.
    const bot = assemble(portal, { STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-us>ms-my' });

    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(true);
    const openedAt = bot.assembly.store.sightingsOf(offer.obj_id)[0];
    expect(openedAt?.notFoundAtMs).toBeNull();

    portal.offers = goesQuiet;
    const startedAt = Date.now();
    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(false);
    const elapsedMs = Date.now() - startedAt;

    // Four attempts, each stopped by our own deadline rather than by the portal: the stub
    // never settles on its own, so every one of these came back because an AbortSignal
    // fired. That is the whole of FR-019b's "slow" branch — without a deadline there is no
    // failure for the retry loop to see, and the first attempt simply never returns.
    expect(callsTo(portal, 'offers')).toHaveLength(1 + 4);
    expect(
      callsTo(portal, 'offers')
        .slice(1)
        .every((c) => c.signal instanceof AbortSignal),
    ).toBe(true);

    // The production deadline itself, measured rather than read off a constant. The gap
    // between two consecutive attempts is one deadline plus the first backoff step
    // (125–250 ms at equal jitter), so a 2 s deadline puts it in [2.125, 2.25] s and the
    // window below admits scheduling noise without admitting 4 s. This is the T043 revisit
    // made checkable: `REQUEST_TIMEOUT_MS` cannot be raised without this failing, which is
    // the whole reason its relationship to the 10 s rhythm was worth writing down.
    const stalls = callsTo(portal, 'offers').slice(1);
    const firstGapMs = (stalls[1]?.atMs ?? 0) - (stalls[0]?.atMs ?? 0);
    expect(firstGapMs).toBeGreaterThan(1_900);
    expect(firstGapMs).toBeLessThan(2_700);

    // And the whole sequence — four deadlines plus their waits — stayed inside the bound
    // `main.ts` claims for it: a maximally slow read costs one extra interval, so the bot
    // polls at half rate while the portal is struggling rather than stopping.
    expect(elapsedMs).toBeGreaterThan(4 * 2_000 * 0.9);
    expect(elapsedMs).toBeLessThan(bot.cfg.pollIntervalMs * 2);

    // A failed read drives NO transition. The appearance that was open before the stall is
    // still open, with the same timestamps — not closed with a fabricated lifetime.
    const afterStall = bot.assembly.store.sightingsOf(offer.obj_id)[0];
    expect(afterStall?.notFoundAtMs).toBeNull();
    expect(afterStall?.lastSeenAtMs).toBe(openedAt?.lastSeenAtMs);

    // And the exhaustion reached a human, through the queue rather than through a log file.
    // This is the join nothing could test before: `assembleStrakerBot` attaches the
    // transport's alert hooks to the outbox itself, and injecting a portal — which every
    // other test here does — skips that wiring entirely.
    expect(bot.senders.got.alerts).toHaveLength(1);
    expect(bot.senders.got.alerts[0]).toMatchObject({
      kind: 'transport',
      condition: 'read_retries_exhausted',
    });

    // Recovers on the next cycle: the stall cost one turn, not the run.
    portal.offers = async () => json([offer]);
    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(true);
    expect(bot.assembly.store.sightingsOf(offer.obj_id)).toHaveLength(1);
  });

  it('attempts a hung claim exactly once and leaves the outcome unknown', async () => {
    // The worst unbounded wait in the feature, because its outcome stays unknown for as
    // long as it hangs — and the one place a retry would be a second irreversible
    // commitment. One attempt, bounded, recorded as unknown, alerted, and never repeated.
    const offer = offerFixture('aj-265:ms-my');
    const portal = fakeStraker();
    portal.offers = async () => json([offer]);
    portal.claim = goesQuiet;
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();

    expect(callsTo(portal, 'claim')).toHaveLength(1);
    expect(bot.assembly.store.listEvents()[0]).toMatchObject({
      eventType: 'claim',
      outcome: 'unknown',
    });
    // Nothing held: the team may or may not owe this work, and charging the ceiling for
    // work nobody has shrinks tomorrow's budget on a guess. Reconciliation settles it.
    expect(bot.assembly.store.heldWork()).toEqual([]);
    expect(bot.senders.got.alerts[0]).toMatchObject({ condition: 'claim_outcome_unknown' });

    // R7 across cycles: still listed, still unresolved, still not claimed again.
    await bot.assembly.cycle.runOnce();
    expect(callsTo(portal, 'claim')).toHaveLength(1);
  });
});

// ===========================================================================
// Malformed payload
// ===========================================================================

describe('failure mode: the reply is not the shape the contract says', () => {
  /** A bot that has already seen the offer, so "nothing was marked vanished" can be asserted. */
  async function botThatHasSeenAnOffer(portal: FakeStraker): Promise<{ bot: Bot; objId: string }> {
    const offer = offerFixture('aj-265:ms-my');
    portal.offers = async () => json([offer]);
    const bot = assemble(portal, { STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-us>ms-my' });
    await bot.assembly.cycle.runOnce();
    return { bot, objId: offer.obj_id };
  }

  it('refuses an envelope where the list has always been bare, rather than reading zero offers', async () => {
    const portal = fakeStraker();
    const { bot, objId } = await botThatHasSeenAnOffer(portal);
    const readsBefore = callsTo(portal, 'offers').length;
    portal.offers = async () => json(envelope([]));

    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(false);

    // Not retried: the reply arrived, in full, and was wrong. Backing off would delay the
    // loud failure FR-023 asks for and spend the budget doing it.
    expect(callsTo(portal, 'offers')).toHaveLength(readsBefore + 1);
    // And the offer that is genuinely still listed was not marked vanished by a read that
    // failed to see it. An envelope read as zero is the silent zero, with a fabricated
    // lifetime stamped on every live offer.
    expect(bot.assembly.store.sightingsOf(objId)[0]?.notFoundAtMs).toBeNull();
  });

  it('claims an offer listed twice in one reply exactly once', async () => {
    const portal = fakeStraker();
    const offer = offerFixture('aj-265:ms-my');
    portal.offers = async () => json([offer, { ...offer }]);
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();

    expect(callsTo(portal, 'claim')).toHaveLength(1);
    expect(bot.assembly.store.heldWork()).toHaveLength(1);
  });

  it('refuses an entry with no identity, because an offer we cannot name we cannot track', async () => {
    const portal = fakeStraker();
    const { bot, objId } = await botThatHasSeenAnOffer(portal);
    const eventsBefore = bot.assembly.store.listEvents().length;
    portal.offers = async () => json([{ words: 2, due_at: '2026-09-15T23:20:00' }]);

    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(false);

    // Nothing new was written from a read the bot refused to interpret, and the offer it
    // could name is still recorded as live rather than vanished.
    expect(bot.assembly.store.listEvents()).toHaveLength(eventsBefore);
    expect(bot.assembly.store.sightingsOf(objId)[0]?.notFoundAtMs).toBeNull();
  });

  it('treats a 200 whose body is not JSON as a contract violation, not as a blip to retry', async () => {
    const portal = fakeStraker();
    const bot = assemble(portal);
    portal.offers = async () => notJson();

    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(false);

    expect(callsTo(portal, 'offers')).toHaveLength(1);
  });

  it('lets one unreadable entry cost itself, and raises a card naming it', async () => {
    // The 2026-09-17 incident, end to end. A good envelope carrying one entry the parser
    // cannot read used to take the whole read with it — seventeen cycles in a row, because
    // the offer was still there on the next poll — and raised nothing, because the alert
    // conditions covered transport and this was a parse.
    //
    // Two things are asserted because the fix has two halves and they fail independently:
    // the readable offer beside it survives (the blast radius), and a card actually reaches
    // the operations channel (FR-023a). The alerting half is the one that shipped untested
    // the first time.
    const portal = fakeStraker();
    const bot = assemble(portal);
    const good = offerFixture('aj-265:ms-my');
    const unreadable = { ...good, obj_id: 'broken-1', words: 'not a number' };
    portal.offers = async () => json([good, unreadable]);

    await bot.assembly.cycle.runOnce();

    // The readable one was still claimed. This is the assertion the incident would fail.
    expect(callsTo(portal, 'claim')).toHaveLength(1);

    const cards = bot.senders.got.alerts;
    expect(cards).toHaveLength(1);
    expect(JSON.stringify(cards[0])).toContain('broken-1');
  });

  it('pages once for an offer that stays unreadable, not once per cycle', async () => {
    // The offer is still on the portal next poll, and the poll is every ten seconds. An
    // alert keyed on anything but the offer's own identity turns a broken offer into a
    // pager storm, which is its own outage.
    const portal = fakeStraker();
    const bot = assemble(portal);
    const unreadable = { ...offerFixture('aj-265:ms-my'), obj_id: 'broken-1', words: 'nope' };
    portal.offers = async () => json([unreadable]);

    await bot.assembly.cycle.runOnce();
    await bot.assembly.cycle.runOnce();
    await bot.assembly.cycle.runOnce();

    expect(bot.senders.got.alerts).toHaveLength(1);
  });

  it('reports a shape violation through the log and the liveness signal, and raises no card', async () => {
    // The same recording as the sign-in case, and for the same reason: FR-023 says "stop
    // and report loudly", and what "loudly" means for an ENVELOPE violation is an `error`
    // line plus a failed cycle, which fails the heartbeat and pages through Healthchecks.
    // No named alert for this one. Pinned so that stays deliberate.
    //
    // Narrowed 2026-09-17: a single unreadable *entry* inside a good envelope no longer
    // behaves this way. It raises a named `offer_unreadable` alert and leaves the other
    // offers alone — see the malformed-entry case below. This test is the envelope half,
    // and the two must not be collapsed: the whole point is that the blast radius differs.
    const portal = fakeStraker();
    const bot = assemble(portal);
    portal.offers = async () => json(envelope([]));

    await bot.assembly.cycle.runOnce();
    await bot.assembly.cycle.runOnce();

    expect(bot.senders.got.alerts).toEqual([]);
  });
});

// ===========================================================================
// T062 — a missing effort or deadline alerts as well as skips (FR-023a, V26)
// ===========================================================================

describe('failure mode: the offer arrives without the numbers the rules need (T062, FR-023a)', () => {
  /**
   * The effort half of this is already proven end to end in `botAssembly.test.ts`
   * ("routes a skip that alerts to the operations channel, named as a condition"), which
   * deletes `words` from a captured payload and asserts the delivered card. The deadline
   * half was proven only at the decision level (`gateWiring.test.ts`) — so what is added
   * here is the missing half, not a second copy of the covered one.
   */
  it('alerts as well as skips when the DEADLINE is the field that did not arrive', async () => {
    const offer: Record<string, unknown> = { ...offerFixture('aj-265:ms-my') };
    delete offer['due_at'];
    const portal = fakeStraker();
    portal.offers = async () => json([offer]);
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();

    expect(callsTo(portal, 'claim')).toEqual([]);
    expect(bot.assembly.store.listEvents()[0]).toMatchObject({
      eventType: 'skip',
      skipReason: 'deadline_unknown',
    });
    // Not an ordinary skip: it means the assumption that the list carries everything the
    // decision needs — recorded as unverified on two independent jobs — has failed, and
    // every later decision rests on it.
    expect(bot.senders.got.alerts).toHaveLength(1);
    expect(bot.senders.got.alerts[0]).toMatchObject({
      kind: 'offer',
      condition: 'offer_deadline_unknown',
      objId: offer['obj_id'],
    });
  });

  it('still records the skip in the tracking file, so the offer is not simply absent', async () => {
    const offer: Record<string, unknown> = { ...offerFixture('aj-265:ms-my') };
    delete offer['due_at'];
    const portal = fakeStraker();
    portal.offers = async () => json([offer]);
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();

    expect(bot.senders.got.tracking).toHaveLength(1);
    expect(bot.senders.got.tracking[0]).toMatchObject({
      eventType: 'skip',
      skipReason: 'deadline_unknown',
      deadlineMs: null,
    });
  });
});

// ===========================================================================
// T063 — a barred account (contract §4a, V27)
// ===========================================================================

describe('failure mode: the account itself is barred (T063, contract §4a)', () => {
  const first = () => offerFixture('aj-265:th');
  const second = () => offerFixture('aj-265:ms-my');

  /** Two offers in one read, and a claim endpoint that answers however the test says. */
  async function twoOffers(
    claimReply: () => Promise<Response>,
    cycles = 1,
  ): Promise<{ portal: FakeStraker; bot: Bot }> {
    const portal = fakeStraker();
    portal.offers = async () => json([first(), second()]);
    portal.claim = claimReply;
    const bot = assemble(portal);
    for (let i = 0; i < cycles; i += 1) await bot.assembly.cycle.runOnce();
    return { portal, bot };
  }

  const barred = async (): Promise<Response> => json({ error: 'account suspended' }, 403);
  const accepted = async (): Promise<Response> => json({});

  it('alerts, stops claiming, and signs in no more often than a healthy run does', async () => {
    // The whole point of telling 403 apart from 401: both arrive as a refusal on the same
    // authenticated request, and reading a suspension as an expiry turns it into a sign-in
    // loop against a portal that has already said no.
    const { portal, bot } = await twoOffers(barred);

    expect(callsTo(portal, 'claim')).toHaveLength(1);
    // Immediately: queued inside the same transaction as the claim record and drained by
    // the end of the cycle, not on some later pass.
    // TWO alerts, saying two different things, and contract §4a wants both.
    //
    // The offer-scoped one names the claim that failed. The system-scoped one says the
    // ACCOUNT is barred and claiming has stopped until a human runs `npm run straker:unbar`
    // — which is the part an operator has to act on, and which "claim_failed on offer-1"
    // does not convey. `sign_in_refused` sits beside per-request failures for exactly this
    // reason. The system alert fires on the DISCOVERY only; see the next test.
    expect(bot.senders.got.alerts).toHaveLength(2);
    expect(bot.senders.got.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'offer',
          condition: 'claim_failed',
          objId: first().obj_id,
        }),
        expect.objectContaining({ kind: 'system', condition: 'account_barred' }),
      ]),
    );
    // The offer it never attempted is still recorded, with the halt as its reason — FR-010,
    // and FR-017's denominator, which a barred account would otherwise inflate.
    expect(
      bot.assembly.store
        .listEvents()
        .filter((e) => e.eventType === 'skip' && e.skipReason === 'claiming_halted'),
    ).toHaveLength(1);

    /**
     * "Does not sign in again" measured as a DIFFERENCE against a run where the claim was
     * accepted, rather than as a count or an ordering.
     *
     * Both of the simpler instruments give the wrong answer here, and finding out why was
     * the useful part: the assembled bot signs in twice per start (the poll cycle and the
     * reconciler each keep their own session), and the reconciler's sign-in lands *after*
     * the claim because `withDelivery` reconciles once the cycle has returned. So a total
     * is not one, and "no sign-in after the claim" is false for a reason that has nothing
     * to do with being barred.
     *
     * What contract §4a is actually about is whether the REJECTION caused a sign-in. A
     * difference of zero against the accepted-claim control says exactly that, and says it
     * whatever the bot's own sign-in habits turn out to be.
     */
    const control = await twoOffers(accepted);
    expect(callsTo(portal, 'login')).toHaveLength(callsTo(control.portal, 'login').length);
  });

  it('never reads a 403 as a lost race — only the confirmed 409 is one', async () => {
    const offer = offerFixture('aj-265:ms-my');
    const portal = fakeStraker();
    portal.offers = async () => json([offer]);
    portal.claim = async () => json({ error: 'account suspended' }, 403);
    const bot = assemble(portal);

    await bot.assembly.cycle.runOnce();

    // `lost` is the one outcome that never alerts. A rejection guessed into it would hide a
    // broken claim path behind silence that looks exactly like arriving second.
    expect(bot.assembly.store.listEvents()[0]).toMatchObject({
      eventType: 'claim',
      outcome: 'failed',
    });
    expect(bot.assembly.store.heldWork()).toEqual([]);
  });

  it('halts for the ACCOUNT, not for the cycle — the next cycle claims nothing (T073)', async () => {
    /**
     * This test previously asserted the opposite, and said so: it recorded "the next cycle
     * claims again at a barred portal" as a known gap, and ended "if a persisted bar is ever
     * added, this test is what it changes". T073 added one, so this is that change.
     *
     * Contract §4a: a barred rejection "must alert immediately and **stop claiming**; it
     * must never be retried around as though it were transient". The bar now lives in
     * `straker_meta`, so it outlives the `runOnce()` that discovered it AND the process —
     * a restart does not launder it. Nothing in the bot lifts it; `npm run straker:unbar`
     * does, and `StrakerStore.clearBar` records why no automatic trigger is safe.
     */
    const { portal } = await twoOffers(barred, 2);

    // One claim across two cycles: the first offer met the 403, the second was never
    // attempted. Kills a regression to the cycle-local flag, which produced two.
    expect(callsTo(portal, 'claim')).toHaveLength(1);
    expect(callsTo(portal, 'claim').map((c) => c.path.split('/')[5])).toEqual([first().obj_id]);
    // Only claiming stops. Sign-in continues at the healthy rate, because reading,
    // tracking and reconciliation must carry on — a barred account that also went blind
    // would lose the record it is going to be audited against.
    const control = await twoOffers(accepted, 2);
    expect(callsTo(portal, 'login')).toHaveLength(callsTo(control.portal, 'login').length);
  });
});

// ===========================================================================
// Reporting-destination outage (FR-016, V11)
// ===========================================================================

describe('failure mode: a reporting destination is unavailable', () => {
  it('holds the outcome through the outage and delivers it exactly once on recovery', async () => {
    // `botAssembly.test.ts` proves the bot keeps claiming while a destination is down. What
    // it does not follow is the other half of FR-016 — that the outcome is still there
    // afterwards and arrives once, not twice — which is the half V11 actually asks for.
    const offer = offerFixture('aj-265:ms-my');
    const portal = fakeStraker();
    portal.offers = async () => json([offer]);
    const bot = assemble(portal);
    bot.senders.down = true;

    await expect(bot.assembly.cycle.runOnce()).resolves.toBe(true);

    expect(bot.senders.got.offers).toEqual([]);
    expect(bot.assembly.outbox.countByStatus('pending')).toBeGreaterThan(0);
    expect(bot.assembly.outbox.countByStatus('sent')).toBe(0);

    // The queue backs off 30 s after a failed delivery, so a recovery cycle at the same
    // instant would find nothing due and prove nothing.
    bot.senders.down = false;
    clock = NOW + 31_000;
    portal.offers = async () => json([offer]);
    await bot.assembly.cycle.runOnce();

    expect(bot.senders.got.offers).toHaveLength(1);
    expect(bot.senders.got.offers[0]).toMatchObject({ objId: offer.obj_id, outcome: 'won' });
    expect(bot.assembly.outbox.countByStatus('pending')).toBe(0);

    // A third cycle must not send it again: the row is `sent`, and re-queuing the same
    // event id on the same channel is refused rather than duplicated.
    clock = NOW + 62_000;
    await bot.assembly.cycle.runOnce();
    expect(bot.senders.got.offers).toHaveLength(1);
  });

  it('never lets a destination being down cost a claim', async () => {
    const offer = offerFixture('aj-265:ms-my');
    const portal = fakeStraker();
    portal.offers = async () => json([offer]);
    const bot = assemble(portal);
    bot.senders.down = true;

    await bot.assembly.cycle.runOnce();

    // The claim went out before anything was recorded or announced (FR-003), so a Chat
    // webhook being down cannot be upstream of the race.
    expect(callsTo(portal, 'claim')).toHaveLength(1);
    expect(bot.assembly.store.listEvents()[0]).toMatchObject({ outcome: 'won' });
  });
});

// ===========================================================================
// Restart mid-cycle
// ===========================================================================

describe('failure mode: the process dies between claiming and recording', () => {
  /**
   * The window FR-003 deliberately opens and FR-016a closes.
   *
   * The claim is dispatched before anything durable happens, because a write in front of it
   * adds latency to the one step where latency decides whether the team gets the work. So
   * there is an interval — small, but real — in which the portal has committed work to the
   * team and nothing here has recorded it. A process that dies inside that interval leaves
   * work the team owns, that counts against no ceiling and reaches nobody.
   *
   * The death is staged by closing the database handle from inside the claim's own HTTP
   * reply: the POST has landed and the portal has committed, and every write after it
   * throws. That is precisely the disk state a `pm2 stop` between the two would leave, and
   * it is reachable without a second process.
   *
   * **The `[jobcatch-straker] reporting failed: … database connection is not open` line this
   * prints to stderr is the expected output, not a failure.** It is `main.ts`'s `reportAsync`
   * guard catching the dispatcher's flush against the closed handle — the guard that exists
   * so a bot whose reporting has broken still reports somewhere. Seeing it here is evidence
   * the crash landed where this test says it did.
   */
  it('leaves a state one reconciliation repairs, and the tracker resumes across it', async () => {
    const seen = offerFixture('aj-265:th');
    const lost = offerFixture('aj-265:ms-my');
    const portal = fakeStraker();
    const assignedOnPortal: Record<string, unknown>[] = [];
    portal.assigned = async () => json(envelope(assignedOnPortal));

    // Cycle 1: an ordinary cycle. `seen` is excluded from claiming, so it only leaves an
    // open sighting — the thing the restarted tracker has to pick back up.
    portal.offers = async () => json([seen]);
    const before = assemble(portal, { STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-us>th' });
    await before.assembly.cycle.runOnce();
    expect(before.assembly.store.sightingsOf(seen.obj_id)[0]?.notFoundAtMs).toBeNull();

    // Cycle 2: the claim lands on the portal, and the process dies before it is recorded.
    portal.offers = async () => json([seen, lost]);
    // The assigned job carries an id of its OWN (2026-09-22) and shares only the work key
    // with the offer — job ref, target language, service. It used to reuse the offer's id,
    // which let a same-id lookup stand in for the key and hid the restart re-claim below.
    const jobId = `job-of-${lost.obj_id}`;
    portal.claim = async () => {
      assignedOnPortal.push({
        obj_id: jobId,
        status: 'assigned',
        words: lost['words'],
        due_at: '2026-09-15T16:20:00Z',
        source_lang: lost['source_lang'],
        target_lang: lost['target_lang'],
        external_job_id: lost['job_ref'],
        service: lost['service'],
      });
      before.assembly.close();
      return json({});
    };
    await before.assembly.cycle.runOnce();

    // The state the crash left: the portal holds the work, our record does not.
    expect(assignedOnPortal.map((w) => w['obj_id'])).toEqual([jobId]);
    expect(callsTo(portal, 'claim')).toHaveLength(1);

    // --- the restart ---------------------------------------------------------
    // The offer is STILL LISTED after the restart. This test used to empty the list here,
    // which hid the worst thing a restart could do: nothing recorded the claim, the in-memory
    // guard died with the process, and the first cycle — which ran before reconciliation —
    // sent a second /accept for work the team already held (FR-019c).
    clock = NOW + 60_000;
    portal.offers = async () => json([lost]);
    const after = reopen(portal, before.stateDir, { STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-us>th' });

    await after.assembly.cycle.runOnce();
    clock += 10_000;
    await after.assembly.cycle.runOnce();

    // Exactly one claim request, ever: reconciliation runs before the first cycle on start
    // and holds the work under its key, and the cycle will not claim held work again.
    expect(callsTo(portal, 'claim')).toHaveLength(1);

    // One pass, and the gap is closed: reconciliation is due on the first call by design,
    // which is FR-016a's "on start".
    const recovered = after.assembly.store
      .eventsOf(jobId)
      .filter((e): e is ClaimEvent => e.eventType === 'claim' || e.eventType === 'recovery');
    expect(recovered.map((e) => e.outcome)).toContain('recovered');
    // Marked recovered rather than claimed, so a recurring gap between the two records is
    // visible instead of smoothed over (FR-016b) — and counted, so the day it lands on
    // stops pretending it has room it does not have.
    expect(after.assembly.store.heldWork().map((h) => h.objId)).toEqual([jobId]);
    expect(after.senders.got.offers.map((o) => o['outcome'])).toContain('recovered');

    // And the tracker came back from disk rather than from zero. The appearance `seen`
    // opened before the crash is closed by this cycle — at sighting 1, the number the store
    // already holds. A tracker booted empty would have nothing to close here, leaving that
    // appearance open for ever and its lifetime never measured; the next time the offer was
    // listed it would reopen row 1 and push `last_seen_at_ms` past its own `not_found_at_ms`.
    const rows = after.assembly.store.sightingsOf(seen.obj_id);
    expect(rows.map((r) => r.sighting)).toEqual([1]);
    expect(rows[0]?.notFoundAtMs).toBe(NOW + 60_000);
  });
});
