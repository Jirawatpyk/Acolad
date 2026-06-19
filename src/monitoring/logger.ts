import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { AppConfig } from '../config/index.js';
import { secretValues } from '../config/index.js';

export interface Logger {
  info(fields: LogFields, msg?: string): void;
  warn(fields: LogFields, msg?: string): void;
  error(fields: LogFields, msg?: string): void;
}

export interface LogFields {
  module: string;
  action: string;
  outcome?: string;
  jobKey?: string;
  latencyMs?: number;
  [k: string]: unknown;
}

/**
 * Structured JSON logger (Constitution V) with daily rotation kept 14 days.
 * Secret config values are redacted from rendered output (FR-012) by matching
 * concrete values, in addition to pino's key-based censor.
 */
export function createLogger(cfg: AppConfig): Logger {
  mkdirSync(cfg.LOG_DIR, { recursive: true });
  const secrets = secretValues(cfg);

  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: join(cfg.LOG_DIR, 'acolad'),
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
      redact: {
        paths: ['password', 'cookie', 'token', '*.password', '*.cookie'],
        censor: '[REDACTED]',
      },
      formatters: {
        log(obj) {
          return redactSecrets(obj, secrets);
        },
      },
    },
    transport,
  );

  // pino's `formatters.log` scrubs the object FIELDS, but the message string (2nd
  // arg) bypasses it — and that is exactly where a Playwright error echoes a
  // `.fill("<password>")` call. Mask the message here too so no secret can leak
  // through a logged error message (FR-012, Constitution V — defense in depth).
  const mask = (msg?: string): string | undefined =>
    msg === undefined ? undefined : maskString(msg, secrets);
  return {
    info: (fields, msg) => logger.info(fields, mask(msg)),
    warn: (fields, msg) => logger.warn(fields, mask(msg)),
    error: (fields, msg) => logger.error(fields, mask(msg)),
  };
}

/** Replace any occurrence of a concrete secret value inside string fields. */
export function redactSecrets(
  obj: Record<string, unknown>,
  secrets: string[],
): Record<string, unknown> {
  if (secrets.length === 0) return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === 'string' ? maskString(v, secrets) : v;
  }
  return out;
}

export function maskString(value: string, secrets: string[]): string {
  let masked = value;
  for (const s of secrets) {
    if (s && masked.includes(s)) masked = masked.split(s).join('[REDACTED]');
  }
  return masked;
}
