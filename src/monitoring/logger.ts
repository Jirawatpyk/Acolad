import type { AppConfig } from '../config/index.js';
import { secretValues } from '../config/index.js';
import { LOG_FLUSH_CAP_MS, createRollingLogger } from '../shared/rollingLogger.js';

export interface Logger {
  info(fields: LogFields, msg?: string): void;
  warn(fields: LogFields, msg?: string): void;
  error(fields: LogFields, msg?: string): void;
  /**
   * Drain the async (pino-roll worker-thread) transport so the final line — notably the
   * shutdown line — reaches disk before `process.exit` kills the worker. Best-effort and
   * capped (never blocks shutdown). Optional so lightweight test stubs need not implement it.
   */
  flush?(): Promise<void>;
}

export interface LogFields {
  module: string;
  action: string;
  outcome?: string;
  jobKey?: string;
  latencyMs?: number;
  [k: string]: unknown;
}

/** This bot's log-file stem. The two bots share one log directory, so it must be its own
 *  name or they would write into each other's rotated files. */
const LOG_NAME = 'acolad';

/**
 * Structured JSON logger (Constitution V) with daily rotation kept 14 days.
 * Secret config values are redacted from rendered output (FR-012) by matching
 * concrete values, in addition to pino's key-based censor.
 *
 * The rotation, retention and key-censoring policy lives in `shared/rollingLogger.ts` —
 * the same one the Straker bot writes under, so a leak fixed here cannot stay open there.
 * What remains this bot's own is which concrete values count as secret, which it knows
 * from `AppConfig` and Straker deliberately does not have.
 */
export function createLogger(cfg: AppConfig): Logger {
  const secrets = secretValues(cfg);

  const logger = createRollingLogger({
    logDir: cfg.LOG_DIR,
    fileName: LOG_NAME,
    formatters: {
      log(obj) {
        return redactSecrets(obj, secrets);
      },
    },
  });

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
    flush: () => flushWithCap(logger, LOG_FLUSH_CAP_MS),
  };
}

/**
 * Best-effort drain of a flushable (pino's worker-thread transport), hard-capped at `capMs`
 * so a stuck transport can NEVER block shutdown. Resolves on the flush callback, on a throw,
 * or on the cap — whichever is first. Pure (target + timer injected via the args) so the
 * bounded behaviour is unit-testable without spinning a real transport.
 */
export function flushWithCap(
  target: { flush(cb: (err?: Error) => void): void },
  capMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      target.flush(done);
    } catch {
      done();
    }
    setTimeout(done, capMs).unref();
  });
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
