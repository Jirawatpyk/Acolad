# Data Model — JobCatch 003: Straker Offer Race

**Date**: 2026-09-11 | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

> ## SC-000 boundary — resolved 2026-09-15
>
> This document once withheld §1 until the capture probe reached exit, so that the offer's
> shape could not be fixed on assumption. **§1 is now modelled from three real captured
> payloads** — the owner chose to proceed at 3 of 10, on day 4.2 of 14, and the limitation is
> recorded in §1 and in spec.md §Clarifications rather than left implicit.
>
> Everything else here — how a sighting behaves, what a claim outcome is, how the ledger
> works, what gets reported — was always derived from the specification rather than from the
> portal, and was never blocked.

---

## 1. `StrakerOffer` (portal-native) — modelled 2026-09-15, from captured payloads

**No longer blocked.** The owner decided on 2026-09-15 to proceed without waiting for
SC-000's exit, and the premise that justified the block had partly lapsed: the capture probe
had produced real payloads, so the shape below is read off files rather than assumed. The
decision, with its sample size and the measured lifetimes, is in spec.md §Clarifications.

**Sample: 3 captured offers, of which only TWO are independent** — two of the files are one
job (`job_ref: aj-265`) split across two target languages. Every statement here rests on
that, and the parser is built to fail loud on anything it has not seen rather than to absorb
it (FR-023).

| Field | Type | What the decision uses it for |
|---|---|---|
| `obj_id` | string | The stable identity. Server-issued and opaque, so there is nothing to compose it from and no reason to (R8). |
| `source_lang`, `target_lang` | string | The language direction (FR-011, FR-011a), lower-case and hyphenated: `en-us`, `ms-my`, `th`. **Granularity is inconsistent** — `th` carries no region while `ms-my` and `zh-tw` do. |
| `words` | number | **Effort**, raw word count (FR-009). Read against the pricing fields rather than assumed — but they **corroborate** the reading, they do not prove it (corrected 2026-09-15, see the note below the table). What they do establish is the *unit*: `total_unit` is one project under `rate_type: total_project` and **hours** under `per_hour`, so the third offer pairs 4 words with 0.010 hours — 36 seconds at $18/hour, a coherent pair. |
| `due_at` | string | **Deadline** — and it carries **no timezone** (`2026-09-15T23:20:00`). Which zone the portal means is unknown and cannot be derived from two samples. Read as Bangkok, following the same precedent the XTM bot set for its zone-less Due cell, through one named constant so changing it is one line. |
| `listing_type` | string | Only ever `direct_po`. Any other value **fails loud** — Q3's meanings are still Straker's to supply. |
| `status` | string | Only ever `open`; the list is already queried for it, so anything else means the portal contradicts itself. |
| `job_ref`, `title`, `service` | string | **Read since 2026-09-22**, never for deciding: they name the work on the sheet and the cards, and `job_ref` + target + `service` is the key (`workKey.ts`) that ties an offer to its purchase order and assigned job, whose ids differ. |
| `budget`, `currency`, `rate_type`, `total_unit`, `unit_cost` | — | Present, and no decision reads them. Recorded so the next reader knows they were seen and deliberately unused. |

**The pricing identity does not hold on every offer — corrected 2026-09-15.** An earlier
version of this document claimed `budget = unit_cost × total_unit` holds on all three
payloads and used that as the *proof* that `words` is the genuine effort field. Re-run on the
files, it does not:

| `job_ref` | `rate_type` | `unit_cost` | `total_unit` | product | stated `budget` | |
|---|---|---|---|---|---|---|
| aj-265 (th) | `total_project` | 1.0000 | 1.000 | 1.0000 | 1.00 | ✓ |
| aj-265 (ms-my) | `total_project` | 1.0000 | 1.000 | 1.0000 | 1.00 | ✓ |
| aj-267 (zh-tw) | `per_hour` | 18.0000 | 0.010 | **0.1800** | **0.19** | ✗ |

Two of the three rows are the *same job* split across two languages, so the identity is
confirmed on exactly **one** independent job — and contradicted on the only other one.
Rounding does not explain the gap: 0.1800 does not round to 0.19. Nobody has explained it,
and it is left here unexplained rather than smoothed away; a fee, a floor price or a
different rounding rule on the `per_hour` path are all plausible and none is evidenced.

**The conclusion still stands on its own ground.** `total_unit` under `per_hour` is hours, so
0.010 h = 36 seconds, and 4 words in 36 seconds is coherent — `words` reads as genuine effort.
That is the pricing fields being *consistent with* the reading, not proving it. If the parser
is ever changed on the strength of the pricing arithmetic, this one-cent gap is the reason not
to.

**Observed sizes**: the three offers were worth **$1.00, $1.00 and $0.19**, at 2, 2 and 4
words. If that is representative the daily ceiling (U4) would never bind and the feasibility
check would pass trivially — see spec.md §Clarifications. Three offers from one day is far
too thin to conclude it.

**Missing is not malformed.** An offer without `words` or `due_at` is a *skip* that also
alerts (FR-023a), carried as `null`; a field of the wrong type, an unknown `listing_type`, or
a missing identity is a hard failure that rejects the whole read.

---

## 2. `OfferSighting` — settled

One continuous period during which a given offer was visible in the open list.

| Field | Meaning | Rules |
|---|---|---|
| `objId` | The offer's own identifier, as issued by the portal | Used as issued, and **not composed** from other fields — because the portal supplies one, not because composing is wrong in itself (R8; the XTM bot composes its key to this day). An entry without one is a hard failure, not a skip: there would be nothing left to compose from that we trust. |
| `sighting` | 1-based count of appearances of this `objId` | An offer that disappears and returns starts a **new** sighting. Distinct-offer counts are taken over `objId`, never over sightings. |
| `firstSeenAtMs` | When this sighting began | |
| `lastSeenAtMs` | Last check at which it was still listed | |
| `notFoundAtMs` | First check at which it was gone | Null while still visible |
| `lifetimeMs` | `lastSeenAtMs − firstSeenAtMs` | A **lower bound**. The true disappearance lies inside `(lastSeenAtMs, notFoundAtMs]`, one poll interval wide. Both bounds are kept so reports can state the uncertainty instead of hiding it. |

**Already implemented and tested** by the capture probe's tracker; the bot reuses the same pure transition rather than reimplementing it.

### Transitions

```text
(absent) --appears--> LIVE --still listed--> LIVE
                        |
                        +--gone from list--> VANISHED  (emits lifetime bounds)
                        |
                        +--claimed by us--> OWNED      (leaves the open list)

VANISHED --appears again--> LIVE (sighting + 1, same objId)
```

A **failed read never drives a transition.** Applying an empty list after a failed read would mark every live offer as vanished and stamp fabricated lifetimes on all of them — the single way this model could silently produce wrong answers. The read layer fails loud instead (FR-023), and the cycle returns the previous state unchanged.

---

## 3. `ClaimOutcome` — settled

The result of the one irreversible action this feature performs.

| Value | Meaning | Alert? | Counts toward |
|---|---|---|---|
| `won` | The portal committed the work to the team | No | Win rate numerator; ledger |
| `lost` | Another vendor claimed it first | **No — this is normal** (FR-006, SC-007) | Win rate denominator only |
| `failed` | Anything else — a genuine fault | Yes | Win rate denominator only; **not** the ledger |
| `unknown` | The request produced no answer, or the process died before recording | Yes, once | Win rate denominator only, until reconciliation (R7) settles it — **never** by retrying the claim |
| `recovered` | Found on the portal's assigned list but absent from our record | Yes, once | Win rate **numerator**; ledger — and flagged so a recurring gap is visible (FR-016b) |

`unknown` and `recovered` are two views of the same event — before and after reconciliation. Keeping them distinct is what makes a persistent gap visible rather than smoothed away.

> **The "Counts toward" column was corrected on 2026-09-15**, when T050 implemented the win rate and the two artefacts turned out to disagree. It previously read `Neither` for `failed`, and named only the ledger for `recovered`.
>
> **FR-017 is decisive and this table was wrong.** It defines winnable as "the language direction was eligible **and** the scheduling gate would have permitted the claim", and names exactly one exclusion: "offers the team's own rules turned away". A claim that failed for a fault was eligible, the gate permitted it, and our rules did not turn it away — so it is in the denominator by the requirement's own words. Excluding it would also make the measure go **quiet at the worst moment**: a claim path broken outright would report `n/a (0 of 0)` rather than 0%, which reads as "nothing happened" instead of "everything failed".
>
> `recovered` is numerator for the reason stated in the line below this table: it and `unknown` are one event seen before and after reconciliation, and the work is on the portal's assigned list — the team holds it. A win the bot only discovered afterwards is still work won; that it needed discovering is what the FR-016b flag is for, and `winRateReport.ts` prints the recovered count beside the total so the two are never conflated.
>
> The ledger half of the column is unchanged and is enforced separately by `countsTowardLedger()` in `outcomePolicy.ts`, which is tested against this table.

---

## 4. `SkipReason` — settled

Why an offer that appeared was never claimed. Recorded for **every** skip (FR-010), in language a human reads without a decoder.

| Value | Source |
|---|---|
| `ineligible_language` | Eligibility (FR-011) |
| `outside_schedule` | Gate — working hours or working day |
| `deadline_on_non_working_day` | Gate |
| `deadline_unreachable` | Gate — cannot be finished in working time at the configured throughput |
| `ceiling_reached` | Ledger — the daily budget is spent |
| `exceeds_daily_ceiling_entirely` | Ledger — the offer alone is larger than a whole day. Kept distinct from an ordinary ceiling skip because it will recur every day forever and needs a human, not patience |
| `holiday_calendar_uncurated` | Gate — the deadline's year has no curated calendar; **refuses rather than assumes** (FR-012) |
| `effort_unknown` / `deadline_unknown` | Gate — a required number was missing from the payload. **These two also raise an alert** (FR-023a): they mean the recorded-as-unverified assumption that the list carries everything the decision needs has failed |
| `claiming_halted` | **Not the gate.** The offer passed every rule and was never attempted: the cycle stopped claiming part-way, after a barred account (contract §4a) or a session that expired mid-run. Added 2026-09-15 — these offers previously reached no row at all, being neither attempted nor refused, which cost FR-010 its completeness and quietly shrank FR-017's "genuinely winnable" denominator at the one time the bot can win nothing. A barred account does not self-heal, so the same offers vanished every cycle for as long as the block lasted. **Raises no alert**: the claim that triggered the halt already raised one, and one per passed-over offer is the burst that stopping early exists to prevent. Which condition halted the cycle is logged once as `action: 'claiming_halted'` rather than copied onto each row, because it is a fact about the cycle |

---

## 5. `PortalLedger` — settled

Committed workload against the daily ceiling. **One ledger per portal; no shared ledger and no cross-process transaction** (R11).

| Field | Meaning |
|---|---|
| `deadlineDay` | The working day the work actually lands on — the key, following the XTM bot's effective-deadline-day rule rather than the day it was claimed |
| `committedEffort` | Sum of effort held against that day, measured in **raw word count** (clarified 2026-09-11) |
| `ceiling` | Straker's **own** daily limit — never read from, never shared with, the XTM bot's |

Work recovered by reconciliation is counted here **even when it pushes the day past the ceiling** (FR-016d): it is already committed on the portal, so the ledger is recording reality rather than making a decision. Crossing the ceiling that way warns, and further claims for that day are then blocked as normal.

Derived from held work rather than kept as a running counter, so finishing a job returns its budget — the correction the XTM bot needed after shipping a counter-based version.

**Accepted consequence**: the two portals' ceilings can sum beyond the crew's real capacity. Mitigated by reporting, not by enforcement — see §6.

---

## 6. `ReportRow` and the combined view — settled in behaviour, open in layout

Every offer seen produces one row in Straker's **own tracking file** (a separate file from the XTM record, clarified 2026-09-11), carrying at least: the offer identifier, the language direction (FR-011a), effort, deadline, outcome, skip reason if any, and the timestamps needed to measure win rate and latency.

**The column layout is still open**, but no longer for the original reason: the payload is
known as of 2026-09-15, and what is outstanding is simply that the sink writing it (T052,
Phase 4) has not been built. Deciding the layout is now a matter of building it, not of
waiting for evidence.

The combined daily view (FR-018) reads **both** portals' records, reports each and the total, and — because they now live in separate files — must state plainly when either is unreadable rather than presenting a partial total as a whole one.

---

## 7. What is stored where

| Data | Home | Why |
|---|---|---|
| Sightings, outcomes, ledger | Straker's **own** database file, own state directory | Bulkhead (R11) |
| Captured offer payloads | `fixtures/straker/offers/` | Evidence; becomes the test data for the parser |
| Outgoing records and announcements | Durable queue before dispatch | An outcome must survive a destination outage (FR-016) |
| Credentials | Environment only, redacted from every log | Constitution; the shared password is a release blocker until rotated |
