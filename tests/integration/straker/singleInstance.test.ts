import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadStrakerBotConfig } from '../../../src/straker/config.js';
import { SingleInstanceRefused, startStrakerBot } from '../../../src/straker/main.js';
import { silentLogger, recordingPinger, idleCycle } from './testDoubles.js';

/**
 * Behavioural tests bind a real port, and vitest runs test FILES in parallel — so each
 * file that starts a bot uses a port of its own. The production default (47812) is asserted
 * from configuration instead, where no binding is involved: asserting it here would make
 * these tests fail whenever the real bot happened to be running on the host.
 */
const TEST_PORT = 47901;

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
};

const held: Server[] = [];

function holdPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((sock) => sock.destroy());
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      held.push(server);
      resolve();
    });
  });
}

function startBot(env = ENV) {
  return startStrakerBot({
    cfg: loadStrakerBotConfig(env),
    logger: silentLogger(),
    heartbeat: recordingPinger(),
    cycle: idleCycle(),
    // No retry window: these tests are about the refusal, not about waiting one out.
    lockRetryMs: 0,
  });
}

afterEach(async () => {
  await Promise.all(held.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
});

describe('the Straker bot takes a port of its own (FR-024, T011)', () => {
  it('defaults to 47812, never the 47811 the live XTM bot holds', () => {
    const { STRAKER_SINGLE_INSTANCE_PORT: _overridden, ...defaults } = ENV;

    expect(loadStrakerBotConfig(defaults).singleInstancePort).toBe(47812);
  });
});

describe('single-instance lock (T011, T012)', () => {
  it('refuses to start when its port is already held', async () => {
    await holdPort(TEST_PORT);

    await expect(startBot()).rejects.toBeInstanceOf(SingleInstanceRefused);
  });

  it('holds its port for as long as it runs, so a second instance cannot start', async () => {
    const bot = await startBot();

    await expect(holdPort(TEST_PORT)).rejects.toThrow(/EADDRINUSE/);

    await bot.stop();
  });

  it('releases the port on stop, so a redeploy can take it straight back', async () => {
    const bot = await startBot();
    await bot.stop();

    // Proof the lock was actually released rather than merely reported as released:
    // if it were still held, binding the same port here would throw EADDRINUSE.
    await expect(holdPort(TEST_PORT)).resolves.toBeUndefined();
  });

  it('stops twice without error, so a signal arriving during shutdown is harmless', async () => {
    const bot = await startBot();

    await bot.stop();
    await expect(bot.stop()).resolves.toBeUndefined();
  });
});
