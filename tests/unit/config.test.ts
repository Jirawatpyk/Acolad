import { describe, it, expect } from 'vitest';
import { loadConfig, secretValues } from '../../src/config/index.js';

/** Minimal valid env for 002 (XTM + Sheets + shared required keys). */
const base = {
  // XTM Cloud (002 target)
  XTM_ACOLAD_PORTAL_URL: 'https://www.xtm-cloud.com/project-manager-ui/login.jsp',
  XTM_ACOLAD_OFFERS_URL: 'https://www.xtm-cloud.com/project-manager-ui/',
  XTM_ACOLAD_Company: 'AMPLEXOR',
  XTM_ACOLAD_Username: 'EQHO',
  XTM_ACOLAD_Password: 'xtm-secret-pw',
  // Google Sheets (002 required)
  GOOGLE_SHEETS_ID: '1IC7kTfKTr5uN0ZHEB',
  SHEETS_TAB_NAME: 'Tasks',
  // shared (001) — still required
  GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.googleapis.com/v1/spaces/X/messages?key=k&token=t',
  GOOGLE_CHAT_WEBHOOK_TEAM: 'https://chat.googleapis.com/v1/spaces/TEAM/messages?key=k&token=t',
  HEALTHCHECKS_PING_URL: 'https://hc-ping.com/abc',
};

describe('loadConfig', () => {
  it('applies defaults for optional vars (002 values)', () => {
    const cfg = loadConfig({ ...base });
    // 002 lowers the poll floor to 20s to win the <1min snatch window (R7).
    expect(cfg.POLL_INTERVAL_MS).toBe(20_000);
    expect(cfg.LOGIN_MAX_RETRY).toBe(3);
    expect(cfg.TZ_DISPLAY).toBe('Asia/Bangkok');
    expect(cfg.LIVE_PORTAL).toBe(false);
    // accept control — safe defaults (FR-012/025)
    expect(cfg.ACCEPT_ENABLED).toBe(false);
    expect(cfg.ACCEPT_LANGUAGES).toEqual(['Malay (Malaysia)']);
    expect(cfg.ACCEPT_MAX_WORDS).toBe(0);
    expect(cfg.ACCEPT_MAX_PER_CYCLE).toBe(0);
    expect(cfg.GOOGLE_SERVICE_ACCOUNT_KEY_PATH).toBe('google-credentials.json');
  });

  it('names the offending variable when a required XTM one is missing', () => {
    const { XTM_ACOLAD_Password: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/XTM_ACOLAD_Password/);
  });

  it('requires SHEETS_TAB_NAME', () => {
    const { SHEETS_TAB_NAME: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/SHEETS_TAB_NAME/);
  });

  it('requires GOOGLE_SHEETS_ID', () => {
    const { GOOGLE_SHEETS_ID: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/GOOGLE_SHEETS_ID/);
  });

  it('rejects POLL_INTERVAL_MS below 20000 (FR-011)', () => {
    expect(() => loadConfig({ ...base, POLL_INTERVAL_MS: '19999' })).toThrow(/POLL_INTERVAL_MS/);
  });

  it('rejects POLL_INTERVAL_MS above 25000 (FR-003 headroom)', () => {
    expect(() => loadConfig({ ...base, POLL_INTERVAL_MS: '26000' })).toThrow(/POLL_INTERVAL_MS/);
  });

  it('accepts LIVE_PORTAL=1 as boolean true', () => {
    expect(loadConfig({ ...base, LIVE_PORTAL: '1' }).LIVE_PORTAL).toBe(true);
  });

  it('accepts ACCEPT_ENABLED=1 as boolean true (kill-switch on)', () => {
    expect(loadConfig({ ...base, ACCEPT_ENABLED: '1' }).ACCEPT_ENABLED).toBe(true);
  });

  it('defaults ACCEPT_RECON to false and parses =1 as true (hover-only menu capture)', () => {
    expect(loadConfig({ ...base }).ACCEPT_RECON).toBe(false);
    expect(loadConfig({ ...base, ACCEPT_RECON: '1' }).ACCEPT_RECON).toBe(true);
  });

  it('parses ACCEPT_LANGUAGES as a trimmed csv list', () => {
    const cfg = loadConfig({ ...base, ACCEPT_LANGUAGES: 'Malay (Malaysia), Thai , ' });
    expect(cfg.ACCEPT_LANGUAGES).toEqual(['Malay (Malaysia)', 'Thai']);
  });

  it('coerces ACCEPT_MAX_WORDS from string to a non-negative int', () => {
    expect(loadConfig({ ...base, ACCEPT_MAX_WORDS: '500' }).ACCEPT_MAX_WORDS).toBe(500);
    expect(() => loadConfig({ ...base, ACCEPT_MAX_WORDS: '-1' })).toThrow(/ACCEPT_MAX_WORDS/);
  });

  it('secretValues redacts XTM credentials and excludes empty optionals', () => {
    const cfg = loadConfig({ ...base });
    const secrets = secretValues(cfg);
    expect(secrets).toContain('xtm-secret-pw');
    expect(secrets).toContain('EQHO');
    expect(secrets).toContain('AMPLEXOR');
    expect(secrets).toContain('https://hc-ping.com/abc');
    expect(secrets).not.toContain('');
  });

  it('requires GOOGLE_CHAT_WEBHOOK_TEAM (missing → throws with var name)', () => {
    const { GOOGLE_CHAT_WEBHOOK_TEAM: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/GOOGLE_CHAT_WEBHOOK_TEAM/);
  });

  it('secretValues includes GOOGLE_CHAT_WEBHOOK_TEAM value (must be redacted in logs)', () => {
    const cfg = loadConfig({ ...base });
    const secrets = secretValues(cfg);
    expect(secrets).toContain('https://chat.googleapis.com/v1/spaces/TEAM/messages?key=k&token=t');
  });
});

/** Wrap base with per-test overrides (string values only, mirrors ProcessEnv). */
function validEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...base, ...over };
}

describe('auto-yield config', () => {
  it('defaults yield enabled, window 600000ms, max 60 min', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.XTM_YIELD_ENABLED).toBe(true);
    expect(cfg.XTM_YIELD_WINDOW_MS).toBe(600_000);
    expect(cfg.XTM_YIELD_MAX_MINUTES).toBe(60);
  });

  it('can be disabled via XTM_YIELD_ENABLED=0', () => {
    expect(loadConfig(validEnv({ XTM_YIELD_ENABLED: '0' })).XTM_YIELD_ENABLED).toBe(false);
  });

  it('kill-switch disables on false/off/0 and stays enabled on 1 or unset (footgun guard)', () => {
    expect(loadConfig(validEnv({ XTM_YIELD_ENABLED: 'false' })).XTM_YIELD_ENABLED).toBe(false);
    expect(loadConfig(validEnv({ XTM_YIELD_ENABLED: 'off' })).XTM_YIELD_ENABLED).toBe(false);
    expect(loadConfig(validEnv({ XTM_YIELD_ENABLED: '0' })).XTM_YIELD_ENABLED).toBe(false);
    expect(loadConfig(validEnv({ XTM_YIELD_ENABLED: '1' })).XTM_YIELD_ENABLED).toBe(true);
    expect(loadConfig(validEnv()).XTM_YIELD_ENABLED).toBe(true);
  });

  it('rejects a window smaller than 3x the poll interval when yield is ENABLED (fail-fast)', () => {
    expect(() =>
      loadConfig(
        validEnv({
          XTM_YIELD_ENABLED: '1',
          POLL_INTERVAL_MS: '20000',
          XTM_YIELD_WINDOW_MS: '40000',
        }),
      ),
    ).toThrow(/XTM_YIELD_WINDOW_MS/);
  });

  it('accepts a window exactly 3x the poll interval', () => {
    const cfg = loadConfig(validEnv({ POLL_INTERVAL_MS: '20000', XTM_YIELD_WINDOW_MS: '60000' }));
    expect(cfg.XTM_YIELD_WINDOW_MS).toBe(60_000);
  });

  it('does NOT reject a sub-3x window when yield is DISABLED — kill-switch is never blocked (F7)', () => {
    // The refine must be gated on XTM_YIELD_ENABLED so an operator can always disable the
    // feature without first having to fix an unrelated window value.
    const cfg = loadConfig(
      validEnv({ XTM_YIELD_ENABLED: '0', POLL_INTERVAL_MS: '20000', XTM_YIELD_WINDOW_MS: '40000' }),
    );
    expect(cfg.XTM_YIELD_ENABLED).toBe(false);
    expect(cfg.XTM_YIELD_WINDOW_MS).toBe(40_000);
  });
});

describe('ACCEPT_SCHEDULE config', () => {
  it('defaults: enabled ON, derived throughput 1000/9', () => {
    const c = loadConfig({ ...base });
    expect(c.ACCEPT_SCHEDULE_ENABLED).toBe(true);
    expect(c.hoursStartMin).toBe(540);
    expect(c.hoursEndMin).toBe(1080);
    expect([...c.workdays]).toEqual([1, 2, 3, 4, 5]);
    expect(c.throughputPerHour).toBeCloseTo(1000 / 9, 5);
  });

  it("kill-switch '0' disables", () => {
    expect(loadConfig({ ...base, ACCEPT_SCHEDULE_ENABLED: '0' }).ACCEPT_SCHEDULE_ENABLED).toBe(
      false,
    );
  });

  it('empty throughput → derived from cap (not 0)', () => {
    // words mode: empty ACCEPT_THROUGHPUT_WORDS_PER_HOUR → derived from cap (1000/9h)
    expect(
      loadConfig({ ...base, ACCEPT_EFFORT_METRIC: 'words', ACCEPT_THROUGHPUT_WORDS_PER_HOUR: '' }).throughputPerHour,
    ).toBeCloseTo(1000 / 9, 5);
  });

  it('explicit throughput override wins over derived (words mode)', () => {
    expect(
      loadConfig({ ...base, ACCEPT_EFFORT_METRIC: 'words', ACCEPT_THROUGHPUT_WORDS_PER_HOUR: '100' }).throughputPerHour,
    ).toBe(100);
  });

  it('refine: start>=end rejected when enabled', () => {
    expect(() =>
      loadConfig({ ...base, ACCEPT_HOURS_START: '18:00', ACCEPT_HOURS_END: '09:00' }),
    ).toThrow();
  });

  it('refine: words-mode capacity=0 without explicit throughput rejected when enabled', () => {
    // Must specify words mode explicitly — the default metric is wwc, and the words-cap
    // refine is correctly gated to words mode only (I-2).
    expect(() =>
      loadConfig({ ...base, ACCEPT_EFFORT_METRIC: 'words', ACCEPT_MAX_WORDS_PER_DAY: '0' }),
    ).toThrow();
  });

  it('disabled: bad values do NOT block startup (kill-switch always works)', () => {
    expect(() =>
      loadConfig({ ...base, ACCEPT_SCHEDULE_ENABLED: '0', ACCEPT_MAX_WORDS_PER_DAY: '0' }),
    ).not.toThrow();
  });
});

describe('ACCEPT_EFFORT_METRIC config', () => {
  it('defaults ACCEPT_EFFORT_METRIC to wwc', () => {
    expect(loadConfig(base).ACCEPT_EFFORT_METRIC).toBe('wwc');
  });
  it('rejects an invalid ACCEPT_EFFORT_METRIC at startup (fail-fast)', () => {
    expect(() => loadConfig({ ...base, ACCEPT_EFFORT_METRIC: 'weighted' })).toThrow();
  });
  it('metric=wwc → active cap = ACCEPT_MAX_WWC_PER_DAY, throughput derived from it', () => {
    const c = loadConfig({ ...base, ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: '900' });
    expect(c.activeMaxPerDay).toBe(900);
    expect(c.throughputPerHour).toBeCloseTo(900 / 9, 5);
    expect(c.unit).toEqual({ adj: 'WWC', noun: 'WWC' });
  });
  it('metric=words → active cap = ACCEPT_MAX_WORDS_PER_DAY (byte-for-byte), unit words', () => {
    const c = loadConfig({
      ...base,
      ACCEPT_EFFORT_METRIC: 'words',
      ACCEPT_MAX_WORDS_PER_DAY: '1000',
    });
    expect(c.activeMaxPerDay).toBe(1000);
    expect(c.throughputPerHour).toBeCloseTo(1000 / 9, 5);
    expect(c.unit).toEqual({ adj: 'word', noun: 'words' });
  });
  it('D7 override isolation: a WORDS override does not leak into wwc throughput', () => {
    const c = loadConfig({
      ...base,
      ACCEPT_EFFORT_METRIC: 'wwc',
      ACCEPT_THROUGHPUT_WORDS_PER_HOUR: '50',
      ACCEPT_MAX_WWC_PER_DAY: '900',
    });
    expect(c.throughputPerHour).toBeCloseTo(100, 5); // 900/9, NOT 50
  });
  it('explicit-0 WWC cap fails fast even with an override set', () => {
    expect(() =>
      loadConfig({
        ...base,
        ACCEPT_EFFORT_METRIC: 'wwc',
        ACCEPT_MAX_WWC_PER_DAY: '0',
        ACCEPT_THROUGHPUT_WWC_PER_HOUR: '111',
      }),
    ).toThrow();
  });

  it('I-2 dynamic path: words mode + cap 0 + explicit throughput → error names ACCEPT_MAX_WORDS_PER_DAY (not WWC)', () => {
    // When ACCEPT_EFFORT_METRIC=words and ACCEPT_MAX_WORDS_PER_DAY=0, the superRefine must
    // name ACCEPT_MAX_WORDS_PER_DAY in the error path, not ACCEPT_MAX_WWC_PER_DAY. An operator
    // in words mode seeing the wrong var name would fix the wrong knob → prolonged outage.
    const err = (() => {
      try {
        loadConfig({
          ...base,
          ACCEPT_EFFORT_METRIC: 'words',
          ACCEPT_MAX_WORDS_PER_DAY: '0',
          ACCEPT_THROUGHPUT_WORDS_PER_HOUR: '111',
        });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    expect(err).not.toBeNull();
    expect(err).toContain('ACCEPT_MAX_WORDS_PER_DAY');
    expect(err).not.toContain('ACCEPT_MAX_WWC_PER_DAY');
  });
  it('kill-switch escape: schedule disabled + wwc + cap 0 does NOT throw', () => {
    expect(() =>
      loadConfig({
        ...base,
        ACCEPT_SCHEDULE_ENABLED: '0',
        ACCEPT_EFFORT_METRIC: 'wwc',
        ACCEPT_MAX_WWC_PER_DAY: '0',
      }),
    ).not.toThrow();
  });

  it('wwc mode + zeroed words cap is valid (I-2: words-cap refine must not fire in wwc mode)', () => {
    // An operator in wwc mode who sets ACCEPT_MAX_WORDS_PER_DAY=0 ("unused in wwc") must NOT
    // hit the words-throughput-resolvability refine — that refine only guards words mode.
    // The wwc active-cap refines already guard throughput resolvability in wwc mode.
    expect(() =>
      loadConfig({
        ...base,
        ACCEPT_EFFORT_METRIC: 'wwc',
        ACCEPT_MAX_WORDS_PER_DAY: '0',
        ACCEPT_MAX_WWC_PER_DAY: '1000',
      }),
    ).not.toThrow();
  });
});
