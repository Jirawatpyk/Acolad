import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOfferExtractor } from '../../../src/straker/offerParse.js';
import { loadStrakerBotConfig } from '../../../src/straker/config.js';
import {
  isBudgetSuspended,
  type StrakerHttpClient,
  type StrakerTransportWarning,
} from '../../../src/straker/httpClient.js';
import { listOpenOffers } from '../../../src/straker/offersApi.js';
import {
  createStrakerPortal,
  startStrakerBot,
  type StrakerPortal,
} from '../../../src/straker/main.js';
import type { RawOffer } from '../../../src/straker/probe.js';
import { silentLogger, recordingPinger, idleCycle } from './testDoubles.js';

/** Its own port: vitest runs test files in parallel and two other files start a bot. */
const TEST_PORT = 47903;

const ENV = {
  STRAKER_BASE_URL: 'https://vendr.straker.ai',
  STRAKER_LOGIN_ID: 'user@example.test',
  STRAKER_PASSWORD: 'pw',
  STRAKER_MAX_WORDS_PER_DAY: '2000',
  STRAKER_SHEETS_ID: 'sheet-straker',
  STRAKER_CHAT_WEBHOOK_OFFERS: 'https://chat.example.test/offers',
  GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example.test/ops',
  STRAKER_HEALTHCHECKS_PING_URL: 'https://hc.example.test/straker',
  STRAKER_SINGLE_INSTANCE_PORT: String(TEST_PORT),
  STRAKER_POLL_INTERVAL_MS: '1000',
};

/** A transport whose two read doors are distinguishable, so a test can assert which one ran. */
function twoDoorClient(reply: unknown = []): StrakerHttpClient & {
  getJson: ReturnType<typeof vi.fn>;
  getJsonWithBackoff: ReturnType<typeof vi.fn>;
} {
  return {
    getJson: vi.fn().mockResolvedValue(reply),
    getJsonWithBackoff: vi.fn().mockResolvedValue(reply),
    postJson: vi.fn(),
    lastRateLimit: () => null,
  } as never;
}

const offer = (id: string): RawOffer => ({ obj_id: id });

describe('the offer-list read goes through the retrying door (FR-019b, V30)', () => {
  it('uses the backoff door when the caller asks for it, which is what the bot needs', async () => {
    const client = twoDoorClient([offer('a')]);

    await listOpenOffers(client, 'vendor-1', { retry: true });

    // The whole point of FR-019b is that a struggling portal is not read at the normal
    // rhythm. Implementing the backoff and then reading through the other door leaves the
    // requirement satisfied on paper and absent in the running bot.
    expect(client.getJsonWithBackoff).toHaveBeenCalledOnce();
    expect(client.getJson).not.toHaveBeenCalled();
  });

  it('stays on the single-attempt door by default, so the running capture probe is unchanged', async () => {
    const client = twoDoorClient([offer('a')]);

    await listOpenOffers(client, 'vendor-1');

    expect(client.getJson).toHaveBeenCalledOnce();
    expect(client.getJsonWithBackoff).not.toHaveBeenCalled();
  });

  it('checks the reply shape on the retrying door too, not only on the plain one', async () => {
    const client = twoDoorClient({ items: [], total: 0 });

    // An envelope where a bare list is expected must fail loud on whichever door it arrives
    // through — reading it as zero offers is the failure the contract exists to prevent.
    await expect(listOpenOffers(client, 'vendor-1', { retry: true })).rejects.toThrow(
      /no longer a bare array/,
    );
  });
});

describe('run() — the loop that actually keeps the bot polling', () => {
  it('waits the configured interval between cycles, which is the account-safety knob', async () => {
    const slept: number[] = [];
    let cycles = 0;
    const bot = await startStrakerBot({
      cfg: loadStrakerBotConfig(ENV),
      logger: silentLogger(),
      heartbeat: recordingPinger(),
      cycle: {
        runOnce: async () => {
          cycles++;
          return true;
        },
      },
      lockRetryMs: 0,
      sleep: async (ms) => {
        slept.push(ms);
        if (slept.length >= 3) await bot.stop();
      },
    });

    await bot.run();

    // A loop that forgets to wait polls a rate-limited portal flat out, which is how an
    // account earns a block — the one failure this project's notes call out by name.
    expect(slept).toEqual([1_000, 1_000, 1_000]);
    expect(cycles).toBe(3);
  });

  it('stops looping once stop() has been called', async () => {
    let cycles = 0;
    const bot = await startStrakerBot({
      cfg: loadStrakerBotConfig(ENV),
      logger: silentLogger(),
      heartbeat: recordingPinger(),
      cycle: idleCycle(),
      lockRetryMs: 0,
      sleep: async () => {
        cycles++;
        await bot.stop();
      },
    });

    await bot.run();

    expect(cycles).toBe(1);
  });

  it('keeps looping when a cycle throws, because a 24/7 bot survives a bad cycle', async () => {
    let cycles = 0;
    const bot = await startStrakerBot({
      cfg: loadStrakerBotConfig(ENV),
      logger: silentLogger(),
      heartbeat: recordingPinger(),
      cycle: {
        runOnce: () => {
          cycles++;
          return Promise.reject(new Error('boom'));
        },
      },
      lockRetryMs: 0,
      sleep: async () => {
        if (cycles >= 2) await bot.stop();
      },
    });

    await bot.run();

    expect(cycles).toBe(2);
  });

  it('survives a liveness signal that rejects, rather than dying with the lock still held', async () => {
    const bot = await startStrakerBot({
      cfg: loadStrakerBotConfig(ENV),
      logger: silentLogger(),
      // `HeartbeatPinger` is an interface, so nothing stops an implementation rejecting.
      // If that escapes runOnce, run() rejects, main() never calls stop(), and the process
      // lingers holding port 47812 while PM2 still reports it online.
      heartbeat: {
        ok: () => Promise.reject(new Error('ping failed')),
        fail: async () => undefined,
      },
      cycle: idleCycle(),
      lockRetryMs: 0,
      sleep: async () => {
        await bot.stop();
      },
    });

    await expect(bot.run()).resolves.toBeUndefined();
  });
});

describe('createStrakerPortal — the wiring the transport cannot do for itself', () => {
  /**
   * Two capabilities have now been built inside `httpClient.ts` and left unreachable
   * because nothing passed the option that switches them on — the retrying read door, and
   * then the request deadline. Both were invisible to every transport test, because those
   * build their own client with the options already set. These tests assert the JOIN
   * instead: what the bot's own composition root actually hands the transport.
   */
  function portalWith(fetchImpl: typeof fetch, capture: StrakerTransportWarning[] = []) {
    return createStrakerPortal(loadStrakerBotConfig(ENV), silentLogger(), {
      fetchImpl,
      onWarning: (w) => capture.push(w),
    });
  }

  it('puts a deadline on the wire, so a portal that accepts and then goes quiet cannot hold a read open', async () => {
    // Asserts the JOIN, not the deadline's behaviour — the transport already has six tests
    // for what a deadline does once it exists. What was missing, and what this catches, is
    // the composition root never handing one over: without it the platform default takes
    // roughly five minutes per attempt, during which the loop does not poll, writes no log
    // line, and neither succeeds nor fails its liveness signal.
    const signals: (AbortSignal | null | undefined)[] = [];
    const recordingFetch: typeof fetch = (_input, init) => {
      signals.push(init?.signal);
      return Promise.resolve(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    };

    await portalWith(recordingFetch).listOpenOffers('vendor-1');

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });

  it('routes the transport warning somewhere, rather than leaving the hook unattached', async () => {
    const seen: StrakerTransportWarning[] = [];
    const noBudgetHeaders: typeof fetch = () =>
      Promise.resolve(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      );

    await portalWith(noBudgetHeaders, seen).listOpenOffers('vendor-1');

    expect(seen.map((w) => w.kind)).toContain('rate_limit_unknown');
  });
});

describe('the extractor the bot actually runs is the real parser (not a placeholder)', () => {
  /**
   * Assembled exactly as `main()` assembles it — `createOfferExtractor` fed the config field
   * it is fed there — and driven with a payload read off disk rather than a literal. Two
   * capabilities in this feature shipped fully built and completely unreachable because a
   * call site never passed what turned them on; this is the test that makes a third one
   * impossible for the offer parser.
   */
  const fixtures = join(process.cwd(), 'fixtures', 'straker', 'offers');
  const captured = readdirSync(fixtures)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(fixtures, f), 'utf8')) as { obj_id: string });

  it('is reading real captured payloads, so an empty fixture folder cannot pass as clean', () => {
    expect(captured.length).toBeGreaterThan(0);
  });

  it('turns a captured payload into a decision input, with every value the gate needs', () => {
    const cfg = loadStrakerBotConfig(ENV);
    const extract = createOfferExtractor({
      excludedLanguagePairs: cfg.excludedLanguagePairs,
      logger: silentLogger(),
    });

    const [offer] = extract(captured.slice(0, 1) as never);

    expect(offer?.objId).toBe(captured[0]?.obj_id);
    expect(offer?.languageDirection).toMatch(/^[a-z-]+>[a-z-]+$/);
    expect(offer?.eligible).toBe(true);
    expect(typeof offer?.effortWords).toBe('number');
    expect(typeof offer?.deadlineMs).toBe('number');
  });

  it('honours the exclusion list the config carries, so the lever reaches the parser', () => {
    const direction = createOfferExtractor({
      excludedLanguagePairs: [],
      logger: silentLogger(),
    })(captured.slice(0, 1) as never)[0]?.languageDirection;
    const cfg = loadStrakerBotConfig({ ...ENV, STRAKER_EXCLUDED_LANGUAGE_PAIRS: direction ?? '' });

    const [offer] = createOfferExtractor({
      excludedLanguagePairs: cfg.excludedLanguagePairs,
      logger: silentLogger(),
    })(captured.slice(0, 1) as never);

    expect(offer?.eligible).toBe(false);
  });
});

/**
 * FR-002 / V32 at the ORCHESTRATOR, not only inside `claim.ts`.
 *
 * `claimOffer` already narrows its own parameter to a post-only door, so nothing it does can
 * enquire first. What that narrowing could not reach was the value handed to it: the poll
 * cycle held a whole `StrakerHttpClient` and cast it down at the call site, so a diagnostic
 * `getJson` added anywhere in the cycle would have compiled. The cast is gone and the portal
 * carries the narrow door instead — which is the difference between a rule to remember and a
 * shape with nothing to break it with.
 */
type _PortalClientIsClaimOnly = keyof StrakerPortal['client'] extends 'postJson' ? true : never;

describe('the portal hands the cycle a claim door, not a client (FR-002, V32)', () => {
  it('keeps the compile-time lock visible in the run', () => {
    // The type above is the assertion; `npm run typecheck` is what enforces it.
    const lock: _PortalClientIsClaimOnly = true;
    expect(lock).toBe(true);
  });
});

describe('the composition root paces its requests (FR-019, SC-003, T065)', () => {
  /**
   * The third capability-unreachable guard in this file, and it exists because the first two
   * were not hypothetical: the retrying read door and the request deadline were each built,
   * tested and left with no production caller because the composition root never passed the
   * option that switches them on.
   *
   * Pacing is opt-in for the same reason those were — the live capture probe builds its
   * client with `{ baseUrl }` alone and must keep behaving exactly as it does. Which means
   * the bot getting paced is a fact about `createStrakerPortal`, provable nowhere else.
   */
  it('hands the transport a pacing policy, so the budget rules govern the running bot', async () => {
    // Driven through the real portal against a fetch that reports a budget already under
    // the deferrable floor. The reconciliation read goes through `getJson`, which is the
    // deferrable door, so a paced client must refuse it rather than spend the allowance.
    // The envelope shape `assigned-jobs` actually returns — a bare array is refused by the
    // read's own guard before pacing could ever be reached, which is how this test first
    // failed for the wrong reason.
    const lowBudget: typeof fetch = () =>
      Promise.resolve(
        new Response('{"items":[],"total":0}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': '300',
            'x-ratelimit-remaining': '5',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30),
          },
        }),
      );
    const portal = createStrakerPortal(loadStrakerBotConfig(ENV), silentLogger(), {
      fetchImpl: lowBudget,
    });

    // First read primes the budget from the reply; the second must be refused.
    await portal.listAssignedWork('vendor-1').catch(() => undefined);

    await expect(portal.listAssignedWork('vendor-1')).rejects.toSatisfy(isBudgetSuspended);
  });

  it('does not pace the claim, because an offer given up to save a request is not recoverable', async () => {
    // `essential` is the exception the policy names, and it has to reach the claim path:
    // shedding a claim to protect the allowance trades the irreversible thing for the
    // renewable one.
    const lowBudget: typeof fetch = () =>
      Promise.resolve(
        new Response('{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': '300',
            'x-ratelimit-remaining': '5',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30),
          },
        }),
      );
    const portal = createStrakerPortal(loadStrakerBotConfig(ENV), silentLogger(), {
      fetchImpl: lowBudget,
    });

    await portal.listAssignedWork('vendor-1').catch(() => undefined);

    await expect(portal.client.postJson('/api/vendors/v/job-offers/o/claim', {})).resolves.toEqual(
      {},
    );
  });
});

describe('signing in is never shed to protect the budget', () => {
  it('opens a session while the budget is below the deferrable floor', async () => {
    // `/auth/me` came through `getJson`, which pacing classifies as deferrable — so a bot
    // whose session expired exactly when the allowance ran low could not renew it, and
    // would stay blind for up to a window. The failure is safe but it is self-inflicted:
    // sign-in is what every other request depends on, so it belongs with the claim on the
    // essential side.
    const replies: Record<string, string> = {
      '/api/vendor/auth/login': '{"token":"t"}',
      '/api/vendor/auth/me': '{"member_obj_id":"vendor-1"}',
    };
    const lowBudget: typeof fetch = (input) => {
      const url = new URL(String(input));
      return Promise.resolve(
        new Response(replies[url.pathname] ?? '{}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': '300',
            'x-ratelimit-remaining': '5',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30),
          },
        }),
      );
    };
    const portal = createStrakerPortal(loadStrakerBotConfig(ENV), silentLogger(), {
      fetchImpl: lowBudget,
    });

    // Twice: the first primes the budget from the reply, the second would be shed if
    // sign-in went through the deferrable door.
    await portal.signIn();

    await expect(portal.signIn()).resolves.toMatchObject({ vendorId: 'vendor-1' });
  });
});
