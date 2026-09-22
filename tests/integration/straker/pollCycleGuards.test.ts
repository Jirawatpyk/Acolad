import { describe, expect, it } from 'vitest';
import { StrakerHttpError, StrakerTimeoutError } from '../../../src/straker/httpClient.js';
import type { HeldWork } from '../../../src/straker/strakerStore.js';
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

describe('an offer whose work the team already holds is never claimed again (restart, FR-019c)', () => {
  /**
   * The restart case R7's two defences cannot see. `claimedObjIds()` answers from recorded
   * claims and `attemptedThisProcess` dies with the process — so a bot killed after its POST
   * reached the portal but before the claim was recorded comes back with neither. If the
   * offer is still listed, it would claim it again. Reconciliation runs first on start and
   * holds the work it finds under the key the offer shares (workKey.ts); this is the guard
   * that reads it.
   */
  const KEY = 'aj-1|ms-my|translation';
  const identity = (workKey: string | null) => ({
    jobRef: 'aj-1',
    title: null,
    service: 'translation',
    workKey,
  });
  const heldRow = (objId: string, workKey: string | null): HeldWork => ({
    objId,
    effortWords: 4,
    kind: 'translation',
    deadlineMs: Date.parse('2026-09-16T17:00:00+07:00'),
    heldSinceMs: Date.parse('2026-09-16T09:00:00+07:00'),
    releasedAtMs: null,
    identity: identity(workKey),
  });

  it('does not claim an offer whose work key matches held work, and says why', async () => {
    const h = harness({
      offers: [raw('offer-1')],
      extract: () => [{ ...eligible('offer-1'), identity: identity(KEY) }],
      held: [heldRow('po-1', KEY)],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual([]);
    expect(h.logs).toContainEqual({
      level: 'info',
      fields: expect.objectContaining({
        module: 'pollCycle',
        action: 'decide',
        outcome: 'already_held',
        objId: 'offer-1',
        workKey: KEY,
      }) as unknown,
    });
  });

  it('still claims an offer whose key matches nothing held', async () => {
    const h = harness({
      offers: [raw('offer-2')],
      extract: () => [{ ...eligible('offer-2'), identity: identity('aj-2|ms-my|translation') }],
      held: [heldRow('po-1', KEY)],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['offer-2']);
  });

  it('does not block a genuine second round of a key the bot itself claimed and recorded', async () => {
    // A held row that came from a recorded claim is already guarded by `claimedObjIds`; its
    // key coming round again under a new offer is new work, and must be judged on its merits.
    const h = harness({
      offers: [raw('offer-2nd')],
      extract: () => [{ ...eligible('offer-2nd'), identity: identity(KEY) }],
      held: [heldRow('offer-1st', KEY)],
      alreadyClaimed: ['offer-1st'],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['offer-2nd']);
  });

  it('matches a keyless offer to recovered held work by deadline and effort', async () => {
    const h = harness({
      offers: [raw('offer-k')],
      extract: () => [{ ...eligible('offer-k'), identity: identity(null) }],
      held: [{ ...heldRow('po-1', KEY), effortWords: 4 }],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual([]);
    expect(h.logs).toContainEqual({
      level: 'info',
      fields: expect.objectContaining({
        outcome: 'already_held',
        objId: 'offer-k',
        heldObjId: 'po-1',
        match: 'effort+deadline',
      }) as unknown,
    });
  });

  it('matches a keyless offer to a zero-weighed recovered order by deadline alone', async () => {
    const h = harness({
      offers: [raw('offer-k')],
      extract: () => [{ ...eligible('offer-k'), identity: identity(null) }],
      held: [{ ...heldRow('po-1', KEY), effortWords: 0 }],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual([]);
    expect(h.logs.some((l) => l.fields['match'] === 'deadline')).toBe(true);
  });

  it('does not match a keyless offer whose deadline is more than a minute away', async () => {
    const h = harness({
      offers: [raw('offer-k')],
      extract: () => [{ ...eligible('offer-k'), identity: identity(null) }],
      held: [
        {
          ...heldRow('po-1', KEY),
          effortWords: 4,
          deadlineMs: Date.parse('2026-09-16T17:01:01+07:00'),
        },
      ],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['offer-k']);
  });

  it('does not match a keyless offer whose effort differs from a weighed held row', async () => {
    const h = harness({
      offers: [raw('offer-k')],
      extract: () => [{ ...eligible('offer-k'), identity: identity(null) }],
      held: [{ ...heldRow('po-1', KEY), effortWords: 5 }],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['offer-k']);
  });

  it('does not match a keyless offer to held work the bot itself claimed', async () => {
    const h = harness({
      offers: [raw('offer-k')],
      extract: () => [{ ...eligible('offer-k'), identity: identity(null) }],
      held: [{ ...heldRow('offer-old', null), effortWords: 4 }],
      alreadyClaimed: ['offer-old'],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['offer-k']);
  });

  it('never matches two keyless records to each other by key', async () => {
    // A null key is "cannot be made honestly", not a value — two of them are not the same work.
    // (A keyless offer can still match by deadline and effort; this one's deadline is hours
    // away from the held row's, so only a null-equals-null key match could block it.)
    const h = harness({
      offers: [raw('offer-3')],
      extract: () => [{ ...eligible('offer-3'), identity: identity(null) }],
      held: [{ ...heldRow('po-1', null), deadlineMs: Date.parse('2026-09-17T17:00:00+07:00') }],
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['offer-3']);
  });
});

describe('every claim attempt leaves one log line (observability, 2026-09-22)', () => {
  // The cycle line only counted wins. A lost race, a refusal and a reply that never came
  // left nothing an operator could grep for per offer — and the latency, which decides the
  // race, was not recorded at all.
  it('logs outcome, identity, work key, status and latency for each attempt', async () => {
    const key = (id: string) => ({
      jobRef: id,
      title: null,
      service: 'translation',
      workKey: `${id}|ms-my|translation`,
    });
    const h = harness({
      offers: [raw('a'), raw('b'), raw('c'), raw('d')],
      extract: () => ['a', 'b', 'c', 'd'].map((id) => ({ ...eligible(id), identity: key(id) })),
      claim: (id) =>
        id === 'b'
          ? { status: 409 }
          : id === 'c'
            ? 'no_answer'
            : id === 'd'
              ? { status: 404 }
              : 'accepted',
    });

    await h.cycle.runOnce();

    const lines = h.logs.filter(
      (l) => l.fields['module'] === 'pollCycle' && l.fields['action'] === 'claim',
    );
    expect(lines.map((l) => [l.fields['objId'], l.fields['outcome']])).toEqual([
      ['a', 'won'],
      ['b', 'lost'],
      ['c', 'unknown'],
      ['d', 'failed'],
    ]);
    for (const l of lines) {
      expect(l.fields['workKey']).toBe(`${String(l.fields['objId'])}|ms-my|translation`);
      expect(typeof l.fields['latencyMs']).toBe('number');
      expect(l.fields['latencyMs']).toBeGreaterThanOrEqual(0);
    }
    expect(lines[1]?.fields['status']).toBe(409);
    expect(lines[3]?.fields['status']).toBe(404);
    expect(lines[0]?.fields).not.toHaveProperty('status');
    expect(lines[2]?.fields).not.toHaveProperty('status');
    // Failures are warnings, a win or a lost race is information.
    expect(lines.map((l) => l.level)).toEqual(['info', 'info', 'warn', 'warn']);
  });

  it('logs a null work key rather than leaving the field out', async () => {
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    const line = h.logs.find((l) => l.fields['action'] === 'claim');
    expect(line?.fields['workKey']).toBeNull();
  });
});

describe('no claim before reconciliation has succeeded once (restart, FR-019c)', () => {
  it('withholds every claim decision, logs once per cycle, and records no skip', async () => {
    let permitted = false;
    const h = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), eligible('b')],
      claimsPermitted: () => permitted,
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual([]);
    expect(h.events).toEqual([]);
    const held = h.logs.filter((l) => l.fields['outcome'] === 'held_until_reconciled');
    expect(held).toHaveLength(1);
    expect(held[0]?.fields).toMatchObject({ module: 'pollCycle', action: 'claim', withheld: 2 });

    // Nothing was decided either: a withheld cycle writes no skip row for any offer.
    expect(h.queued.filter((q) => q.channel === 'tracking')).toEqual([]);

    // Not remembered as attempted: once reconciliation succeeds, the next cycle claims them.
    permitted = true;
    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['a', 'b']);
  });
});

describe('a withheld cycle decides nothing, so it writes no false skip rows', () => {
  // Withheld claims used to be decided anyway, consuming capacity in `decideClaims`, so an
  // offer behind them was skipped for a ceiling or a deadline that nothing had actually used.
  it('writes no skip row and consults no gate while claims are withheld', async () => {
    const h = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), { ...eligible('b'), eligible: false }],
      claimsPermitted: () => false,
    });

    await h.cycle.runOnce();

    expect(h.events).toEqual([]);
    expect(h.queued.filter((q) => q.channel === 'tracking')).toEqual([]);
    expect(h.trace).not.toContain('gate:capacity');
    // Sightings are still recorded.
    expect(h.trace).toContain('persist:sighting:a');
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
    // The shape is the notifier's, and `condition` rather than a raw `reason`: the sender
    // refuses a payload whose condition has no card, so a body it cannot render is a row
    // that dead-letters rather than an alert nobody reads.
    expect(alert?.payload).toMatchObject({
      kind: 'offer',
      condition: 'offer_effort_unknown',
      objId: 'a',
    });
    expect(alert?.payload.occurredAtMs).toEqual(expect.any(Number));
  });

  it('keys each queued row on the offer and its outcome, which is what de-duplicates alerts', async () => {
    // FR-019a: once per offer identity per outcome. The key is what enforces it, so it is
    // worth asserting rather than assuming.
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    // Two rows per claim now: the tracking record contract §1 asks for on every offer, and
    // the announcement. They are keyed differently on purpose — the tracking row is keyed
    // on identity plus event type so a later recovery updates it rather than duplicating,
    // while the announcement is keyed on the outcome because a different outcome is a
    // different thing to say.
    expect(h.queued.map((q) => `${q.channel}:${q.eventId}`)).toEqual([
      'tracking:row:a|claim',
      'offers:claim:a:won',
    ]);
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

describe('R7 survives a store that cannot record the claim (C-2)', () => {
  /**
   * The cross-cycle guard reads `claimedObjIds()`, which reads the very rows the per-claim
   * transaction writes — and that transaction's failure is caught and only logged. So when
   * the write fails, the offer is invisible to the next cycle's guard and is claimed again
   * ten seconds later.
   *
   * That is precisely the conversion the guard's own comment exists to prevent: an outcome
   * of `unknown` means nobody knows whether the first claim landed, and asking again is how
   * "we do not know" becomes "we may have committed twice". Reconciliation cannot help — it
   * adds rows, it cannot un-claim, and it runs once per ninety poll cycles.
   *
   * The realistic trigger is systemic rather than per-row — a full disk, `SQLITE_IOERR`, a
   * sustained `SQLITE_BUSY` — which means it would hit every claim at once rather than one.
   */
  it('does not claim the same offer twice when its record could not be written', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      recordEventFails: () => true,
    });

    await h.cycle.runOnce();
    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['a']);
  });

  it('still claims a genuinely new offer in the same cycle as a failed record', async () => {
    // The guard must not become "stop claiming once anything fails" — that would turn one
    // bad write into a bot that races for nothing.
    const h = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), eligible('b')],
      recordEventFails: (objId) => objId === 'a',
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['a', 'b']);
  });
});

describe('a cycle that lost a claim record does not report success (S1)', () => {
  /**
   * The spec's worst outcome, and it was reachable while looking perfectly healthy.
   *
   * The reads succeed, the claims go out, the portal commits work to the team — and then
   * the per-claim transaction fails. It was caught, logged, and the cycle returned `true`
   * unconditionally, logging `outcome: 'ok'`, so `startStrakerBot` pinged `heartbeat.ok()`.
   * Portal-committed work, no row, no ledger hold, no card, and a green dead-man switch,
   * indefinitely. The only trace was pino error lines — on the same disk that, if the
   * trigger was a full disk, could not take them either.
   *
   * The heartbeat is the one channel that does not depend on the store, which is exactly
   * why it is the one that has to carry this.
   */
  it('returns false when a claim could not be recorded, so the heartbeat goes red', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      recordEventFails: () => true,
    });

    await expect(h.cycle.runOnce()).resolves.toBe(false);
  });

  it('returns false when the observational half could not be written either', async () => {
    // This test asserted `true` until 2026-09-22, on the argument that a lost sighting costs
    // a measurement rather than a commitment. The measurement is not what the write failing
    // says, though: SQLite refusing a write is almost always the disk or the file (full,
    // locked, corrupt), and the next thing that write path carries is a won claim. The audit
    // found a store that took no writes left the heartbeat green. It stays non-throwing — the
    // loop carries on — but the liveness signal now says what happened.
    const h = harness({
      offers: [raw('a')],
      extract: () => [{ ...eligible('a'), eligible: false }],
      recordEventFails: () => true,
    });

    await expect(h.cycle.runOnce()).resolves.toBe(false);
    expect(
      h.logs.some(
        (l) =>
          l.level === 'error' &&
          l.fields['action'] === 'persist_observations' &&
          l.fields['outcome'] === 'failed',
      ),
    ).toBe(true);
  });

  it('returns false when a sighting write fails, with nothing to claim at all', async () => {
    const h = harness({ offers: [raw('a')], sightingFails: true });

    await expect(h.cycle.runOnce()).resolves.toBe(false);
  });

  it('returns true on a quiet cycle whose writes all land', async () => {
    const h = harness({ offers: [raw('a')] });

    await expect(h.cycle.runOnce()).resolves.toBe(true);
  });
});

describe('a refused sign-in backs off instead of hammering the portal (T075)', () => {
  /**
   * The bot signs in whenever it has no session, and the loop runs every ten seconds. A
   * refused password therefore posted the same refused credentials **8,640 times a day,
   * indefinitely** — and nothing in the graduated budget response could damp it, because
   * sign-in deliberately goes through the `essential` door, which is never suspended.
   *
   * Three things make that the wrong direction to be wrong in. RP-1 records this account's
   * password as compromised, so it is the credential most likely to be refused. The
   * portal's lockout policy is unknown. And contract §4a already establishes the principle
   * for the claim path — a bot that argues with a refusal is how an account earns a
   * permanent block rather than recovers from one.
   *
   * The live XTM bot has had `LOGIN_MAX_RETRY` → lockout for this since 001. This is the
   * same shape, which DC-3 wants anyway.
   */
  /** Ten seconds a cycle, the production rhythm — the figure the storm is measured in. */
  function ticking(start = Date.parse('2026-09-16T10:00:00+07:00')) {
    let t = start;
    return { now: () => t, tick: (ms = 10_000) => (t += ms) };
  }

  it('stops re-attempting after consecutive refusals rather than trying every cycle', async () => {
    const clock = ticking();
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      signInFails: () => new StrakerHttpError(401, '/auth/login', 'bad credentials'),
      now: clock.now,
    });

    // Forty minutes of production cycles.
    for (let i = 0; i < 240; i += 1) {
      await h.cycle.runOnce();
      clock.tick();
    }

    // Far fewer than one per cycle. The exact figure is the backoff's business; what this
    // pins is that it is bounded rather than linear in cycles.
    // Was 240 — one per cycle. The backoff doubles from a minute, so forty minutes buys a
    // handful of attempts rather than one every ten seconds.
    const attempts = h.trace.filter((t) => t === 'signIn').length;
    expect(attempts).toBeLessThan(10);
    expect(attempts).toBeGreaterThan(0);
  });

  it('alerts once the refusals look like a credential problem, not a blip', async () => {
    const clock = ticking();
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      signInFails: () => new StrakerHttpError(401, '/auth/login', 'bad credentials'),
      now: clock.now,
    });

    for (let i = 0; i < 240; i += 1) {
      await h.cycle.runOnce();
      clock.tick();
    }

    // T075: a refused sign-in used to raise nothing at all. What paged was "the bot is not
    // alive", half an hour later, via the dead-man switch — not "the password is wrong".
    const alerts = h.queued.filter((q) => q.channel === 'alerts');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.length).toBeLessThan(4);
    expect(JSON.stringify(alerts)).toMatch(/sign[- ]?in|credential|login/i);
  });

  it('recovers immediately once the credentials work again', async () => {
    // The backoff must not outlive the problem: a password fixed at 09:00 should not leave
    // the bot idle until the lockout elapses.
    let bad = true;
    const clock = ticking();
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      signInFails: () => (bad ? new StrakerHttpError(401, '/auth/login', 'bad') : null),
      now: clock.now,
    });

    for (let i = 0; i < 30; i += 1) {
      await h.cycle.runOnce();
      clock.tick();
    }
    bad = false;
    for (let i = 0; i < 400; i += 1) {
      await h.cycle.runOnce();
      clock.tick();
    }

    expect(h.claimed).toEqual(['a']);
  });

  /**
   * 2026-09-21: the portal answered HTML and 405 for eight hours during its domain move, and
   * every one of those was counted as a refused password — so the bot escalated to its
   * hour-long backoff and kept waiting it out after the portal came back. Only a 401 or 403
   * from the sign-in is the portal saying no to these credentials; anything else is the
   * transport, and the next cycle simply tries again.
   */
  it('does not back off on sign-in timeouts: the cycle after recovery polls at once', async () => {
    const clock = ticking();
    let failures = 5;
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      signInFails: () =>
        failures-- > 0 ? new StrakerTimeoutError('/api/vendor/auth/login', 10_000, null) : null,
      now: clock.now,
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(h.cycle.runOnce()).resolves.toBe(false);
      clock.tick();
    }
    // Five cycles, five attempts: a timeout is not a refusal, so nothing was held back.
    expect(h.trace.filter((t) => t === 'signIn')).toHaveLength(5);

    // Fifty seconds in — inside the one-minute first step a refusal would have set.
    await expect(h.cycle.runOnce()).resolves.toBe(true);
    expect(h.trace.filter((t) => t === 'fetch')).toHaveLength(1);
    expect(h.claimed).toEqual(['a']);
    // And nothing claimed it was a password problem.
    expect(h.queued.filter((q) => q.channel === 'alerts')).toEqual([]);
    expect(h.logs.some((l) => l.fields['outcome'] === 'backing_off')).toBe(false);
  });

  it.each([
    ['a 5xx', () => new StrakerHttpError(503, '/api/vendor/auth/login', 'unavailable')],
    ['a 405', () => new StrakerHttpError(405, '/api/vendor/auth/login', '<html>')],
    ['an HTML body', () => new SyntaxError('Unexpected token < in JSON at position 0')],
  ])('treats %s at sign-in as a transport failure, named as such', async (_label, fail) => {
    const clock = ticking();
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      signInFails: fail,
      now: clock.now,
    });

    for (let i = 0; i < 6; i += 1) {
      await h.cycle.runOnce();
      clock.tick();
    }

    expect(h.trace.filter((t) => t === 'signIn')).toHaveLength(6);
    expect(h.queued.filter((q) => q.channel === 'alerts')).toEqual([]);
    const signInLogs = h.logs.filter((l) => l.fields['action'] === 'sign_in');
    expect(signInLogs.length).toBeGreaterThan(0);
    expect(signInLogs.every((l) => l.fields['outcome'] === 'transport_failed')).toBe(true);
  });

  it('still backs off on a 401 at the same cadence', async () => {
    const clock = ticking();
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      signInFails: () => new StrakerHttpError(401, '/api/vendor/auth/login', 'bad'),
      now: clock.now,
    });

    for (let i = 0; i < 6; i += 1) {
      await h.cycle.runOnce();
      clock.tick();
    }

    // One attempt, then the one-minute hold covers the next five cycles.
    expect(h.trace.filter((t) => t === 'signIn')).toHaveLength(1);
    expect(h.logs.some((l) => l.fields['outcome'] === 'backing_off')).toBe(true);
  });
});

describe('the tracking record carries what the gate decided on (A1, C1)', () => {
  /**
   * `trackingSink.ts` documents column F as "What the gate decided on" and column G as "The
   * other half of what the gate decided on". For a skip they were both written `null` — not
   * because the numbers were unknown, but because `ClaimDecision`'s `skip` variant dropped
   * them at the moment of deciding, so nothing downstream could carry them.
   *
   * The consequence is the one question the combined view exists to answer: "how many words
   * did the ceiling turn away today?" The sheet cannot say. `ceiling_reached`,
   * `deadline_unreachable` and `claiming_halted` are exactly the rows decided **by** those
   * two numbers, and exactly the rows that recorded neither.
   *
   * The audit also found the claim rows barely covered — outcome, language, deadline and
   * effort could each be replaced by a constant with the suite staying green — so these
   * assert content rather than counts.
   */
  it('records the effort and deadline the gate refused on, not blanks', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [{ ...eligible('a'), eligible: false }],
    });

    await h.cycle.runOnce();

    const row = h.queued.find((q) => q.channel === 'tracking')?.payload;
    expect(row).toMatchObject({
      eventType: 'skip',
      skipReason: 'ineligible_language',
      languageDirection: 'en-us>ms-my',
      effortWords: 4,
    });
    expect(row?.deadlineMs).toEqual(expect.any(Number));
  });

  it('records a claim with its real outcome, direction, effort and deadline', async () => {
    // Kills replacing any of the four with a constant — the audit showed all four could be.
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    expect(h.queued.find((q) => q.channel === 'tracking')?.payload).toMatchObject({
      objId: 'a',
      eventType: 'claim',
      outcome: 'won',
      languageDirection: 'en-us>ms-my',
      effortWords: 4,
    });
  });

  it('records a lost claim too, because the denominator is made of those', async () => {
    // Kills emitting a tracking row only for wins — without the losses the win rate has no
    // denominator and "Straker sends us nothing" cannot be told from "we keep arriving
    // second", which is the sentence contract §1 opens with.
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      claim: () => ({ status: 409 }),
    });

    await h.cycle.runOnce();

    expect(h.queued.find((q) => q.channel === 'tracking')?.payload).toMatchObject({
      objId: 'a',
      eventType: 'claim',
      outcome: 'lost',
    });
  });
});

describe('a barred account stops claiming for good, not for one cycle (T073, contract §4a)', () => {
  // Contract §4a says a barred account means "alert immediately and STOP CLAIMING", and
  // never retry around it. The flag that implemented "stop" lived in one `runOnce()`, so
  // ten seconds later the bot claimed again at a portal that had already refused — which
  // is how a suspension becomes permanent.

  it('does not claim again on the next cycle after a 403', async () => {
    let offers = [raw('offer-1')];
    const h = harness({
      get offers() {
        return offers;
      },
      extract: (rs) => rs.map((r) => eligible(r.obj_id)),
      claim: () => ({ status: 403 }),
    });

    await h.cycle.runOnce();
    expect(h.claimed).toEqual(['offer-1']);

    // A brand-new offer on the next cycle. Nothing about it is barred — the ACCOUNT is.
    offers = [raw('offer-2')];
    await h.cycle.runOnce();

    // The load-bearing assertion: no second attempt. Kills the mutation that makes the
    // stop local to one cycle, which is exactly what the code did.
    expect(h.claimed).toEqual(['offer-1']);
  });

  it('keeps reading and recording while barred, because only claiming is barred', async () => {
    // Stopping the cycle outright would be the wrong cure: reconciliation and tracking must
    // continue, or a barred account also blinds the record it will be audited against.
    let offers = [raw('offer-1')];
    const h = harness({
      get offers() {
        return offers;
      },
      extract: (rs) => rs.map((r) => eligible(r.obj_id)),
      claim: () => ({ status: 403 }),
    });

    await h.cycle.runOnce();
    offers = [raw('offer-2')];
    const ok = await h.cycle.runOnce();

    // The offer was still seen and still reached a row, it simply was not claimed.
    expect(h.events.some((e) => e['objId'] === 'offer-2')).toBe(true);
    expect(ok).toBe(true);
  });

  it('alerts once when the bar is discovered, not once per cycle', async () => {
    // A condition that does not self-heal must not page on a ten-second rhythm.
    let offers = [raw('offer-1')];
    const h = harness({
      get offers() {
        return offers;
      },
      extract: (rs) => rs.map((r) => eligible(r.obj_id)),
      claim: () => ({ status: 403 }),
    });

    await h.cycle.runOnce();
    offers = [raw('offer-2')];
    await h.cycle.runOnce();
    offers = [raw('offer-3')];
    await h.cycle.runOnce();

    const barredAlerts = h.queued.filter(
      (q) => q.channel === 'alerts' && JSON.stringify(q.payload).includes('account_barred'),
    );
    expect(barredAlerts).toHaveLength(1);
  });
});
