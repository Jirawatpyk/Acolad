/**
 * The rolling-file logging policy both bots write under.
 *
 * Each bot has its own logger — they redact different secrets, and one of them stamps every
 * line with its name — but the *policy* underneath was written out twice, identically: a
 * daily-rotating file kept fourteen days, the same list of secret-bearing keys censored,
 * and the same half-second cap on draining the transport at shutdown.
 *
 * None of those three is incidental. Fourteen days is Constitution V's retention minimum,
 * so an incident spanning both bots stays reconstructable. The censored keys are what stops
 * a session cookie reaching disk. The flush cap is what stops a stuck worker thread from
 * hanging a shutdown. A fix applied to one copy and not the other is a silent divergence in
 * all three, which is why the policy is here and the bots pass in only what is theirs.
 *
 * What is NOT here is redaction of concrete secret *values* — the two bots apply that at
 * different points in pino's pipeline (the XTM bot through `formatters.log`, Straker
 * through a wrapper around the call site), and the primitives they share for it live with
 * the XTM logger already.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { DestinationStream, LoggerOptions, TransportSingleOptions } from 'pino';

/** Days of history kept on disk — Constitution V's retention minimum. */
export const LOG_RETENTION_FILES = 14;

/**
 * Keys censored by name, on top of whatever value-based masking a bot adds. The two catch
 * different things: a portal's session cookie arrives under a well-known key without ever
 * appearing in configuration, so no list of known secret values would find it.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  'password',
  'cookie',
  'token',
  '*.password',
  '*.cookie',
];

/** Hard cap on draining the transport at shutdown: a stuck worker thread must never be
 *  able to keep the process alive. Pair it with `flushWithCap`. */
export const LOG_FLUSH_CAP_MS = 500;

export interface RollingLoggerSpec {
  /** Directory for the rotated files; created if absent. */
  readonly logDir: string;
  /** Base name of the rotated files, without extension. The two bots share one log
   *  directory, so this must be the bot's own name or they write into each other's files. */
  readonly fileName: string;
  /** Bindings stamped on every line. Omit to keep pino's defaults (pid, hostname). */
  readonly base?: Record<string, unknown>;
  /** pino formatters — the XTM bot scrubs its field values here. Omit to keep pino's. */
  readonly formatters?: LoggerOptions['formatters'];
}

/**
 * How the rotating destination is built. Defaulted to the real `pino.transport`, so callers
 * never think about it; a test supplies its own so the policy can be asserted against the
 * lines that actually come out, without standing up a worker thread that writes real files
 * and outlives the test. Only this is injected — the logger itself is the real pino, so the
 * options below are proved by their effect rather than by having been passed along.
 */
export type RollingTransportFactory = (options: TransportSingleOptions) => DestinationStream;

/**
 * A sink writing under the policy above — deliberately narrower than the pino logger that
 * implements it.
 *
 * This used to be `pino.Logger`, which handed both bots pino's whole surface and made pino a
 * type dependency of everything downstream. The problem is not breadth for its own sake: the
 * policy this module exists to hold is exactly what that surface lets a caller step around.
 * `child({ redact: [] })` returns a logger outside the redaction; `level` is settable at
 * runtime; the transport handle is reachable. Narrowing removes the means rather than
 * adding a rule nobody would think to check, and the two bots call nothing else.
 */
export interface RollingSink {
  info(fields: Record<string, unknown>, msg?: string): void;
  warn(fields: Record<string, unknown>, msg?: string): void;
  error(fields: Record<string, unknown>, msg?: string): void;
  /** Drain the worker-thread transport. Always through `flushWithCap`, never bare: a stuck
   *  worker must not be able to keep the process alive. */
  flush(cb: (err?: Error) => void): void;
}

/** Build a pino logger writing to a daily-rotating file under the shared policy. */
export function createRollingLogger(
  spec: RollingLoggerSpec,
  makeTransport: RollingTransportFactory = pino.transport,
): RollingSink {
  mkdirSync(spec.logDir, { recursive: true });

  const destination = makeTransport({
    target: 'pino-roll',
    options: {
      file: join(spec.logDir, spec.fileName),
      frequency: 'daily',
      mkdir: true,
      limit: { count: LOG_RETENTION_FILES },
      extension: '.log',
      dateFormat: 'yyyy-MM-dd',
    },
  });

  const options: LoggerOptions = {
    level: 'info',
    // A fresh array per logger: fast-redact takes ownership of the one it is handed, and a
    // shared reference would let the first logger built edit the policy for the second.
    redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' },
  };
  // Assigned only when given, never set to undefined: pino reads an explicit
  // `base: undefined` as "no bindings at all" rather than "unspecified", which would
  // silently drop pid and hostname from a bot that never asked for that.
  if (spec.formatters !== undefined) options.formatters = spec.formatters;
  if (spec.base !== undefined) options.base = spec.base;

  return pino(options, destination);
}
