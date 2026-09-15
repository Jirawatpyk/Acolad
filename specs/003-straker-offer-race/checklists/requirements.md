# Specification Quality Checklist: JobCatch 003 — Straker Offer Race

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-11
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

**Status: 16 / 16 passing.**

## Validation Record

### Iteration 1 — 2026-09-11

**13 / 16 passing.** Three items failed with a single shared root cause: two unanswered business decisions, not a structural defect.

- `No [NEEDS CLARIFICATION] markers remain` — failed: eligibility scope and effort metric unanswered.
- `Requirements are testable and unambiguous` — failed for exactly two requirements, FR-009 and FR-011, which were well-formed but carried no concrete value. The other requirements were testable as written.
- `All functional requirements have clear acceptance criteria` — failed for the same two.

Questions raised with the team.

### Iteration 2 — 2026-09-11

Both blocking questions answered; all three items now pass.

| Question | Answer | Landed in |
|---|---|---|
| Which language directions is the bot allowed to claim? | **All 44 the account is registered for** — deliberately *not* the XTM Malay-only rule | FR-011, plus new FR-011a |
| How is effort measured? | **Raw word count**, matching the unit the XTM bot runs on today | FR-009 |

**Two consequences were recorded rather than silently absorbed:**

1. Eligibility across 44 directions assumes the crew can actually deliver all of them. Registration is what the account signed up for, not proof of capacity per language, and claiming is irreversible. FR-011a now requires the claimed language mix to be recorded so an unstaffable direction surfaces early; a new Assumption states the risk plainly.
2. The scheduling gate decides deadline reachability from a single throughput figure. That was sound when every job was Malay; across many directions it will be optimistic for some languages and pessimistic for others. Raised as **Q5** rather than assumed away.

### Iteration 3 — 2026-09-11 (after `/speckit-clarify`)

Four clarifications integrated; re-evaluated all 16 items against the updated spec. **No state changes — 16/16 → 16/16.** The additions (FR-016a/b, FR-026a/b, SC-009, SC-010, two edge cases) are testable and technology-agnostic, and a second leak scan again returned 0 matches.

### Evidence for the passing items

- *No implementation details*: the spec was scanned twice — after the first draft and after the clarification edits — for protocol, framework, storage and vendor-library vocabulary (HTTP, REST, API, endpoint, JSON, SQLite, cookie, fetch, Playwright, PM2, status codes, iframe, webhook, selector). **0 matches both times.** Portal mechanics are described by behaviour ("reading rendered pages in a browser", "the portal's own front end") rather than by technology.
- *Success criteria measurable and technology-agnostic*: every criterion states a number and how to check it. SC-001 and SC-002 are marked conditional, with both the condition and the consequence of striking them written into the spec, so the decision rests on Phase 0's measurement rather than on judgement.
- *Scope bounded*: non-goals inherited verbatim from the brief — no portal abstraction, no declining, no file delivery, no time tracking, no invoicing, no XTM migration, no relocation of the host.
- *Edge cases*: thirteen identified after clarification, led by the two silent-corruption cases — reading a failed response as "no offers", and absorbing an unexpected payload shape. Both mirror real incidents from the XTM bot.

## Notes

**Open questions that remain are deliberate and none of them block planning:**

- **Q3 (listing-category meaning)** — cannot be answered internally; the values come from Phase 0 but the meanings must come from Straker. The conservative default (every open offer is contested) is the safe reading and is already written into the spec.
- **Q4 (numeric daily ceiling)** — deliberately deferred to Phase 0 evidence. Blocks release configuration, not planning.
- **Q5 (one throughput figure across 44 directions)** — a design refinement surfaced by the Q1 answer; decide with Phase 0's language mix in hand.

**SC-000 is a hard gate on the next phase.** This specification is complete enough to plan *around*, but `/speckit-plan` MUST NOT fix the offer data model or the polling rhythm until Phase 0 has delivered at least 10 real offer payloads and a measured offer lifetime. The Phase 0 probe is running; at the time of writing (2026-09-11) it has captured **0 offers**.

> **What happened to that gate — 2026-09-15.** The probe reached **3 distinct offers** (two of
> them one job split across two target languages) on day 4.2 of the 14-day branch, and the
> owner **lifted the gate there rather than at its exit**. The offer model and the polling
> rhythm were both fixed on that sample: `data-model.md` §1 is modelled from the three payloads
> and the rhythm is 10 seconds. The paragraph above is left as written because it records what
> the checklist demanded at the time; this note records that the demand was consciously not
> met, and why — the payloads were real, so the model was no longer being fixed *on assumption*,
> which was the failure SC-000 existed to prevent. The cost is a two-job sample, carried
> forward as an explicit limitation in spec §Clarifications, data-model §1, research §R10 and
> quickstart V19, and answered in code by a parser that refuses anything it has not seen.

**Recommended next step**: `/speckit-plan` may begin on the parts SC-000 does not gate (isolation, reporting, scheduling reuse, the DC-1..DC-4 structure). Raise Q3 with Straker in parallel.
