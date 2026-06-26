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

  it('rejects a window smaller than 3x the poll interval (fail-fast)', () => {
    expect(() =>
      loadConfig(validEnv({ POLL_INTERVAL_MS: '20000', XTM_YIELD_WINDOW_MS: '40000' })),
    ).toThrow(/XTM_YIELD_WINDOW_MS/);
  });

  it('accepts a window exactly 3x the poll interval', () => {
    const cfg = loadConfig(validEnv({ POLL_INTERVAL_MS: '20000', XTM_YIELD_WINDOW_MS: '60000' }));
    expect(cfg.XTM_YIELD_WINDOW_MS).toBe(60_000);
  });
});
