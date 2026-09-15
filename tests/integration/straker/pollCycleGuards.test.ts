import { describe, expect, it } from 'vitest';
import { eligible, harness, raw, type HarnessOptions } from './pollCycleHarness.js';

/**
 * The guarantees a branch-wide review found claimed but not enforced. Each block names the
 * mutation that used to survive, because that is the only honest description of what these
 * tests are for.
 */

describe('a claim is never attempted twice for the same offer, across cycles (R7, FR-019c)', () => {
  it('claims a still-listed offer once, not once per cycle', async () => {
    // `claim.ts` cannot enforce this. It refuses to retry inside the one call it is given,
    // and a compile-time lock keeps it that way — but FR-019c says "never retried at all,
    // at ANY interval", and the poll interval is an interval. Without a cross-cycle guard
    // the bot re-POSTs an irreversible claim every ten seconds while the offer is listed,
    // and the second attempt then collides with the settled record and takes the cycle down.
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();
    await h.cycle.runOnce();
    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['a']);
  });

  it('does not re-claim an offer whose outcome was unknown — the case R7 exists for', async () => {
    // `unknown` means the request may or may not have landed, which is precisely why the
    // offer can still be listed. A second attempt turns "we do not know" into "we may have
    // committed twice". Reconciliation settles it instead (FR-016a).
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      alreadyClaimed: ['a'],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual([]);
  });

  it('does not re-claim after a failed attempt either, because R7 forbids the blind retry', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      alreadyClaimed: ['a'],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual([]);
  });

  it('still claims a different offer in the same read', async () => {
    const h = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), eligible('b')],
      alreadyClaimed: ['a'],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['b']);
  });

  it('asks the store once per cycle, not once per offer', async () => {
    const h = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), eligible('b')],
    });

    await h.cycle.runOnce();

    expect(h.trace.filter((t) => t === 'read:claimedObjIds')).toHaveLength(1);
  });
});

describe('the record of an irreversible claim survives whatever else fails', () => {
  it('commits each claim separately, so one rejected write cannot lose the others', async () => {
    // The portal has already committed both. Writing them in one transaction means a single
    // rejected row discards the record of work the team now owns — exactly the gap FR-016a
    // then has to go and find.
    const h = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), eligible('b')],
      recordEventFails: (objId) => objId === 'a',
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['a', 'b']);
    expect(h.events.map((e) => e.objId)).toContain('b');
  });

  it('reports a claim it could not record as an error, not as a quiet omission', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      recordEventFails: () => true,
    });

    await h.cycle.runOnce();

    expect(h.logs.some((l) => l.level === 'error' && l.fields.action === 'persist_claim')).toBe(
      true,
    );
  });

  it('records the claim before it records anything merely observational', async () => {
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    const claimRow = h.trace.findIndex((t) => t.startsWith('persist:event:claim:'));
    const sighting = h.trace.findIndex((t) => t.startsWith('persist:sighting:'));
    expect(claimRow).toBeGreaterThan(-1);
    expect(claimRow).toBeLessThan(sighting);
  });
});

describe('a read that fails MID-RUN marks nothing as vanished (FR-023, V6)', () => {
  /** A portal whose listing, and whose health, the test changes between cycles. */
  function shiftingPortal(): {
    opts: HarnessOptions;
    list: (o: string[]) => void;
    fail: () => void;
  } {
    let listed = ['a', 'b'];
    let broken = false;
    const opts: HarnessOptions = {
      get offers() {
        return listed.map(raw);
      },
      get readFails() {
        return broken ? new Error('portal down') : undefined;
      },
      extract: () => [],
    };
    return { opts, list: (o) => (listed = o), fail: () => (broken = true) };
  }

  it('records no ending and no lifetime when the read fails after offers were known', async () => {
    // V6 asks for a fault "mid-run". Failing the very FIRST read proves nothing: an empty
    // tracker has nothing that could be marked vanished, so the assertion passes vacuously.
    // This is the shape that catches a silent zero — the failure family the XTM bot's
    // 38-minute outage belongs to, though by a different mechanism (`offersApi.ts`).
    const p = shiftingPortal();
    const h = harness(p.opts);

    await h.cycle.runOnce();
    expect(h.trace.filter((t) => t.startsWith('persist:sighting:'))).toHaveLength(2);

    p.fail();
    await expect(h.cycle.runOnce()).resolves.toBe(false);

    expect(h.trace.filter((t) => t.startsWith('persist:endSighting:'))).toEqual([]);
  });

  it('still reports the offers as live once the portal recovers', async () => {
    // The other half of the guarantee: the failed read must not have consumed them either.
    const p = shiftingPortal();
    const h = harness(p.opts);

    await h.cycle.runOnce();
    p.fail();
    await h.cycle.runOnce();

    expect(h.trace.filter((t) => t.startsWith('persist:endSighting:'))).toEqual([]);
    expect(h.trace.filter((t) => t.startsWith('persist:sighting:'))).toHaveLength(2);
  });

  it('does mark an offer vanished when a SUCCESSFUL read stops listing it', async () => {
    // Guard against over-correcting into a cycle that never closes a sighting at all.
    const p = shiftingPortal();
    const h = harness(p.opts);

    await h.cycle.runOnce();
    p.list(['a']);
    await h.cycle.runOnce();

    expect(h.trace).toContain('persist:endSighting:b');
  });
});

describe('an outcome is queued in the same transaction that records it (FR-016)', () => {
  it('enqueues inside the transaction, so a crash cannot commit one without the other', async () => {
    // outbox.ts states the rule itself: written "in the same transaction as the state change
    // that produced it… a destination being unavailable can then delay an outcome but cannot
    // lose one". Enqueuing after the commit reopens exactly that window.
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    const notify = h.trace.findIndex((t) => t.startsWith('notify:offers:'));
    expect(notify).toBeGreaterThan(-1);

    const opened = h.trace.slice(0, notify).filter((t) => t === 'tx:begin').length;
    const closed = h.trace.slice(0, notify).filter((t) => t === 'tx:end').length;
    expect(opened).toBeGreaterThan(closed);
  });

  it('still keeps every write and announcement behind the claim (FR-003)', async () => {
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    const beforeClaim = h.trace.slice(0, h.trace.indexOf('claim:a'));
    expect(beforeClaim.filter((t) => t.startsWith('persist:'))).toEqual([]);
    expect(beforeClaim.filter((t) => t.startsWith('notify:'))).toEqual([]);
  });
});

describe('the tracker and the store disagreeing is noticed (endSighting)', () => {
  it('logs when the store had no sighting the tracker is ending', async () => {
    // strakerStore documents this precisely: `false` here means the two have diverged, and
    // "the caller is the only thing in a position to alert on that". Discarding the boolean
    // cancels a signal the store went out of its way to provide.
    let listed = ['a'];
    const h = harness({
      get offers() {
        return listed.map(raw);
      },
      extract: () => [],
      endSightingResult: false,
    });

    await h.cycle.runOnce();
    listed = [];
    await h.cycle.runOnce();

    expect(h.logs.some((l) => l.fields.action === 'sighting_divergence')).toBe(true);
  });

  it('says nothing when the store and the tracker agree', async () => {
    let listed = ['a'];
    const h = harness({
      get offers() {
        return listed.map(raw);
      },
      extract: () => [],
    });

    await h.cycle.runOnce();
    listed = [];
    await h.cycle.runOnce();

    expect(h.logs.some((l) => l.fields.action === 'sighting_divergence')).toBe(false);
  });
});

describe('what the cycle writes and announces, not merely that it did (F)', () => {
  /**
   * Three mutations used to survive here because the harness recorded labels instead of
   * payloads: the effort that sets tomorrow's ceiling, the identity everything keys on, and
   * the entire body of every announcement could each be replaced by a constant.
   */
  it('records the offer own identity, which every dedup and reconciliation keys on', async () => {
    const h = harness({ offers: [raw('abc-123')], extract: () => [eligible('abc-123')] });

    await h.cycle.runOnce();

    expect(h.events.map((e) => e.objId)).toEqual(['abc-123']);
  });

  it('records the effort the decision carried, because it sets tomorrow capacity', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [{ ...eligible('a'), effortWords: 137 }],
    });

    await h.cycle.runOnce();

    expect(h.events[0]?.effortWords).toBe(137);
    expect(h.holds[0]?.effortWords).toBe(137);
  });

  it('holds the deadline it decided on, not some other day', async () => {
    const deadlineMs = Date.parse('2026-09-17T16:00:00+07:00');
    const h = harness({ offers: [raw('a')], extract: () => [{ ...eligible('a'), deadlineMs }] });

    await h.cycle.runOnce();

    expect(h.holds[0]?.deadlineMs).toBe(deadlineMs);
    expect(h.events[0]?.deadlineMs).toBe(deadlineMs);
  });

  it('announces a won offer with the identity, direction, effort and deadline in the body', async () => {
    // FR-011a asks for the language direction of every claimed offer to be recorded, so the
    // claimed language mix is visible early rather than discovered at delivery.
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    const card = h.queued.find((q) => q.channel === 'offers');
    expect(card?.payload).toMatchObject({
      objId: 'a',
      languageDirection: 'en-us>ms-my',
      effortWords: 4,
      outcome: 'won',
    });
    expect(card?.payload.deadlineMs).toEqual(expect.any(Number));
  });

  it('names the offer and the reason in a skip alert, not an empty body', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [{ ...eligible('a'), effortWords: null }],
    });

    await h.cycle.runOnce();

    const alert = h.queued.find((q) => q.channel === 'alerts');
    expect(alert?.payload).toMatchObject({ objId: 'a', reason: 'effort_unknown' });
  });

  it('keys each queued row on the offer and its outcome, which is what de-duplicates alerts', async () => {
    // FR-019a: once per offer identity per outcome. The key is what enforces it, so it is
    // worth asserting rather than assuming.
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    expect(h.queued[0]?.eventId).toBe('claim:a:won');
  });
});

describe('an outcome that died undelivered is not read as handled (C3)', () => {
  it('reports already_dead loudly, because nothing will resend it', async () => {
    // tasks.md names this hazard: `already_dead` must never be read as "handled" — that
    // outcome will not be delivered until ops requeues it, so treating it as done loses the
    // record, which is what FR-016 forbids.
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      enqueueResult: () => 'already_dead',
    });

    await h.cycle.runOnce();

    expect(h.logs.some((l) => l.level === 'error' && l.fields.outcome === 'already_dead')).toBe(
      true,
    );
  });

  it('stays quiet for an ordinary duplicate, which needs nobody', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      enqueueResult: () => 'already_pending',
    });

    await h.cycle.runOnce();

    expect(h.logs.some((l) => l.fields.outcome === 'already_dead')).toBe(false);
  });
});
