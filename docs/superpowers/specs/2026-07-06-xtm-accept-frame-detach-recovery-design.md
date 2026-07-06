# Design: XTM auto-accept — frame-detach recovery

**Date:** 2026-07-06
**Status:** Revised to **approach A′** after adversarial review — pending spec review
**Motivating incident:** job `4725506-1-6 (Tata Communications) Affiliate EMAIL`, 2026-07-06 17:07:35 BKK — `xtmAccept` threw `locator.count: Frame was detached` mid-accept. The bot marked the whole Malay group terminal `accept_failed` and paged a human (🔴), even though the bulk click had actually **landed** (the job was accepted on XTM). Result: a false page + a DB/Sheet/capacity mismatch that had to be reconciled by hand.

## Review outcome — why this design was rewritten (B → A′)

The first draft (approach B) added an **in-cycle re-click**: on a frame fault, reload + re-read, and if a target still showed `"Accept task"`, re-drive the accept. Two independent specialist reviews (reliability-engineer + playwright-automation-engineer) **converged on the same verdict: the in-cycle re-click has real, irreversible double-accept paths, and it removes a safety net the current code already has.** Key findings (all about the re-click):

1. **`"Accept task"` after reload is NOT proof the click didn't land.** The reloaded grid can show a stale/pre-commit `"Accept task"` on an *already-accepted* row because of (a) XTM server-commit lag (`networkidle` ≠ accept committed) and (b) the late-XHR grid render race (`waitForGridComplete` is best-effort — it proceeds after a 3 s cap). Re-clicking then **double-accepts, silently, with no alert** (the second re-read shows `"Finish task"` → reports `accepted`).
2. **The bulk action is group-level.** `openBulkAcceptForLanguage`'s "Accept all tasks for this language in this group" claims the *whole* language group. Re-driving it for a still-claimable member also re-hits already-owned siblings; whether XTM double-accepts them is **unproven** (no recon evidence). So per-target reasoning does not make the group action safe.
3. **Today's code is already safe against this:** a frame fault → terminal `failed` → a human pages, never an auto-retry. Approach B **removed** that net, converting a previously-harmless mis-read (a false page) into an irreversible action.

The review split the original design cleanly: the **record-accepted** half is safe and high-value; the **re-click** half is where all the danger is. This revision keeps the safe half and drops the re-click.

## Problem

When a **transient browser fault** interrupts `acceptEligibleTasks` — an iframe detaching / navigating / its execution context being destroyed / the target closing mid-operation — the current code short-circuits to the terminal `failed` outcome:

- A fault inside the click flow (`openBulkAcceptForLanguage`) is caught per-language and the group is marked `failed` **without ever reaching the authoritative re-read** (`src/portal/xtmAccept.ts` ~L132–140).
- A fault inside `reReadActive` triggers `failAllAttempted('post-accept re-read failed')`.

`failed` is **terminal** (the robustness pass only re-attempts `none`/`missing`), so the job sits in `accept_failed` limbo and pages a human — even in the common case where the click already landed (the 4725506 incident).

## Approach A′ (chosen) — reclassify on fault, never auto-re-click

On a **retryable frame fault**, reload + do the authoritative re-read (which `reReadActive` already performs: reload inbox → re-resolve the fresh iframe → per-row menu probe of `"Accept task"` vs `"Finish task"`). Then classify each affected target:

| Post-reload re-read shows | Disposition | Why safe |
|---|---|---|
| **"Finish task"** (owned) | `accepted` — record it, **no page** | Recording reality is not an irreversible action. `"Finish task"` only appears for an owned job, so a partial/stale grid cannot fabricate it. This is the false-page fix (the incident). |
| **"Accept task"** / ambiguous | `failed` + 🔴 page (human decides) | Status quo for the fault path. A stale/pre-commit `"Accept task"` is exactly the unsafe direction, so we do **not** act on it — a human confirms and accepts manually if needed. No double-accept. |
| **gone** from the grid | `failed` + 🔴 page (conservative) | For a *faulted* group, "gone" is ambiguous (accepted-and-moved vs snatched); page rather than silently reset. |

**There is no in-cycle re-click and no reset-to-`missing` on the fault path.** This dissolves all three critical findings at once (they were all about the re-click and its stale frame handle). A′ is therefore **strictly safer than the status quo**: it only *adds* the "record `accepted` when the reload proves `"Finish task"`" path and otherwise preserves today's fail-loud behavior.

**Non-retryable errors** (e.g. `AcceptUnconfirmedError`, "bulk option not found", a menu-path/selector break) → **immediate** `failed` + 🔴 page (fail-loud NOT weakened).

### Fault classification (structural, not string-only)

Classify a caught error as retryable when it is a genuine transient frame fault, judged **structurally**:

- `scope.isDetached()` is true (the frame died), **or**
- `err.name === 'TimeoutError'` **and** the frame is detached/navigated (a detach while a locator action was pending frequently surfaces as a timeout, not "Frame was detached"), **or**
- the message matches a version-pinned allowlist (case-insensitive): `frame was detached`, `execution context was destroyed`, `target closed`, `target crashed`, `net::ERR_ABORTED`, navigation-interrupted.

**Never** retry a timeout on a still-live, non-navigated frame — that is a real selector break and must page (fail-loud). Log every classification decision (matched signal + redacted message) so a misclassification is diagnosable. `target crashed`/`target closed` and a mid-accept **logout** (iframe → login → "execution context destroyed") degrade safely: the reload re-read finds no grid → `LayoutChangedError` (non-retryable) → `failed` + page. `reReadActive` does **not** re-login; a mid-accept logout is expected to fall through to `failed` + page, not be silently recovered.

### Bounds & rate budget (stated honestly)

The recovery performs **one** authoritative reload+re-read (the reclassification), retried **at most once** if that re-read itself hits a retryable fault. Count portal **navigations**, not "rounds": recovery adds **at most 2 extra inbox navigations** per accept invocation, and each `reReadActive` records the rate limiter more than once (its own call + `navigateToInbox`), so the test asserts the true navigation/`rate.record` count — not "≤1". Within FR-011 / FR-027 (no interval reduction, no unbounded retry).

### Restart-safety & observability

- The recovery lengthens the interval between `claimForAccept` ('accepting') and `recordAcceptOutcome`. A crash in that window is caught by the existing stranded-'accepting' guard (`xtmPollCycle.ts` ~L162–192), which records `accept_failed` + alert and never re-accepts — so restart-safety holds (a possible extra false page, never a double-accept). Document this dependency explicitly.
- Emit a structured log when recovery runs: `module:xtmAccept action:recover outcome:accepted|failed jobKey:…`. Make fault-time `captureEvidence` **best-effort/guarded** — a detached-frame capture can itself throw and must degrade to the structured log, not crash the recovery.

## Where implemented

| File | Change |
|---|---|
| `src/portal/errors.ts` (or a small helper) | pure `isRetryableFrameFault(err, scope)` — structural (`isDetached`/`TimeoutError`) + version-pinned message allowlist; unit-testable |
| `src/portal/xtmAccept.ts` | `acceptEligibleTasks`: a retryable fault in the click flow routes its targets into the authoritative reload+re-read for **reclassification** (record `accepted` on `"Finish task"`, else `failed`), instead of immediate blanket `failed`; wrap `reReadActive` in the bounded (≤1) retry-on-fault |
| `src/portal/xtmClient.ts` | ensure the reload+re-read is reachable on the recovery path (the reload already lives in `reReadActive`); thread the grid-settle *result* out only if later needed (not needed for A′ since we never re-click) |
| tests | failure-mode coverage (below) |

`determineAcceptOutcomes` and `isRetryableFrameFault` stay **pure** (unit-tested). The orchestration is integration-tested via the existing stub-`Scope`/stub-deps pattern in `tests/integration/accept.test.ts`.

## Testing (failure-mode suite — Constitution mandate)

TDD, red first:

1. **Landed click, then frame detached** → reloaded re-read shows `"Finish task"` → `accepted`, **no alert** (the incident; headline fix).
2. **Click did not land, frame detached** → re-read shows `"Accept task"` → `failed` + 🔴 page (no re-click, no reset-to-missing).
3. **Non-retryable error** (`AcceptUnconfirmedError`, bulk option missing, selector break) → **immediate** `failed` + page (fail-loud preserved).
4. **Re-read itself faults once, then succeeds** → recovered, classified normally (bounded ≤1 read-retry).
5. **Bulk group, partial:** member A landed (`"Finish task"`) → `accepted`; member B not (`"Accept task"`) → `failed` + page. No re-click of the group.
6. **Fault classification:** `scope.isDetached()` and `TimeoutError`-on-detached-frame are retryable; a `TimeoutError` on a live, non-navigated frame is **not** (pages).
7. **Rate budget:** recovery adds ≤ 2 extra navigations; assert the exact `rate.record` count.

## Deferred (separate future effort, NOT in this design)

The **in-cycle re-click** ("bot re-accepts within the snatch window") is deferred. To be safe it requires, at minimum: recon evidence that XTM's bulk is a **no-op on already-owned siblings**; a positive **accept-commit confirmation signal** (the accept's own XHR/dialog, currently UNCONFIRMED in `selectors.ts`) so a post-reload reading reflects committed state; a **strictly-settled** grid gate (not the best-effort `waitForGridComplete`); a **stable** `"Accept task"` reading across two probes; and an **audit alert** on every re-attempt that resolves `accepted` (so any double-accept leaves a trail). Revisit only if losing the snatch-window auto-accept proves to matter in practice.

## Out of scope (YAGNI)

- No change to the schedule/capacity gate, the bulk-group key, or `determineAcceptOutcomes`' per-member classification.
- No auto-reconciliation of jobs already stuck in `accept_failed` from **before** this ships (4725506 was hand-reconciled; this prevents *future* occurrences).
- The latent `readClosedKeys` pagination gap is tracked separately (Closed-vs-Removed work), not here.
