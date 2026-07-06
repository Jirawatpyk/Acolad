# Design: XTM auto-accept — frame-detach recovery

**Date:** 2026-07-06
**Status:** Approved (approach B) — pending spec review
**Motivating incident:** job `4725506-1-6 (Tata Communications) Affiliate EMAIL`, 2026-07-06 17:07:35 BKK — `xtmAccept` threw `locator.count: Frame was detached` mid-accept. The bot marked the whole Malay group terminal `accept_failed` and paged a human (🔴), even though the bulk click had actually **landed** (the job was accepted on XTM). Result: a false page + a DB/Sheet/capacity mismatch that had to be reconciled by hand.

## Problem

When a **transient browser fault** interrupts `acceptEligibleTasks` — an iframe detaching / navigating / its execution context being destroyed / the target closing mid-operation — the current code short-circuits to the terminal `failed` outcome:

- A fault inside the click flow (`openBulkAcceptForLanguage`) is caught per-language and the group is marked `failed` **without ever reaching the authoritative re-read** (`src/portal/xtmAccept.ts` ~L132–140).
- A fault inside `reReadActive` triggers `failAllAttempted('post-accept re-read failed')`.

`failed` is a **terminal** state: the robustness pass only re-attempts `none`/`missing`, never `failed`. So the job sits in `accept_failed` limbo and pages a human — even in the common case where the click already landed.

## Root insight (why this is a small, safe change)

The machinery to disambiguate a landed click from a genuine failure **already exists**:

- `reReadActive` (`src/portal/xtmClient.ts`) **reloads the inbox**, re-resolves the fresh iframe, and re-reads the grid.
- `readAcceptAvailability` opens **each target row's menu** and reports "Accept task" (still claimable) vs "Finish task" (we own it now).
- `determineAcceptOutcomes` maps that per-job: present + not-acceptable → `accepted`; present + still-acceptable + we clicked → `failed`; gone → `missing`.

The **only** gap is that a transient frame fault throws **before** this authoritative re-read runs. The fix routes those faults **through** the re-read instead of around it.

## Safety invariant (non-negotiable)

> **Re-attempt an accept click ONLY for a target that the post-reload authoritative re-read shows as still `"Accept task"`.**

A landed click flips the row menu to `"Finish task"` immediately, so observing `"Accept task"` is **proof** the previous click did not take. Re-clicking is therefore gated on live, reloaded menu state — never on our own record of whether we clicked. This makes a double-accept impossible **by construction**, independent of where the fault occurred (before, during, or after the click).

## Approach B (chosen)

Considered three approaches:

- **A — minimal:** route frame faults into the existing reload+re-read; record `accepted` if it landed, else let the *next cycle's* robustness pass re-click. Rejected as the sole fix: the re-click is ~1 poll cycle (~20–30 s) later and may miss the sub-1-minute Malay snatch window.
- **B — minimal + in-cycle re-attempt (CHOSEN):** A, plus re-drive the accept **in the same cycle** for targets the reloaded re-read still shows as `"Accept task"`. Fast enough for the snatch window; the safety invariant makes the re-click double-accept-safe.
- **C — multi-round backoff loop:** rejected as YAGNI and a portal-rate-limit risk.

### Mechanics

1. **Classify the caught error.** A pure `isRetryableFrameFault(err): boolean` recognises the transient-fault allowlist: frame detached, execution context destroyed/was destroyed, target closed, target crashed, navigation-interrupted. **Everything else stays fail-loud** — a menu-path/selector error (`AcceptUnconfirmedError`, "bulk option not found", etc.) must still go straight to `failed` + 🔴 alert (never mask real breakage; Constitution "fail loud").

2. **On a retryable fault in the click flow:** do **not** mark the group `failed`. Carry its targets forward so the authoritative reload+re-read classifies them (a landed click → `accepted`; still-claimable → candidate for in-cycle re-attempt; gone → `missing`).

3. **On a retryable fault in the re-read itself:** reload + retry the re-read (bounded), rather than `failAllAttempted`.

4. **In-cycle re-attempt (bounded).** For targets the reloaded re-read shows still `"Accept task"`, re-drive `openBulkAcceptForLanguage` on the fresh frame, then re-read + re-classify **once**. Bound = **1** in-cycle recovery round (original attempt + 1). If a target is still unresolved after the bound (still `"Accept task"`, or the retry itself faults), fall back to the **existing** `failed` + 🔴 alert as the last resort.

5. **Bulk-group partial faults are already handled.** `determineAcceptOutcomes` attributes per member, so a mid-bulk fault that left some members accepted and others not classifies each correctly. No change there.

### Bounds & rate budget

- Each reload counts as one portal request and is already recorded via `this.rate.record` in `reReadActive`. The recovery adds **at most one** extra reload+re-read+re-attempt per accept invocation. This stays within FR-011 / FR-027 (no interval reduction, no unbounded retry). The design **must not** add more than the single bounded recovery round.

### Observability

- Emit a structured log when recovery runs: `module:xtmAccept action:recover outcome:accepted|reattempt|failed jobKey:…` so the false-page reduction is measurable and a recurring fault is visible. The existing `logError` for the real (redacted) cause is preserved.

## Where implemented

| File | Change |
|---|---|
| `src/portal/errors.ts` (or a small helper) | new pure `isRetryableFrameFault(err)` + its allowlist — unit-testable |
| `src/portal/xtmAccept.ts` | `acceptEligibleTasks`: retryable faults route into the authoritative re-read + the bounded in-cycle re-attempt instead of immediate `failed`; wrap `reReadActive` in a bounded retry-on-fault |
| `src/portal/xtmClient.ts` | expose a reload/re-read entry the recovery can call on a fresh frame if needed (the reload already lives in `reReadActive`) |
| `tests/integration/accept.test.ts` + `tests/unit/*` | failure-mode coverage (below) |

`determineAcceptOutcomes` and `isRetryableFrameFault` stay **pure** (unit-tested). The orchestration is integration-tested via the existing stub-`Scope`/stub-deps pattern in `accept.test.ts`.

## Testing (failure-mode suite — Constitution mandate)

TDD, red first. Cases:

1. **Landed click, then frame detached** → reloaded re-read shows `"Finish task"` → `accepted`, **no alert** (the incident; the headline fix).
2. **Click did not land, frame detached** → re-read shows `"Accept task"` → in-cycle re-attempt → `accepted`.
3. **Still `"Accept task"` after the bounded re-attempt** (or the retry faults again) → `failed` + 🔴 alert (last resort preserved).
4. **Non-retryable error** (e.g. `AcceptUnconfirmedError`, bulk option missing) → **immediate** `failed` + alert (fail-loud NOT weakened).
5. **Bulk group, partial:** member A landed, member B did not → A `accepted`, B re-attempted → both resolved.
6. **Re-read itself faults once, then succeeds** → recovered, classified normally.
7. **Rate budget:** recovery adds ≤ 1 extra reload (assert `rate.record` call count bound).

## Out of scope (YAGNI)

- No multi-round/backoff retry loop (approach C).
- No change to the schedule/capacity gate, the bulk-group key, or `determineAcceptOutcomes`' per-member logic.
- No auto-reconciliation of jobs already stuck in `accept_failed` from **before** this ships (the 4725506 row was hand-reconciled; this design prevents *future* occurrences).

## Constitution / complexity note

- The in-cycle re-attempt on the irreversible accept path is justified by the **safety invariant** (re-click only on proven-still-claimable menu state) — it is a hardening, not a principle violation, so no Complexity Tracking entry is required. The rate-budget interaction is bounded (+1 reload) and stays within FR-011/FR-027; the plan must assert this bound in a test.
