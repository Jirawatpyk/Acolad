import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';
import { Dispatcher } from '../../src/reporting/dispatcher.js';
import {
  classifyStatus,
  type ChatSender,
  type SendOutcome,
} from '../../src/reporting/googleChat.js';

const NOW = '2026-06-10T10:00:00.000Z';
const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let dir: string;
let db: DB;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acolad-disp-'));
  db = openDatabase(dir, NOW).db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

class StubSender implements ChatSender {
  constructor(public outcome: SendOutcome) {}
  calls = 0;
  async send(): Promise<SendOutcome> {
    this.calls++;
    return this.outcome;
  }
}

describe('classifyStatus', () => {
  it('maps status codes to the failure taxonomy', () => {
    expect(classifyStatus(200)).toBe('ok');
    expect(classifyStatus(429)).toBe('transient');
    expect(classifyStatus(503)).toBe('transient');
    expect(classifyStatus(403)).toBe('permanent');
    expect(classifyStatus(404)).toBe('permanent');
  });
});

describe('Dispatcher', () => {
  it('sends one message per row and marks them sent', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    ob.enqueue('e2', JSON.stringify({ text: 'b' }), NOW);
    const sender = new StubSender('ok');
    const summary = await new Dispatcher(ob, sender, noopLogger).flush(NOW, Date.parse(NOW));
    expect(summary.sent).toBe(2);
    expect(sender.calls).toBe(2);
    expect(ob.due(NOW)).toHaveLength(0);
  });

  it('keeps a row pending on transient failure (FR-013)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    const summary = await new Dispatcher(ob, new StubSender('transient'), noopLogger).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(summary.transientFailures).toBe(1);
    expect(ob.countByStatus('pending')).toBe(1);
  });

  it('fires onDead when a row exhausts retries', async () => {
    const ob = new Outbox(db, 1, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    const onDead = vi.fn();
    const summary = await new Dispatcher(ob, new StubSender('transient'), noopLogger, {
      onDead,
    }).flush(NOW, Date.parse(NOW));
    expect(summary.dead).toBe(1);
    expect(onDead).toHaveBeenCalledWith('e1');
  });

  it('fires onPermanent for a revoked webhook (403)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    const onPermanent = vi.fn();
    await new Dispatcher(ob, new StubSender('permanent'), noopLogger, { onPermanent }).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(onPermanent).toHaveBeenCalledWith('e1');
  });

  it('V13/FR-018: a permanent failure never becomes dead and stays queued', async () => {
    const ob = new Outbox(db, 1, 6); // cap=1 → a transient would die immediately
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    const disp = new Dispatcher(ob, new StubSender('permanent'), noopLogger);
    for (let i = 1; i <= 5; i++) {
      const at = new Date(Date.parse(NOW) + i * 31 * 60_000).toISOString();
      await disp.flush(at, Date.parse(at));
    }
    expect(ob.countByStatus('dead')).toBe(0);
    expect(ob.countByStatus('pending')).toBe(1);
    expect(ob.countByStatus('sent')).toBe(0);
  });

  it('drops a malformed payload (no text) with an onDead alert instead of sending empty', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('bad', JSON.stringify({ notText: 'oops' }), NOW);
    const sender = new StubSender('ok');
    const onDead = vi.fn();
    const summary = await new Dispatcher(ob, sender, noopLogger, { onDead }).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(sender.calls).toBe(0); // never attempted to send empty text
    expect(summary.dead).toBe(1);
    expect(onDead).toHaveBeenCalledWith('bad');
    expect(ob.due(NOW)).toHaveLength(0); // dropped, queue not wedged
  });

  it('V10/FR-013: a transient failure stays queued, then flushes once the channel recovers', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);

    await new Dispatcher(ob, new StubSender('transient'), noopLogger).flush(NOW, Date.parse(NOW));
    expect(ob.countByStatus('pending')).toBe(1);

    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    const ok = new StubSender('ok');
    const summary = await new Dispatcher(ob, ok, noopLogger).flush(later, Date.parse(later));
    expect(summary.sent).toBe(1);
    expect(ok.calls).toBe(1);
    expect(ob.countByStatus('sent')).toBe(1);
  });
});
