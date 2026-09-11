# Data Model — JobCatch 003: Straker Offer Race

**Date**: 2026-09-11 | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

> ## 🚧 SC-000 boundary — read this first
>
> **The portal-native shape of an offer is NOT fixed in this document and must not be fixed until the capture probe reaches its exit — 10 distinct real payloads, or 14 days elapsed, whichever comes first.** That region is marked **BLOCKED** below. If exit comes on the time branch, the model is built from the smaller sample and the limitation is recorded with it.
>
> Everything else here — how a sighting behaves, what a claim outcome is, how the ledger works, what gets reported — is derived from the specification rather than from the portal, and is settled. Track A can be built against it today.

---

## 1. BLOCKED — `StrakerOffer` (portal-native)

**Status: not modelled. Do not define these fields from the recon note.**

The recon note lists candidate fields read out of the portal's own front-end code, with **zero real payloads ever observed**. Two of them feed the scheduling gate directly:

| Needed by | What it needs | Why guessing is unacceptable |
|---|---|---|
| Gate — capacity and feasibility | the offer's **effort** | Feeding the wrong field mis-measures every ceiling and deadline decision the bot makes, in a way that looks like it is working |
| Gate — deadline reachability | the offer's **deadline** | Same |
| Eligibility | the **language direction**, in the portal's own identifiers | A wrong field silently claims work in the wrong languages |
| Eligibility | the **listing category** | Its values are unknown and its meanings need Straker (Q3/U3) |

**How this gets unblocked**: the capture probe writes each newly-seen payload verbatim to `fixtures/straker/offers/`. When ten distinct offers have accumulated, this section is replaced with a model derived from those files, and the parser is written test-first against them.

**Until then**: no code may reference a portal field name. Track A depends on none of them.

---

## 2. `OfferSighting` — settled

One continuous period during which a given offer was visible in the open list.

| Field | Meaning | Rules |
|---|---|---|
| `objId` | The offer's own identifier, as issued by the portal | Opaque; **never composed** from other fields (R8 — the XTM bot had to fix a collision caused by a composed key). An entry without one is a hard failure, not a skip. |
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
| `failed` | Anything else — a genuine fault | Yes | Neither |
| `unknown` | The request produced no answer, or the process died before recording | Yes, once | Resolved by reconciliation (R7), **never by retrying the claim** |
| `recovered` | Found on the portal's assigned list but absent from our record | Yes, once | Ledger, and flagged so a recurring gap is visible (FR-016b) |

`unknown` and `recovered` are two views of the same event — before and after reconciliation. Keeping them distinct is what makes a persistent gap visible rather than smoothed away.

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

**The column layout is deferred** with the offer model — it cannot be finalised before the payload is known.

The combined daily view (FR-018) reads **both** portals' records, reports each and the total, and — because they now live in separate files — must state plainly when either is unreadable rather than presenting a partial total as a whole one.

---

## 7. What is stored where

| Data | Home | Why |
|---|---|---|
| Sightings, outcomes, ledger | Straker's **own** database file, own state directory | Bulkhead (R11) |
| Captured offer payloads | `fixtures/straker/offers/` | Evidence; becomes the test data for the parser |
| Outgoing records and announcements | Durable queue before dispatch | An outcome must survive a destination outage (FR-016) |
| Credentials | Environment only, redacted from every log | Constitution; the shared password is a release blocker until rotated |
