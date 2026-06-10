import { describe, it, expect } from 'vitest';
import { loadConfig, secretValues } from '../../src/config/index.js';

const base = {
  ACOLAD_PORTAL_URL: 'https://partner.acolad.com/login',
  ACOLAD_EMAIL: 'team@example.com',
  ACOLAD_PASSWORD: 'secret-pw',
  GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.googleapis.com/v1/spaces/X/messages?key=k&token=t',
  HEALTHCHECKS_PING_URL: 'https://hc-ping.com/abc',
};

describe('loadConfig', () => {
  it('applies defaults for optional vars', () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.POLL_INTERVAL_MS).toBe(25_000);
    expect(cfg.LOGIN_MAX_RETRY).toBe(3);
    expect(cfg.TZ_DISPLAY).toBe('Asia/Bangkok');
    expect(cfg.LIVE_PORTAL).toBe(false);
  });

  it('names the offending variable when a required one is missing', () => {
    const { ACOLAD_PASSWORD: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/ACOLAD_PASSWORD/);
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

  it('secretValues excludes empty optional webhook', () => {
    const cfg = loadConfig({ ...base });
    const secrets = secretValues(cfg);
    expect(secrets).toContain('secret-pw');
    expect(secrets).toContain('https://hc-ping.com/abc');
    expect(secrets).not.toContain('');
  });
});
