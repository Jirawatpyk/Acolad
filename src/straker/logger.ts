/**
 * The Straker bot's own structured logger (FR-032, Constitution V).
 *
 * Separate from `src/monitoring/logger.ts` because that one is bound to `AppConfig` — the
 * XTM bot's config object, which the Straker bot deliberately does not have (adding
 * required Straker variables to `src/config/index.ts` would fail-fast the live XTM bot on
 * start). What is NOT duplicated is the redaction itself: `redactSecrets`, `maskString`
 * and `flushWithCap` are imported from the XTM logger, so a fix to how a secret is masked
 * lands in both bots at once rather than in whichever one someone remembered.
 *
 * The two bots share one log directory (an enumerated, accepted sharing in the spec), so
 * the file base below must be the bot's own name or the two would write into each other's
 * rotated files.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { LogFields, Logger } from '../monitoring/logger.js';
import { flushWithCap, maskString, redactSecrets } from '../monitoring/logger.js';
import { strakerSecretValues, type StrakerBotConfig } from './config.js';

/** ADR-002: the program is named JobCatch, and naming this feature introduces follows it. */
export const STRAKER_LOG_NAME = 'jobcatch-straker';

/** The subset of pino the redaction wrapper needs — small enough to stub in a test. */
export interface PinoLike {
  info(fields: Record<string, unknown>, msg?: string): void;
  warn(fields: Record<string, unknown>, msg?: string): void;
  error(fields: Record<string, unknown>, msg?: string): void;
}

/**
 * Wrap a pino-shaped sink so no secret survives into output, in BOTH places one can hide.
 *
 * Field values are scrubbed by `redactSecrets`; the message string is scrubbed separately
 * by `maskString`, because pino's `formatters.log` never sees the second argument — and
 * the message is exactly where an error from a failed sign-in echoes the credential back.
 *
 * Exported (rather than inlined into `createStrakerLogger`) so the redaction is testable
 * without standing up a real rolling-file transport: the part that must never regress is
 * pure, and the part that cannot be unit-tested is thin wiring.
 */
export function withRedaction(target: PinoLike, secrets: string[]): Logger {
  const mask = (msg?: string): string | undefined =>
    msg === undefined ? undefined : maskString(msg, secrets);
  const scrub = (fields: LogFields): Record<string, unknown> => redactSecrets(fields, secrets);

  return {
    info: (fields, msg) => target.info(scrub(fields), mask(msg)),
    warn: (fields, msg) => target.warn(scrub(fields), mask(msg)),
    error: (fields, msg) => target.error(scrub(fields), mask(msg)),
  };
}

/**
 * Structured JSON logger with daily rotation kept 14 days (Constitution V's retention
 * minimum, matching the XTM bot so an incident spanning both is reconstructable).
 */
export function createStrakerLogger(cfg: StrakerBotConfig): Logger {
  mkdirSync(cfg.logDir, { recursive: true });

  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: join(cfg.logDir, STRAKER_LOG_NAME),
      frequency: 'daily',
      mkdir: true,
      limit: { count: 14 },
      extension: '.log',
      dateFormat: 'yyyy-MM-dd',
    },
  });

  const logger = pino(
    {
      level: 'info',
      // Key-based censoring as well as the value-based masking below: the two catch
      // different things, and the portal's session cookie is exactly the kind of value
      // that arrives under a well-known key without ever appearing in config.
      redact: {
        paths: ['password', 'cookie', 'token', '*.password', '*.cookie'],
        censor: '[REDACTED]',
      },
      // Stamped on every line so the two bots remain tellable apart in the shared log
      // directory even after a line is copied out of its file.
      base: { bot: STRAKER_LOG_NAME },
    },
    transport,
  );

  const redacted = withRedaction(logger, strakerSecretValues(cfg));
  return { ...redacted, flush: () => flushWithCap(logger, 500) };
}
