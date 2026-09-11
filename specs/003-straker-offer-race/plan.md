# Implementation Plan: JobCatch 003 — Straker Offer Race

**Branch**: `feat/003-straker-phase0-probe` — the capture probe and these documents both landed here, and the implementation continues on it (decided 2026-09-11). An earlier draft said the implementation branch would be cut from `main`; that is not possible, because `main` does not carry the probe's `src/straker/` modules and T017 reuses all four of them. Cutting from `main` would have meant rewriting the very code the probe proved against the live portal. | **Date**: 2026-09-11 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-straker-offer-race/spec.md`

> ### ⚠️ Two different things are called "Phase 0"
>
> | Name | What it is |
> |---|---|
> | **Spec Kit Phase 0 / Phase 1** | The research and design steps of *this command*. Both are complete; their outputs are `research.md`, `data-model.md`, `contracts/`, `quickstart.md`. |
> | **The capture probe** (the brief calls it "Phase 0") | A read-only probe already running in production, collecting real offer payloads and lifetimes. **SC-000 refers to this one.** |
>
> Throughout this plan the second is called **the capture probe**, never "Phase 0".

---

## Summary

Add a second job-catching bot for the Straker vendor portal, alongside the XTM bot that has run unattended since 2026-06-22. Straker differs in kind, not just in destination: work is offered first-come-first-served, so another vendor taking an offer is a normal outcome and the interval between checks is a direct lever on how much work the team wins.

**Technical approach**: a separate process reading the portal's structured data interface over HTTP — no browser — reusing the existing scheduling gate untouched, with its own store, its own ceiling, its own liveness signal, its own tracking file and its own announcement channel. Nothing the XTM bot does changes.

**The plan is deliberately split in two by what the capture probe gates.** Track A can be built today and is the majority of the work. Track B is small, sharply defined, and waits for real offer payloads.

---

## Scope decision — deviation from the brief, recorded on purpose

The feature brief plans for 003 to also perform a mechanical extraction of the proven-generic modules into `packages/core`. **This plan defers that extraction.** The reasoning, agreed 2026-09-11:

- The extraction is the one piece of 003 that **modifies the live XTM bot** (its import paths). SC-005 requires XTM's behaviour to be provably unchanged, so it carries the feature's highest risk.
- It is also the piece with **no dependency on the capture probe**, which makes it tempting to do "while waiting". That is precisely the trap: it would churn a bot that has run 18 days without a restart, in service of a portal that has not yet won a single job.
- ADR-001's own reasoning argues for waiting — do not generalise from one example. Extracting core *before* the Straker adapter is proven repeats the mistake ADR-001 was written to prevent, just at a different layer.

**Consequence to accept**: for the life of 003 the Straker bot imports the scheduling and monitoring modules from their current locations in `src/`. This is a known, deliberate coupling, recorded in Complexity Tracking, and is the work that a later extraction would undo. DC-1..DC-4 still apply in full and are what keep that later extraction mechanical.

---

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) on Node.js 22

**Primary Dependencies**: `undici` (keep-alive connection pooling — *conditional, see Track B*), `zod` (payload and config validation), `better-sqlite3` (state), `googleapis` (tracking file), `pino` (structured logs). **Deliberately not Playwright** — Straker needs no browser, which is the single largest difference from the XTM bot.

**Storage**: SQLite via `better-sqlite3`, in a **separate database file under a separate `STATE_DIR`** from the XTM bot. No shared tables, no shared ledger, no cross-process transaction.

**Testing**: Vitest. Unit tests for pure logic, integration tests against stub transports, a failure-mode suite per the constitution, and live-portal tests behind an explicit flag that never runs in CI.

**Target Platform**: the existing office Windows 11 host, supervised by PM2 as a third application alongside `acolad-bot` and the temporary capture probe.

**Project Type**: unattended background service (bot), no user interface.

**Performance Goals**: detect→claim ≤ 400 ms at p95 — measured from the arrival of the response carrying the offer to the dispatch of the claim, which is the bot's own reaction time — and poll-gap ≤ 1.3× the configured rhythm (SC-001/SC-002). **Both are conditional**, struck only by the spec's computable rule: a shortest observed sighting lifetime of ≥ 120 s across a sample of at least 10 offers. Unconditionally: never exceed 300 requests/minute and never let the portal-reported remaining budget fall below 60 (SC-003).

**Constraints**: the XTM bot's behaviour must be provably unchanged (SC-005); separate single-instance port (XTM holds 47811, Straker takes 47812); separate state directory; either bot must be releasable and restartable without touching the other; claiming is irreversible so no blind retry of a claim is permitted.

**Scale/Scope**: **2-3 offers per day at most, irregular, some days none** (stated by the team). This rules out throughput engineering — batching, parallelism, bulk handling — and equally rules out using low volume as an argument against latency work, since scarcity raises the value of winning each race rather than lowering it.

### Unresolved — all gated by the capture probe (SC-000)

| # | Unknown | Blocks |
|---|---|---|
| U1 | The offer payload's real shape — which field carries the language direction, the size, the deadline | The data model, and therefore claim eligibility and gate input |
| U2 | How long an open offer survives | The polling rhythm, and whether SC-001/SC-002 survive at all — which in turn decides whether keep-alive pooling and proactive session renewal are needed |
| U3 | The real values of the listing category, and what each means | Whether some offers are reserved rather than contested (Q3 — needs Straker, not the team) |
| U4 | Offers per day and their size distribution | The numeric daily ceiling (Q4) |
| U5 | Whether one throughput figure is honest across 44 language directions | Possible per-direction rates in the gate (Q5) |

U1 and U2 are the hard gates. U3–U5 have safe conservative defaults and block release configuration, not construction.

---

## Constitution Check

*GATE: evaluated before research, re-evaluated after design (both recorded below).*

| # | Principle | Verdict | Notes |
|---|---|---|---|
| I | Code Quality | **PASS** | Strict TypeScript, lint and typecheck gates already enforced repo-wide; new code is additive. |
| II | Testing Standards | **PASS with an action** | TDD applies to decision logic, state and reporting. The existing coverage gate covers `src/detection/`, `src/state/`, `src/reporting/`, `src/schedule/` — it does **not** cover `src/straker/`. The gate's include list must be extended to the new decision and state logic, otherwise Straker ships with the constitution's coverage requirement silently not applied to it. Tracked as task group T-QA. |
| III | UX Consistency | **PASS** | Announcements follow the existing card conventions; Straker gets its own channel per the spec. |
| IV | Reliability & Recovery | **PASS** | Supervised restart; own liveness signal (FR-026a); reconciliation against the portal restores any record lost to a crash (FR-016a). |
| V | Observability | **PASS** | Structured logs; every claim attempt logged with outcome and latency; daily summary covers both portals (FR-018). |
| VI | Robustness | **PASS** | Every response validated before use; unexpected shapes fail loud and never read as "no offers" (FR-023); explicit timeouts on every call. **Corrected 2026-09-11 after review**: this row claimed the timeout before the code had one — there was no `AbortSignal` anywhere, so a portal that accepted a connection and went quiet stalled each attempt on the platform default (~300 s), and FR-019b's "slow" branch could not fire at all. It now holds: a per-attempt deadline is opt-in at `attempt()`, the single seam every request passes through, and `createStrakerPortal` passes it (2 s; revisit at T043 with the polling rhythm). Opt-in is what leaves the capture probe unchanged while it collects. The wiring itself is asserted, not assumed — the same capability had already been built and left unreachable once. |
| VII | Idempotency & State | **PASS** | The offer's own identifier is the stable key; reconciliation converges rather than compounds; **a failed claim is never blindly retried**, because retrying an irreversible commitment is worse than leaving it unknown. |
| VIII | Performance | **PASS** | Detection well inside the 30-second requirement; claim latency target is stricter than the constitution's 5-second bound. |
| — | **Operational: "throttled to human-plausible rates"** | **VIOLATION — justified below** | A one-second rhythm is not human-plausible by any reading. See Complexity Tracking. |
| — | Secrets handling | **PASS with a release precondition** | Credentials in environment only, redacted from logs. The account password was shared over chat and **must be rotated before release**. |
| — | Live-portal tests behind a flag | **PASS** | Same flag discipline as the XTM bot; never in CI. |

**Post-design re-evaluation (after Phase 1)**: no verdict changed. The design added no new violation; the single violation above is inherent to the feature's premise, not to how it is built.

---

## Project Structure

### Documentation (this feature)

```text
specs/003-straker-offer-race/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output — partially BLOCKED by SC-000
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── straker-portal.md      # what the bot expects of the portal
│   └── straker-reporting.md   # what the bot emits
├── checklists/
│   └── requirements.md
└── tasks.md             # Created by /speckit-tasks, not here
```

### Source Code (repository root)

```text
src/
├── straker/                  # EXTENDED — started by the capture probe, already real
│   ├── httpClient.ts         # built · transport in one file (DC-4): cookie jar,
│   │                         #   Origin/Referer, budget headers, loud non-2xx
│   ├── session.ts            # built · sign-in; vendor identity read, never pinned
│   ├── offersApi.ts          # built · open-offer read + shape guards
│   ├── offerTracker.ts       # built · appeared / still-here / vanished (pure)
│   ├── captureStore.ts       # built · probe evidence on disk
│   ├── config.ts             # EXTEND · add ceiling, throughput, schedule, ports
│   ├── probe.ts              # built · probe cycle (read-only)
│   ├── reconMain.ts          # built · probe entry; deleted when the probe ends
│   ├── types.ts              # NEW  · shared vocabulary (DC-2): sighting, outcome,
│   │                         #   effort unit, gate decision — same names as the XTM bot
│   ├── eligibility.ts        # NEW  · pure — is this offer one we want? (Track B)
│   ├── offerParse.ts         # NEW  · payload → domain, from fixtures (Track B)
│   ├── claimOutcome.ts       # NEW  · pure — won / lost / failed / unknown
│   ├── claim.ts              # NEW  · the irreversible action itself
│   ├── reconcile.ts          # NEW  · portal's assigned work vs our record (FR-016a)
│   ├── strakerStore.ts       # NEW  · own SQLite: offers, outcomes
│   ├── ledger.ts             # NEW  · per-portal ceiling, keyed by deadline day
│   ├── outbox.ts             # NEW  · durable outcome delivery (FR-016)
│   ├── trackingSink.ts       # NEW  · Straker's own tracking file
│   ├── notifier.ts           # NEW  · own announcement channel + shared alert channel
│   ├── combinedSummary.ts    # NEW  · reads BOTH portals at reporting time only
│   ├── winRateReport.ts      # NEW  · ops script
│   ├── logger.ts             # NEW  · own logger (the XTM one is bound to AppConfig)
│   ├── pollCycle.ts          # NEW  · fetch → diff → gate → act → persist → notify (DC-3)
│   └── main.ts               # NEW  · long-running entry, supervised

   NOTE: rate limiting, backoff and session renewal are NOT separate modules —
   DC-4 puts every request-issuing and request-pacing concern inside httpClient.ts.
├── schedule/                 # REUSED UNCHANGED — input is primitives only, no portal types
├── monitoring/               # REUSED — liveness signal, logger
├── reporting/                # EXTENDED — a Straker sink + card builder; XTM paths untouched
└── config/index.ts           # NOT TOUCHED — adding required vars here would stop the live bot

tests/
├── unit/straker/             # pure logic, test-first
├── integration/straker/      # stub transport; failure-mode suite
└── live/straker/             # behind the live flag, never in CI
```

**Structure Decision**: extend the existing `src/straker/` package that the capture probe already created — its transport, sign-in, offer reader and sighting tracker are carried into the bot rather than rewritten, rather than introducing `packages/`. This keeps the diff additive, keeps the live XTM bot untouched, and leaves the monorepo move as a clean, separate, mechanical change later. DC-4 is already satisfied — all transport lives in `httpClient.ts` — and DC-3 is expressed by naming `pollCycle.ts`'s steps to match the XTM loop exactly.

---

## Delivery split

### Track A — buildable now, gated by nothing

**The invariant that makes this safe**: no Track A item names a portal field or assumes anything about an offer's shape, size or lifetime. If the capture probe contradicts an assumption, it can only contradict a Track B one. Should a Track A item turn out to depend on offer shape after all, **the item moves to Track B rather than being patched in place** — that dependency is the signal the split was drawn in the wrong spot, and redrawing it is cheaper than discovering it later.

Roughly two-thirds of the feature, and none of it depends on what an offer looks like.

1. **Process isolation** (FR-024/025/026): own PM2 application, own single-instance port 47812, own state directory, release script able to touch one bot without the other.
2. **Own liveness signal + alert routing** (FR-026a/b): either bot stopping is noticed on its own; alerts name their portal and land in the one existing operations channel.
3. **Own store** (`strakerStore.ts`): offers, sightings, outcomes, per-portal ledger. Schema for everything except the offer's portal-native fields.
4. **Reporting pipe** (FR-014/015): separate tracking file, separate announcement channel, durable delivery so an outcome survives a destination outage.
5. **Reconciliation** (FR-016a/b): compare the portal's assigned work against our record, add what is missing, mark it recovered.
6. **Scheduling gate wiring**: the gate is already portal-agnostic — verified, its input is primitives only — so this is wiring plus a Straker-owned ceiling and throughput setting, not new gate logic.
7. **Combined daily view** (FR-018): read both portals' records, report each and the total, state plainly when one is unreadable.
8. **`docs/add-a-portal.md`**: the runbook that ADR-001 delivers instead of an abstraction.

### Track B — waits for the capture probe

Small, and sharply bounded.

1. **Offer model + parsing** (U1): fixed against real fixtures, not guessed.
2. **Eligibility** (U3, FR-011): the language-direction check across all 44 registered directions, plus whatever the listing category turns out to mean.
3. **Polling rhythm** (U2) and, only if offers prove short-lived: keep-alive pooling (FR-020), proactive session renewal (FR-021), and critical-path tuning (FR-003).
4. **Release configuration**: the numeric ceiling (U4) and the throughput decision (U5).

**If the probe's shortest observed sighting lifetime is 120 seconds or more, across a sample of at least 10 offers**, SC-001 and SC-002 are struck, item 3 disappears entirely, and Track B shrinks to parsing plus configuration. Below a sample of 10 the criteria are kept. The only valid ground for striking them is measured lifetime — never offer volume.

---

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **Recording state only *after* the irreversible action** (FR-003), where Principle VII expects state committed before an action is reported complete | The claim path is the race. A durable write before claiming adds latency to the only step where latency decides whether the team gets the work at all. | Writing an "attempting" marker first was rejected for that reason. The principle's intent — never lose track of an irreversible action — is met **behind** the claim instead of in front of it, by reconciling against the portal (FR-016a) within 15 minutes. This is a genuine deviation in mechanism, not merely in wording, and is recorded as such rather than argued away. |
| **Polling far faster than "human-plausible rates"** (Operational Constraints) — up to 60 requests/minute against a portal, where the XTM bot is capped at 3/minute | The premise of the feature is a first-come-first-served race. At a human-plausible rhythm the bot arrives after every other vendor's bot and wins nothing, making the whole feature worthless. The portal itself publishes a budget of 300 requests/minute and reports the remainder on every response, so 60/minute is 20% of the vendor's own stated allowance — the vendor's definition of acceptable, not a human's. | Polling at the XTM rhythm (3/minute) was rejected: with offers possibly living under a minute, it would miss most of them outright. Relying on a push notification was rejected because the portal offers none. Hard floors remain: never exceed 300/minute, never let the remaining budget fall below 60, and step down as the budget is consumed (FR-019). **Re-review is triggered by any of**: the portal publishing a lower budget, the account being throttled or warned, the portal's terms changing, or the measured offer lifetime turning out long enough to strike SC-001/SC-002 — in which case the fast rhythm is no longer justified at all and this violation must be withdrawn rather than inherited. |
| **Straker code imports scheduling and monitoring from `src/` instead of an extracted `packages/core`** | Deferring the extraction keeps the live XTM bot untouched while the second portal is still unproven (see Scope decision). | Extracting core first was rejected: it is the only part of 003 that modifies a bot which has run 18 days without incident, for a portal that has not yet won a job. DC-1..DC-4 keep the later extraction mechanical, so the cost of waiting is low. **Reopen when any of these occurs**: a third portal is proposed; the duplication between the two bots grows beyond what DC-3 makes readable at a glance; or feature 004 begins. Without a stated trigger a deferral quietly becomes a permanent decision nobody ever made. |
| **A daily ceiling per portal, with no shared ledger, knowing the two can sum past the crew's real capacity** | Separate ledgers are what make the bulkhead complete — no shared state, no cross-process transaction, either bot can die without touching the other. | A shared ledger was rejected: it would couple the two bots at exactly the point the isolation requirement protects. The mitigation is visibility instead of enforcement — the combined daily view (FR-018) shows the total so a human can lower a ceiling. |
