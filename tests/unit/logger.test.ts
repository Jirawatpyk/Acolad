import { describe, it, expect } from 'vitest';
import { maskString, redactSecrets } from '../../src/monitoring/logger.js';

/**
 * Regression guard for the credential leak (FR-012, Constitution V): a Playwright
 * error echoes the `.fill("<password>")` argument, and that string used to reach
 * the log as the message. maskString must scrub every concrete secret value from
 * ANY string — including a multi-line error message.
 */
describe('maskString (concrete-value redaction)', () => {
  const PW = 'On!y4Eqh0PMn@k@x'; // not a real secret — shape only
  const secrets = [PW, 'webhook-token-xyz'];

  it('scrubs a secret embedded in a multi-line Playwright error message', () => {
    const leak = `locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - fill("${PW}")\n  - retrying`;
    const masked = maskString(leak, secrets);
    expect(masked).not.toContain(PW);
    expect(masked).toContain('[REDACTED]');
    expect(masked).toContain('locator.fill: Timeout'); // non-secret context preserved
  });

  it('scrubs every occurrence of a repeated secret', () => {
    expect(maskString(`${PW} and again ${PW}`, secrets)).toBe('[REDACTED] and again [REDACTED]');
  });

  it('scrubs multiple distinct secrets in one string', () => {
    expect(maskString(`pw=${PW} token=webhook-token-xyz`, secrets)).toBe(
      'pw=[REDACTED] token=[REDACTED]',
    );
  });

  it('leaves a string with no secrets unchanged and is a no-op for empty secret lists', () => {
    expect(maskString('nothing secret here', secrets)).toBe('nothing secret here');
    expect(maskString(`contains ${PW}`, [])).toBe(`contains ${PW}`);
  });
});

describe('redactSecrets (object field scrubbing)', () => {
  const secrets = ['s3cr3t-value'];

  it('masks secret values inside string fields, leaving non-strings untouched', () => {
    const out = redactSecrets(
      { msg: 'logged s3cr3t-value here', latencyMs: 42, ok: true },
      secrets,
    );
    expect(out.msg).toBe('logged [REDACTED] here');
    expect(out.latencyMs).toBe(42);
    expect(out.ok).toBe(true);
  });
});
