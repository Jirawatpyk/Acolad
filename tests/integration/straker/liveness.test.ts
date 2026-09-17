import { describe, expect, it } from 'vitest';
import { loadStrakerBotConfig } from '../../../src/straker/config.js';
import {
  SingleInstanceRefused,
  startStrakerBot,
  strakerPingUrls,
} from '../../../src/straker/main.js';
import { idleCycle, recordingPinger, silentLogger } from './testDoubles.js';

/** Its own port: vitest runs test files in parallel, and another file starts a bot too. */
const TEST_PORT = 47902;

const ENV = {
  STRAKER_BASE_URL: 'https://vendr.straker.ai',
  STRAKER_LOGIN_ID: 'user@example.test',
  STRAKER_PASSWORD: 'pw',
  STRAKER_MAX_WORDS_PER_DAY: '2000',
  STRAKER_DTP_MAX_WORDS_PER_DAY: '30000',
  STRAKER_SHEETS_ID: 'sheet-straker',
  STRAKER_CHAT_WEBHOOK_OFFERS: 'https://chat.example.test/offers',
  GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example.test/ops',
  STRAKER_HEALTHCHECKS_PING_URL: 'https://hc.example.test/straker',
  STRAKER_SINGLE_INSTANCE_PORT: String(TEST_PORT),
};

/** The XTM bot's variable. Straker must never be satisfied by it. */
const XTM_PING = 'https://hc.example.test/acolad-xtm';

async function startWith(cycleOk: boolean | (() => boolean), env = ENV) {
  const pinger = recordingPinger();
  const bot = await startStrakerBot({
    cfg: loadStrakerBotConfig(env),
    logger: silentLogger(),
    heartbeat: pinger,
    cycle: idleCycle(cycleOk),
    lockRetryMs: 0,
  });
  return { bot, pinger };
}

describe('the Straker liveness signal is its own (FR-026a, FR-025, SC-010)', () => {
  it('pings a URL of its own, derived from its own variable', () => {
    const urls = strakerPingUrls(loadStrakerBotConfig(ENV));

    expect(urls.ok).toBe(ENV.STRAKER_HEALTHCHECKS_PING_URL);
    expect(urls.fail).toBe(`${ENV.STRAKER_HEALTHCHECKS_PING_URL}/fail`);
  });

  it('is not satisfied by the XTM bot own liveness variable', () => {
    const { STRAKER_HEALTHCHECKS_PING_URL: _omitted, ...withoutOwnPing } = ENV;

    // A shared signal is the failure this requirement exists to prevent: one bot can die
    // while the other keeps reporting health, and nobody notices until work stops arriving.
    expect(() =>
      loadStrakerBotConfig({ ...withoutOwnPing, HEALTHCHECKS_PING_URL: XTM_PING }),
    ).toThrow(/STRAKER_HEALTHCHECKS_PING_URL/);
  });

  it('never points at the XTM bot signal even when both variables are present', () => {
    const urls = strakerPingUrls(loadStrakerBotConfig({ ...ENV, HEALTHCHECKS_PING_URL: XTM_PING }));

    expect(urls.ok).not.toContain('acolad-xtm');
    expect(urls.fail).not.toContain('acolad-xtm');
  });
});

describe('what the Straker bot signals, cycle by cycle', () => {
  it('signals alive after a successful cycle', async () => {
    const { bot, pinger } = await startWith(true);

    await bot.runOnce();
    await bot.stop();

    expect(pinger.pings).toEqual(['ok']);
  });

  it('signals failing — not silence — after a failed cycle, so a limping bot is tellable from a dead machine', async () => {
    const { bot, pinger } = await startWith(false);

    await bot.runOnce();
    await bot.stop();

    expect(pinger.pings).toEqual(['fail']);
  });

  it('signals failing when a cycle throws, rather than letting the loop die unannounced', async () => {
    const pinger = recordingPinger();
    const bot = await startStrakerBot({
      cfg: loadStrakerBotConfig(ENV),
      logger: silentLogger(),
      heartbeat: pinger,
      cycle: {
        runOnce: () => Promise.reject(new Error('portal unreachable')),
      },
      lockRetryMs: 0,
    });

    await expect(bot.runOnce()).resolves.toBe(false);
    await bot.stop();

    expect(pinger.pings).toEqual(['fail']);
  });

  it('keeps signalling across cycles rather than only at startup', async () => {
    const outcomes = [true, false, true];
    let i = 0;
    const { bot, pinger } = await startWith(() => outcomes[i++] ?? true);

    await bot.runOnce();
    await bot.runOnce();
    await bot.runOnce();
    await bot.stop();

    expect(pinger.pings).toEqual(['ok', 'fail', 'ok']);
  });
});

describe('a Straker bot that cannot start is noticed on its own (SC-010)', () => {
  it('signals failing before refusing, so a blocked start is not silent', async () => {
    const cfg = loadStrakerBotConfig(ENV);
    const first = await startStrakerBot({
      cfg,
      logger: silentLogger(),
      heartbeat: recordingPinger(),
      cycle: idleCycle(),
      lockRetryMs: 0,
    });

    const secondPinger = recordingPinger();
    await expect(
      startStrakerBot({
        cfg,
        logger: silentLogger(),
        heartbeat: secondPinger,
        cycle: idleCycle(),
        lockRetryMs: 0,
      }),
    ).rejects.toBeInstanceOf(SingleInstanceRefused);

    // Nobody watches `pm2 status`. The refusal has to reach the dead-man switch itself,
    // because at this point the bot has no running loop to signal from.
    expect(secondPinger.pings).toEqual(['fail']);
    await first.stop();
  });
});
