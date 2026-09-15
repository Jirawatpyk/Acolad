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
    // Until RP-4 confirms the lost-race signal, every rejection is a fault. A rejection
    // quietly classified as a normal loss is the one outcome that would never page anyone.
    const h = harness({
      offers: [raw('a')],
      extract: () => [eligible('a')],
      claim: () => ({ status: 409 }),
    });

    await h.cycle.runOnce();

    expect(h.trace).toContain('persist:event:claim:failed');
    expect(h.trace).not.toContain('persist:hold');
    expect(h.trace.some((t) => t.startsWith('notify:alerts:'))).toBe(true);
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
