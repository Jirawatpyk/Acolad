import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStrakerDispatcher,
  type SendOutcome,
  type StrakerSenders,
} from '../../../src/straker/dispatcher.js';
import { StrakerOutbox } from '../../../src/straker/outbox.js';
import { openStrakerDatabase, type StrakerDB } from '../../../src/straker/strakerStore.js';
import { silentLogger } from '../../integration/straker/testDoubles.js';

/**
 * The drain. Nothing in this feature had one, and outcomes were being queued durably into a
 * table nobody read — a win would have been recorded and never announced.
 *
 * What it must get right is narrower than it looks, because the retry arithmetic is not its
 * own: `StrakerOutbox.recordFailure` already owns backoff and the give-up rule, shared with
 * the live XTM bot in `shared/outboxRetry.ts`. This file is routing plus bookkeeping — and
 * the one rule that is genuinely its own, which is that a single bad row must not be able to
 * stop every row behind it.
 */

const NOW = Date.parse('2026-09-16T10:00:00+07:00');
const dirs: string[] = [];
const dbs: StrakerDB[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshOutbox(options: { retryCap?: number } = {}): StrakerOutbox {
  const dir = mkdtempSync(join(tmpdir(), 'straker-dispatch-'));
  dirs.push(dir);
  const opened = openStrakerDatabase(dir, NOW);
  dbs.push(opened.db);
  return new StrakerOutbox(opened.db, options);
}

interface Recorder extends StrakerSenders {
  readonly sent: { channel: string; payload: unknown }[];
}

/** Senders that record what they were handed. `outcome` decides what they then report. */
function recorders(outcome: (channel: string) => SendOutcome = () => ({ ok: true })): Recorder {
  const sent: { channel: string; payload: unknown }[] = [];
  const make = (channel: string) => async (payload: unknown) => {
    sent.push({ channel, payload });
    return outcome(channel);
  };
  return {
    get sent() {
      return sent;
    },
    offers: make('offers'),
    tracking: make('tracking'),
    alerts: make('alerts'),
  };
}

describe('the dispatcher routes each queued outcome to the channel it was queued for', () => {
  it('sends every due row to its own sender, with the payload it was queued with', async () => {
    const outbox = freshOutbox();
    outbox.enqueue('claim:a:won', 'offers', JSON.stringify({ objId: 'a' }), NOW);
    outbox.enqueue('row:a', 'tracking', JSON.stringify({ objId: 'a', outcome: 'won' }), NOW);
    outbox.enqueue('claim:b:failed', 'alerts', JSON.stringify({ objId: 'b' }), NOW);
    const senders = recorders();

    const summary = await createStrakerDispatcher(outbox, senders, silentLogger()).flush(NOW);

    expect(summary).toMatchObject({ sent: 3, failed: 0, dropped: 0 });
    // Content, not just counts: a dispatcher that sends the right number of messages to the
    // wrong places, or sends an empty body, passes a count assertion perfectly.
    expect(senders.sent).toEqual([
      { channel: 'offers', payload: { objId: 'a' } },
      { channel: 'tracking', payload: { objId: 'a', outcome: 'won' } },
      { channel: 'alerts', payload: { objId: 'b' } },
    ]);
  });

  it('marks what it sent, so a second flush sends nothing again', async () => {
    const outbox = freshOutbox();
    outbox.enqueue('claim:a:won', 'offers', '{}', NOW);
    const senders = recorders();
    const dispatcher = createStrakerDispatcher(outbox, senders, silentLogger());

    await dispatcher.flush(NOW);
    const second = await dispatcher.flush(NOW + 1_000);

    expect(second.sent).toBe(0);
    expect(senders.sent).toHaveLength(1);
  });
});

describe('a destination that is down delays an outcome and never loses it (FR-016)', () => {
  it('leaves a failed row queued, for the outbox to schedule again', async () => {
    const outbox = freshOutbox();
    outbox.enqueue('claim:a:won', 'offers', '{}', NOW);

    const summary = await createStrakerDispatcher(
      outbox,
      recorders(() => ({ ok: false, reason: 'chat webhook returned 503' })),
      silentLogger(),
    ).flush(NOW);

    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(outbox.countByStatus('pending')).toBe(1);
    expect(outbox.countByStatus('sent')).toBe(0);
  });

  it('treats a sender that throws exactly as one that reports failure', async () => {
    // A sender is an interface; an implementation can reject rather than return. Letting
    // that escape would abandon the flush part-way with the remaining rows unattempted and
    // the loop's own error handling deciding what the cycle looks like.
    const outbox = freshOutbox();
    outbox.enqueue('a', 'offers', '{}', NOW);
    outbox.enqueue('b', 'tracking', '{}', NOW);
    const senders = recorders();
    const throwing: StrakerSenders = {
      ...senders,
      offers: () => Promise.reject(new Error('socket hang up')),
    };

    const summary = await createStrakerDispatcher(outbox, throwing, silentLogger()).flush(NOW);

    expect(summary).toMatchObject({ sent: 1, failed: 1 });
    expect(outbox.countByStatus('pending')).toBe(1);
  });
});

describe('one bad row must not stop the rows behind it', () => {
  it('drops a row whose payload is not readable, and keeps going', async () => {
    // The queue is drained in order. A row that can never be sent — its payload is not JSON,
    // so no sender can be given anything — would be retried forever at the head of the queue
    // and everything behind it would wait on it. It is dropped loudly instead: the XTM
    // dispatcher learned this one in production.
    const outbox = freshOutbox();
    outbox.enqueue('broken', 'offers', 'not json at all', NOW);
    outbox.enqueue('fine', 'offers', JSON.stringify({ objId: 'b' }), NOW);
    const senders = recorders();

    const summary = await createStrakerDispatcher(outbox, senders, silentLogger()).flush(NOW);

    expect(summary).toMatchObject({ sent: 1, dropped: 1 });
    expect(senders.sent).toEqual([{ channel: 'offers', payload: { objId: 'b' } }]);
    // Dropped means gone from the queue, not left to be retried forever.
    expect(outbox.countByStatus('pending')).toBe(0);
  });

  it('says loudly which row it dropped, because a dropped outcome is never delivered', async () => {
    const outbox = freshOutbox();
    outbox.enqueue('broken', 'alerts', '{oh dear', NOW);
    const logs: { level: string; fields: Record<string, unknown> }[] = [];
    const logger = {
      info: () => undefined,
      warn: (fields: Record<string, unknown>) => logs.push({ level: 'warn', fields }),
      error: (fields: Record<string, unknown>) => logs.push({ level: 'error', fields }),
    };

    await createStrakerDispatcher(outbox, recorders(), logger as never).flush(NOW);

    const dropped = logs.find((l) => l.fields.action === 'drop');
    expect(dropped?.level).toBe('error');
    expect(dropped?.fields).toMatchObject({ eventId: 'broken', channel: 'alerts' });
  });

  it('carries on after one failure so a single bad destination cannot block the others', async () => {
    const outbox = freshOutbox();
    outbox.enqueue('a', 'offers', '{}', NOW);
    outbox.enqueue('b', 'tracking', '{}', NOW);
    outbox.enqueue('c', 'alerts', '{}', NOW);
    const senders = recorders((channel) =>
      channel === 'tracking' ? { ok: false, reason: 'sheets quota' } : { ok: true },
    );

    const summary = await createStrakerDispatcher(outbox, senders, silentLogger()).flush(NOW);

    expect(summary).toMatchObject({ sent: 2, failed: 1 });
    expect(senders.sent.map((s) => s.channel)).toEqual(['offers', 'tracking', 'alerts']);
  });
});

describe('what the cycle can tell from a flush', () => {
  it('reports a flush that delivered nothing because there was nothing, not as a failure', async () => {
    const summary = await createStrakerDispatcher(freshOutbox(), recorders(), silentLogger()).flush(
      NOW,
    );

    expect(summary).toEqual({ sent: 0, failed: 0, dropped: 0, dead: 0 });
  });

  it('counts a row the outbox gave up on separately from one it will try again', async () => {
    // `dead` is the one an operator has to act on: it will not be delivered until someone
    // runs a requeue. Folding it into `failed` would hide the only outcome that needs a human.
    // `retryCap: 2` so the first failure schedules a retry and the second exhausts it —
    // which is the transition being asserted. At a cap of 1 the very first failure is
    // already fatal and there is no "will try again" state to tell `dead` apart from.
    const outbox = freshOutbox({ retryCap: 2 });
    outbox.enqueue('a', 'offers', '{}', NOW);
    const dispatcher = createStrakerDispatcher(
      outbox,
      recorders(() => ({ ok: false, reason: 'down' })),
      silentLogger(),
    );

    const first = await dispatcher.flush(NOW);
    const second = await dispatcher.flush(NOW + 60 * 60 * 1000);

    expect(first).toMatchObject({ failed: 1, dead: 0 });
    expect(second).toMatchObject({ failed: 0, dead: 1 });
    expect(outbox.countByStatus('dead')).toBe(1);
  });
});
