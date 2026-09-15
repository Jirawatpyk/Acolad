import { describe, expect, it, vi } from 'vitest';
import { loadStrakerBotConfig } from '../../../src/straker/config.js';
import {
  type StrakerHttpClient,
  type StrakerTransportWarning,
} from '../../../src/straker/httpClient.js';
import { listOpenOffers } from '../../../src/straker/offersApi.js';
import { createStrakerPortal, startStrakerBot } from '../../../src/straker/main.js';
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
