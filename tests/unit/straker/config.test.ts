import { describe, expect, it } from 'vitest';
import { loadStrakerBotConfig, loadStrakerReconConfig } from '../../../src/straker/config.js';

const VALID = {
  STRAKER_BASE_URL: 'https://vendr.straker.ai',
  STRAKER_LOGIN_ID: 'user@example.test',
  STRAKER_PASSWORD: 'pw',
};

/** The bot needs everything the probe needs, plus its own ceiling, reporting and liveness. */
const VALID_BOT = {
  ...VALID,
  STRAKER_MAX_WORDS_PER_DAY: '2000',
  STRAKER_SHEETS_ID: 'sheet-straker',
  STRAKER_CHAT_WEBHOOK_OFFERS: 'https://chat.example.test/straker-offers',
  GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example.test/ops',
  STRAKER_HEALTHCHECKS_PING_URL: 'https://hc.example.test/straker',
};

describe('loadStrakerReconConfig', () => {
  it('names the missing variable when a required secret is absent', () => {
    const { STRAKER_PASSWORD: _omitted, ...withoutPassword } = VALID;

    expect(() => loadStrakerReconConfig(withoutPassword)).toThrow(/STRAKER_PASSWORD/);
  });

  it('defaults the poll interval to the 10s the brief budgets for (2% of 300 req/min)', () => {
    expect(loadStrakerReconConfig(VALID).pollIntervalMs).toBe(10_000);
  });

  it('refuses a poll interval below 1s so the probe cannot burn the request budget', () => {
    expect(() => loadStrakerReconConfig({ ...VALID, STRAKER_POLL_INTERVAL_MS: '200' })).toThrow(
      /STRAKER_POLL_INTERVAL_MS/,
    );
  });

  it('still loads without any of the bot-only variables, so shipping the bot config cannot stop the live probe', () => {
    expect(() => loadStrakerReconConfig(VALID)).not.toThrow();
  });
});

describe('loadStrakerBotConfig — isolation from the XTM bot (FR-024)', () => {
  it('defaults the single-instance port to 47812, never the 47811 the XTM bot holds', () => {
    const cfg = loadStrakerBotConfig(VALID_BOT);

    expect(cfg.singleInstancePort).toBe(47812);
    expect(cfg.singleInstancePort).not.toBe(47811);
  });

  it('defaults the state directory below the XTM bot rather than into it', () => {
    const cfg = loadStrakerBotConfig(VALID_BOT);

    expect(cfg.stateDir).toBe('state/straker');
    expect(cfg.stateDir).not.toBe('state');
  });

  it('refuses to start when its state directory is the XTM bot own, which would share a database file', () => {
    expect(() => loadStrakerBotConfig({ ...VALID_BOT, STRAKER_STATE_DIR: 'state' })).toThrow(
      /STRAKER_STATE_DIR/,
    );
  });

  it('refuses to start when its single-instance port is the one the XTM bot holds', () => {
    expect(() =>
      loadStrakerBotConfig({ ...VALID_BOT, STRAKER_SINGLE_INSTANCE_PORT: '47811' }),
    ).toThrow(/STRAKER_SINGLE_INSTANCE_PORT/);
  });
});

describe('loadStrakerBotConfig — its own ceiling and throughput (FR-009)', () => {
  it('requires its own daily ceiling and names it when absent', () => {
    const { STRAKER_MAX_WORDS_PER_DAY: _omitted, ...withoutCeiling } = VALID_BOT;

    expect(() => loadStrakerBotConfig(withoutCeiling)).toThrow(/STRAKER_MAX_WORDS_PER_DAY/);
  });

  it('refuses a ceiling of zero, which would silently claim nothing rather than claim freely', () => {
    expect(() => loadStrakerBotConfig({ ...VALID_BOT, STRAKER_MAX_WORDS_PER_DAY: '0' })).toThrow(
      /STRAKER_MAX_WORDS_PER_DAY/,
    );
  });

  it('derives throughput from its own ceiling and the working window, not from the XTM figure', () => {
    const cfg = loadStrakerBotConfig({
      ...VALID_BOT,
      STRAKER_MAX_WORDS_PER_DAY: '900',
      ACCEPT_HOURS_START: '09:00',
      ACCEPT_HOURS_END: '18:00',
    });

    expect(cfg.throughputWordsPerHour).toBe(100);
  });

  it('lets an explicit throughput pin the derived one, for the slowest direction the crew handles', () => {
    const cfg = loadStrakerBotConfig({
      ...VALID_BOT,
      STRAKER_MAX_WORDS_PER_DAY: '900',
      STRAKER_THROUGHPUT_WORDS_PER_HOUR: '40',
    });

    expect(cfg.throughputWordsPerHour).toBe(40);
  });
});

describe('loadStrakerBotConfig — its own reporting and liveness (FR-014, FR-015, FR-026a/b)', () => {
  it('requires its own tracking file, separate from the XTM record', () => {
    const { STRAKER_SHEETS_ID: _omitted, ...withoutSheet } = VALID_BOT;

    expect(() => loadStrakerBotConfig(withoutSheet)).toThrow(/STRAKER_SHEETS_ID/);
  });

  it('requires its own announcement channel', () => {
    const { STRAKER_CHAT_WEBHOOK_OFFERS: _omitted, ...withoutChannel } = VALID_BOT;

    expect(() => loadStrakerBotConfig(withoutChannel)).toThrow(/STRAKER_CHAT_WEBHOOK_OFFERS/);
  });

  it('reads alerts from the single existing operations channel rather than a Straker-only one', () => {
    const cfg = loadStrakerBotConfig(VALID_BOT);

    expect(cfg.alertsWebhookUrl).toBe(VALID_BOT.GOOGLE_CHAT_WEBHOOK_SYSTEM);
    expect(cfg.alertsWebhookUrl).not.toBe(cfg.offersWebhookUrl);
  });

  it('requires its own liveness ping so either bot stopping is noticed on its own', () => {
    const { STRAKER_HEALTHCHECKS_PING_URL: _omitted, ...withoutPing } = VALID_BOT;

    expect(() => loadStrakerBotConfig(withoutPing)).toThrow(/STRAKER_HEALTHCHECKS_PING_URL/);
  });
});

describe('loadStrakerBotConfig — eligibility exclusion list', () => {
  it('defaults the exclusion list to empty, so the agreed all-44-directions behaviour is unchanged', () => {
    expect(loadStrakerBotConfig(VALID_BOT).excludedLanguagePairs).toEqual([]);
  });

  it('parses a comma-separated exclusion list, trimmed and case-folded for comparison', () => {
    const cfg = loadStrakerBotConfig({
      ...VALID_BOT,
      STRAKER_EXCLUDED_LANGUAGE_PAIRS: 'en-US>ja-JP , EN-US>KO-KR',
    });

    expect(cfg.excludedLanguagePairs).toEqual(['en-us>ja-jp', 'en-us>ko-kr']);
  });
});

describe('loadStrakerBotConfig — the scheduling rules are the team own, reused unchanged', () => {
  it('reads the shared working window and workdays rather than defining Straker-only ones', () => {
    const cfg = loadStrakerBotConfig({
      ...VALID_BOT,
      ACCEPT_HOURS_START: '08:30',
      ACCEPT_HOURS_END: '17:30',
      ACCEPT_WORKDAYS: '1-6',
    });

    expect(cfg.hoursStartMin).toBe(8 * 60 + 30);
    expect(cfg.hoursEndMin).toBe(17 * 60 + 30);
    expect([...cfg.workdays].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('keeps the poll rhythm independent of the XTM bot (FR-001)', () => {
    const cfg = loadStrakerBotConfig({ ...VALID_BOT, STRAKER_POLL_INTERVAL_MS: '1000' });

    expect(cfg.pollIntervalMs).toBe(1_000);
  });
});

describe('loadStrakerBotConfig — the path the documentation actually tells an operator to take', () => {
  /**
   * `.env.example` ships several variables as bare `KEY=` lines whose comments say "empty =
   * derived" or "leave blank until 2FA is on". dotenv turns those into `''`, not `undefined`
   * — and zod's `.optional()` and `.default()` only treat `undefined` as absent, while
   * `z.coerce.number()` turns `''` into 0. So the documented happy path threw, and a first
   * deploy would have been a PM2 crash loop with the operator having followed the file
   * exactly. The XTM config already carries this fix; this one did not.
   */
  const BLANK = {
    ...VALID_BOT,
    STRAKER_TOTP_CODE: '',
    STRAKER_THROUGHPUT_WORDS_PER_HOUR: '',
    STRAKER_SHEETS_TAB_NAME: '',
    STRAKER_STATE_DIR: '',
    STRAKER_LOG_DIR: '',
    STRAKER_SINGLE_INSTANCE_PORT: '',
    STRAKER_POLL_INTERVAL_MS: '',
    STRAKER_EXCLUDED_LANGUAGE_PAIRS: '',
    ACCEPT_HOURS_START: '',
    ACCEPT_HOURS_END: '',
    ACCEPT_WORKDAYS: '',
  };

  it('loads when every optional variable is present but blank, as copying the example leaves them', () => {
    expect(() => loadStrakerBotConfig(BLANK)).not.toThrow();
  });

  it('treats a blank throughput as "derive it", which is what the comment beside it promises', () => {
    const cfg = loadStrakerBotConfig({ ...BLANK, STRAKER_MAX_WORDS_PER_DAY: '900' });

    expect(cfg.throughputWordsPerHour).toBe(100);
  });

  it('falls back to each default rather than rejecting the blank line that stands for it', () => {
    const cfg = loadStrakerBotConfig(BLANK);

    expect(cfg.singleInstancePort).toBe(47812);
    expect(cfg.stateDir).toBe('state/straker');
    expect(cfg.trackingTabName).toBe('Straker_Tracking');
    expect(cfg.pollIntervalMs).toBe(10_000);
    expect(cfg.hoursStartMin).toBe(9 * 60);
    expect([...cfg.workdays].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('still rejects a blank value for a variable that has no default and no derivation', () => {
    // Blank must mean "absent", not "zero" — and absent is still fatal for the ceiling,
    // which the code must never guess (U4 leaves the real number unknown until the probe).
    expect(() => loadStrakerBotConfig({ ...BLANK, STRAKER_MAX_WORDS_PER_DAY: '' })).toThrow(
      /STRAKER_MAX_WORDS_PER_DAY/,
    );
  });

  it('leaves the probe loader able to start from the same blank lines', () => {
    expect(() =>
      loadStrakerReconConfig({ ...VALID, STRAKER_TOTP_CODE: '', STRAKER_POLL_INTERVAL_MS: '' }),
    ).not.toThrow();
  });
});
