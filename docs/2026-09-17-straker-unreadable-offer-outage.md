# Postmortem — one unreadable offer blinded jobcatch-straker for three minutes

**Date**: 2026-09-17 · **Bot**: `jobcatch-straker` · **Duration**: 07:06:18 – 07:09:19 (~3 min,
17 consecutive polling cycles) · **Class**: missed job **and** silent outage · **Detected by**:
the owner noticing a job on the portal that the bot had not claimed — not by any alert.

Written because Constitution §Development Workflow requires one, and because the incident's
own reasoning is the interesting part: the code did what it was designed to do, and the
design was wrong in a way that read as correct right up until it fired.

## What happened

At 07:06 the Straker portal listed a DTP job carrying `target_lang: null`. Every offer the
bot had ever seen was a translation with two language tags, so `parseOffer` treated the null
as a shape violation and threw — correctly, by its own contract.

The caller was `raw.map(parseOffer)`. **A throw from one entry therefore discarded the entire
read**, including offers that had parsed perfectly well. The unreadable offer was still on the
portal at the next poll ten seconds later, so it happened again, and again: 17 cycles in a
row saw nothing at all.

Nothing alerted. The alert conditions in `notifier.ts` covered transport — sign-in failures,
timeouts, exhausted retries, a barred account — and this was a parse. The cycle logged an
error each time and the heartbeat kept reporting healthy, because the loop itself was fine.

A human claimed the 956-word job by hand. `reconcile` found it on the assigned list and
brought it onto the ledger at 09:02, which is the recovery path working as designed (FR-016a).

## Why it happened — three independent conditions, all of them required

1. **Blast radius.** The read was all-or-nothing over a list of independent entries.
2. **No alert for this class of failure.** A parse failure had no named condition, so the
   loudest thing it could do was write a log line nobody was watching at 07:06.
3. **An unmodelled kind of work.** Monolingual (DTP) offers existed on the portal and did not
   exist in the parser's model.

Remove any one of the three and the morning is uneventful: (1) alone loses one offer, (2)
alone pages a human in seconds, (3) alone never produces the null.

### The reasoning that produced condition 1, which was not careless

The all-or-nothing read was deliberate and documented. Dropping a bad entry shrinks the list,
and **a silently shorter list is indistinguishable from offers vanishing** — which would stamp
fabricated lifetimes on live offers and corrupt the win-rate measurement this feature exists
to produce. That is the same silent-zero family as the XTM bot's 38-minute outage.

The error was treating *silent drop* and *fatal throw* as the only two options. The third —
**drop the entry loudly** — gives the same protection against silent shrinkage at a fraction
of the blast radius, and it is what shipped.

## What changed

| Condition | Fix | Where |
|---|---|---|
| Blast radius | Parsing is per-entry inside a try/catch; one bad entry costs itself | `src/straker/offerParse.ts` |
| Silence | New `offer_unreadable` alert condition, keyed on the offer id so a permanently broken offer pages **once**, not every 10s | `src/straker/notifier.ts`, `src/straker/main.ts` |
| Unmodelled work | `target_lang: null` parses as monolingual (`ja>ja`); DTP work is claimable against its own daily ceiling and its own derived throughput | `offerParse.ts`, `ledger.ts`, `claimDecision.ts`, `strakerStore.ts` |

Non-obvious details worth keeping:

- **Only `StrakerOfferShapeError` is caught.** Anything else is rethrown and still takes the
  cycle down. A genuine bug in the parser must stay fatal; only a portal-shape disagreement
  is survivable.
- **The alert call is itself guarded.** It writes to SQLite from inside the read's own try
  block, so an unguarded failure there would abort the read and lose the good offers — this
  incident, re-entering through its own fix. A failed enqueue is logged, not thrown.
- **An entry with no `obj_id` still fails the whole read**, in `offersApi.ts`, before parsing
  begins. That is deliberate (an offer without identity cannot be tracked or deduplicated)
  and it fails *loudly* — cycle fails, heartbeat fails, someone is paged. "One bad offer no
  longer blinds the bot" is true below the identity check, not above it.

## What this says about the system, beyond the bug

**Alert conditions were organised by subsystem rather than by consequence.** Transport had
conditions because transport was where failure had been imagined. The question that would
have caught this is not "what can the network do" but "what can make the bot see zero
offers while believing it is healthy" — and a parse failure answers it as well as a timeout
does. The remaining inventory is worth re-reading with that question in hand.

**A heartbeat that measures the loop cannot detect a failure of what the loop reads.** It
reported healthy throughout, correctly. This is a known limit, not a defect; the detection
that was missing had to come from the alert.

**Tests that set both budgets equal cannot tell which one was consulted.** Unrelated to the
outage, and found while reviewing its fix: every integration test used
`{ translation: ceiling, monolingual: ceiling }`, which erased the distinction under test and
let a second defect (the DTP throughput being computed and never read) ship unnoticed. Test
fixtures now use deliberately different figures on the two sides.

## Follow-ups

- [x] Per-entry parse isolation, with a test that a good offer survives a bad neighbour
- [x] `offer_unreadable` alert, with an end-to-end test that the card reaches the ops channel
- [x] Mutation-checked: severing the alert wiring turns both tests red
- [x] Migration round-trip test for the `kind` column on a database that predates it
- [ ] **RP-4 still open** — the DTP rate (words/hour) has never been measured; the ceiling is
      an owner's figure, not an observation. Recorded in `plan.md` §Complexity Tracking with
      its withdrawal trigger.
- [ ] Re-read the alert-condition inventory against "what makes the bot see zero while
      looking healthy", rather than against the list of subsystems.
