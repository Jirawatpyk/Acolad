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

> **Status, 2026-09-15.** Both tracks of Phases 1–3 are built: isolation, store, ledger,
> outbox, transport, claim path, gate wiring, poll cycle (Track A), then parsing, eligibility
> and the rhythm decision (Track B). **Track B did not wait for SC-000's exit** — the owner
> proceeded on 3 captured offers, on day 4.2 of 14, because the model could by then be read off
> real files rather than assumed. What that costs is written wherever the evidence is used: the
> sample is two independent jobs, and the parser refuses anything it has not seen rather than
> absorbing it. Phases 4–6 (reporting, reconciliation, the combined view, the failure-mode
> suite, release preconditions) are **not started**. See tasks.md for the task-level state.

---

## Scope decision — deviation from the brief, recorded on purpose

The feature brief plans for 003 to also perform a mechanical extraction of the proven-generic modules into `packages/core`. **This plan defers that extraction.** The reasoning, agreed 2026-09-11:

- The extraction is the one piece of 003 that **modifies the live XTM bot** (its import paths). SC-005 requires XTM's behaviour to be provably unchanged, so it carries the feature's highest risk.
- It is also the piece with **no dependency on the capture probe**, which makes it tempting to do "while waiting". That is precisely the trap: it would churn a bot that has run 18 days without a restart, in service of a portal that has not yet won a single job.
- ADR-001's own reasoning argues for waiting — do not generalise from one example. Extracting core *before* the Straker adapter is proven repeats the mistake ADR-001 was written to prevent, just at a different layer.

**Consequence to accept**: for the life of 003 the Straker bot imports the scheduling and monitoring modules from their current locations in `src/`. This is a known, deliberate coupling, recorded in Complexity Tracking, and is the work that a later extraction would undo. DC-1..DC-4 still apply in full and are what keep that later extraction mechanical.

> ### What actually happened — a partial extraction shipped, 2026-09-15
>
> **This section says the extraction is deferred because it is "the one piece of 003 that
> modifies the live XTM bot (its import paths)". A smaller version of exactly that has since
> been merged**, in the two review-fix waves (`01e5c52`, `986f0b8`), and it is recorded here
> because it was not recorded anywhere before.
>
> A new `src/shared/` holds three pieces both bots now run on — `outboxRetry.ts` (the delivery
> retry schedule), `rollingLogger.ts` (rotation, retention and key censoring) and
> `sqliteOpen.ts` (the open → WAL → migrate → quarantine sequence) — and **three live XTM files
> were re-pointed at them**: `src/state/outbox.ts`, `src/state/db.ts` and
> `src/monitoring/logger.ts`. The bodies those files used to hold now live in `src/shared/`.
> This is not a Straker-only addition; it is a change to code that has run unattended since
> 2026-06-22.
>
> **Why it was done** (from the wave's own reasoning): the duplication was real and Constitution
> I requires duplication found in review to be extracted, and a fix made in one copy — the
> example given was a log leak — would otherwise stay open in the other. Each extraction keeps
> the bot-specific part behind: the filename and migration stay in `db.ts`, the secret values
> stay in `monitoring/logger.ts`, and `sqliteOpen`'s new corruption predicate is passed
> **only** by Straker, with XTM passing none so that its quarantine behaviour is unchanged.
>
> **Verification**: the XTM suite alone — `npx vitest run --exclude 'tests/**/straker/**'
> --exclude 'tests/unit/shared/**'` — stands at **exactly 820 passing**, and has been re-run at
> that scope after each extraction and again after the review waves. Lint and typecheck are
> clean and all six per-area coverage gates pass. SC-005's other two checks are post-release
> observations and cannot be made yet. The bulkhead test forbidding `src/straker/**` from
> importing `state/` or `config/` is unchanged and still passes — `shared/` was never in its
> scope, so the guard did not fail; nobody edited it away.
>
> **Ratified 2026-09-15.** Accepted as a narrowed extraction rather than reverted, on three
> grounds. First, SC-005 asks that the XTM bot's behaviour be **provably unchanged**, not that
> its files be untouched, and the 820-test baseline at a fixed scope is that proof, taken before
> and after. Second, the duplication was exact and the failure it invites is silent: a redaction
> fix applied to one logger and not the other is a leak that no test would show. Third, each
> piece left its bot-specific half behind, so the one behavioural lever added — `sqliteOpen`'s
> corruption predicate — is passed by Straker alone and XTM's quarantine rule is the same rule
> it ran yesterday.
>
> What was actually wrong was that it went unrecorded: the row above still deferred the
> extraction while three files had already moved. That is now fixed here and in the fourth row
> of Complexity Tracking. The deferral's **reopen triggers stand unchanged** for the remaining
> extraction — a third portal, duplication outgrowing DC-3, or feature 004.

---

> ### Scope decision — 003 modifies the live XTM bot's daily report (owner-approved 2026-09-16)
>
> **FR-018 cannot be satisfied without it.** The requirement is about *the* daily summary, and
> the daily summary is the `📋 Daily Report` the XTM bot already sends at 09:00 from
> `src/reporting/dailyReport.ts`. A combined view that lives only in a Straker ops script is
> the mitigation for the two-ceiling problem sitting somewhere nobody looks — which is the
> failure this feature has now produced four times, and the reason T052a and T056a exist.
>
> **Why this is compatible with SC-005**, whose three checks are all about job-catching:
> the suite stays green with the coverage gate intact (check 1 — note it says *green*, not
> *unchanged in count*, and the count necessarily grows when tests are added); nothing on the
> accept or skip path is touched (check 2); and the report is not an alert and stays inside
> the loop's existing try/catch, so a fault in it cannot page anyone or raise the error count
> (check 3). `dailyReport.ts` was made throw-safe in PR #14 after a bug in it took the loop
> down; that property must survive this change and is the thing to test for.
>
> **The 820-test figure this branch has been holding to is a proxy I adopted, not SC-005
> itself.** It was the right proxy while 003 claimed to touch nothing of XTM's; once XTM code
> is deliberately changed it stops being meaningful, and the invariant becomes: the XTM suite
> stays green, its coverage gate holds, and every test that existed before still exists and
> still passes. Any drop in that set is a regression; growth is the new work.
>
> **The change is inert until deployed.** Editing the file carries no risk to the running bot;
> `npm run deploy` is what takes effect, is the owner's to run, and is best run in a quiet
> window — which is what prompted this approval.

---

## Technical Context

**Language/Version**: TypeScript 5.x (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) on Node.js 22

**Primary Dependencies**: `zod` (payload and config validation), `better-sqlite3` (state), `googleapis` (tracking file), `pino` (structured logs). **Deliberately not Playwright** — Straker needs no browser, which is the single largest difference from the XTM bot. **`undici` was listed here as conditional** on keep-alive pooling being needed; on the 2026-09-15 measurement it is not (T044 deferred), so it was never added and the transport runs on the platform `fetch`. It returns only with T044.

**Storage**: SQLite via `better-sqlite3`, in a **separate database file under a separate `STATE_DIR`** from the XTM bot. No shared tables, no shared ledger, no cross-process transaction.

**Testing**: Vitest. Unit tests for pure logic, integration tests against stub transports, a failure-mode suite per the constitution, and live-portal tests behind an explicit flag that never runs in CI.

**Target Platform**: the existing office Windows 11 host, supervised by PM2 as a third application alongside `acolad-bot` and the temporary capture probe.

**Project Type**: unattended background service (bot), no user interface.

**Performance Goals**: detect→claim ≤ 400 ms at p95 — measured from the arrival of the response carrying the offer to the dispatch of the claim, which is the bot's own reaction time — and poll-gap ≤ 1.3× the configured rhythm (SC-001/SC-002). **Both are conditional**, struck only by the spec's computable rule: a shortest observed sighting lifetime of ≥ 120 s across a sample of at least 10 offers. **Resolved 2026-09-15: both are KEPT** — the sample stopped at 3, and the rule keeps them below 10 — while the measurement (shortest window 204 s) points the other way. The consequence of that split is recorded, not tidied: the criteria stand, and the latency work they would justify (T044) is deferred as unnecessary at the measured slack. Unconditionally: never exceed 300 requests/minute and never let the portal-reported remaining budget fall below 60 (SC-003).

**Constraints**: the XTM bot's behaviour must be provably unchanged (SC-005); separate single-instance port (XTM holds 47811, Straker takes 47812); separate state directory; either bot must be releasable and restartable without touching the other; claiming is irreversible so no blind retry of a claim is permitted.

**Scale/Scope**: **2-3 offers per day at most, irregular, some days none** (stated by the team). This rules out throughput engineering — batching, parallelism, bulk handling — and equally rules out using low volume as an argument against latency work, since scarcity raises the value of winning each race rather than lowering it.

### The unknowns, and what became of them

Written 2026-09-11 as "Unresolved — all gated by the capture probe (SC-000)". **On 2026-09-15
the owner decided to proceed without waiting for SC-000's exit** (10 distinct offers or 14
days): three payloads had arrived, so the model could be read off files rather than assumed,
and the premise of the gate had lapsed. The gate is kept visible here because what it cost to
lift early is part of the record — the sample is 3 offers of which only 2 are independent, on
day 4.2 of 14. The decision is in spec.md §Clarifications.

| # | Unknown | Blocks | Status 2026-09-15 |
|---|---|---|---|
| U1 | The offer payload's real shape — which field carries the language direction, the size, the deadline | The data model, and therefore claim eligibility and gate input | **Answered on 3 payloads / 2 independent jobs.** data-model §1, `offerParse.ts`, `eligibility.ts` — all built from the fixtures. The parser fails loud on anything unseen (FR-023), which is what makes a thin sample survivable rather than safe |
| U2 | How long an open offer survives | The polling rhythm, and whether SC-001/SC-002 survive at all — which in turn decides whether keep-alive pooling and proactive session renewal are needed | **Answered thinly**: 204 / 587 / 1,938 s, every one ended by a competitor claiming, not by expiry. Rhythm fixed at 10 s; SC-001/SC-002 kept by the rule; pooling and proactive renewal deferred (T044). Polling cannot see a lifetime shorter than one interval, so "no short-lived offers exist" is **not** what this shows |
| U3 | The real values of the listing category, and what each means | Whether some offers are reserved rather than contested (Q3 — needs Straker, not the team) | **Still open.** Only `direct_po` observed, and those three were taken by other vendors — the conservative default is confirmed for that value, on three offers of one type |
| U4 | Offers per day and their size distribution | The numeric daily ceiling (Q4) | **Still open**, and the code refuses to guess: `STRAKER_MAX_WORDS_PER_DAY` is required configuration with no default. Observed sizes of 2, 2 and 4 words are too thin to set it from |
| U5 | Whether one throughput figure is honest across 44 language directions | Possible per-direction rates in the gate (Q5) | **Still open.** Three directions seen of forty-four |

U1 and U2 were the hard gates and are now answered on a small sample rather than closed. U3–U5
have safe conservative defaults and block release configuration, not construction.

---

## Constitution Check

*GATE: evaluated before research, re-evaluated after design (both recorded below).*

| # | Principle | Verdict | Notes |
|---|---|---|---|
| I | Code Quality | **PASS, with the "additive" claim withdrawn 2026-09-15** | Strict TypeScript, lint and typecheck gates already enforced repo-wide. This row originally read "new code is additive"; that is no longer true. The review waves extracted `src/shared/{outboxRetry,rollingLogger,sqliteOpen}.ts` and **re-pointed three live XTM files at them** (`state/outbox.ts`, `state/db.ts`, `monitoring/logger.ts`). Principle I is what motivated it — duplication found in review must be extracted — so the verdict stands, but the reasoning must not keep saying the feature touches nothing existing. Recorded in Complexity Tracking and in §Scope decision. |
| II | Testing Standards | **PASS — the action is done** | TDD applies to decision logic, state and reporting. The gate originally covered `src/detection/`, `src/state/`, `src/reporting/`, `src/schedule/` and **not** `src/straker/`, which would have shipped the new bot with the coverage requirement silently not applied to it. **Closed (T003, and hardened since)**: `vitest.config.ts` now derives both the include list and the thresholds from one list of gated areas, which `straker` and `shared` are on. The thresholds are **per-area groups with no global number** — measured 2026-09-11, a single global figure read 89.45% while `src/straker/` alone sat at 79.93%, so the XTM areas were subsidising it and a Straker regression could not turn the gate red. Per-area groups also stop the reverse: Straker slipping can no longer fail the gate governing the live XTM bot. T067 still has to confirm the report on a run. |
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
├── data-model.md        # Phase 1 output — §1 was blocked by SC-000; modelled 2026-09-15
│                        #   from three captured payloads
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
│   │                         #   STATUS as of 2026-09-16 (T079): ALL phases built and the
│   │                         #   bot is live. Every file below exists except reconMain.ts,
│   │                         #   which T072/RP-5 deleted with the capture probe
│   ├── httpClient.ts         # built · transport in one file (DC-4): cookie jar,
│   │                         #   Origin/Referer, budget headers, loud non-2xx,
│   │                         #   retry-with-backoff, opt-in per-attempt deadline
│   ├── session.ts            # built · sign-in; vendor identity read, never pinned
│   ├── offersApi.ts          # built · open-offer read + shape guards
│   ├── offerTracker.ts       # built · appeared / still-here / vanished (pure)
│   ├── captureStore.ts       # built · probe evidence on disk. No production caller since
│   │                         #   T072; KEPT on the T078 decision — the live bot does not
│   │                         #   preserve raw payloads, and the parser still stands on two
│   │                         #   independent jobs
│   ├── config.ts             # built · ceiling, throughput, schedule, ports; TWO loaders,
│   │                         #   the probe's left untouched so it cannot fail-fast mid-capture
│   ├── probe.ts              # built · probe cycle (read-only). `runProbeCycle` has had no
│   │                         #   production caller since T072; kept deliberately (T078).
│   │                         #   `RawOffer` lives here and IS used throughout the bot
│   │                         # reconMain.ts — DELETED by T072 (the probe's entry point)
│   ├── types.ts              # built · shared vocabulary (DC-2), TYPE-ONLY — the coverage
│   │                         #   gate excludes **/types.ts, so no runtime member may live here
│   ├── outcomePolicy.ts      # built · NOT IN THE ORIGINAL PLAN — the runtime half of
│   │                         #   types.ts (value lists, XTM concept map, outcome predicates),
│   │                         #   split out so executable code is not hidden from the gate
│   ├── eligibility.ts        # built · pure — is this offer one we want? (was Track B)
│   ├── offerParse.ts         # built · payload → domain, from fixtures (was Track B);
│   │                         #   owns STRAKER_DEADLINE_ZONE, the one place due_at's zone is set
│   ├── claimOutcome.ts       # built · pure — won / lost / failed / unknown
│   ├── claimDecision.ts      # built · NOT IN THE ORIGINAL PLAN — pure claim/skip decision
│   │                         #   (eligibility + gate + ledger → one verdict with a reason)
│   ├── claim.ts              # built · the irreversible action itself
│   ├── strakerStore.ts       # built · own SQLite: offers, outcomes
│   ├── ledger.ts             # built · per-portal ceiling, keyed by deadline day
│   ├── outbox.ts             # built · durable outcome delivery (FR-016)
│   ├── logger.ts             # built · own logger (the XTM one is bound to AppConfig)
│   ├── pollCycle.ts          # built · fetch → diff → gate → act → persist → notify (DC-3)
│   ├── main.ts               # built · long-running entry + composition root, supervised
│   ├── reconcile.ts          # built · portal's assigned work vs our record; also RELEASES
│   │                         #   finished work back to the ledger (T056b)
│   ├── trackingSink.ts       # built · Straker's own tracking file
│   ├── notifier.ts           # built · own announcement channel + alerts
│   ├── dispatcher.ts         # built · NOT IN THE ORIGINAL PLAN — the drain: outbox rows to
│   │                         #   their senders, one interface written before the senders
│   ├── combinedSummary.ts    # built · reads BOTH portals at reporting time only, read-only
│   │                         #   handles; also renders the win-rate row (T076)
│   ├── winRate.ts            # built · NOT IN THE ORIGINAL PLAN — pure win-rate computation
│   │                         #   (FR-017), split from the script so the report can use it
│   ├── winRateReport.ts      # built · ops script — npm run straker:win-rate
│   ├── requeue.ts            # built · NOT IN THE ORIGINAL PLAN — ops script; dead outbox
│   │                         #   rows back to pending (npm run straker:outbox:requeue)
│   └── unbar.ts              # built · NOT IN THE ORIGINAL PLAN — ops script; lifts the
│                             #   durable claiming bar after a 403 (T073, npm run straker:unbar)

   NOTE: rate limiting, backoff and session renewal are NOT separate modules —
   DC-4 puts every request-issuing and request-pacing concern inside httpClient.ts.
├── shared/                   # NEW, NOT IN THE ORIGINAL PLAN — extracted during 003 because
│   │                         #   BOTH bots run on it: outboxRetry.ts (delivery schedule),
│   │                         #   rollingLogger.ts (log retention), sqliteOpen.ts (corruption
│   │                         #   quarantine). On the coverage gate for that reason
├── schedule/                 # REUSED UNCHANGED — input is primitives only, no portal types
├── monitoring/               # REUSED — liveness signal, logger
├── reporting/                # to be EXTENDED in Phase 4 — a Straker sink + card builder;
│                             #   untouched so far, and XTM paths stay untouched
└── config/index.ts           # NOT TOUCHED — adding required vars here would stop the live bot

tests/
├── unit/straker/             # pure logic, test-first
├── integration/straker/      # stub transport; failure-mode suite
└── live/straker/             # behind the live flag, never in CI — smoke.test.ts (T069),
                              #   5 tests, skipped unless the flag is set
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

### Track B — was waiting for the capture probe; unblocked 2026-09-15

Small, and sharply bounded. **The wait ended early, by decision rather than by exit**: on
2026-09-15, with 3 offers captured of the 10 the criterion asks for and on day 4.2 of 14, the
owner proceeded. The reason is that the premise had lapsed — real payloads existed, so nothing
was being fixed on assumption — and the answer to the thin sample is a parser that fails loud
on anything unfamiliar rather than a longer wait (spec.md §Clarifications).

1. **Offer model + parsing** (U1): **built** — `offerParse.ts`, fixed against the three real fixtures, never against the recon note's field list.
2. **Eligibility** (U3, FR-011): **built** — `eligibility.ts`, the language-direction check across all 44 registered directions with the exclusion list honoured. What the listing category *means* is still Straker's to answer; every open offer is treated as contested.
3. **Polling rhythm** (U2): **decided — 10 seconds**, from the 204 s shortest observed window. The work that was conditional on offers proving short-lived — keep-alive pooling (FR-020), proactive session renewal (FR-021) and critical-path tuning (FR-003) — is **deferred** (T044): at 204 s of slack a 400 ms handshake does not decide anything.
4. **Release configuration**: **still open** — the numeric ceiling (U4) and the throughput decision (U5). The ceiling is required configuration with no default, so the bot cannot start without a human choosing one.

**The strike rule and what it did.** If the probe's shortest observed sighting lifetime is 120 seconds or more, across a sample of at least 10 offers, SC-001 and SC-002 are struck, item 3 disappears entirely, and Track B shrinks to parsing plus configuration. Below a sample of 10 the criteria are kept. The only valid ground for striking them is measured lifetime — never offer volume. **Applied on 2026-09-15 at a sample of 3, it keeps them** — so the criteria stand while the work they justify is deferred on the measurement. That is an inconsistency, and it is recorded as one here and in the spec rather than resolved by bending either half. A single materially shorter lifetime would settle it in the other direction.

---

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **Recording state only *after* the irreversible action** (FR-003), where Principle VII expects state committed before an action is reported complete | The claim path is the race. A durable write before claiming adds latency to the only step where latency decides whether the team gets the work at all. | Writing an "attempting" marker first was rejected for that reason. The principle's intent — never lose track of an irreversible action — is met **behind** the claim instead of in front of it, by reconciling against the portal (FR-016a) within 15 minutes. This is a genuine deviation in mechanism, not merely in wording, and is recorded as such rather than argued away. |
| **Polling far faster than "human-plausible rates"** (Operational Constraints) — planned at up to 60 requests/minute against a portal, where the XTM bot is capped at 3/minute. **Shipped at 6/minute** (a 10-second rhythm), decided 2026-09-15 on measured offer lifetimes — 2% of the portal's stated allowance rather than the planned 20%. The violation is real but an order of magnitude smaller than the one justified below. | The premise of the feature is a first-come-first-served race. At a human-plausible rhythm the bot arrives after every other vendor's bot and wins nothing, making the whole feature worthless. The portal itself publishes a budget of 300 requests/minute and reports the remainder on every response, so even the planned 60/minute was 20% of the vendor's own stated allowance — the vendor's definition of acceptable, not a human's. **What the measurement then showed** is that the race is decided over minutes, not milliseconds: the shortest observed window before a competitor claimed was 204 s, so 10 s buys ~194 s of slack and 1 s would buy 9 s more for ten times the requests. | Polling at the XTM rhythm (3/minute) was rejected: with offers possibly living under a minute, it would miss most of them outright — and at 3/minute a 204-second window is still only four chances to see it, against twenty at the shipped rhythm. Relying on a push notification was rejected because the portal offers none. Hard floors remain: never exceed 300/minute, never let the remaining budget fall below 60, and step down as the budget is consumed (FR-019). **Re-review is triggered by any of**: the portal publishing a lower budget, the account being throttled or warned, the portal's terms changing, or the measured offer lifetime turning out long enough to strike SC-001/SC-002 — in which case the fast rhythm is no longer justified at all and this violation must be withdrawn rather than inherited. **Note on that last trigger (2026-09-15)**: the lifetimes measured so far are past the 120 s threshold, but the sample never reached 10, so the rule keeps the criteria and the trigger has not fired. It came close enough that the rhythm was set at 10 s rather than 1 s — the violation was reduced on the evidence even though it could not yet be withdrawn. |
| **Straker code imports scheduling and monitoring from `src/` instead of an extracted `packages/core`** | Deferring the extraction keeps the live XTM bot untouched while the second portal is still unproven (see Scope decision). | Extracting core first was rejected: it is the only part of 003 that modifies a bot which has run 18 days without incident, for a portal that has not yet won a job. DC-1..DC-4 keep the later extraction mechanical, so the cost of waiting is low. **Reopen when any of these occurs**: a third portal is proposed; the duplication between the two bots grows beyond what DC-3 makes readable at a glance; or feature 004 begins. Without a stated trigger a deferral quietly becomes a permanent decision nobody ever made. |
| **A partial shared extraction into `src/shared/`, which modified the live XTM bot's import paths** — the thing the row above defers. Added 2026-09-15, recording what shipped in `01e5c52` and `986f0b8`; **not previously recorded anywhere, and not yet ratified by the owner.** | Constitution I requires duplication found in review to be extracted before merge, and the duplication was exact: the same outbox backoff constants and formula, the same open→WAL→migrate→quarantine sequence, the same log rotation policy, in two copies. The argument that carried it was a fix diverging — a leak closed in one logger staying open in the other. Three pieces moved (`outboxRetry.ts`, `rollingLogger.ts`, `sqliteOpen.ts`), each leaving the bot-specific half behind: filename and migration in `db.ts`, secret values in `monitoring/logger.ts`, and a corruption predicate that only Straker passes so XTM's quarantine behaviour is untouched. | Leaving the duplication was the plan of record and was rejected in review rather than in planning — which is the part to notice, because this row exists to make that visible. Two alternatives were **not** tried: a shared helper parameterised by path and migration that never changes an XTM import (which was this auditor's earlier suggestion), and deferring the whole thing to the `packages/core` extraction the row above already defers it to. Against the row above, the count that mattered — "the only part of 003 that modifies a bot which has run 18 days without incident" — is now three files modified. The bulkhead itself is intact: `src/straker/**` still may not import `state/` or `config/`, and the test enforcing that is unchanged. **Ratified 2026-09-15 as a narrowed extraction** — not reverted. SC-005 requires the XTM bot's behaviour to be provably unchanged, not its files untouched, and the proof is the 820-test XTM-only baseline held before and after each move; the alternative on offer was two copies of a redaction policy whose divergence no test would reveal. The genuine defect was that it shipped unrecorded while the row above still deferred it — recorded here now, with that row's reopen triggers left in force for the extraction that remains. |
| **A daily ceiling per portal, with no shared ledger, knowing the two can sum past the crew's real capacity** | Separate ledgers are what make the bulkhead complete — no shared state, no cross-process transaction, either bot can die without touching the other. | A shared ledger was rejected: it would couple the two bots at exactly the point the isolation requirement protects. The mitigation is visibility instead of enforcement — the combined daily view (FR-018) shows the total so a human can lower a ceiling. |
