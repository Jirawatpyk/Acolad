# Contract — What the bot emits

**Date**: 2026-09-11 | **Spec**: [spec.md](../spec.md)

Four outbound surfaces. Their **destinations were clarified on 2026-09-11** and the split is deliberate rather than accidental:

> **Job news is separated per portal. Operational alerts are unified.**
>
> People choose which streams of work to follow, so job news gets its own channel per portal. On-call watches one place for failures, and an alert delivered somewhere nobody watches is the same as no alert — so alerts stay together and name their portal instead.

---

## 1. Tracking record — Straker's own file

A **separate spreadsheet file** from the XTM record, not a tab within it.

**Every offer seen produces a row**, not only the won ones. Without the losses and the skips the team cannot tell "Straker sends us nothing" from "we keep arriving second" — and the win rate has no denominator.

| Must carry | Why |
|---|---|
| Offer identifier | The stable key; rows are deduplicated on it (constitution VII) |
| **Language direction** | FR-011a — with all 44 directions eligible, the claimed language mix must be visible early, not discovered at delivery |
| Effort and deadline | What the gate decided on |
| Outcome — `won` / `lost` / `failed` / `unknown` / `recovered` | `lost` is a normal result and must never read as a fault |
| Skip reason, when skipped | Named in plain language, not a code |
| Timestamps for first sighting and claim | Feed win rate and, if the race is real, the latency measure |

**Column layout is deferred** with the offer model (SC-000). Writes are upserts on the offer identifier so a re-run never duplicates a row. The layout is checked before writing, and a shifted layout fails loud rather than writing into the wrong columns — the XTM bot needed that guard after a real incident.

## 2. Job announcements — Straker's own channel

A separate announcement channel from the XTM bot's.

| Event | Announced? |
|---|---|
| Offer won | **Yes** — the team needs to know work has arrived |
| Offer lost to another vendor | **No message per loss.** At a few offers a day a per-loss message would be noise, and a lost race is not news. Losses appear in the tracking record and in the win rate. |
| Offer skipped by the rules | **No message per skip**; recorded with its reason |
| Work recovered by reconciliation | **Yes, and marked as recovered** — the team is holding work nobody announced, which is exactly what they need told |

Cards follow the existing conventions: English, Bangkok time as `DD/MM/YYYY HH:mm`, one message per job, no batching. Each card **names the portal in its heading** (FR-015) — a concrete test, rather than a judgement about visual distinctiveness.

## 3. Operational alerts — the existing single channel

Every alert **names the portal it came from**.

| Condition | Alert |
|---|---|
| A claim failed for a reason that is not a lost race | Yes |
| A claim's outcome is unknown | Yes, once — resolved by reconciliation, never by retrying |
| Reconciliation found work the record was missing | Yes — a recurring gap means something is wrong upstream |
| The portal's shape departed from the contract | Yes, with the payload captured as evidence |
| Sign-in failed after its single retry | Yes |
| The request budget ran low | Warning |
| The deadline's year has no curated holiday calendar | Yes — claiming refuses rather than assuming |
| The daily ceiling was reached | Warning, once per deadline day |
| Reconciliation failed three times running | Yes — one that has silently stopped looks exactly like one finding nothing |
| An offer arrived without the effort or deadline the rules need | Yes — a contract assumption has failed, not merely one offer skipped |
| A single offer is larger than an entire day's ceiling | Yes — it needs a human, and will otherwise recur forever |
| The account is blocked or suspended | Yes, immediately, and claiming stops |
| **A lost race** | **Never.** SC-007 makes this testable. |

Every alert is de-duplicated **once per offer identity per outcome** (FR-019a): a condition recurring on the same offer must not page repeatedly, while the same condition on a different offer still must.

## 4. Liveness signal — Straker's own

The Straker side emits its **own** signal, monitored independently (FR-026a).

The failure this prevents: a shared signal means one bot can die while the other keeps reporting health, and nobody notices until work stops arriving. Separate signals mean either bot stopping is noticed on its own; SC-010 makes that testable.

## 5. Daily summary — both portals in one view

Produced on working days only, as the XTM bot's already is.

| Must show | |
|---|---|
| Each portal's committed workload | Separately |
| The **combined** total | The agreed mitigation for two ceilings that can sum past the crew's real capacity |
| Straker's win rate for the period | Reported from the start; a target is set only after a baseline, and at 2–3 offers a day an early figure is a weak signal, not a verdict |

Because the two records live in separate files, the summary reads both — and when one is unreadable it **says so** rather than presenting a partial total as a whole one.

Producing the summary must never participate in a claim decision: it reads, at reporting time only, and never on the race path.
