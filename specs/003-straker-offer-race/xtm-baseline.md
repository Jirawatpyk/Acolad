# XTM seven-day baseline (RP-3, SC-005a)

**Captured**: 2026-09-16 · **Window**: 2026-09-09 → 2026-09-16 · **Method**: read-only queries
against `state/acolad.db` and `logs/acolad.2026-09-*.log`. Nothing was written.

SC-005a requires this to exist **before release**, because SC-005 compares the seven days
after release against the seven days before, and a criterion that can only be assessed from
memory is not a criterion.

---

## The headline, which is not what this document was expected to contain

**The XTM bot has seen no jobs at all since 2026-07-15 — two months before this baseline was
taken.** It is running, reading successfully, and correctly reporting an empty queue.

| Measure, this window | Value |
|---|---|
| Poll cycles | ~1,500/day, every one `outcome: "ok"` |
| Cycles reporting jobs | **0** |
| New jobs first seen | **0** |
| Jobs accepted | 0 |
| Jobs skipped, any reason | **0** |
| Mean read latency | 3.4–3.8 s |

So **the skip-reason baseline is the empty set**, and that has a direct consequence for how
SC-005 can be read — see the last section.

---

## Check 3's baseline: alert and error counts

This is the one check with usable data.

| Day | error lines | warn lines | system alerts |
|---|---|---|---|
| 2026-09-09 | 0 | 7 | 0 |
| 2026-09-10 | 1 | 1 | 0 |
| 2026-09-11 | 0 | 0 | **1 critical** (`layout_changed`, recovered 5 s later) + 1 info |
| 2026-09-12 | 1 | 1 | 0 |
| 2026-09-13 | 0 | 1 | 0 |
| 2026-09-14 | 0 | 2 | 0 |
| 2026-09-15 | 0 | 0 | 0 |
| 2026-09-16 | 0 | 0 | 0 |

**The range SC-005 check 3 compares against**: 0–1 error lines/day, 0–7 warn lines/day, and
at most one `layout_changed` critical in a week, self-recovering within seconds. Only one
alert kind occurred: `layout_changed`.

---

## Why the bot is reporting zero, and why that is not the 38-minute bug

Worth settling explicitly, because "reads zero for two months" is exactly the shape of this
repo's most expensive past defect — the inbox grid that returned 0 rows because the read
fired before the data XHR (see `xtm-grid-loads-via-late-xhr` and the note in
`src/straker/offersApi.ts`). Three things say this is not that:

1. **Latency is unchanged across the cliff.** 3,679 ms/cycle on 2026-07-14 when nearly every
   cycle saw jobs; 3,413 ms on 2026-07-16 when none did; 3,830 ms today. The read is doing
   the same work and still settling — the old bug's signature was an *instant* zero.
2. **A real layout drift still alerts.** `layout_changed` fired on 2026-09-11 and recovered,
   so the fail-loud path is alive rather than silently swallowing everything.
3. **The teammate-yield events stopped at the same moment as the jobs.** `xtm_yielding` fires
   when someone else is signed into the shared account. Those events ran constantly through
   14–15 July — dozens a day — and the **last one is 2026-07-15T07:27:50Z**, within an hour
   of the last job seen (2026-07-15T06:13:06Z). Since then: none.

That third point is the decisive one. A broken *reader* would still see teammate sessions
coming and going. Jobs and human activity ceasing together points at the account, not at the
bot: the work stopped, or the account was reassigned.

**This is not proof, and it is not the bot's question to answer.** It is a statement about
what the evidence supports. Confirming it means a human opening XTM and looking.

---

## What this does to SC-005

SC-005's three checks were written expecting an active bot. Against an idle one:

| Check | Status |
|---|---|
| 1. Existing suite green, coverage gate intact | **Usable and holding.** The invariant is now "every test that existed still exists and still passes" — see plan §Scope decision, which retires the 820 figure this branch had been using. |
| 2. No job skipped for a reason absent from the prior seven days | **Not usable as written.** The prior set is empty, so *any* skip after release is a new reason and fails the check — while zero skips passes it trivially, including if the bot has broken. It discriminates nothing in either direction. |
| 3. Alert and error counts stay in range | **Usable**, with the range above. Narrow, but real. |

**Recommended reading of check 2 rather than a silent pass**: treat it as *armed but not yet
meaningful*. It becomes the check it was meant to be on the first day XTM has jobs again; until
then the honest statement is that it cannot distinguish a regression from an idle portal, and
saying so is better than reporting a green tick that rests on nothing happening.

The deeper point this baseline raises belongs in the release conversation rather than here:
**003 exists because the team needs work from a second portal, and this is the measurement of
how completely the first one stopped.** That makes Straker's release more urgent and SC-005
less informative at the same time.
