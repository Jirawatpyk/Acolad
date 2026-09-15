/**
 * T051 — alert de-duplication (FR-019a, V28), in its two halves.
 *
 * ## Half one: alerts that carry an offer identity
 *
 * FR-019a asks for de-duplication **once per offer identity per outcome**. The instinct is
 * to build that. The instinct is wrong: `StrakerOutbox.enqueue` is already idempotent on
 * event id together with channel, and `pollCycle.ts` already keys its alerts
 * `claim:${objId}:${outcome}` — identity and outcome, which is precisely FR-019a's key.
 * The requirement is therefore already met, and a second suppressor layered on top would
 * be two mechanisms disagreeing about what counts as the same alert.
 *
 * So these tests **prove the existing queue satisfies FR-019a** rather than testing
 * something new. They run the real outbox and the real dispatcher end to end, and they are
 * the reason `notifier.ts` contains no dedup of its own — if they ever go red, that is the
 * signal to reconsider, and until they do, adding a second layer is forbidden by evidence.
 *
 * ## Half two: alerts that carry no identity at all
 *
 * The transport's `onAlert` (`read_retries_exhausted`) and `onWarning` know nothing about
 * offers, so FR-019a's key cannot apply to them and the transport does not throttle them
 * itself. At a ten-second rhythm a ten-minute outage raises around sixty. The throttle for
 * those lives in `createTransportAlertHooks`, and is asserted here.
 *
 * No network anywhere: the queue is a temporary SQLite file, the senders are stubs, and
 * the clock is injected.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger, LogFields } from '../../../src/monitoring/logger.js';
import {
  createStrakerDispatcher,
  type SendOutcome,
  type StrakerSenders,
} from '../../../src/straker/dispatcher.js';
import { StrakerOutbox } from '../../../src/straker/outbox.js';
import { openStrakerDatabase, type StrakerDB } from '../../../src/straker/strakerStore.js';
import {
  TRANSPORT_ALERT_WINDOW_MS,
  createTransportAlertHooks,
  type StrakerTransportAlertNotice,
} from '../../../src/straker/notifier.js';
import type {
  StrakerTransportAlert,
  StrakerTransportWarning,
} from '../../../src/straker/httpClient.js';

const NOW_MS = Date.parse('2026-09-15T10:00:00+07:00');
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const roots: string[] = [];
const openDbs: StrakerDB[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshOutbox(): StrakerOutbox {
  const root = mkdtempSync(join(tmpdir(), 'straker-alerts-'));
  roots.push(root);
  const dir = join(root, 'straker');
  mkdirSync(dir, { recursive: true });
  const opened = openStrakerDatabase(dir, NOW_MS);
  openDbs.push(opened.db);
  return new StrakerOutbox(opened.db);
}

interface RecordingLogger extends Logger {
  readonly lines: { level: 'info' | 'warn' | 'error'; fields: LogFields; msg?: string }[];
}

function recordingLogger(): RecordingLogger {
  const lines: RecordingLogger['lines'] = [];
  return {
    lines,
    info: (fields, msg) => void lines.push({ level: 'info', fields, ...(msg ? { msg } : {}) }),
    warn: (fields, msg) => void lines.push({ level: 'warn', fields, ...(msg ? { msg } : {}) }),
    error: (fields, msg) => void lines.push({ level: 'error', fields, ...(msg ? { msg } : {}) }),
  };
}

/** Records what each channel was asked to deliver. No network, no card rendering. */
function recordingSenders(): {
  senders: StrakerSenders;
  delivered: { channel: keyof StrakerSenders; payload: unknown }[];
} {
  const delivered: { channel: keyof StrakerSenders; payload: unknown }[] = [];
  const make =
    (channel: keyof StrakerSenders) =>
    (payload: unknown): Promise<SendOutcome> => {
      delivered.push({ channel, payload });
      return Promise.resolve({ ok: true });
    };
  return {
    senders: { offers: make('offers'), tracking: make('tracking'), alerts: make('alerts') },
    delivered,
  };
}

const alertPayload = (objId: string, condition: string): string =>
  JSON.stringify({ kind: 'offer', condition, objId, detail: 'x', occurredAtMs: NOW_MS });

// =========================================================================================
// V28 — de-duplicated once per offer identity per outcome (FR-019a)
// =========================================================================================

describe('FR-019a is already satisfied by the queue, for anything carrying an identity', () => {
  it('delivers ONE alert however many times the same condition recurs on the same offer', async () => {
    const outbox = freshOutbox();
    const { senders, delivered } = recordingSenders();
    const dispatcher = createStrakerDispatcher(outbox, senders, recordingLogger());

    // The same condition on the same offer, raised on three consecutive cycles — which is
    // exactly what a recurring fault looks like from `pollCycle.ts`.
    for (const cycle of [0, 1, 2]) {
      const result = outbox.enqueue(
        'claim:OFFER-1:failed',
        'alerts',
        alertPayload('OFFER-1', 'claim_failed'),
        NOW_MS + cycle * 10 * SECOND,
      );
      expect(result).toBe(cycle === 0 ? 'queued' : 'already_pending');
    }

    const summary = await dispatcher.flush(NOW_MS + MINUTE);

    expect(summary.sent).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it('still alerts when the SAME condition happens to a DIFFERENT offer', async () => {
    const outbox = freshOutbox();
    const { senders, delivered } = recordingSenders();
    const dispatcher = createStrakerDispatcher(outbox, senders, recordingLogger());

    outbox.enqueue(
      'claim:OFFER-1:failed',
      'alerts',
      alertPayload('OFFER-1', 'claim_failed'),
      NOW_MS,
    );
    outbox.enqueue(
      'claim:OFFER-2:failed',
      'alerts',
      alertPayload('OFFER-2', 'claim_failed'),
      NOW_MS,
    );

    await dispatcher.flush(NOW_MS + MINUTE);

    // "Per offer identity" cuts both ways: silence on a second offer would be a real alert
    // swallowed, which is the failure a global throttle would introduce here.
    expect(delivered).toHaveLength(2);
  });

  it('still alerts when the SAME offer reaches a DIFFERENT outcome', async () => {
    const outbox = freshOutbox();
    const { senders, delivered } = recordingSenders();
    const dispatcher = createStrakerDispatcher(outbox, senders, recordingLogger());

    outbox.enqueue(
      'claim:OFFER-1:failed',
      'alerts',
      alertPayload('OFFER-1', 'claim_failed'),
      NOW_MS,
    );
    outbox.enqueue(
      'claim:OFFER-1:unknown',
      'alerts',
      alertPayload('OFFER-1', 'claim_outcome_unknown'),
      NOW_MS,
    );

    await dispatcher.flush(NOW_MS + MINUTE);

    expect(delivered).toHaveLength(2);
  });

  it('holds the dedup across a restart, because the key lives in the database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'straker-alerts-restart-'));
    roots.push(root);
    const dir = join(root, 'straker');
    mkdirSync(dir, { recursive: true });

    const first = openStrakerDatabase(dir, NOW_MS);
    new StrakerOutbox(first.db).enqueue(
      'claim:OFFER-1:failed',
      'alerts',
      alertPayload('OFFER-1', 'claim_failed'),
      NOW_MS,
    );
    first.db.close();

    const second = openStrakerDatabase(dir, NOW_MS);
    openDbs.push(second.db);
    const outbox = new StrakerOutbox(second.db);
    // A restart mid-incident is when an in-memory throttle would forget and page again.
    expect(
      outbox.enqueue(
        'claim:OFFER-1:failed',
        'alerts',
        alertPayload('OFFER-1', 'claim_failed'),
        NOW_MS,
      ),
    ).toBe('already_pending');

    const { senders, delivered } = recordingSenders();
    await createStrakerDispatcher(outbox, senders, recordingLogger()).flush(NOW_MS + MINUTE);
    expect(delivered).toHaveLength(1);
  });

  it('does not let the alert dedup swallow the announcement of the same event', async () => {
    const outbox = freshOutbox();
    const { senders, delivered } = recordingSenders();
    const dispatcher = createStrakerDispatcher(outbox, senders, recordingLogger());

    // Recovered work is BOTH announced (contract §2) and alerted (contract §3). The
    // outbox keys on event id TOGETHER WITH channel, so one event reaching two
    // destinations is two rows — which is the reason a dedup keyed on identity alone
    // would have been wrong.
    outbox.enqueue('claim:OFFER-1:recovered', 'offers', alertPayload('OFFER-1', 'x'), NOW_MS);
    outbox.enqueue(
      'claim:OFFER-1:recovered',
      'alerts',
      alertPayload('OFFER-1', 'work_recovered'),
      NOW_MS,
    );

    await dispatcher.flush(NOW_MS + MINUTE);

    expect(delivered.map((d) => d.channel).sort()).toEqual(['alerts', 'offers']);
  });
});

// =========================================================================================
// The real gap — transport alerts carry no offer identity
// =========================================================================================

describe('transport alerts carry no identity, so the sink throttles them (T051)', () => {
  const READ_FAILED: StrakerTransportAlert = {
    kind: 'read_retries_exhausted',
    path: '/api/offers/open',
    attempts: 4,
    waitedMs: 1_750,
    reason: 'Straker /api/offers/open gave no answer within 2000ms',
  };

  const BUDGET_UNREADABLE: StrakerTransportWarning = {
    kind: 'rate_limit_unknown',
    reason: 'headers_missing',
    path: '/api/offers/open',
    detail: 'the portal stopped reporting its request budget',
  };

  function harness(windowMs = TRANSPORT_ALERT_WINDOW_MS): {
    raised: { eventId: string; alert: StrakerTransportAlertNotice }[];
    logger: RecordingLogger;
    hooks: ReturnType<typeof createTransportAlertHooks>;
    tick(ms: number): void;
  } {
    const raised: { eventId: string; alert: StrakerTransportAlertNotice }[] = [];
    const logger = recordingLogger();
    let clock = NOW_MS;
    const hooks = createTransportAlertHooks({
      raise: (eventId, alert) => void raised.push({ eventId, alert }),
      logger,
      now: () => clock,
      windowMs,
    });
    return {
      raised,
      logger,
      hooks,
      tick: (ms) => {
        clock += ms;
      },
    };
  }

  it('raises the first occurrence immediately — a real fault must not wait out a window', () => {
    const h = harness();

    h.hooks.onAlert(READ_FAILED);

    expect(h.raised).toHaveLength(1);
    expect(h.raised[0]?.alert.condition).toBe('read_retries_exhausted');
    expect(h.raised[0]?.alert.suppressed).toBe(0);
    expect(h.raised[0]?.alert.path).toBe('/api/offers/open');
  });

  it('turns a ten-minute outage at a ten-second rhythm into 2 alerts, not 60', () => {
    const h = harness();

    // Sixty failed reads over ten minutes — the exact shape T051 names.
    for (let i = 0; i < 60; i++) {
      h.hooks.onAlert(READ_FAILED);
      h.tick(10 * SECOND);
    }
    expect(h.raised).toHaveLength(1);

    // The window has now elapsed, and the condition is still happening. It says so again,
    // once, carrying everything it stood in for — a condition that goes quiet while it
    // persists is indistinguishable from one that cleared.
    h.hooks.onAlert(READ_FAILED);

    expect(h.raised).toHaveLength(2);
    expect(h.raised[1]?.alert.suppressed).toBe(59);
    expect(h.raised[1]?.alert.windowMs).toBe(TRANSPORT_ALERT_WINDOW_MS);
  });

  it('counts the suppressed occurrences rather than discarding them', () => {
    const h = harness();
    h.hooks.onAlert(READ_FAILED);
    for (let i = 0; i < 5; i++) {
      h.tick(SECOND);
      h.hooks.onAlert(READ_FAILED);
    }

    h.tick(TRANSPORT_ALERT_WINDOW_MS);
    h.hooks.onAlert(READ_FAILED);

    expect(h.raised).toHaveLength(2);
    expect(h.raised[1]?.alert.suppressed).toBe(5);
  });

  it('starts the next window clean, so an old burst is never counted twice', () => {
    const h = harness();
    h.hooks.onAlert(READ_FAILED);
    h.hooks.onAlert(READ_FAILED);
    h.tick(TRANSPORT_ALERT_WINDOW_MS);
    h.hooks.onAlert(READ_FAILED);

    h.tick(TRANSPORT_ALERT_WINDOW_MS);
    h.hooks.onAlert(READ_FAILED);

    expect(h.raised).toHaveLength(3);
    expect(h.raised[2]?.alert.suppressed).toBe(0);
  });

  it('throttles each request path on its own — one broken endpoint must not hide another', () => {
    const h = harness();

    h.hooks.onAlert(READ_FAILED);
    h.hooks.onAlert({ ...READ_FAILED, path: '/api/session' });

    expect(h.raised).toHaveLength(2);
    expect(h.raised.map((r) => r.alert.path)).toEqual(['/api/offers/open', '/api/session']);
  });

  it('keeps a budget warning separate from a read failure on the same path', () => {
    const h = harness();

    h.hooks.onAlert(READ_FAILED);
    h.hooks.onWarning(BUDGET_UNREADABLE);

    // Two conditions, not one with two severities — the transport keeps them apart on
    // purpose and collapsing them here would re-merge what it separated.
    expect(h.raised).toHaveLength(2);
    expect(h.raised[1]?.alert.condition).toBe('rate_limit_unknown');
  });

  it('treats a different reason for the same warning as a different condition', () => {
    const h = harness();

    h.hooks.onWarning(BUDGET_UNREADABLE);
    h.hooks.onWarning({ ...BUDGET_UNREADABLE, reason: 'headers_nonsensical' });
    h.hooks.onWarning(BUDGET_UNREADABLE);

    // Headers vanishing and headers arriving unbelievable are different faults. The third
    // call repeats the first and is inside its window, so it is collapsed.
    expect(h.raised).toHaveLength(2);
  });

  it('carries the warning own plain-language detail through unchanged', () => {
    const h = harness();

    h.hooks.onWarning(BUDGET_UNREADABLE);

    expect(h.raised[0]?.alert.detail).toBe(BUDGET_UNREADABLE.detail);
  });

  it('keys the event id on the window, so a restart inside one does not re-page', () => {
    const first = harness();
    const second = harness();

    first.hooks.onAlert(READ_FAILED);
    second.hooks.onAlert(READ_FAILED); // a fresh process, same window, empty memory

    // The in-memory throttle cannot survive a restart, so the event id is what stops a
    // crash-loop from paging on every start: the outbox refuses the duplicate.
    expect(second.raised[0]?.eventId).toBe(first.raised[0]?.eventId);
  });

  it('gives a later window a different event id, so a persisting outage is still heard', () => {
    const h = harness();
    h.hooks.onAlert(READ_FAILED);
    h.tick(TRANSPORT_ALERT_WINDOW_MS);
    h.hooks.onAlert(READ_FAILED);

    expect(h.raised[0]?.eventId).not.toBe(h.raised[1]?.eventId);
  });

  it('records every suppressed occurrence in the log, where the full picture survives', () => {
    const h = harness();
    h.hooks.onAlert(READ_FAILED);
    h.hooks.onAlert(READ_FAILED);

    // Throttling is about what pages a human, not about what is knowable afterwards —
    // "what did it do at 03:00" must still be answerable (Constitution V).
    const suppressed = h.logger.lines.filter((l) => l.fields.outcome === 'suppressed');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.fields.module).toBe('notifier');
  });

  it('never lets a broken alert sink escape into the transport, and says so loudly', () => {
    const logger = recordingLogger();
    const hooks = createTransportAlertHooks({
      raise: () => {
        throw new Error('database is locked');
      },
      logger,
      now: () => NOW_MS,
    });

    // The warning hook rides the SUCCESS path of a good read; a throw here would turn a
    // healthy offer-list read into a failed one. The transport swallows what escapes, so
    // an alert lost this way would otherwise vanish without a trace.
    expect(() => hooks.onAlert(READ_FAILED)).not.toThrow();
    expect(() => hooks.onWarning(BUDGET_UNREADABLE)).not.toThrow();
    expect(logger.lines.filter((l) => l.level === 'error')).toHaveLength(2);
  });

  it('defaults to a ten-minute window without being told', () => {
    const raised: { eventId: string; alert: StrakerTransportAlertNotice }[] = [];
    let clock = NOW_MS;
    const hooks = createTransportAlertHooks({
      raise: (eventId, alert) => void raised.push({ eventId, alert }),
      logger: recordingLogger(),
      now: () => clock,
    });

    hooks.onAlert(READ_FAILED);
    clock += TRANSPORT_ALERT_WINDOW_MS - 1;
    hooks.onAlert(READ_FAILED);
    clock += 1;
    hooks.onAlert(READ_FAILED);

    expect(TRANSPORT_ALERT_WINDOW_MS).toBe(10 * MINUTE);
    expect(raised).toHaveLength(2);
  });
});
