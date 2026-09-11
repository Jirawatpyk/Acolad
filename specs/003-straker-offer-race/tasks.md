# Tasks: JobCatch 003 — Straker Offer Race

**Input**: Design documents from `/specs/003-straker-offer-race/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: MANDATORY per Constitution II for decision logic, state, reporting and scheduling. Every such test task is written and watched to **fail** before its implementation task. Test tasks are numbered before the code they cover, and that ordering is not a convenience — a test written after the code proves only that the code does what it does.

**Organization**: grouped by user story so each can be implemented and verified on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelisable — different files, no dependency on an unfinished task
- **[US1/US2/US3]**: the user story a task serves (story phases only)
- **🚧 Track B**: **blocked by SC-000** — must not start until the capture probe reaches exit

## The SC-000 gate, stated once

**Track A** tasks name no portal field and assume nothing about an offer's shape, size or lifetime. They are buildable today.

**🚧 Track B** tasks need real offer payloads. They are blocked until the capture probe reports **10 distinct offers, or 14 days elapsed** — whichever comes first. Starting one early means guessing which field carries effort and which carries the deadline, and both feed the scheduling gate directly.

Current probe state: **0 offers captured** (running since 2026-09-11 11:56 BKK).

## Path conventions

Single project. Straker code extends `src/straker/`, started by the capture probe. `src/schedule/` and `src/monitoring/` are **reused unchanged**. `src/config/index.ts` and every existing XTM file are **not touched** — see plan §Scope decision.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: make the new bot configurable and governable before any of its logic exists

- [ ] T001 [P] (FR-001, FR-009, FR-024) Write failing tests for the extended Straker config — own daily ceiling, own throughput, `SINGLE_INSTANCE_PORT` 47812, own `STATE_DIR`, own tracking-file id, own announcement channel, and the eligibility exclusion list defaulting to empty — in `tests/unit/straker/config.test.ts`
- [ ] T002 Extend the config schema to pass T001 in `src/straker/config.ts` (FR-009, FR-024), keeping it wholly separate from `src/config/index.ts` (adding required vars there would fail-fast the live XTM bot on start)
- [ ] T003 [P] Add `src/straker/**` to the coverage gate include list in `vitest.config.ts` (FR-013a, V18) — without this the constitution's coverage requirement silently does not apply to any new code
- [ ] T004 [P] Add the Straker bot as its own PM2 application named `jobcatch-straker` in `straker.config.cjs`, separate from `ecosystem.config.cjs` (FR-024, FR-032) — the filename must end in `.config.cjs` or PM2 runs it as a plain script instead of reading it as an app definition
- [ ] T005 Extend `scripts/deploy.ps1` so either bot can be released or restarted **without touching the other** (FR-026, V12), and verify the existing XTM path is byte-for-byte unchanged
- [ ] T006 [P] (FR-024) Add the new `STRAKER_*` variables with placeholder values and explanatory comments to `.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: state, isolation and observability that every story needs

**⚠️ No user-story work may begin until this phase is complete**

- [ ] T007 [P] (FR-024, R11) Write failing tests for the Straker store schema — sightings, outcomes and ledger, in its **own** database file under its own state directory — in `tests/unit/straker/strakerStore.test.ts`
- [ ] T008 Implement the store to pass T007 in `src/straker/strakerStore.ts`, sharing no table, file or transaction with the XTM store (R11)
- [ ] T009 [P] (FR-009) Write failing tests for the per-portal ledger: keyed by **effective deadline day**, effort in **raw word count**, derived from held work rather than a running counter, in `tests/unit/straker/ledger.test.ts`
- [ ] T010 Implement the ledger to pass T009 in `src/straker/ledger.ts` (FR-009) — derived-from-held is what makes finishing a job return its budget, the correction the XTM bot needed after shipping a counter
- [ ] T011 [P] (FR-024) Write a failing test that a second instance refuses to start when port 47812 is held, in `tests/integration/straker/singleInstance.test.ts`
- [ ] T012 Bind the single-instance lock on port 47812 in `src/straker/main.ts` (FR-024)
- [ ] T013 [P] Write failing tests that the Straker liveness signal is emitted independently of the XTM bot's, in `tests/integration/straker/liveness.test.ts` (FR-026a, FR-025, SC-010)
- [ ] T014 Emit the Straker liveness signal in `src/straker/main.ts` (FR-026a, FR-025), monitored separately so neither bot can hide the other's death
- [ ] T015 [P] Write failing tests that an outcome survives a reporting destination being unavailable and is delivered on recovery, in `tests/unit/straker/outbox.test.ts` (FR-016, FR-016b, V11)
- [ ] T016 Implement durable outcome queuing in `src/straker/outbox.ts` (FR-016)
- [ ] T017 Wire the capture probe's proven modules into the bot — `httpClient.ts` (transport, cookie jar, Origin/Referer, budget headers), `session.ts` (sign-in, vendor identity read from the portal every time and never pinned — FR-022), `offersApi.ts` (open-offer read with its shape guards — FR-023) and `offerTracker.ts` (the pure sighting transition) — consumed by `src/straker/main.ts` and `src/straker/pollCycle.ts` rather than rewritten. These already exist and are tested; nothing else in the plan picks them up
- [ ] T018 [P] (FR-032) Add a `jobcatch-straker` logger in `src/straker/logger.ts` with the credential values redacted, independent of the XTM bot's logger (which is bound to `AppConfig`)

- [ ] T019 [P] Write failing tests for **exponential backoff with jitter and a defined cap** on the reading path, and that exhausting the cap **raises an alert** rather than retrying forever, in `tests/unit/straker/httpClient.test.ts` (FR-019b, V30, Constitution IV)
- [ ] T020 Implement that backoff **inside `src/straker/httpClient.ts`** (FR-019b, FR-030). Without it a one-second rhythm would send sixty requests a minute at a portal that is already failing — and the budget headers cannot restrain it, because a failing portal may not send them at all
- [ ] T021 [P] Write a failing test that the backoff is **never** applied to the claim path, in `tests/integration/straker/claimCycle.test.ts` (FR-019c, V31) — an unknown claim outcome is not retried at any interval, since the risk there is a duplicate irreversible commitment rather than a wasted request
- [ ] T022 [P] Define the shared vocabulary in `src/straker/types.ts` — sighting, claim outcome, effort unit, gate decision — using **the same names and meanings as the XTM bot** (FR-028, DC-2, V33), and record the mapping in a comment so drift between the two is visible rather than discovered during a later extraction

**Checkpoint**: the bot can start, hold its own lock, keep its own state, and be seen to be alive — with the XTM bot demonstrably untouched

---

## Phase 3: User Story 1 — Win an eligible offer without a human watching (Priority: P1) 🎯 MVP

**Goal**: an offer the team wants is claimed automatically, or a lost race is reported plainly

**Independent Test**: present an eligible offer inside the schedule and within the ceiling; it ends up claimed, recorded and announced with no human involved. Then present one another vendor takes first, and confirm it is reported as a normal loss.

> **This story is mostly Track A.** Only the reading of fields out of a payload is blocked. The claim mechanics, the outcome model, the gate wiring and the ordering rules can all be built and tested against stubs today.

### Tests for User Story 1 (MANDATORY — Constitution II) ⚠️

- [ ] T023 [P] [US1] Write failing tests for claim-outcome classification — `won`, `lost`, `failed`, `unknown` — including that an **unrecognised rejection is `failed`, never `lost`**, in `tests/unit/straker/claimOutcome.test.ts` (FR-005, FR-005a)
- [ ] T024 [P] [US1] Write a failing test that a lost race raises **no alert** and does not interrupt the loop, in `tests/integration/straker/claimCycle.test.ts` (FR-006, SC-007, V2)
- [ ] T025 [P] [US1] Write a failing test that a claim whose outcome is unknown is **never retried**, in `tests/integration/straker/claimCycle.test.ts` (R7, V9)
- [ ] T026 [P] [US1] Write failing tests that the scheduling gate's verdict is honoured — outside hours, deadline on a non-working day, deadline unreachable, ceiling reached, and **uncurated holiday year refuses rather than assumes** — in `tests/integration/straker/gateWiring.test.ts` (FR-008, FR-012, FR-013, V4, V5)
- [ ] T027 [P] [US1] Write a failing test that reaching the ceiling does **not** stop reading, and that skips keep being recorded, in `tests/integration/straker/gateWiring.test.ts` (FR-007a, V23)
- [ ] T028 [P] [US1] Write a failing test that several offers in one read are evaluated in **portal order**, stopping when the ceiling is exhausted, in `tests/integration/straker/gateWiring.test.ts` (FR-007b)
- [ ] T029 [P] [US1] Write a failing test that a claim is **never** attempted for an offer the gate rejected, under any path including retries, in `tests/integration/straker/gateWiring.test.ts` (FR-013, SC-006, V16)
- [ ] T030 [P] [US1] Write a failing test that **no further enquiry about an offer is made between noticing it and claiming it** — no detail fetch, no file listing — in `tests/integration/straker/claimCycle.test.ts` (FR-002, V32). This is the kind of regression that hides: it costs a round trip on the one path where a round trip decides the outcome, and nothing else about the system looks wrong
- [ ] T031 [P] [US1] Add a static check that the strings `decline` and the decline endpoint appear nowhere in `src/straker/`, wired into the test suite (FR-007) — the same grep discipline the capture probe used, which is what kept it provably read-only
- [ ] T032 [P] [US1] 🚧 **Track B** Write failing tests for eligibility against the **44 registered language directions**, using the portal's own language identifiers, honouring the exclusion list, in `tests/unit/straker/eligibility.test.ts` (FR-011, V3)
- [ ] T033 [P] [US1] 🚧 **Track B** Write failing tests for parsing a real offer payload — built **from the captured fixtures**, not from the recon note's field list — in `tests/unit/straker/offerParse.test.ts` (U1)

### Implementation for User Story 1

- [ ] T034 [US1] Implement claim-outcome classification to pass T023 in `src/straker/claimOutcome.ts` (FR-005, FR-005a), keeping it **pure** so it is unit-testable without a transport
- [ ] T035 [US1] Implement the claim action in `src/straker/claim.ts` — one offer at a time, no group action (FR-004), and **no blind retry ever** (R7)
- [ ] T036 [US1] Translate the portal's rejection codes into `AcceptOutcome` values **at the edge of `claim.ts`** (FR-027, DC-1) so no portal-specific code reaches the orchestration
- [ ] T037 [US1] Implement the poll cycle in `src/straker/pollCycle.ts` with the step names **matching the XTM loop exactly** — fetch → diff → gate → act → persist → notify (FR-029, DC-3)
- [ ] T038 [US1] In `src/straker/pollCycle.ts`, keep the path between noticing an eligible offer and dispatching the claim free of recording, announcing and every other deferrable operation (FR-003) — and add a comment naming reconciliation as what closes the window this opens
- [ ] T039 [US1] Wire `evaluateAcceptSchedule` from `src/schedule/` **unchanged**, supplying only effort, deadline, throughput and the calendar (R6) — write no Straker-specific scheduling logic
- [ ] T040 [US1] Define the skip reasons in `src/straker/types.ts` and record one for every offer not claimed in `src/straker/pollCycle.ts`, including `exceeds_daily_ceiling_entirely` as distinct from an ordinary ceiling skip (FR-010, data-model §4)
- [ ] T041 [US1] 🚧 **Track B** Implement eligibility to pass T032 in `src/straker/eligibility.ts` (FR-011)
- [ ] T042 [US1] 🚧 **Track B** Implement payload parsing to pass T033 in `src/straker/offerParse.ts`, failing loud on any field that is absent or of an unexpected type (FR-023)
- [ ] T043 [US1] 🚧 **Track B** Set the polling rhythm from the measured lifetime in `src/straker/config.ts`, and apply the strike rule to SC-001/SC-002 — recording the decision, the sample size and the shortest measured lifetime in the Clarifications section of `specs/003-straker-offer-race/spec.md`, so the call is a written artefact rather than something someone remembers making
- [ ] T044 [US1] 🚧 **Track B** *(only if the criteria survive)* Add keep-alive connection pooling (FR-020) and proactive session renewal (FR-021) in `src/straker/httpClient.ts` and `src/straker/session.ts`

**Checkpoint**: with Track B complete, an eligible offer is claimed end to end; without it, every non-parsing behaviour is already proven against stubs

---

## Phase 4: User Story 2 — See every offer and every outcome (Priority: P2)

**Goal**: a truthful record of wins, losses and skips — so "Straker sends us nothing" can be told from "we keep arriving second"

**Independent Test**: run a period containing wins, losses and skips; the record and the announcements together account for every offer that appeared, each with an outcome and a reason.

### Tests for User Story 2 (MANDATORY — Constitution II) ⚠️

- [ ] T045 [P] [US2] Write failing tests that **every** offer seen produces a row — won, lost and skipped alike — deduplicated on **offer identity together with event type**, so a sighting, a claim and a recovery of the same offer are not collapsed into one row, in `tests/unit/straker/trackingSink.test.ts` (FR-014, V10)
- [ ] T046 [P] [US2] (FR-014, FR-023) Write a failing test that a shifted column layout **fails loud** rather than writing into the wrong columns, in `tests/unit/straker/trackingSink.test.ts`
- [ ] T047 [P] [US2] Write failing tests for reconciliation: it runs on start and at least every 15 minutes, adds what the record is missing, and marks it **recovered** rather than as a normal claim, in `tests/integration/straker/reconcile.test.ts` (FR-016a, FR-016b, SC-009, V9)
- [ ] T048 [P] [US2] Write a failing test that **three consecutive reconciliation failures raise an alert**, in `tests/integration/straker/reconcile.test.ts` (FR-016c, V24)
- [ ] T049 [P] [US2] Write a failing test that recovered work is counted **even when it pushes the day past its ceiling**, and warns, in `tests/integration/straker/reconcile.test.ts` (FR-016d, V25)
- [ ] T050 [P] [US2] Write failing tests for the win rate — **won ÷ genuinely winnable** — and for the companion count of offers our own rules turned away, in `tests/unit/straker/winRate.test.ts` (FR-017, FR-017a, SC-004, V22)
- [ ] T051 [P] [US2] Write a failing test that alerts de-duplicate **once per offer identity per outcome**, in `tests/unit/straker/alerts.test.ts` (FR-019a, V28)

### Implementation for User Story 2

- [ ] T052 [US2] Implement the tracking sink in `src/straker/trackingSink.ts` writing to Straker's **own file**, carrying at minimum the offer identity, **language direction** (FR-011a), effort, deadline, outcome, skip reason and the timestamps win rate needs
- [ ] T053 [US2] Implement reconciliation in `src/straker/reconcile.ts` — the portal is the authority, our record is a copy (FR-016a)
- [ ] T054 [US2] Implement announcement cards in `src/straker/notifier.ts` for Straker's **own channel**, each **naming the portal in its heading** (FR-015), announcing wins and recovered work but **not** every loss or skip
- [ ] T055 [US2] Route operational alerts from `src/straker/notifier.ts` to the **single existing operations channel**, each naming its portal (FR-026b) — and add a comment marking the news-separated / alerts-unified asymmetry as deliberate, so it is not later "made consistent"
- [ ] T056 [US2] Implement win-rate reporting to pass T050 as an ops script in `src/straker/winRateReport.ts` (FR-017, FR-017a, SC-004), plus its `package.json` entry

**Checkpoint**: the team can see exactly what the bot saw and what it did about it

---

## Phase 5: User Story 3 — See the combined workload across both portals (Priority: P3)

**Goal**: one daily view of committed work across both portals, so a human can lower a ceiling before the crew is over-committed

**Independent Test**: with work committed on both portals, the daily summary shows each portal's figure and the total, and never participates in a claim decision.

### Tests for User Story 3 (MANDATORY — Constitution II) ⚠️

- [ ] T057 [P] [US3] Write failing tests that the summary reads **both** records and reports each portal, the combined total, and the period's **retries performed and uptime**, in `tests/unit/straker/combinedSummary.test.ts` (FR-018, V17) — the last two are named by the constitution and are what reveal a bot limping rather than failing
- [ ] T058 [P] [US3] (FR-018) Write a failing test that an unreadable record is **stated plainly**, never presented as a complete total, in `tests/unit/straker/combinedSummary.test.ts` (US3 scenario 2)
- [ ] T059 [P] [US3] Write a failing test that the combined total is suppressed or labelled when the two portals are not measuring in the same unit, in `tests/unit/straker/combinedSummary.test.ts` (FR-018)

### Implementation for User Story 3

- [ ] T060 [US3] Implement the combined daily view to pass T057-T059 in `src/straker/combinedSummary.ts` (FR-018), reading both records **read-only at reporting time** and never on the claim path

**Checkpoint**: the accepted cost of separate ledgers is visible to a human who can act on it

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T061 [P] (FR-021, FR-023, Constitution IV/VI) Write the failure-mode suite the constitution mandates, in `tests/integration/straker/failureModes.test.ts`: sign-in failure, session expiry, request timeout, malformed payload, reporting-destination outage, and **restart mid-cycle**
- [ ] T062 [P] Write a failing test that a missing effort or deadline **alerts as well as skips**, in `tests/integration/straker/failureModes.test.ts` (FR-023a, V26) — it means a contract assumption failed, not merely that one offer was skipped
- [ ] T063 [P] Write a failing test that an account-blocked rejection **alerts immediately and stops claiming**, without a sign-in retry loop, in `tests/integration/straker/failureModes.test.ts` (contract §4a, V27)
- [ ] T064 [P] Write failing tests for the graduated budget response — deferrable work stops below 120 remaining, reading pauses below 60 — in `tests/unit/straker/httpClient.test.ts` (FR-019, SC-003, V15, V29)
- [ ] T065 Implement per-minute pacing **inside `src/straker/httpClient.ts`**, adapting to the reported remainder and holding a hard ceiling when the headers are missing or nonsensical (R4, FR-019). It does **not** get its own module: FR-030 (DC-4) puts every request-issuing and request-pacing concern in the one transport file, and a separate limiter would be the first thing to break that rule
- [ ] T066 [P] Write a failing isolation test that killing, blocking or breaking the sign-in of the Straker side leaves the XTM side unchanged in uptime, restart count, cadence and alert count, in `tests/integration/straker/isolation.test.ts` (SC-008, V13)
- [ ] T067 Confirm `npm run test:coverage` reports the `src/straker/**` modules added to `vitest.config.ts` in T003 and meets the gate (V18) — a gate reporting green while not covering the code it governs is worse than none
- [ ] T068 [P] (FR-031) Write `docs/add-a-portal.md` — the runbook ADR-001 delivers **instead of** an abstraction, including the port register (XTM 47811, Straker 47812) and the state-directory convention
- [ ] T069 [P] (Constitution: live-portal tests behind a flag) Add a live-portal smoke path in `tests/live/straker/smoke.test.ts` behind the existing live flag, never running in CI
- [ ] T070 Capture the **seven-day XTM baseline** that SC-005 compares against and store it at `specs/003-straker-offer-race/xtm-baseline.md` (RP-3, SC-005a) — without it SC-005 cannot be evaluated after release
- [ ] T071 Work the release preconditions RP-1..RP-5 in `quickstart.md` and record each outcome — rotate the password, read and **write down** the terms conclusion, confirm the lost-race signal on one real offer under supervision, and stop the capture probe before the bot starts
- [ ] T072 (RP-5) Tear down the capture probe: remove its PM2 application, `recon.config.cjs` and `src/straker/reconMain.ts`, **keeping** `fixtures/straker/offers/` — those payloads are the parser's test data

---

## Dependencies

```text
Phase 1 Setup
  └─> Phase 2 Foundational  (blocks every story)
        ├─> Phase 3 US1  (P1) ─┐
        ├─> Phase 4 US2  (P2) ─┼─> Phase 6 Polish
        └─> Phase 5 US3  (P3) ─┘

SC-000 gate ──> T032, T033, T041, T042, T043, T044 only
```

**Story independence**: US2 and US3 do not depend on US1 being finished. US2 can record and reconcile outcomes produced by stubs; US3 reads records rather than producing them. US1's Track B tail is the only thing the SC-000 gate touches.

**Within Phase 3**: T023–T031 and T034–T040 are independent of T032–T033 and T041–T044. The story's Track A body can reach its checkpoint while the probe is still collecting.

## Parallel execution

- **Phase 1**: T001, T003, T004, T006 in parallel; T002 after T001; T005 after T004
- **Phase 2**: the seven test tasks T007, T009, T011, T013, T015, T019, T021 in parallel; each implementation follows its own test
- **Phase 3**: T023–T031 in parallel (all Track A tests, including the two MUST-NOT assertions); T032–T033 in parallel once unblocked
- **Phase 4**: T045–T051 in parallel (all US2 tests)
- **Phase 6**: T061–T064, T066, T068, T069 in parallel

## Implementation strategy

**MVP is User Story 1** — but note the inversion this feature carries: **the MVP story is the one the SC-000 gate touches.** The sequence that respects both:

1. **Phases 1–2** (T001–T022). Nothing here is blocked; the bot becomes startable, stateful and observable, with the XTM bot proven untouched.
2. **Phase 3 Track A** (T023–T031, T034–T040). The claim mechanics, outcome model, gate wiring and ordering rules — all built and proven against stubs while the probe collects.
3. **Phase 4** (T045–T056), then **Phase 5** (T057–T060). Both fully unblocked.
4. **Phase 3 Track B** (T032–T033, T041–T044) the moment the probe reaches exit. By then everything it plugs into is already tested.
5. **Phase 6** (T061–T072), ending with the release preconditions (T070–T071) and the probe teardown (T072).

**If a Track A task turns out to depend on offer shape after all, move it to Track B rather than patching it in place** — that dependency is the signal the split was drawn in the wrong spot, and redrawing it costs less than discovering it after release.
