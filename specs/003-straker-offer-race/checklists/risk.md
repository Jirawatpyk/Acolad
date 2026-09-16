# Risk Requirements Checklist: JobCatch 003 — Straker Offer Race

**Purpose**: Validate the *quality of the requirements* in the four risk-bearing dimensions of this feature — irreversible action & recovery, isolation from the live bot, the conditional race premise, and operational/compliance readiness — plus the quality of the SC-000 deferral itself
**Created**: 2026-09-11
**Feature**: [spec.md](../spec.md) · [plan.md](../plan.md) · [research.md](../research.md)
**Depth**: Standard — review before implementation, ahead of `/speckit-tasks`
**Audience**: Reviewer, pre-implementation

**Note**: This is a **requirements-quality** review, not a test plan. Every item asks whether something is *written well enough to build from*, never whether the system works. `[x]` means the reviewer judged the requirement adequately specified — it does **not** mean the work is done. Items are left unchecked for the reviewer.

> Companion file: [requirements.md](./requirements.md) is Spec Kit's built-in spec-quality checklist and is maintained by `/speckit-specify` and `/speckit-clarify`. This file is reviewer-owned and separate.

---

## Requirement Completeness

- [ ] CHK001 Is the **frequency** of reconciliation specified, rather than only "on start, and periodically"? [Clarity, Spec §FR-016a]
- [ ] CHK002 Are requirements defined for **reconciliation itself failing** — the portal unreachable, or its assigned-work list unreadable? [Gap, Spec §FR-016a]
- [ ] CHK003 Is it specified what happens when recovered work would push the day **past its ceiling** — is it accepted as already-committed, or does it trigger a different response? [Gap, Spec §FR-016a + §PortalLedger]
- [ ] CHK004 Are requirements defined for how the three claim outcomes are **told apart**, given the contract records the lost-race signal as unconfirmed? [Gap, Spec §FR-005, Contract §4]
- [ ] CHK005 Is the coverage-gate extension expressed as a **requirement anywhere in the spec**, or does it exist only in the plan and research? [Traceability, Gap, Plan §Constitution Check II, Research §R12]
- [ ] CHK006 Is password rotation stated as a **requirement or acceptance gate**, rather than only as an assumption and a quickstart checkbox? [Traceability, Spec §Assumptions]
- [ ] CHK007 Are the resources the two bots **still share** enumerated — service-account credentials, log directory, the process supervisor itself — and is sharing them explicitly accepted? [Gap, Spec §FR-024]
- [ ] CHK008 Are requirements defined for what the bot does between reaching the daily ceiling and the next day — continue reading to keep the win-rate denominator honest, or stop? [Gap, Spec §FR-009/FR-017]

## Requirement Clarity

- [ ] CHK009 In SC-001, is "**the moment the offer first became visible**" defined as when the portal published it or when our read observed it? The two differ by up to one poll interval, which is the same order as the 400 ms target itself. [Ambiguity, Spec §SC-001]
- [ ] CHK010 Is the **boundary between "short-lived" and "minutes or longer"** defined? A measured median of, say, 90 seconds falls between the two branches as currently written. [Ambiguity, Spec §Conditional criteria]
- [ ] CHK011 Is the win-rate **denominator** precisely defined — does an eligible offer seen outside working hours, or after the ceiling is reached, count as one the team could have won? [Ambiguity, Spec §SC-004/FR-017]
- [ ] CHK012 Is "alert **once**" scoped — once per offer, per day, or per occurrence? [Ambiguity, Data model §ClaimOutcome]
- [ ] CHK013 Is "**slow itself** as the budget is consumed" quantified with a trigger point and a response, rather than left as a direction of travel? [Clarity, Spec §FR-019]
- [ ] CHK014 Is "the portal's terms have been **read and cleared**" defined — who decides, and what recorded artefact shows it was done? [Ambiguity, Spec §Assumptions, Quickstart §Release blockers]
- [ ] CHK015 Is "**distinguishable at a glance** from XTM work" expressed in terms a reviewer can judge, or does it rest on the reader's taste? [Measurability, Spec §FR-015]

## Requirement Consistency

- [ ] CHK016 Do FR-003 (record only **after** the claim resolves) and the constitution's rule that state is committed **before** an action is reported complete describe a reconciled position, or a contradiction papered over by FR-016a? [Conflict, Spec §FR-003, Constitution VII]
- [ ] CHK017 Does SC-000's "**at least 10 distinct offers**" agree with the brief's original exit criterion, which also allowed **14 days elapsed** as an alternative? The alternative does not appear in the spec, so a probe that captures 8 offers in a month has no defined exit. [Conflict, Spec §SC-000, Brief §Phase 0 exit criteria]
- [ ] CHK018 Are the separation rules coherent — job news separated per portal (FR-015) while alerts are unified (FR-026b) — and is the distinction stated as a rule a future reader will not "fix" into consistency? [Consistency, Spec §FR-015/FR-026b]
- [ ] CHK019 Do the effort unit in the ledger (raw word count) and the unit the combined daily view totals across both portals agree, so the total is not adding unlike quantities? [Consistency, Spec §FR-009/FR-018]
- [ ] CHK020 Is eligibility across all 44 directions consistent with the scheduling gate's **single** throughput figure, or is the tension only recorded as an open question? [Consistency, Spec §FR-011 + Q5]

## Acceptance Criteria Quality

- [ ] CHK021 Is SC-005's "**indistinguishable** from the seven days before" given a numeric tolerance, or can any reviewer's judgement satisfy it? [Measurability, Spec §SC-005]
- [ ] CHK022 Is the requirement to **capture the XTM baseline before release** stated, given SC-005 compares against it? Without a pre-recorded baseline the criterion cannot be evaluated after the fact. [Gap, Spec §SC-005]
- [ ] CHK023 Is SC-008's "**no measurable effect**" tied to specific observable quantities, or left open to interpretation? [Measurability, Spec §SC-008]
- [ ] CHK024 Is SC-010's "within the same detection window the XTM bot already meets today" resolved to an actual duration in this spec, rather than by reference to another system's configuration? [Clarity, Spec §SC-010]
- [ ] CHK025 Is SC-009's "**one reconciliation pass**" bounded in time, so "beyond one pass" is a measurable interval rather than a count of an unscheduled event? [Measurability, Spec §SC-009]
- [ ] CHK026 Is the **1.3× factor** in SC-002 derived from something, or is it an unexplained constant a future reader cannot re-justify? [Traceability, Spec §SC-002]

## Scenario & Edge Case Coverage

- [ ] CHK027 Are requirements defined for an offer whose effort **exceeds the entire daily ceiling** — is it reported for a human decision, or does it recur as a skip forever? [Coverage, Spec §Edge Cases]
- [ ] CHK028 Are requirements defined for the account being **suspended or blocked mid-run** — distinct from an expired session, which is already covered? [Gap, Exception Flow]
- [ ] CHK029 Are requirements defined for **two offers arriving in the same read** where the first consumes the remaining ceiling — is evaluation order specified, or arbitrary? [Gap, Coverage]
- [ ] CHK030 Are requirements defined for the probe and the bot running **at the same time against the same account**, during the overlap when one replaces the other? [Gap, Quickstart §Tearing down]
- [ ] CHK031 Are **clock-related** scenarios addressed — host time drift, or a deadline expressed in a different zone than the scheduling calendar assumes? [Gap, Coverage]

## Dependencies & Assumptions

- [ ] CHK032 Is the assumption that **everything the gate needs arrives in the list reply** flagged as unverified, and is a defined response specified for the case where it turns out false? [Assumption, Contract §2]
- [ ] CHK033 Is the dependency on the crew actually being able to **deliver all 44 language directions** validated, or recorded as an accepted risk with no mitigation beyond visibility? [Assumption, Spec §FR-011a]
- [ ] CHK034 Is the dependency on **Straker answering Q3** (listing-category meanings) given an owner and a consequence if it goes unanswered indefinitely? [Dependency, Spec §Open Questions]

## Quality of the SC-000 Deferral

*Requested focus: judge whether the gating itself is written well, not the deferred content.*

- [ ] CHK035 Does the spec state **who decides** that SC-000 is satisfied, and where that decision is recorded? [Gap, Spec §SC-000]
- [ ] CHK036 Is the **exact scope** of what SC-000 blocks enumerated, so a reader can tell a blocked decision from an allowed one without re-deriving it? [Clarity, Spec §SC-000, Plan §Delivery split]
- [ ] CHK037 Is there a defined response if the probe runs for an extended period and **never reaches 10 offers** — proceed on a small sample and say so, or keep waiting? See also CHK017. [Gap, Spec §SC-000]
- [ ] CHK038 Is it specified what happens to **work already built under Track A** if the probe's findings contradict an assumption it rests on? [Gap, Plan §Delivery split]
- [ ] CHK039 Is the rule that **only measured lifetime — never offer volume** — may strike SC-001/SC-002 stated somewhere a reader will encounter it before making that call? [Clarity, Spec §Conditional criteria]

## Ambiguities & Conflicts to Resolve

- [ ] CHK040 Is the rate-limit **constitution violation** recorded with a condition under which it must be re-reviewed, rather than as a permanent exemption? [Gap, Plan §Complexity Tracking]
- [ ] CHK041 Is the decision to **defer the shared-core extraction** given a trigger that would reopen it, so it does not quietly become permanent? [Gap, Plan §Scope decision]
- [ ] CHK042 Is the term "**claim**" used consistently across spec, plan, data model and contracts, with no drift into "accept" (the XTM bot's word) that would blur which system is meant? [Consistency, Terminology]

---

## Notes

- Items are unchecked by design — checkbox state belongs to the reviewer.
- `/speckit-implement` reads checklist state but does not modify these markers.
- Items marked `[Gap]` point at something absent from the requirements; `[Ambiguity]` and `[Conflict]` point at something present but unclear or contradictory.
- **CHK017 and CHK037 are the same underlying hole** seen from two directions — the probe's exit criterion lost its "or 14 days" branch somewhere between the brief and the spec. Resolving one should resolve both.
- **CHK009 and CHK010 both make a conditional success criterion unmeasurable as written.** Because those criteria decide whether a substantial block of work exists at all, they are worth resolving before `/speckit-tasks` rather than after.

### Resolution log (agent-applied 2026-09-11 — **checkboxes deliberately left for the reviewer**)

| Item | What changed | Where |
|---|---|---|
| CHK009 | SC-001's origin is now "the arrival of the response that first carried the offer", with the unobservable alternative explicitly rejected. This restores precision the brief already had and the spec had lost. | spec §SC-001, plan §Performance Goals |
| CHK010 | The strike rule is now computable: strike only if the **shortest** sighting lifetime is ≥ 120 s, with the choice of statistic and threshold both justified in place. | spec §Conditional criteria, quickstart §The one decision |
| CHK017 / CHK037 | SC-000's exit restored to "10 distinct offers **or** 14 days, whichever first", with a small sample recorded as a limitation and the criteria **kept** rather than struck below a sample of 10. | spec §SC-000, data-model, research §R8/R9, quickstart §V19 |

**Second sweep — remaining 39 items, same day.** All were worked; the table below records what changed and where. Checkboxes remain the reviewer's to set.

| Items | Resolution |
|---|---|
| CHK001-003 | Reconciliation given a **15-minute** interval, a failure policy (retry next pass; alert after three consecutive), and a rule that recovered work counts **even past the ceiling** — it is already committed, so recording it reports reality rather than deciding. FR-016a/c/d |
| CHK004 | The lost-race signal must be identified **positively**; until confirmed against a real offer an unrecognised rejection is a **fault**, not a loss. FR-005a, release precondition RP-4 |
| CHK005 | Coverage-gate inclusion is now a requirement in the spec, not only a note in the plan. FR-013a |
| CHK006, CHK014, CHK022 | New **Release Preconditions** section, RP-1..RP-5. RP-2 requires the terms conclusion to be *written down* — a named person, a date, a finding; "someone looked at it" is not a record |
| CHK007 | What the two bots still share is now enumerated — host, supervisor, service-account credentials and quota, log directory, alert channel — each accepted explicitly, against a list of what is **not** shared |
| CHK008, CHK029 | Reaching the ceiling does not stop reading (it would corrupt the win-rate denominator and suspend reconciliation); multiple offers in one read are evaluated in **portal order**, chosen for determinism over the race path. FR-007a/b |
| CHK011 | Win rate defined exactly — won ÷ **genuinely winnable** — with a companion figure for offers our own rules turned away, so a low intake can be traced to the right cause. FR-017/017a |
| CHK012, CHK013 | Alerts de-duplicate **per offer identity per outcome**; the budget response is now stepped at **120** (stop deferrable work) and **60** (pause reading). FR-019/019a |
| CHK015 | "Distinguishable at a glance" replaced by **name the portal in the heading** — a test rather than a taste. FR-015 |
| CHK016 | The FR-003 / Principle VII tension is recorded in Complexity Tracking as a **genuine deviation in mechanism**, met behind the action by reconciliation rather than argued away |
| CHK018 | The alerts-unified / news-separated asymmetry is now marked **MUST NOT be made consistent**, with the reason attached |
| CHK019 | The combined total is shown only while both portals measure in the same unit; otherwise suppressed or labelled |
| CHK020 | Interim rule while Q5 is open: the single throughput figure is set to the **slowest** plausible direction, never an average — being optimistic promises deadlines the crew cannot meet |
| CHK021 | SC-005 rebuilt as three yes-or-no checks; a percentage tolerance was **rejected** because normal variation swamps any meaningful threshold at a handful of jobs a day |
| CHK023 | SC-008 now names four quantities — uptime, restart count, cadence, alert count |
| CHK024 | SC-010 resolved to **10 minutes**, stated here rather than by reference to another system's configuration |
| CHK025 | SC-009 bounded as **15 minutes**: a pass that never runs is not a pass that found nothing |
| CHK026 | The 1.3× factor justified — passes jitter, still catches a skipped cycle at ~2× |
| CHK027, CHK028, CHK030, CHK031 | Four edge cases added, with a distinct skip reason for an offer larger than a whole day, and a contract section separating **account blocked** from **session expired** |
| CHK032 | A missing effort or deadline now **alerts** as well as skips: it means a recorded-as-unverified contract assumption has failed. FR-023a |
| CHK033 | An **exclusion list** added, defaulting to empty — a lever that changes nothing today but converts the 44-direction risk from wait-and-notice into a setting |
| CHK034 | Q3 given an **owner** and a standing default if it is never answered |
| CHK035, CHK036 | SC-000 now states **who records the decision** and **exactly what it blocks** (four items), with everything else explicitly unblocked |
| CHK038 | Track A's invariant stated: no item names a portal field, so a contradiction can only reach Track B; an item found to depend on offer shape **moves** rather than being patched |
| CHK039 | The volume-is-not-a-reason rule now appears in spec, plan, research and quickstart — a reader meets it before the decision |
| CHK040, CHK041 | Both deferrals given **reopen triggers**, so neither quietly becomes a permanent decision nobody made |
| CHK042 | Terminology verified by scan: **claim** for Straker, **accept** only when describing the XTM bot. No drift found; the distinction is now stated in Context so it is not blurred later |

Nine new acceptance items (V23-V29) and eleven new requirements were added as a result. Two items — CHK033 and CHK020 — were resolved by adding a **lever** rather than by changing the agreed decision.
