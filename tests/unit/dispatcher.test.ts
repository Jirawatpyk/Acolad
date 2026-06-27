import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';
import { Dispatcher, type DispatcherHooks } from '../../src/reporting/dispatcher.js';
import {
  classifyStatus,
  type ChatSender,
  type ChatPayload,
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

/** StubSender records the last payload received and returns a fixed outcome. */
class StubSender implements ChatSender {
  calls = 0;
  lastPayload: ChatPayload | undefined;
  lastStatus: number;
  constructor(
    public outcome: SendOutcome,
    statusOverride?: number,
  ) {
    this.lastStatus =
      statusOverride ?? (outcome === 'ok' ? 200 : outcome === 'transient' ? 500 : 403);
  }
  async sendDetailed(payload: ChatPayload): Promise<{ outcome: SendOutcome; status: number }> {
    this.calls++;
    this.lastPayload = payload;
    return { outcome: this.outcome, status: this.lastStatus };
  }
  async send(payload: ChatPayload): Promise<SendOutcome> {
    const { outcome } = await this.sendDetailed(payload);
    return outcome;
  }
}

/** Build a Dispatcher with only a chat sender (the common case for unit tests). */
function makeDisp(ob: Outbox, chatSender: StubSender, hooks: DispatcherHooks = {}): Dispatcher {
  return new Dispatcher(ob, { chat: chatSender }, noopLogger, hooks);
}

describe('classifyStatus', () => {
  it('maps status codes to the failure taxonomy', () => {
    expect(classifyStatus(200)).toBe('ok');
    expect(classifyStatus(429)).toBe('transient');
    expect(classifyStatus(503)).toBe('transient');
    expect(classifyStatus(403)).toBe('permanent');
    expect(classifyStatus(404)).toBe('permanent');
    expect(classifyStatus(400)).toBe('permanent');
  });
});

describe('Dispatcher — {text} payload (backward-compatible)', () => {
  it('sends one message per row and marks them sent', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    ob.enqueue('e2', JSON.stringify({ text: 'b' }), NOW);
    const sender = new StubSender('ok');
    const summary = await makeDisp(ob, sender).flush(NOW, Date.parse(NOW));
    expect(summary.sent).toBe(2);
    expect(sender.calls).toBe(2);
    expect(ob.due(NOW)).toHaveLength(0);
  });

  it('sends the payload as a {text} object (not a raw string)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'hello' }), NOW);
    const sender = new StubSender('ok');
    await makeDisp(ob, sender).flush(NOW, Date.parse(NOW));
    expect(sender.lastPayload).toEqual({ text: 'hello' });
  });

  it('keeps a row pending on transient failure (FR-013)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    const summary = await makeDisp(ob, new StubSender('transient')).flush(NOW, Date.parse(NOW));
    expect(summary.transientFailures).toBe(1);
    expect(ob.countByStatus('pending')).toBe(1);
  });

  it('fires onDead when a row exhausts retries — passes channel + reason (Fix 5)', async () => {
    const ob = new Outbox(db, 1, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    const onDead = vi.fn();
    const summary = await makeDisp(ob, new StubSender('transient'), { onDead }).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(summary.dead).toBe(1);
    // New signature: (eventId, channel, reason)
    expect(onDead).toHaveBeenCalledWith('e1', 'chat', 'retry limit exceeded');
  });

  it('fires onPermanent for a revoked webhook (403) — passes channel (Fix 5)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    const onPermanent = vi.fn();
    await makeDisp(ob, new StubSender('permanent'), { onPermanent }).flush(NOW, Date.parse(NOW));
    // New signature: (eventId, channel)
    expect(onPermanent).toHaveBeenCalledWith('e1', 'chat');
  });

  it('V13/FR-018: a permanent failure never becomes dead and stays queued', async () => {
    const ob = new Outbox(db, 1, 6); // cap=1 → a transient would die immediately
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);
    const disp = makeDisp(ob, new StubSender('permanent'));
    for (let i = 1; i <= 5; i++) {
      const at = new Date(Date.parse(NOW) + i * 31 * 60_000).toISOString();
      await disp.flush(at, Date.parse(at));
    }
    expect(ob.countByStatus('dead')).toBe(0);
    expect(ob.countByStatus('pending')).toBe(1);
    expect(ob.countByStatus('sent')).toBe(0);
  });

  it('drops a malformed payload (no text, no cardsV2) with onDead alert — passes channel+reason (Fix 5)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('bad', JSON.stringify({ notText: 'oops' }), NOW);
    const sender = new StubSender('ok');
    const onDead = vi.fn();
    const summary = await makeDisp(ob, sender, { onDead }).flush(NOW, Date.parse(NOW));
    expect(sender.calls).toBe(0);
    expect(summary.dead).toBe(1);
    // Malformed drop: reason = 'malformed payload'
    expect(onDead).toHaveBeenCalledWith('bad', 'chat', 'malformed payload');
    expect(ob.due(NOW)).toHaveLength(0);
  });

  it('V10/FR-013: a transient failure stays queued, then flushes once the channel recovers', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e1', JSON.stringify({ text: 'a' }), NOW);

    await makeDisp(ob, new StubSender('transient')).flush(NOW, Date.parse(NOW));
    expect(ob.countByStatus('pending')).toBe(1);

    const later = new Date(Date.parse(NOW) + 60_000).toISOString();
    const ok = new StubSender('ok');
    const summary = await makeDisp(ob, ok).flush(later, Date.parse(later));
    expect(summary.sent).toBe(1);
    expect(ok.calls).toBe(1);
    expect(ob.countByStatus('sent')).toBe(1);
  });
});

describe('Dispatcher — {cardsV2} payload', () => {
  it('sends a cardsV2 payload to the chat sender', async () => {
    const ob = new Outbox(db, 10, 6);
    const card = { cardId: 'c1', card: { header: { title: 'Job' } } };
    ob.enqueue('ev-card', JSON.stringify({ cardsV2: [card] }), NOW, 'chat');
    const sender = new StubSender('ok');
    const summary = await makeDisp(ob, sender).flush(NOW, Date.parse(NOW));
    expect(summary.sent).toBe(1);
    expect(sender.calls).toBe(1);
    expect(sender.lastPayload).toEqual({ cardsV2: [card] });
  });

  it('a 400 on a card payload treats row as dead+onDead (payload rejection, not permanent webhook) — passes channel+reason (Fix 5)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue(
      'ev-bad-card',
      JSON.stringify({ cardsV2: [{ cardId: 'x', card: {} }] }),
      NOW,
      'chat',
    );
    // 400 classifies as permanent but isPayloadRejection → must go to dead, not permanentFailures
    const sender = new StubSender('permanent', 400);
    const onDead = vi.fn();
    const onPermanent = vi.fn();
    const summary = await new Dispatcher(ob, { chat: sender }, noopLogger, {
      onDead,
      onPermanent,
    }).flush(NOW, Date.parse(NOW));
    expect(summary.dead).toBe(1);
    expect(summary.permanentFailures).toBe(0);
    // Payload-rejected drop: reason = 'rejected by Chat (400)'
    expect(onDead).toHaveBeenCalledWith('ev-bad-card', 'chat', 'rejected by Chat (400)');
    expect(onPermanent).not.toHaveBeenCalled();
    expect(ob.countByStatus('sent')).toBe(1); // markSent (dropped)
    expect(ob.countByStatus('pending')).toBe(0);
  });

  it('a 403 on a card payload stays permanent (webhook revoked, not payload fault) — passes channel (Fix 5)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('ev-403', JSON.stringify({ cardsV2: [{ cardId: 'x', card: {} }] }), NOW, 'chat');
    const sender = new StubSender('permanent', 403);
    const onPermanent = vi.fn();
    const summary = await new Dispatcher(ob, { chat: sender }, noopLogger, { onPermanent }).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(summary.permanentFailures).toBe(1);
    expect(summary.dead).toBe(0);
    expect(onPermanent).toHaveBeenCalledWith('ev-403', 'chat');
  });

  it('an empty cardsV2 array is malformed — sender is never called, row goes dead — passes channel+reason (Fix 5)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('ev-empty-card', JSON.stringify({ cardsV2: [] }), NOW, 'chat');
    const sender = new StubSender('ok');
    const onDead = vi.fn();
    const summary = await makeDisp(ob, sender, { onDead }).flush(NOW, Date.parse(NOW));
    expect(sender.calls).toBe(0);
    expect(summary.dead).toBe(1);
    expect(summary.sent).toBe(0);
    // Malformed drop (no sender / empty cardsV2)
    expect(onDead).toHaveBeenCalledWith('ev-empty-card', 'chat', 'malformed payload');
  });

  it('a 400 on a {text} row treats it as dead (payload rejected), not permanent — passes channel+reason (Fix 5)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('ev-text-400', JSON.stringify({ text: 'hi' }), NOW);
    const sender = new StubSender('permanent', 400);
    const onDead = vi.fn();
    const summary = await makeDisp(ob, sender, { onDead }).flush(NOW, Date.parse(NOW));
    expect(summary.dead).toBe(1);
    expect(summary.permanentFailures).toBe(0);
    expect(onDead).toHaveBeenCalledWith('ev-text-400', 'chat', 'rejected by Chat (400)');
  });
});

describe('Dispatcher — team channel', () => {
  it('routes a team-channel row to senders.team', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('et1', JSON.stringify({ text: 'team msg' }), NOW, 'team');
    const chatSender = new StubSender('ok');
    const teamSender = new StubSender('ok');
    const summary = await new Dispatcher(
      ob,
      { chat: chatSender, team: teamSender },
      noopLogger,
    ).flush(NOW, Date.parse(NOW));
    expect(summary.sent).toBe(1);
    expect(teamSender.calls).toBe(1);
    expect(chatSender.calls).toBe(0);
  });

  it('treats a team row as malformed/dead when no team sender is configured — passes channel+reason (Fix 5)', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('et1', JSON.stringify({ text: 'team msg' }), NOW, 'team');
    const chatSender = new StubSender('ok');
    const onDead = vi.fn();
    const summary = await new Dispatcher(ob, { chat: chatSender }, noopLogger, { onDead }).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(summary.dead).toBe(1);
    expect(chatSender.calls).toBe(0);
    // No sender for 'team' → malformed
    expect(onDead).toHaveBeenCalledWith('et1', 'team', 'malformed payload');
  });
});

describe('Dispatcher — sender throws / invalid JSON (C1)', () => {
  /**
   * A sender that REJECTS (throws) instead of returning an outcome — simulates a
   * network/DNS reject or an unexpected client exception, which the dispatcher must
   * catch and classify as transient (sendRow's try/catch around sendDetailed).
   */
  class ThrowingChatSender implements ChatSender {
    calls = 0;
    async sendDetailed(): Promise<{ outcome: SendOutcome; status: number }> {
      this.calls++;
      throw new Error('ECONNREFUSED — simulated network/DNS reject');
    }
    async send(): Promise<SendOutcome> {
      return (await this.sendDetailed()).outcome;
    }
  }

  it('treats a thrown chat sender as transient: row stays pending, flush does not throw, sibling rows still delivered', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e-throw', JSON.stringify({ text: 'boom' }), NOW, 'chat'); // this sender throws
    ob.enqueue('e-team', JSON.stringify({ text: 'ok' }), NOW, 'team'); // same batch — must still send
    const throwing = new ThrowingChatSender();
    const team = new StubSender('ok');
    const onDead = vi.fn();
    const onPermanent = vi.fn();

    // flush() must resolve (not reject) even though the chat sender threw.
    const summary = await new Dispatcher(ob, { chat: throwing, team }, noopLogger, {
      onDead,
      onPermanent,
    }).flush(NOW, Date.parse(NOW));

    expect(throwing.calls).toBe(1);
    // (1) Treated as transient — NOT permanent, NOT dead.
    expect(summary.transientFailures).toBe(1);
    expect(summary.permanentFailures).toBe(0);
    expect(summary.dead).toBe(0);
    expect(onDead).not.toHaveBeenCalled();
    expect(onPermanent).not.toHaveBeenCalled();
    // (2) The throwing row stays pending (retried later, never lost).
    expect(ob.countByStatus('pending')).toBe(1);
    // (3) The sibling team row in the same batch is still delivered.
    expect(summary.sent).toBe(1);
    expect(team.calls).toBe(1);
    expect(ob.countByStatus('sent')).toBe(1);
  });

  it('treats an invalid-JSON chat payload as malformed → dead + onDead(chat, "malformed payload"); sender never called', async () => {
    const ob = new Outbox(db, 10, 6);
    ob.enqueue('e-badjson', '{ this is not valid json', NOW, 'chat'); // JSON.parse throws → malformed
    const sender = new StubSender('ok');
    const onDead = vi.fn();
    const summary = await new Dispatcher(ob, { chat: sender }, noopLogger, { onDead }).flush(
      NOW,
      Date.parse(NOW),
    );
    expect(sender.calls).toBe(0); // parse failed before any send attempt
    expect(summary.dead).toBe(1);
    // The code classifies a JSON parse failure as malformed (DeadReason 'malformed payload'),
    // NOT a Chat 400 rejection — the payload never reached the endpoint.
    expect(onDead).toHaveBeenCalledWith('e-badjson', 'chat', 'malformed payload');
    expect(ob.due(NOW)).toHaveLength(0); // dropped (markSent) so the queue can't wedge
    expect(ob.countByStatus('sent')).toBe(1);
  });
});
