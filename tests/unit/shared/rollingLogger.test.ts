/**
 * The rolling-file logging policy, tested once for both bots.
 *
 * `src/monitoring/logger.ts` and `src/straker/logger.ts` each spelled out the same
 * transport block, the same `redact.paths`, the same fourteen-file retention and the same
 * flush cap. Those are not incidental figures: the retention is Constitution V's minimum,
 * the redact paths are what stops a session cookie reaching disk, and the flush cap is what
 * stops a stuck transport from hanging shutdown. Copied twice, they drift silently — a leak
 * fixed in one bot's logger and not the other's is exactly the failure this prevents.
 *
 * Only the *destination* is substituted. The logger under test is the real pino, so what is
 * asserted below is the line that would have been written to the file — not that an options
 * object was passed along, which proves nothing about whether pino honoured it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DestinationStream, TransportSingleOptions } from 'pino';
import {
  LOG_FLUSH_CAP_MS,
  LOG_REDACT_PATHS,
  LOG_RETENTION_FILES,
  createRollingLogger,
  type RollingLoggerSpec,
} from '../../../src/shared/rollingLogger.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shared-logger-'));
  dirs.push(dir);
  return dir;
}

interface Harness {
  readonly logger: ReturnType<typeof createRollingLogger>;
  /** The options the rotating destination would have been built with. */
  readonly transportOptions: TransportSingleOptions;
  /** Every line written, parsed — i.e. what would have landed in the file. */
  readonly lines: () => Record<string, unknown>[];
}

/** Build a logger whose destination collects lines instead of rotating a real file. */
function harness(spec: Omit<RollingLoggerSpec, 'logDir'> & { logDir?: string }): Harness {
  const written: string[] = [];
  let transportOptions: TransportSingleOptions | undefined;
  const logger = createRollingLogger(
    { logDir: spec.logDir ?? tempDir(), ...spec },
    (options): DestinationStream => {
      transportOptions = options;
      return {
        write(chunk: string): void {
          written.push(chunk);
        },
      };
    },
  );
  return {
    logger,
    transportOptions: transportOptions ?? ({} as TransportSingleOptions),
    lines: () => written.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('the rolling file the log goes to', () => {
  it('creates the log directory before pino is asked to write into it', () => {
    const logDir = join(tempDir(), 'logs', 'nested');

    harness({ logDir, fileName: 'somebot' });

    expect(existsSync(logDir)).toBe(true);
  });

  it('rotates daily, keeps fourteen files, and names them after the bot', () => {
    const logDir = tempDir();

    const h = harness({ logDir, fileName: 'somebot' });

    expect(h.transportOptions).toEqual({
      target: 'pino-roll',
      options: {
        file: join(logDir, 'somebot'),
        frequency: 'daily',
        mkdir: true,
        limit: { count: LOG_RETENTION_FILES },
        extension: '.log',
        dateFormat: 'yyyy-MM-dd',
      },
    });
    // Constitution V's retention minimum. Named so that changing it has to be deliberate.
    expect(LOG_RETENTION_FILES).toBe(14);
  });

  it('names the file from the caller, because the two bots share one log directory', () => {
    // A shared stem would have each bot writing into the other's rotated files.
    const logDir = tempDir();

    const h = harness({ logDir, fileName: 'jobcatch-straker' });

    expect((h.transportOptions.options as { file: string }).file).toBe(
      join(logDir, 'jobcatch-straker'),
    );
  });
});

describe('what never reaches the file', () => {
  it('censors the secret-bearing keys, at the top level and one nested level down', () => {
    const h = harness({ fileName: 'b' });

    h.logger.info(
      {
        module: 'portal',
        password: 'hunter2',
        cookie: 'session=abc',
        token: 'ghp_xyz',
        request: { password: 'hunter2', cookie: 'session=abc' },
      },
      'sign-in failed',
    );

    const [line] = h.lines();
    expect(line).toMatchObject({
      module: 'portal',
      password: '[REDACTED]',
      cookie: '[REDACTED]',
      token: '[REDACTED]',
      request: { password: '[REDACTED]', cookie: '[REDACTED]' },
      msg: 'sign-in failed',
    });
  });

  it('keeps every logger redacting, however many have been built', () => {
    // fast-redact takes ownership of the paths array it is handed, so the policy is copied
    // per logger; sharing one array by reference would let the first build disarm the next.
    const first = harness({ fileName: 'a' });
    const second = harness({ fileName: 'b' });

    first.logger.info({ module: 'm', action: 'a', password: 'p' });
    second.logger.info({ module: 'm', action: 'a', password: 'p' });

    expect(first.lines()[0]?.password).toBe('[REDACTED]');
    expect(second.lines()[0]?.password).toBe('[REDACTED]');
    expect(LOG_REDACT_PATHS).toEqual(['password', 'cookie', 'token', '*.password', '*.cookie']);
  });

  it('writes at info and drops anything below it', () => {
    const h = harness({ fileName: 'b' });

    h.logger.debug({ module: 'm', action: 'noisy' });
    expect(h.lines()).toEqual([]);

    h.logger.info({ module: 'm', action: 'worth-keeping' });
    expect(h.lines()).toHaveLength(1);
  });
});

describe('what each bot adds for itself', () => {
  it("keeps pino's own bindings when the caller asks for none", () => {
    // Absent, NOT present-and-undefined: pino reads `base: undefined` as "no bindings at
    // all", which would silently drop pid and hostname from a bot that never asked for that.
    const h = harness({ fileName: 'b' });

    h.logger.info({ module: 'm', action: 'a' });

    expect(h.lines()[0]).toHaveProperty('pid');
    expect(h.lines()[0]).toHaveProperty('hostname');
  });

  it('stamps caller-supplied bindings on every line, which is how Straker names itself', () => {
    const h = harness({ fileName: 'b', base: { bot: 'jobcatch-straker' } });

    h.logger.info({ module: 'm', action: 'a' });

    expect(h.lines()[0]).toMatchObject({ bot: 'jobcatch-straker' });
  });

  it('applies a caller-supplied log formatter, which is how the XTM bot scrubs values', () => {
    const h = harness({
      fileName: 'b',
      formatters: {
        log: (obj) => ({ ...obj, scrubbed: true }),
      },
    });

    h.logger.info({ module: 'm', action: 'a', detail: 'kept' });

    expect(h.lines()[0]).toMatchObject({ module: 'm', detail: 'kept', scrubbed: true });
  });
});

describe('the shutdown flush cap', () => {
  it('is half a second, shared, and named rather than repeated at each call site', () => {
    // A stuck transport must never block shutdown, and both bots cap the drain at the same
    // figure — a figure typed twice is a figure that eventually disagrees.
    expect(LOG_FLUSH_CAP_MS).toBe(500);
  });
});
