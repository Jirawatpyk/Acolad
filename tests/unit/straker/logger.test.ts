import { describe, expect, it } from 'vitest';
import { loadStrakerBotConfig, strakerSecretValues } from '../../../src/straker/config.js';
import { STRAKER_LOG_NAME, withRedaction } from '../../../src/straker/logger.js';

const ENV = {
  STRAKER_BASE_URL: 'https://vendr.straker.ai',
  STRAKER_LOGIN_ID: 'user@example.test',
  STRAKER_PASSWORD: 'hunter2-straker',
  STRAKER_MAX_WORDS_PER_DAY: '2000',
  STRAKER_DTP_MAX_WORDS_PER_DAY: '30000',
  STRAKER_SHEETS_ID: 'sheet-straker',
  STRAKER_CHAT_WEBHOOK_OFFERS: 'https://chat.example.test/offers-secret-token',
  GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://chat.example.test/ops-secret-token',
  STRAKER_HEALTHCHECKS_PING_URL: 'https://hc.example.test/straker-uuid',
};

/** A pino-shaped sink that records what would have been written. */
function recordingSink(): {
  lines: { level: string; fields: Record<string, unknown>; msg?: string }[];
  pino: Parameters<typeof withRedaction>[0];
} {
  const lines: { level: string; fields: Record<string, unknown>; msg?: string }[] = [];
  const at =
    (level: string) =>
    (fields: Record<string, unknown>, msg?: string): void => {
      lines.push(msg === undefined ? { level, fields } : { level, fields, msg });
    };
  return {
    lines,
    pino: { info: at('info'), warn: at('warn'), error: at('error') },
  };
}

describe('strakerSecretValues', () => {
  it('collects every credential the bot holds, so none can reach a log line', () => {
    const secrets = strakerSecretValues(loadStrakerBotConfig(ENV));

    expect(secrets).toContain(ENV.STRAKER_PASSWORD);
    expect(secrets).toContain(ENV.STRAKER_CHAT_WEBHOOK_OFFERS);
    expect(secrets).toContain(ENV.GOOGLE_CHAT_WEBHOOK_SYSTEM);
    expect(secrets).toContain(ENV.STRAKER_HEALTHCHECKS_PING_URL);
  });

  it('includes the one-time code once 2FA is switched on', () => {
    const secrets = strakerSecretValues(
      loadStrakerBotConfig({ ...ENV, STRAKER_TOTP_CODE: '123456' }),
    );

    expect(secrets).toContain('123456');
  });
});

describe('withRedaction — Constitution V, no secret in any diagnostic output', () => {
  it('masks a secret that arrives in a field value', () => {
    const sink = recordingSink();
    const log = withRedaction(sink.pino, strakerSecretValues(loadStrakerBotConfig(ENV)));

    log.info({ module: 'session', action: 'sign_in', webhook: ENV.STRAKER_CHAT_WEBHOOK_OFFERS });

    expect(JSON.stringify(sink.lines)).not.toContain('offers-secret-token');
    expect(sink.lines[0]?.fields.webhook).toBe('[REDACTED]');
  });

  it('masks a secret embedded in the message string, which field-level redaction misses', () => {
    const sink = recordingSink();
    const log = withRedaction(sink.pino, strakerSecretValues(loadStrakerBotConfig(ENV)));

    log.error({ module: 'session', action: 'sign_in' }, `login failed for ${ENV.STRAKER_PASSWORD}`);

    expect(JSON.stringify(sink.lines)).not.toContain('hunter2-straker');
    expect(sink.lines[0]?.msg).toContain('[REDACTED]');
  });

  it('leaves ordinary diagnostic content intact, so redaction does not blind the operator', () => {
    const sink = recordingSink();
    const log = withRedaction(sink.pino, strakerSecretValues(loadStrakerBotConfig(ENV)));

    log.warn({ module: 'pollCycle', action: 'read', outcome: 'failed', objId: 'offer-123' });

    expect(sink.lines[0]?.fields.objId).toBe('offer-123');
    expect(sink.lines[0]?.fields.outcome).toBe('failed');
  });
});

describe('the Straker logger is its own', () => {
  it('writes under a name of its own, so two bots sharing one log directory never collide', () => {
    expect(STRAKER_LOG_NAME).toBe('jobcatch-straker');
    expect(STRAKER_LOG_NAME).not.toBe('acolad');
  });
});
