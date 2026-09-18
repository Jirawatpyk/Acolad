import { describe, expect, it } from 'vitest';
import { StrakerHttpError } from '../../../src/straker/httpClient.js';
import { eligible, harness, raw } from './pollCycleHarness.js';

describe('T037 the cycle runs the same named steps as the XTM loop (FR-029, DC-3)', () => {
  it('fetches, diffs, gates, acts, persists and notifies — in that order', async () => {
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await expect(h.cycle.runOnce()).resolves.toBe(true);

    const order = (step: string): number => h.trace.findIndex((t) => t.startsWith(step));
    expect(order('fetch')).toBeGreaterThanOrEqual(0);
    expect(order('gate')).toBeGreaterThan(order('fetch'));
    expect(order('claim')).toBeGreaterThan(order('gate'));
    expect(order('persist')).toBeGreaterThan(order('claim'));
    expect(order('notify')).toBeGreaterThan(order('persist'));
  });

  it('leaves the tracker untouched and reports failure when the read fails (FR-023)', async () => {
    const h = harness({ readFails: new Error('portal down') });

    await expect(h.cycle.runOnce()).resolves.toBe(false);

    expect(h.trace).not.toContain('persist:endSighting');
    expect(h.claimed).toEqual([]);
  });
});

describe('re-authenticating only when the portal says the session expired', () => {
  it('signs in again after an expired-session rejection on the read', async () => {
    const h = harness({
      readFails: new StrakerHttpError(401, '/offers', 'expired'),
      offers: [],
    });
    await h.cycle.runOnce();
    await h.cycle.runOnce();

    expect(h.trace.filter((t) => t === 'signIn')).toHaveLength(2);
  });

  it('does NOT sign in again after an account-blocked rejection on the read', async () => {
    // Contract 4a: a barred account must never be retried around as though it were
    // transient. Re-signing in every cycle turns a suspension into a sign-in storm against
    // a portal that has already said no.
    const h = harness({ readFails: new StrakerHttpError(403, '/offers', 'blocked') });

    await h.cycle.runOnce();
    await h.cycle.runOnce();
    await h.cycle.runOnce();

    expect(h.trace.filter((t) => t === 'signIn')).toHaveLength(1);
  });

  it('does NOT sign in again after a shape violation, which is a contract fault', async () => {
    const h = harness({ readFails: new Error('reply is no longer a bare array') });

    await h.cycle.runOnce();
    await h.cycle.runOnce();

    expect(h.trace.filter((t) => t === 'signIn')).toHaveLength(1);
  });
});

describe('a payload that breaks the contract is treated as a failed read (FR-023)', () => {
  it('drives no transition and reports the cycle as failed', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => {
        throw new Error('offer field is of an unexpected type');
      },
    });

    await expect(h.cycle.runOnce()).resolves.toBe(false);

    // Parsing after the diff would advance the tracker in memory while the store recorded
    // nothing, leaving the two disagreeing about which offers are already known — with
    // nothing to say so. Same guarantee as a failed read: nothing moves.
    expect(h.trace.filter((t) => t.startsWith('persist:'))).toEqual([]);
    expect(h.claimed).toEqual([]);
  });

  it('re-emits the offer as newly appeared on the next cycle, because nothing was consumed', async () => {
    let broken = true;
    const h = harness({
      offers: [raw('a')],
      extract: () => {
        if (broken) throw new Error('offer field is of an unexpected type');
        return [eligible('a')];
      },
    });

    await h.cycle.runOnce();
    broken = false;
    await h.cycle.runOnce();

    expect(h.trace).toContain('persist:sighting:a');
  });
});

describe('T038 nothing deferrable happens between noticing an offer and claiming it (FR-003)', () => {
  it('writes nothing and announces nothing before the claim is dispatched', async () => {
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    // The window this protects is the race itself. A durable write in front of the claim
    // adds latency to the one step where latency decides whether the team gets the work —
    // which is why the spec closes the window BEHIND the claim, by reconciling, instead.
    const beforeClaim = h.trace.slice(0, h.trace.indexOf('claim:a'));
    expect(beforeClaim.filter((t) => t.startsWith('persist:'))).toEqual([]);
    expect(beforeClaim.filter((t) => t.startsWith('notify:'))).toEqual([]);
  });

  it('reads the held list once per cycle, before the gate, not once per offer', async () => {
    const h = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), eligible('b')],
    });

    await h.cycle.runOnce();

    expect(h.trace.filter((t) => t === 'read:heldWork')).toHaveLength(1);
  });
});

describe('T040 every offer not claimed is recorded with the reason that blocked it (FR-010)', () => {
  it('records a skip event naming the reason', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [{ ...eligible('a'), eligible: false }],
    });

    await h.cycle.runOnce();

    expect(h.trace).toContain('persist:event:skip:ineligible_language');
    expect(h.claimed).toEqual([]);
  });

  it('alerts as well as skips when the offer arrived without the numbers the rules need', async () => {
    // FR-023a: this is not an ordinary skip. It means the recorded-as-unverified assumption
    // that the list carries everything the decision needs has failed, and every later
    // decision rests on it.
    const h = harness({
      offers: [raw('a')],
      extract: () => [{ ...eligible('a'), effortWords: null }],
    });

    await h.cycle.runOnce();

    expect(h.trace.some((t) => t === 'persist:event:skip:effort_unknown')).toBe(true);
    expect(h.trace.some((t) => t.startsWith('notify:alerts:'))).toBe(true);
  });

  it('does not alert for a skip that is our own rules working as intended', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [{ ...eligible('a'), eligible: false }],
    });

    await h.cycle.runOnce();

    expect(h.trace.some((t) => t.startsWith('notify:alerts:'))).toBe(false);
  });
});

describe('what each claim outcome then causes', () => {
  it('holds a won offer on the ledger and announces it', async () => {
    const h = harness({ offers: [raw('a')], extract: () => [eligible('a')] });

    await h.cycle.runOnce();

    expect(h.trace).toContain('persist:hold');
    expect(h.trace).toContain('persist:event:claim:won');
    expect(h.trace.some((t) => t.startsWith('notify:offers:'))).toBe(true);
  });

  it('records a rejected claim as failed, holds nothing, and alerts (FR-005a)', async () => {
    // Every rejection but the confirmed lost-race 409 is a fault. A rejection quietly
    // classified as a normal loss is the one outcome that would never page anyone.
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      claim: () => ({ status: 400 }),
    });

    await h.cycle.runOnce();

    expect(h.trace).toContain('persist:event:claim:failed');
    expect(h.trace).not.toContain('persist:hold');
    expect(h.trace.some((t) => t.startsWith('notify:alerts:'))).toBe(true);
  });

  it('records a 409 as a lost race: holds nothing and pages no one (RP-4, 2026-09-18)', async () => {
    // The portal's own web app reads 409 on accept as "taken by another vendor".
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      claim: () => ({ status: 409 }),
    });

    await h.cycle.runOnce();

    expect(h.trace).toContain('persist:event:claim:lost');
    expect(h.trace).not.toContain('persist:hold');
    expect(h.trace.some((t) => t.startsWith('notify:alerts:'))).toBe(false);
  });

  it('records an unanswered claim as unknown and never dispatches a second one (R7)', async () => {
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      claim: () => 'no_answer',
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['a']);
    expect(h.trace).toContain('persist:event:claim:unknown');
    expect(h.trace).not.toContain('persist:hold');
  });

  it('stops claiming for the rest of the cycle when the session expires mid-run', async () => {
    // Carrying on would meet the same 401 on every remaining offer, classify each as a
    // fault, and turn one dead session into a burst of alerts about unrelated offers.
    const h = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), eligible('b')],
      claim: () => ({ status: 401 }),
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['a']);
  });

  it('stops claiming for the rest of the cycle once the account is barred (contract 4a)', async () => {
    const h = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), eligible('b')],
      claim: () => ({ status: 403 }),
    });

    await h.cycle.runOnce();

    // Carrying on would hammer claims at a portal that has already said no — how an
    // account earns a permanent block rather than recovers from one.
    expect(h.claimed).toEqual(['a']);
  });
});

describe('an offer the halt passed over is still recorded (FR-010)', () => {
  /**
   * The offers left behind when `stopClaiming` fires used to reach no row at all: they were
   * decided `claim`, so the skip pass — which records only `action: 'skip'` — ignored them,
   * and the claim pass iterates only what was attempted. An offer with a sighting and
   * nothing else.
   *
   * Two things make that worse than untidy. FR-010 asks that every offer not claimed carry
   * the reason that blocked it, and a barred account does not self-heal: `stop_claiming`
   * fires again every cycle, so the same offers stay invisible for as long as the block
   * lasts. And FR-017's win rate is won ÷ genuinely winnable — these ARE winnable, our own
   * rules asked for them, so leaving them out of the record inflates the rate at exactly
   * the moment the bot is least able to win anything.
   */
  it('records the ones it never attempted, naming the halt as the reason', async () => {
    const h = harness({
      offers: [raw('a'), raw('b'), raw('c')],
      extract: () => [eligible('a'), eligible('b'), eligible('c')],
      claim: () => ({ status: 403 }),
    });

    await h.cycle.runOnce();

    expect(h.claimed).toEqual(['a']);
    const skips = h.events.filter((e) => e.eventType === 'skip');
    expect(skips.map((e) => e.objId)).toEqual(['b', 'c']);
    expect(skips.every((e) => e.skipReason === 'claiming_halted')).toBe(true);
  });

  it('logs which condition halted it, once for the cycle rather than once per offer', async () => {
    // The row says an offer was passed over; it does not say why the bot stopped, and there
    // is no prose column to put that in. It belongs to the cycle, not to each offer — a
    // barred account needs someone to call Straker, an expired session needs nothing — so
    // it is one log line naming the condition and how many offers it cost.
    const barred = harness({
      offers: [raw('a'), raw('b'), raw('c')],
      extract: () => [eligible('a'), eligible('b'), eligible('c')],
      claim: () => ({ status: 403 }),
    });
    const expired = harness({
      offers: [raw('a'), raw('b')],
      extract: () => [eligible('a'), eligible('b')],
      claim: () => ({ status: 401 }),
    });

    await barred.cycle.runOnce();
    await expired.cycle.runOnce();

    const halt = (h: typeof barred) => h.logs.find((l) => l.fields.action === 'claiming_halted');
    expect(halt(barred)?.fields).toMatchObject({ followUp: 'stop_claiming', passedOver: 2 });
    expect(halt(expired)?.fields).toMatchObject({ followUp: 're_authenticate', passedOver: 1 });
  });

  it('does not alert once per passed-over offer — the halt itself already alerted', async () => {
    // One dead session or one barred account arriving as a burst of alerts about unrelated
    // offers is the thing `stopClaiming` exists to prevent; recording must not undo it.
    const h = harness({
      offers: [raw('a'), raw('b'), raw('c'), raw('d')],
      extract: () => [eligible('a'), eligible('b'), eligible('c'), eligible('d')],
      claim: () => ({ status: 403 }),
    });

    await h.cycle.runOnce();

    // TWO alerts, and the number is the point: it is constant in the number of offers
    // passed over, not one per offer. Four eligible offers, one claim attempted, two alerts.
    //
    // They say different things and both are wanted. The offer-scoped one names the claim
    // that failed; the system-scoped one says claiming is now stopped and will not resume
    // without a human (T073). `sign_in_refused` sits beside per-request failures for the
    // same reason. Adding a fifth offer must not add a third alert — that is the property.
    const alerts = h.queued.filter((q) => q.channel === 'alerts');
    // Asserted as a SET, not a sequence. The system alert is raised the moment the 403
    // arrives and the offer alert in the later persist phase, so their order is an artefact
    // of where each is raised rather than anything the design promises.
    expect(alerts).toHaveLength(2);
    const ids = alerts.map((a) => a.eventId);
    expect(ids).toContain('claim:a:failed');
    expect(ids.some((id) => id.startsWith('account_barred:'))).toBe(true);
  });
});
