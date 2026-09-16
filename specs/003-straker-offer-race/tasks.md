# Tasks: JobCatch 003 — Straker Offer Race

**Input**: Design documents from `/specs/003-straker-offer-race/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: MANDATORY per Constitution II for decision logic, state, reporting and scheduling. Every such test task is written and watched to **fail** before its implementation task. Test tasks are numbered before the code they cover, and that ordering is not a convenience — a test written after the code proves only that the code does what it does.

**Organization**: grouped by user story so each can be implemented and verified on its own.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelisable — different files, no dependency on an unfinished task
- **[US1/US2/US3]**: the user story a task serves (story phases only)
- **🚧 Track B**: **was blocked by SC-000** — unblocked by decision on 2026-09-15. The marker is kept, not deleted: it says "this task was built on three payloads, not ten", which is something a reader of the code needs to know.
- **Checkbox meaning**: `[x]` = built and covered by tests that run in the suite. `[ ]` = not started, **except T044**, which is `[ ]` and **deliberately deferred** — see its note.

## The SC-000 gate, and how it ended

**Track A** tasks name no portal field and assume nothing about an offer's shape, size or lifetime. They were buildable from day one, and are done.

**🚧 Track B** tasks need real offer payloads. They were blocked until the capture probe reported **10 distinct offers, or 14 days elapsed** — whichever comes first. Starting one early would have meant guessing which field carries effort and which carries the deadline, and both feed the scheduling gate directly.

### Resolution — 2026-09-15: the gate was lifted at 3 offers, not at exit

**Neither exit branch was reached.** The probe held **3 distinct offers** — and only **two independent jobs**, since two of the payloads are one job (`job_ref: aj-265`) split across two target languages — on day **4.2 of 14** (the time branch would have fallen 2026-09-25 ~11:56 BKK). The owner decided to proceed.

**Why it was defensible**: the premise had lapsed, not the criterion. SC-000 forbids fixing an offer's shape *on assumption*; three real payloads existed, so `offerParse.ts` and its tests are read off files in `fixtures/straker/offers/` rather than off the recon note's field list.

**What it cost, carried forward rather than filed away**:

- the shape is confirmed on **two independent jobs**; anything absent from them is unseen, not absent — the answer is FR-023's fail-loud parser, not confidence;
- `listing_type` is `direct_po` on all three and no other value has ever been observed (Q3 still unanswered);
- `due_at` carries **no timezone** and is read as Bangkok through one named constant (`STRAKER_DEADLINE_ZONE`) — an assumption, not a finding;
- the measured lifetimes (204 s / 587 s / 1,938 s) are **times-until-a-competitor-claimed**, and polling is blind by construction to any offer living less than one 10-second interval.

Full record in spec.md §Clarifications (the two decision entries of 2026-09-15, plus the interim evidence entry beneath them, which was written before the decision and is marked as superseded in its framing). The model itself is in data-model.md §1.

## Path conventions

Single project. Straker code extends `src/straker/`, started by the capture probe. `src/schedule/` is **reused unchanged**. `src/config/index.ts` is **not touched** — adding required variables there would fail-fast the live XTM bot on start.

**Corrected 2026-09-15 — "every existing XTM file is not touched" is no longer true.** The two review-fix waves created `src/shared/` (`outboxRetry.ts`, `rollingLogger.ts`, `sqliteOpen.ts`) and re-pointed **three live XTM files** at it: `src/state/outbox.ts`, `src/state/db.ts` and `src/monitoring/logger.ts` — so `src/monitoring/` is reused *and modified*, not reused unchanged. The motivation was Constitution I (duplication found in review must be extracted) and each move left the bot-specific half behind. It is a real deviation from plan §Scope decision, which deferred exactly this on the grounds that it is the one piece of 003 that modifies the live bot; it is now recorded in plan.md §Scope decision and Complexity Tracking, and **awaits the owner's decision to accept or revert**. The bulkhead is unaffected: `src/straker/**` still may not import from `state/` or `config/`, and the test asserting that is unchanged.

### Carried into Phase 3+ from the Phase 2 review wave (2026-09-11)

Four reviewers audited the Phase 1+2 commit; the fixes changed three shapes that later tasks
consume, and two of them fail *silently* if a caller assumes the old shape:

- **`StrakerLedger.hold()` returns a discriminated union.** Read `deadlineDay` before
  `committedEffort` — the null-deadline branch carries `committedEffort: null`, deliberately
  not `0`, because `0` reads as "nothing booked that day" for work of any size.
- **`StrakerOutbox.enqueue()` returns `'queued' | 'already_pending' | 'already_sent' |
  'already_dead'`**, not a boolean. **`already_dead` must never be read as "handled"**: that
  outcome will not be delivered until ops requeues it, so treating it as done loses the
  outcome — exactly what FR-016 forbids.
- **`StrakerStore.endSighting()` returns a boolean**, and unlike `release()`'s `false`
  ("nothing to release, which is normal") a `false` here means the tracker and the store have
  diverged, which the caller should alert on.

Two habits worth carrying, both learned the hard way in this wave: a capability built inside
`httpClient.ts` was twice left **unreachable** because no caller passed the option that
switches it on (the retrying read door, then the request deadline), so the composition root's
wiring is now asserted by tests of its own; and `src/straker/types.ts` is **type-only** — its
runtime members live in `outcomePolicy.ts`, because the coverage gate excludes `**/types.ts`
repo-wide and executable code must not hide behind a name the gate skips.

### Carried forward from the Phase 3 review waves (2026-09-15)

Two further waves ran after Phase 3 closed — `388300b` (Criticals on the claim-and-persist
path) and `986f0b8` (the remaining Criticals plus eleven Important findings). What they changed
that later tasks must not assume around:

- **The "unreachable capability" habit struck a third time**, and at the top: `main()` was
  asserted by nothing, so `extractOffers: () => []` and a hard-coded ceiling of `999_999` both
  survived a green suite. The composition is now `assembleStrakerBot()` and
  `tests/integration/straker/botAssembly.test.ts` drives it end to end against payloads read off
  disk. **Phase 4-6 tasks that add a collaborator must assert the join, not only the part.**
- **`src/shared/` now exists and both bots run on it** — see Path conventions above. Anything
  Phase 4 writes that duplicates an XTM behaviour should go there rather than into a second
  copy, and `src/shared/**` is on the coverage gate.
- **Persistence is now one transaction per claim**, not one per cycle: a single constraint
  violation used to roll back the most valuable row in the cycle *after* the portal had already
  committed the work. The announcement is enqueued inside that same transaction.
- **`OfferEvent` is a union, not a flat record** — a skip carrying `won` used to compile and
  then throw `SQLITE_CONSTRAINT` inside the per-claim transaction. T045/T052 write against the
  union.
- **The sighting tracker resumes from the store** (`StrakerStore.trackerState()`) instead of
  booting empty, which was writing back into closed appearances after every restart.
- **Session expiry is translated at the transport** (`isSessionExpired`), not read as
  `err.status === 401` in the cycle — DC-1. Keep portal status codes out of Phase 4 code too.
- **`sqliteOpen` only quarantines on a strict corruption predicate** that Straker passes and the
  XTM bot does not. A transient `SQLITE_BUSY`/`EACCES`/`SQLITE_FULL` must never rename the
  ledger aside: Straker derives its whole daily ceiling from held work, so a cold start reads
  the day's committed workload as zero and every offer then "fits".

---

## Phase 1: Setup (Shared Infrastructure) — **COMPLETE**

**Purpose**: make the new bot configurable and governable before any of its logic exists

- [x] T001 [P] (FR-001, FR-009, FR-024) Write failing tests for the extended Straker config — own daily ceiling, own throughput, `SINGLE_INSTANCE_PORT` 47812, own `STATE_DIR`, own tracking-file id, own announcement channel, and the eligibility exclusion list defaulting to empty — in `tests/unit/straker/config.test.ts`
- [x] T002 Extend the config schema to pass T001 in `src/straker/config.ts` (FR-009, FR-024), keeping it wholly separate from `src/config/index.ts` (adding required vars there would fail-fast the live XTM bot on start)
- [x] T003 [P] Add `src/straker/**` to the coverage gate include list in `vitest.config.ts` (FR-013a, V18) — without this the constitution's coverage requirement silently does not apply to any new code
- [x] T004 [P] Add the Straker bot as its own PM2 application named `jobcatch-straker` in `straker.config.cjs`, separate from `ecosystem.config.cjs` (FR-024, FR-032) — the filename must end in `.config.cjs` or PM2 runs it as a plain script instead of reading it as an app definition
- [x] T005 Extend `scripts/deploy.ps1` so either bot can be released or restarted **without touching the other** (FR-026, V12), and verify the existing XTM path is byte-for-byte unchanged
- [x] T006 [P] (FR-024) Add the new `STRAKER_*` variables with placeholder values and explanatory comments to `.env.example`

---

## Phase 2: Foundational (Blocking Prerequisites) — **COMPLETE**

**Purpose**: state, isolation and observability that every story needs

**⚠️ No user-story work may begin until this phase is complete**

- [x] T007 [P] (FR-024, R11) Write failing tests for the Straker store schema — sightings, outcomes and ledger, in its **own** database file under its own state directory — in `tests/unit/straker/strakerStore.test.ts`
- [x] T008 Implement the store to pass T007 in `src/straker/strakerStore.ts`, sharing no table, file or transaction with the XTM store (R11)
- [x] T009 [P] (FR-009) Write failing tests for the per-portal ledger: keyed by **effective deadline day**, effort in **raw word count**, derived from held work rather than a running counter, in `tests/unit/straker/ledger.test.ts`
- [x] T010 Implement the ledger to pass T009 in `src/straker/ledger.ts` (FR-009) — derived-from-held is what makes finishing a job return its budget, the correction the XTM bot needed after shipping a counter
- [x] T011 [P] (FR-024) Write a failing test that a second instance refuses to start when port 47812 is held, in `tests/integration/straker/singleInstance.test.ts`
- [x] T012 Bind the single-instance lock on port 47812 in `src/straker/main.ts` (FR-024)
- [x] T013 [P] Write failing tests that the Straker liveness signal is emitted independently of the XTM bot's, in `tests/integration/straker/liveness.test.ts` (FR-026a, FR-025, SC-010)
- [x] T014 Emit the Straker liveness signal in `src/straker/main.ts` (FR-026a, FR-025), monitored separately so neither bot can hide the other's death
- [x] T015 [P] Write failing tests that an outcome survives a reporting destination being unavailable and is delivered on recovery, in `tests/unit/straker/outbox.test.ts` (FR-016, FR-016b, V11)
- [x] T016 Implement durable outcome queuing in `src/straker/outbox.ts` (FR-016)
- [x] T017 Wire the capture probe's proven modules into the bot — `httpClient.ts` (transport, cookie jar, Origin/Referer, budget headers), `session.ts` (sign-in, vendor identity read from the portal every time and never pinned — FR-022), `offersApi.ts` (open-offer read with its shape guards — FR-023) and `offerTracker.ts` (the pure sighting transition) — consumed by `src/straker/main.ts` and `src/straker/pollCycle.ts` rather than rewritten. These already exist and are tested; nothing else in the plan picks them up. **Scope note (2026-09-11), now closed**: at the time only the `main.ts` half was done and `createSightingCycle` was named as the seam T037 would replace. **T037 replaced it (2026-09-15)**: `pollCycle.ts` carries the full fetch → diff → gate → act → persist → notify sequence, `createSightingCycle` is gone, and the four probe modules are reached through `createStrakerPortal` / `createSightingTracker` inside `assembleStrakerBot()` — the composition root that `botAssembly.test.ts` drives end to end. The tracker is no longer created empty; it resumes from `store.trackerState()`
- [x] T018 [P] (FR-032) Add a `jobcatch-straker` logger in `src/straker/logger.ts` with the credential values redacted, independent of the XTM bot's logger (which is bound to `AppConfig`)

- [x] T019 [P] Write failing tests for **exponential backoff with jitter and a defined cap** on the reading path, and that exhausting the cap **raises an alert** rather than retrying forever, in `tests/unit/straker/httpClient.test.ts` (FR-019b, V30, Constitution IV)
- [x] T020 Implement that backoff **inside `src/straker/httpClient.ts`** (FR-019b, FR-030). Without it a one-second rhythm would send sixty requests a minute at a portal that is already failing — and the budget headers cannot restrain it, because a failing portal may not send them at all
- [x] T021 [P] Write a failing test that the backoff is **never** applied to the claim path, in `tests/integration/straker/claimCycle.test.ts` (FR-019c, V31) — an unknown claim outcome is not retried at any interval, since the risk there is a duplicate irreversible commitment rather than a wasted request
- [x] T022 [P] Define the shared vocabulary in `src/straker/types.ts` — sighting, claim outcome, effort unit, gate decision — using **the same names and meanings as the XTM bot** (FR-028, DC-2, V33), and record the mapping in a comment so drift between the two is visible rather than discovered during a later extraction. **Note**: the `SkipReason` values came with it — the store and ledger needed them in Phase 2; T040 therefore retains only its second half, recording a reason for every offer not claimed. **Updated 2026-09-15**: `types.ts` is now **type-only** and the values moved to `src/straker/outcomePolicy.ts` (`SKIP_REASONS`, `CLAIM_OUTCOMES`, `XTM_ACCEPT_OUTCOME_OF`), because the coverage gate excludes `**/types.ts` repo-wide and these are executable decision data. Read the concept map in `types.ts`, the values in `outcomePolicy.ts`

**Checkpoint**: the bot can start, hold its own lock, keep its own state, and be seen to be alive — with the XTM bot demonstrably untouched

---

## Phase 3: User Story 1 — Win an eligible offer without a human watching (Priority: P1) 🎯 MVP — **COMPLETE** (T044 deferred by decision), then twice review-fixed

**Goal**: an offer the team wants is claimed automatically, or a lost race is reported plainly

**Independent Test**: present an eligible offer inside the schedule and within the ceiling; it ends up claimed, recorded and announced with no human involved. Then present one another vendor takes first, and confirm it is reported as a normal loss.

> **This story is mostly Track A.** Only the reading of fields out of a payload was blocked. The claim mechanics, the outcome model, the gate wiring and the ordering rules were all built and tested against stubs first (Track A closed in `9e413a9`), and the payload half followed in `1f57904` once the gate was lifted on 2026-09-15.
>
> **What is built is not the same as what is exercised.** Every claim outcome in this story is proven against a stub: **no claim has ever been sent to the real portal.** Which rejection means "another vendor won" is still unconfirmed (RP-4), so `CONFIRMED_LOST_RACE_SIGNALS` is empty and every rejection currently reads as a fault; 403 reads as "account barred, stop claiming"; and any 2xx reads as won. spec §RP-4 lists all four guesses.

### Tests for User Story 1 (MANDATORY — Constitution II) ⚠️

- [x] T023 [P] [US1] Write failing tests for claim-outcome classification — `won`, `lost`, `failed`, `unknown` — including that an **unrecognised rejection is `failed`, never `lost`**, in `tests/unit/straker/claimOutcome.test.ts` (FR-005, FR-005a)
- [x] T024 [P] [US1] Write a failing test that a lost race raises **no alert** and does not interrupt the loop, in `tests/integration/straker/claimCycle.test.ts` (FR-006, SC-007, V2)
- [x] T025 [P] [US1] Write a failing test that a claim whose outcome is unknown is **never retried**, in `tests/integration/straker/claimCycle.test.ts` (R7, V9)
- [x] T026 [P] [US1] Write failing tests that the scheduling gate's verdict is honoured — outside hours, deadline on a non-working day, deadline unreachable, ceiling reached, and **uncurated holiday year refuses rather than assumes** — in `tests/integration/straker/gateWiring.test.ts` (FR-008, FR-012, FR-013, V4, V5)
- [x] T027 [P] [US1] Write a failing test that reaching the ceiling does **not** stop reading, and that skips keep being recorded, in `tests/integration/straker/gateWiring.test.ts` (FR-007a, V23)
- [x] T028 [P] [US1] Write a failing test that several offers in one read are evaluated in **portal order**, stopping when the ceiling is exhausted, in `tests/integration/straker/gateWiring.test.ts` (FR-007b)
- [x] T029 [P] [US1] Write a failing test that a claim is **never** attempted for an offer the gate rejected, under any path including retries, in `tests/integration/straker/gateWiring.test.ts` (FR-013, SC-006, V16)
- [x] T030 [P] [US1] Write a failing test that **no further enquiry about an offer is made between noticing it and claiming it** — no detail fetch, no file listing — in `tests/integration/straker/claimCycle.test.ts` (FR-002, V32). This is the kind of regression that hides: it costs a round trip on the one path where a round trip decides the outcome, and nothing else about the system looks wrong
- [x] T031 [P] [US1] Add a static check that the strings `decline` and the decline endpoint appear nowhere in `src/straker/`, wired into the test suite (FR-007) — the same grep discipline the capture probe used, which is what kept it provably read-only
- [x] T032 [P] [US1] 🚧 **Track B** Write failing tests for eligibility against the **44 registered language directions**, using the portal's own language identifiers, honouring the exclusion list, in `tests/unit/straker/eligibility.test.ts` (FR-011, V3)
- [x] T033 [P] [US1] 🚧 **Track B** Write failing tests for parsing a real offer payload — built **from the captured fixtures**, not from the recon note's field list — in `tests/unit/straker/offerParse.test.ts` (U1)

### Implementation for User Story 1

- [x] T034 [US1] Implement claim-outcome classification to pass T023 in `src/straker/claimOutcome.ts` (FR-005, FR-005a), keeping it **pure** so it is unit-testable without a transport
- [x] T035 [US1] Implement the claim action in `src/straker/claim.ts` — one offer at a time, no group action (FR-004), and **no blind retry ever** (R7)
- [x] T036 [US1] Translate the portal's rejection codes into `AcceptOutcome` values **at the edge of `claim.ts`** (FR-027, DC-1) so no portal-specific code reaches the orchestration
- [x] T037 [US1] Implement the poll cycle in `src/straker/pollCycle.ts` with the step names **matching the XTM loop exactly** — fetch → diff → gate → act → persist → notify (FR-029, DC-3)
- [x] T038 [US1] In `src/straker/pollCycle.ts`, keep the path between noticing an eligible offer and dispatching the claim free of recording, announcing and every other deferrable operation (FR-003) — and add a comment naming reconciliation as what closes the window this opens
- [x] T039 [US1] Wire `evaluateAcceptSchedule` from `src/schedule/` **unchanged**, supplying only effort, deadline, throughput and the calendar (R6) — write no Straker-specific scheduling logic
- [x] T040 [US1] Define the skip reasons — **in `src/straker/outcomePolicy.ts`, not `types.ts`** (see T022's note; `types.ts` is type-only so the coverage gate cannot skip them) — and record one for every offer not claimed, decided in `src/straker/claimDecision.ts` and written by `src/straker/pollCycle.ts`, including `exceeds_daily_ceiling_entirely` as distinct from an ordinary ceiling skip (FR-010, data-model §4). `outside_schedule` is defined and deliberately never emitted — spec §Clarifications, 2026-09-15, with a test in `gateWiring.test.ts` asserting it stays that way
- [x] T041 [US1] 🚧 **Track B** Implement eligibility to pass T032 in `src/straker/eligibility.ts` (FR-011)
- [x] T042 [US1] 🚧 **Track B** Implement payload parsing to pass T033 in `src/straker/offerParse.ts`, failing loud on any field that is absent or of an unexpected type (FR-023)
- [x] T043 [US1] 🚧 **Track B** Set the polling rhythm from the measured lifetime in `src/straker/config.ts`, and apply the strike rule to SC-001/SC-002 — recording the decision, the sample size and the shortest measured lifetime in the Clarifications section of `specs/003-straker-offer-race/spec.md`, so the call is a written artefact rather than something someone remembers making
- [ ] **T044 — DEFERRED BY DECISION (2026-09-15). This is a closed question, not outstanding work**, and the empty checkbox means "deliberately not built", not "not started yet". Nothing downstream waits on it; reopening it needs new evidence, named below. [US1] 🚧 **Track B** *(only if the criteria survive)* Add keep-alive connection pooling (FR-020) and proactive session renewal (FR-021) in `src/straker/httpClient.ts` and `src/straker/session.ts`. **Deferred as unnecessary** — and this is an inconsistency worth naming rather than tidying: the strike rule formally KEEPS SC-001/SC-002 because the sample is under 10, yet the measurement it rests on says the race is decided at **204 seconds**, not at the 400 ms SC-001 bounds. Pooling, proactive renewal and critical-path tuning exist to win a race decided in milliseconds. Revisit this and the strike rule together if a materially shorter lifetime ever appears — that single observation, not a larger count of long ones, is what would change the answer. See spec.md §Clarifications, 2026-09-15. **State of the code, checked rather than assumed**: no pooling agent and no `undici` dependency — the transport runs on the platform `fetch` — and session handling is R5's single reactive re-sign-in with nothing proactive anywhere

**Checkpoint — reached 2026-09-15.** Both tracks are in: an eligible offer is parsed, gated, claimed, persisted and queued for announcement end to end, driven against real captured payloads by `botAssembly.test.ts`. The two things that remain outside a test harness are the ones no harness can supply — a real claim at the portal (RP-4) and a destination for the queued announcements (Phase 4)

---

## Phase 4: User Story 2 — See every offer and every outcome (Priority: P2) — **COMPLETE 2026-09-16**

> **Done.** `trackingSink.ts`, `reconcile.ts`, `notifier.ts`, `dispatcher.ts`, `winRate.ts` and `winRateReport.ts` all exist, and — the part this phase was really about — the queue is now drained and the delivery is asserted end to end in `tests/integration/straker/botAssembly.test.ts`. Before T056a every piece passed its own tests while the running bot delivered nothing.
>
> **Two holes found during the phase are NOT closed and need tasks of their own** — see "Carried out of Phase 4" below. Neither blocks the checkpoint; both block release.

**Goal**: a truthful record of wins, losses and skips — so "Straker sends us nothing" can be told from "we keep arriving second"

**Independent Test**: run a period containing wins, losses and skips; the record and the announcements together account for every offer that appeared, each with an outcome and a reason.

### Tests for User Story 2 (MANDATORY — Constitution II) ⚠️

- [x] T045 [P] [US2] Write failing tests that **every** offer seen produces a row — won, lost and skipped alike — deduplicated on **offer identity together with event type**, so a sighting, a claim and a recovery of the same offer are not collapsed into one row, in `tests/unit/straker/trackingSink.test.ts` (FR-014, V10)
- [x] T046 [P] [US2] (FR-014, FR-023) Write a failing test that a shifted column layout **fails loud** rather than writing into the wrong columns, in `tests/unit/straker/trackingSink.test.ts`
- [x] T047 [P] [US2] Write failing tests for reconciliation: it runs on start and at least every 15 minutes, adds what the record is missing, and marks it **recovered** rather than as a normal claim, in `tests/integration/straker/reconcile.test.ts` (FR-016a, FR-016b, SC-009, V9)
- [x] T048 [P] [US2] Write a failing test that **three consecutive reconciliation failures raise an alert**, in `tests/integration/straker/reconcile.test.ts` (FR-016c, V24)
- [x] T049 [P] [US2] Write a failing test that recovered work is counted **even when it pushes the day past its ceiling**, and warns, in `tests/integration/straker/reconcile.test.ts` (FR-016d, V25)
- [x] T050 [P] [US2] Write failing tests for the win rate — **won ÷ genuinely winnable** — and for the companion count of offers our own rules turned away, in `tests/unit/straker/winRate.test.ts` (FR-017, FR-017a, SC-004, V22)
- [x] T051 [P] [US2] Write a failing test that alerts de-duplicate **once per offer identity per outcome**, in `tests/unit/straker/alerts.test.ts` (FR-019a, V28). **Carried forward from T019/T020 (2026-09-11)**: transport-level alerts (`onAlert`, read retries exhausted) carry **no offer identity**, so FR-019a's key cannot apply to them and the transport does not de-duplicate them itself. At a one-second rhythm a ten-minute outage fires hundreds. Whatever wires the alert sink must throttle or collapse them, and this test is where that belongs

### Implementation for User Story 2

> **Two tasks added 2026-09-15, because the breakdown had no owner for the drain.** T052–T056
> build senders and card builders; nothing built the loop that reads `straker_outbox` and sends
> what is in it, and nothing called that loop from the cycle. The phase note above had already
> observed the symptom — "outcomes are being written durably to the outbox today, and nothing
> drains it" — without a task to fix it. This feature has now shipped three capabilities built,
> tested and unreachable because a **call site between two files belonged to nobody**; a whole
> delivery path was about to be the fourth. T052a owns the drain, T056a owns the call sites, and
> both are the coordinator's rather than any file-scoped agent's.

- [x] T052a [US2] Implement the dispatcher in `src/straker/dispatcher.ts` — drain `outbox.due()`, route each row by channel to its sender, `markSent` on success and `recordFailure` otherwise, honouring the retry-and-dead policy already shared with the XTM bot in `src/shared/outboxRetry.ts`. A malformed row must be dropped loudly rather than wedging the queue (the XTM dispatcher's own lesson). **Its `StrakerSenders` interface is the contract T052, T054 and T055 build to, so it is written first.**
- [x] T056a [US2] Wire the drain and the reconciliation cadence into the running bot, in `src/straker/main.ts` / `src/straker/pollCycle.ts`, and **assert the wiring** — that a completed cycle actually flushes, and that reconciliation is reached on start and on its interval. A dispatcher nothing calls is the same defect as no dispatcher, and this feature has already produced three of those (see the note above)
- [x] T052 [US2] Implement the tracking sink in `src/straker/trackingSink.ts` writing to Straker's **own file**, carrying at minimum the offer identity, **language direction** (FR-011a), effort, deadline, outcome, skip reason and the timestamps win rate needs
- [x] T053 [US2] Implement reconciliation in `src/straker/reconcile.ts` — the portal is the authority, our record is a copy (FR-016a)
- [x] T054 [US2] Implement announcement cards in `src/straker/notifier.ts` for Straker's **own channel**, each **naming the portal in its heading** (FR-015), announcing wins and recovered work but **not** every loss or skip
- [x] T055 [US2] Route operational alerts from `src/straker/notifier.ts` to the **single existing operations channel**, each naming its portal (FR-026b) — and add a comment marking the news-separated / alerts-unified asymmetry as deliberate, so it is not later "made consistent"
- [x] T056 [US2] Implement win-rate reporting to pass T050 as an ops script in `src/straker/winRateReport.ts` (FR-017, FR-017a, SC-004), plus its `package.json` entry

**Checkpoint**: the team can see exactly what the bot saw and what it did about it — **met**, with the two carried items below outstanding.

### Carried out of Phase 4 (found 2026-09-16, not fixed)

- [x] T056b **Nothing ever releases held work, so the ledger's budget never returns.** Both `StrakerStore.release` and `StrakerLedger.release` were written anticipating a reconciliation caller, and reconciliation — the only thing that reads the portal's assigned list — is the only thing that *could* notice work the team no longer holds. It was deliberately not built in T053: FR-016a mandates only the additive direction, and the subtractive one is unsafe on the same evidence, because a partial read would free capacity for work the team genuinely holds and over-committing an irreversible claim is the one error this feature cannot take back. The consequence is that FR-016d's "further claims for that day are then blocked as normal" becomes permanent: **held work accumulates forever.** *(Severity corrected 2026-09-16, by reading `ledger.ts` rather than reasoning from the omission: the earlier wording said the bot "eventually stops claiming while looking perfectly healthy", and that is not what the code does.* `committedByDay` buckets held effort by the offer's own **effective deadline day** (`ledger.ts:182, :228`) and each day carries an independent ceiling, so stale holds land in **past** days that nothing claims against again and a new deadline day always starts fresh. The bot does not seize up. What is actually wrong is narrower and still real: the held set grows without bound, and work **finished early** for a still-future day does not give that day its budget back, so the bot is **over-conservative** for that one day — it under-claims rather than over-commits, which is the safe direction but not the intended one. The same omission also silently falsified the comment at `ledger.ts:75`, which promises that "`ceiling_reached` clears itself as held work finishes"; with nothing releasing, it never clears. Fix the comment with the code.)* Needs a safe rule — most likely "release only what a complete, unpaginated read positively shows as finished" — and its own failure-mode test. **DONE 2026-09-16.** Reconciliation now releases held work the portal **positively reports as finished**, and that phrasing is the whole safety argument. Only an item present in the read AND recognised by `isFinished` (observed AND not outstanding) releases anything, so a truncated page, a paginated response or a half-answered list can only ever release *less* — absence is never evidence, which is precisely the hazard T053 refused to take. An unrecognised status keeps the work held. Per-item failures never fail the pass. `ReconcileOutcome` gained `released`, and four tests cover it including the partial-read property; removing the `isFinished` guard kills three of them.
- [x] T056c **FR-019's "below 120 remaining, suspend deferrable work" has no owner.** Nothing marks the reconciliation read as deferrable, and `readAssignedWork` goes through `getJson` unconditionally, so a budget running low cannot shed it. This belongs with T064/T065's pacing inside `httpClient.ts`, but the transport currently cannot tell a deferrable path from a hot one — which is the actual gap: the capability needs a way to be asked for. **DONE — closed by design rather than by the flag this task proposed.** `httpClient.ts` classifies by **door** instead: `getJson` is the `deferrable` class and is refused below 120 remaining, `getJsonWithBackoff` is `read`, `postJson` is `essential`. Reconciliation already came through `getJson`, so it is shed with no call-site change and no per-call flag to forget. `reconcile.ts` treats the refusal as `outcome: shed` with `alerted: false` and leaves FR-016c's failure streak untouched — being shed is obeying a rule, not failing. The corollary is recorded in `httpClient.ts`: a *racing* read added through `getJson` would wrongly join the deferrable class; the hot path's door is `getJsonWithBackoff`.

---

## Phase 5: User Story 3 — See the combined workload across both portals (Priority: P3) — **COMPLETE 2026-09-16**

**Goal**: one daily view of committed work across both portals, so a human can lower a ceiling before the crew is over-committed

**Independent Test**: with work committed on both portals, the daily summary shows each portal's figure and the total, and never participates in a claim decision.

### Tests for User Story 3 (MANDATORY — Constitution II) ⚠️

- [x] T057 [P] [US3] Write failing tests that the summary reads **both** records and reports each portal, the combined total, and the period's **retries performed and uptime**, in `tests/unit/straker/combinedSummary.test.ts` (FR-018, V17) — the last two are named by the constitution and are what reveal a bot limping rather than failing
- [x] T058 [P] [US3] (FR-018) Write a failing test that an unreadable record is **stated plainly**, never presented as a complete total, in `tests/unit/straker/combinedSummary.test.ts` (US3 scenario 2)
- [x] T059 [P] [US3] Write a failing test that the combined total is suppressed or labelled when the two portals are not measuring in the same unit, in `tests/unit/straker/combinedSummary.test.ts` (FR-018)

### Implementation for User Story 3

- [x] T060 [US3] Implement the combined daily view to pass T057-T059 in `src/straker/combinedSummary.ts` (FR-018), reading both records **read-only at reporting time** and never on the claim path

- [x] T060a [US3] Wire the combined view into the **09:00 daily report the XTM bot already sends** (`src/reporting/dailyReport.ts`), so FR-018's summary reaches the place a human reads. **Owner-approved 2026-09-16** as a deliberate change to the live bot — see plan §Scope decision, which records why SC-005 still holds and what the test invariant becomes now that "exactly 820" no longer applies. Two properties must survive: the report stays **throw-safe** (PR #14 fixed a bug in it that took the loop down) and a Straker record that cannot be read must degrade to the XTM-only report rather than suppressing the whole thing — the combined view is a mitigation, and a mitigation that can break the report it rides on is worse than none

**Checkpoint**: the accepted cost of separate ledgers is visible to a human who can act on it

---

## Phase 6: Polish & Cross-Cutting Concerns — **CODE COMPLETE 2026-09-16; release preconditions outstanding**

> Two carried-forward notes in this phase were written in September 2026 and have since been overtaken by the code — **T061's** (the transport has no timeout) is simply false now, and **T067's** measurement was superseded by the per-area coverage thresholds. Both are corrected in place below. Treat every other note here as claiming a state of the code from the date it was written, and check it before acting on it.

- [x] T061 [P] (FR-021, FR-023, Constitution IV/VI) Write the failure-mode suite the constitution mandates, in `tests/integration/straker/failureModes.test.ts`: sign-in failure, session expiry, request timeout, malformed payload, reporting-destination outage, and **restart mid-cycle**. ~~**Carried forward from T019/T020 (2026-09-11)**: the transport has **no request timeout at all** today~~ — **this note is out of date and was corrected 2026-09-15; do not act on it.** The timeout exists, built exactly as the note prescribed: an **opt-in `timeoutMs` on the single `attempt()` seam** in `httpClient.ts` (`AbortSignal.timeout`, surfacing `StrakerTimeoutError`), which `createStrakerPortal` passes at **2 s** while the capture probe, passing nothing, keeps its old unbounded behaviour. The wiring — not just the capability — is asserted: `tests/integration/straker/botWiring.test.ts`, *"puts a deadline on the wire, so a portal that accepts and then goes quiet cannot hold a read open"*, checks that the composition root actually hands a live `AbortSignal` to `fetch`. **What is left for T061** is therefore the suite itself, not the capability: exercise a hung socket end to end and confirm FR-019b's "slow" branch backs off rather than stalling, and revisit whether 2 s is still the right figure now that the rhythm is 10 s (`main.ts` flags it as a T043 revisit that never happened)
- [x] T062 [P] Write a failing test that a missing effort or deadline **alerts as well as skips**, in `tests/integration/straker/failureModes.test.ts` (FR-023a, V26) — it means a contract assumption failed, not merely that one offer was skipped
- [x] T063 [P] Write a failing test that an account-blocked rejection **alerts immediately and stops claiming**, without a sign-in retry loop, in `tests/integration/straker/failureModes.test.ts` (contract §4a, V27)
- [x] T064 [P] Write failing tests for the graduated budget response — deferrable work stops below 120 remaining, reading pauses below 60 — in `tests/unit/straker/httpClient.test.ts` (FR-019, SC-003, V15, V29)
- [x] T065 Implement per-minute pacing **inside `src/straker/httpClient.ts`**, adapting to the reported remainder and holding a hard ceiling when the headers are missing or nonsensical (R4, FR-019). It does **not** get its own module: FR-030 (DC-4) puts every request-issuing and request-pacing concern in the one transport file, and a separate limiter would be the first thing to break that rule
- [x] T066 [P] Write a failing isolation test that killing, blocking or breaking the sign-in of the Straker side leaves the XTM side unchanged in uptime, restart count, cadence and alert count, in `tests/integration/straker/isolation.test.ts` (SC-008, V13)
- [x] T067 Confirm `npm run test:coverage` reports the `src/straker/**` modules added to `vitest.config.ts` in T003 and meets the gate (V18) — a gate reporting green while not covering the code it governs is worse than none. **Measured at the Phase 2 checkpoint (2026-09-11)**: the whole-repo gate PASSED at 89.45% lines while `src/straker/` on its own sat at **79.93%** — the XTM areas were subsidising it, so a Straker regression could not turn the gate red. **Resolved differently, and better, in `vitest.config.ts` (2026-09-15)**: the thresholds are now **one group per gated area with no global number**, so each area answers for itself at the same figures, and `straker` and `shared` are both on the list. That also removed the reverse coupling — Straker slipping can no longer fail the gate that governs the live XTM bot. **The authority to exclude entry points was deliberately left unused**: the config records that `src/straker/` clears every number *with* `reconMain.ts` and `main()` counted, so excluding them would be tuning a passing figure rather than fixing anything, and if `reconMain.ts`'s 0% ever becomes the difference the answer is T072 deleting it. **Measured again 2026-09-15**, after the two review-fix waves: all six groups green with no threshold error — detection 100, schedule 100, shared 98.78, state 96.62, straker **91.14**, reporting 90.13, across 1311 passing tests. `src/straker/` has gone 79.93 → 91.14 and now clears its own gate unaided, which is the thing the old whole-repo number was hiding. The box stays unticked because T067 is a **release** check and Phase 6 has not started: this is the current reading, not the one that closes the task
- [x] T068 [P] (FR-031) Write `docs/add-a-portal.md` — the runbook ADR-001 delivers **instead of** an abstraction, including the port register (XTM 47811, Straker 47812) and the state-directory convention
- [x] T069 [P] (Constitution: live-portal tests behind a flag) Add a live-portal smoke path in `tests/live/straker/smoke.test.ts` behind the existing live flag, never running in CI
- [x] T070 Capture the **seven-day XTM baseline** that SC-005 compares against and store it at `specs/003-straker-offer-race/xtm-baseline.md` (RP-3, SC-005a) — without it SC-005 cannot be evaluated after release
- [~] T071 **Record created and RP-3 closed (2026-09-16)** — [`release-preconditions.md`](./release-preconditions.md) is the record T071 asks for, with what closes each of the five written down. RP-3 done. RP-1, RP-2 and RP-4 are the owner's by their nature: a password only they can rotate, a terms judgement that needs a name against it, and a real claim under supervision. Work the release preconditions RP-1..RP-5 in `quickstart.md` and record each outcome — rotate the password, read and **write down** the terms conclusion, confirm the lost-race signal on one real offer under supervision, and stop the capture probe before the bot starts
### Found by the Phase 6 failure-mode suite, and NOT fixed (2026-09-16)

The suite's job was to find these, and it did. Two were fixed in place — the reconciler
posting refused credentials twice, and a budget-shed pass counting toward FR-016c's
three-strike alert. These three are recorded instead of rushed:

- [x] T073 **`stopClaiming` stops the cycle, not the account.** Contract §4a says a barred account means "alert immediately and **stop claiming**", and never retry around it. The flag is local to one `runOnce()`, and nothing persists "this account is barred", so ten seconds later the bot claims again at a portal that has already refused. The blast radius is small today — `claimedObjIds()` means one attempt per *new* offer rather than one per cycle, and the portal sends 2–3 offers a day — but "stop" is not what the code does. Fixing it needs a decision the code cannot make alone: what clears the barred state. A successful sign-in is the obvious candidate and is probably wrong, since the account can be signed-in and barred at once. **DONE 2026-09-16, and the open question is answered: nothing in the bot clears it.** The bar is now a row in a new `straker_meta` table, so it outlives the `runOnce()` that found it and the process too — a restart does not launder it. Only claiming stops; reading, tracking and reconciliation continue, because a barred account that also went blind would lose the record it will be audited against. A new system alert `account_barred` fires on the **discovery** only (`barAccount` answers true once), beside the existing per-offer `claim_failed`, because "claim failed on offer-1" does not tell an operator that claiming has stopped indefinitely. **A successful sign-in was rejected as the clearing trigger** for the reason this task named — an account can be signed in and barred at once — and so was every other observable signal, since none of them is the thing that actually changed. `npm run straker:unbar` is the clearing action. The failure-mode test that documented this bug and said "if a persisted bar is ever added, this test is what it changes" has been changed.
- [x] T074 **FR-021 is not implemented, and nothing recorded that.** The spec says "the session must be renewed **before** it lapses rather than after a rejection"; the code is `session ??= await signIn()`, which is purely reactive. T044 deferred proactive renewal with good reasoning — the race is decided at 204 s, not in milliseconds — but that reasoning was never connected to FR-021, so the spec still reads as though the requirement were met. Either implement it or strike it with the T044 evidence; leaving a requirement that quietly is not met is the worse of the three options. **CLOSED 2026-09-16 by striking it, which was the third option this task named.** FR-021 in `spec.md` now reads STRUCK with the T044 evidence carried across explicitly, and is replaced by the requirement the code actually meets: re-establish the session **on rejection**, and a re-sign-in must not cost an offer (R5). The reasoning is T044's own — proactive renewal buys milliseconds against a race measured at 204 seconds — and the gap this task identified was precisely that T044 never connected it to FR-021. What would reopen it is recorded on the requirement: evidence that a lapsed session costs a *claim* rather than a read.
- [x] T075 **A refused sign-in and a contract-shape violation raise no alert at all** — only a log line and a failed heartbeat. Measured: three cycles with a wrong password produce three error lines and an empty outbox. The dead-man switch does fire, so this is not a silent failure, but what pages is "jobcatch-straker is not alive", not "the Straker password is wrong". The XTM bot has a named alert for the same case (`LOGIN_MAX_RETRY` → lockout). FR-023's "stop and report loudly" is currently satisfied by the quietest of the loud options. **DONE.** `signInOrBackOff()` in `pollCycle.ts` now backs off exponentially (60s base, 1h ceiling) and raises a named `sign_in_refused` system alert on the third consecutive refusal — so what pages is "the Straker password is wrong", not merely "jobcatch-straker is not alive". Covered by `pollCycleGuards.test.ts` via the harness's `signInFails` option.

- [x] T072 **Done 2026-09-16** — code removed and the PM2 app deleted (on the owner's instruction, before RP-1). — the probe runs from `dist/`, so removing the source did not and could not stop it. `captureStore.ts` and `runProbeCycle` are now production-callerless and kept deliberately; see the release record. (RP-5) Tear down the capture probe: remove its PM2 application, `recon.config.cjs` and `src/straker/reconMain.ts`, **keeping** `fixtures/straker/offers/` — those payloads are the parser's test data

---

## Dependencies

```text
Phase 1 Setup
  └─> Phase 2 Foundational  (blocks every story)
        ├─> Phase 3 US1  (P1) ─┐
        ├─> Phase 4 US2  (P2) ─┼─> Phase 6 Polish
        └─> Phase 5 US3  (P3) ─┘

SC-000 gate ──> T032, T033, T041, T042, T043, T044 only   [lifted 2026-09-15 at 3 offers]
```

**Story independence**: US2 and US3 do not depend on US1 being finished. US2 can record and reconcile outcomes produced by stubs; US3 reads records rather than producing them. US1's Track B tail was the only thing the SC-000 gate touched.

**Within Phase 3**: T023–T031 and T034–T040 are independent of T032–T033 and T041–T044. The story's Track A body reached its checkpoint (`9e413a9`) while the probe was still collecting, exactly as this split intended; Track B followed in `1f57904` once the gate was lifted.

## Parallel execution

- **Phase 1**: T001, T003, T004, T006 in parallel; T002 after T001; T005 after T004
- **Phase 2**: the seven test tasks T007, T009, T011, T013, T015, T019, T021 in parallel; each implementation follows its own test
- **Phase 3**: T023–T031 in parallel (all Track A tests, including the two MUST-NOT assertions); T032–T033 in parallel once unblocked
- **Phase 4**: T045–T051 in parallel (all US2 tests)
- **Phase 6**: T061–T064, T066, T068, T069 in parallel

## Implementation strategy

**MVP is User Story 1** — but note the inversion this feature carries: **the MVP story is the one the SC-000 gate touches.** The sequence that respects both, annotated 2026-09-15 with what actually happened:

1. ✅ **Phases 1–2** (T001–T022). Nothing here was blocked; the bot became startable, stateful and observable. *"With the XTM bot proven untouched" no longer holds — see Path conventions.*
2. ✅ **Phase 3 Track A** (T023–T031, T034–T040), closed in `9e413a9`. The claim mechanics, outcome model, gate wiring and ordering rules — all built and proven against stubs while the probe collected.
3. ⏭️ **Phase 4** (T045–T056), then **Phase 5** (T057–T060) — **skipped for now, and this is the departure from the plan.** Both were fully unblocked and were meant to come next; Track B was taken instead when the gate was lifted early.
4. ✅ **Phase 3 Track B** (T032–T033, T041–T043), in `1f57904` — taken on 2026-09-15 at 3 offers rather than "the moment the probe reaches exit", which never arrived. T044 deferred. Then two review-fix waves (`388300b`, `986f0b8`).
5. ⬜ **Phase 6** (T061–T072), ending with the release preconditions (T070–T071) and the probe teardown (T072).

**Where that leaves the work**: Phase 4 is now the critical path, and its absence is load-bearing rather than cosmetic — outcomes are written durably and nothing drains the queue, so a win today would be recorded and never announced. The release preconditions (RP-1..RP-5) are all still open, and RP-4 in particular gates the claim path's four unconfirmed guesses.

**If a Track A task turns out to depend on offer shape after all, move it to Track B rather than patching it in place** — that dependency is the signal the split was drawn in the wrong spot, and redrawing it costs less than discovering it after release.

---

## Phase 7: Convergence

Appended by `/speckit-converge` on 2026-09-16, after Phases 0–6 were complete and the bot
was live. Zero CRITICAL, zero `missing` — the specified scope is built. What remains is one
success criterion only half met, one invariant that holds but is unguarded, code the spec no
longer calls for, and a stale structure block.

- [ ] T076 Report the Straker win rate automatically instead of only on demand, per SC-004 (partial) — `computeWinRate` has exactly one caller, `winRateReport.ts`, which is the manual `npm run straker:win-rate`. The 09:00 combined report already carries workload, retries and uptime, so it is the obvious home. The consequence of leaving it is not a missing number but a missing *habit*: SC-004 sets a target only after two weeks of baseline, and a baseline nobody is shown is a baseline nobody reads. Note the report is in the XTM bot's path (`dailyReport.ts`), so this must go through `combinedSummary.ts` like FR-018 did, and must keep `combinedReportRows`'s never-throws property.
- [ ] T077 Guard FR-030 (DC-4) with a walking test the way R11 is guarded, per FR-030 (partial) — the invariant currently HOLDS: no `fetch(` exists in `src/straker/` outside `httpClient.ts`. Nothing enforces it. R11's equivalent is enforced at `tests/integration/straker/isolation.test.ts:652`, and `httpClient.ts` names the exact failure this would catch — a *racing* read added through `getJson` silently joins the deferrable class and gets shed below 120 remaining, which is the hot path quietly losing its budget priority. Walk `src/straker/**` and fail on any request-issuing call outside the one file; assert the guard is not vacuous (a deliberate violation must fail it).
- [ ] T078 Decide whether the probe's stranded core stays or goes, per T072/RP-5 (unrequested) — `CaptureStore` (`src/straker/captureStore.ts`) and `runProbeCycle` (`src/straker/probe.ts`) have had no production caller since T072 removed the probe entry point; only their tests reach them. RP-5 recorded keeping them deliberately, because "Straker's payload shape is confirmed on two jobs and resurrecting evidence collection should be cheap". That reasoning may well still hold — this task is to make it a decision with a date rather than drift, and to record the outcome either way. `probe.ts` itself must stay regardless: `RawOffer` is used throughout the bot.
- [ ] T079 Bring `plan.md`'s Source Code block in line with the tree, per plan: Source Code structure (contradicts) — it still lists `reconMain.ts`, which T072 deleted, and omits four files that shipped since: `dispatcher.ts` (Phase 4), `requeue.ts` and `winRate.ts` (review-fix waves), `unbar.ts` (T073). Documentation-only; no code changes.
