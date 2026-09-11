import { describe, expect, it } from 'vitest';
import { loadStrakerReconConfig } from '../../../src/straker/config.js';

const VALID = {
  STRAKER_BASE_URL: 'https://vendr.straker.ai',
  STRAKER_LOGIN_ID: 'user@example.test',
  STRAKER_PASSWORD: 'pw',
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
});
