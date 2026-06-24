# Accept-flow read-race + sheet field-sync fixes — Design (v2)

**Date:** 2026-06-24
**Status:** Approved (brainstorming, post agent-review) — ready for writing-plans
**Feature:** 002-xtm-detect-accept (bug fixes)
**Supersedes:** the v1 count-stability `settleRows` approach (replaced after a
playwright + reliability agent review found it false-passes on a partial render).

This design bundles two independent bugs surfaced from live Malay jobs on 2026-06-23/24,
both rooted in how the accept/reporting path treats a grid that renders incrementally:

- **A — Malay jobs lost at accept** (read race): detected + logged, never accepted.
- **B — Due date (and other late fields) missing from the Sheet** (sync gap).

---

## Problem A — Malay jobs lost at accept

8 Malay (eligible) jobs arrived; all 8 were **detected and logged**, but ~5 ended
`missing`/`removed`, never accepted (`accepted:0`, no `accept_failed` alert, no
`action:"accept"` log). `decideAccept` returns `accept` for them — the bot **decided**
to accept but never clicked. The user confirmed every job stayed available **> 2 min**
(not a genuine fast snatch). Evidence: job 4717761 detected 22:06:32, the accept-flow
re-read 3 s later read fewer rows ("gone"), yet a fresh detection at 22:06:58 logged it
again → it was **present the whole time**; the accept-flow read **raced**. The loss
clustered when an already-owned Malay job ("Finish task") shared the language group.

### Root cause A

A grid-read race **in the accept flow** (detection itself is fine — `settleGrid` read
all 8). Two reads race a partial/auto-refreshing grid:

1. `openBulkAcceptForLanguage` (`xtmAccept.ts`) **scans the live grid row-by-row via
   `rows.nth(i)`**, opening each Malay row's kebab menu (~1–2 s each). XTM's own grid
   auto-refresh fires a data XHR **during** the multi-second scan → rows reindex, the
   new job's row is absent or `nth(i)` points at a different row → the scan sees only
   the owned row → returns `'already-owned'` → **no click**.
2. The FR-024 re-read (`reReadActive`) then also reads a partial grid → the target is
   absent → `determineAcceptOutcomes` returns `'missing'`. `missing` resets
   `accept_status` to `'none'`, so the robustness pass re-attempts next cycle — **but
   the same race recurs every cycle** until the job genuinely leaves → permanent loss.

The existing guard catches only a **wholesale-empty** re-read (`reRead.length === 0`).
A **partial** race is unguarded. (v1's count-stability `settleRows` was rejected because
"row count stable" ≠ "target row present" — it false-passes on a stable *partial* count,
e.g. owned-row-only.)

### Fix A — target-keyed accept (deterministic, not count-based)

We **know the exact jobKeys** we intend to accept (the cycle's claimed targets). Drive the
accept off those, not a blind `nth(i)` scan of a mutating grid:

1. **Locate the target row by jobKey, not `nth(i)`.** In `openBulkAcceptForLanguage`,
   build a locator that matches the row whose File/Step/Role cells equal the target
   jobKey, and `waitFor({ state: 'attached', timeout: ~3 s })` it. Then open **only that
   row's** menu and drive the bulk. This:
   - waits for the *specific* target row to render (kills the partial-render miss),
   - never opens owned rows' menus (no added latency, no `nth(i)` reindex flakiness),
   - is independent of row order and total count.
   If the target row never attaches within the cap → the job is genuinely not present
   this cycle → no click, classified retriable (see §3).
2. **Re-read on a *complete* grid.** In `reReadActive`, after `settleGrid` (networkidle),
   wait for a **deterministic completeness signal**: the footer "… of N" total equals the
   rendered kebab-data-row count (bounded ~3 s). Read only then. (The footer total is the
   authoritative row count; matching it to the DOM rows means the data XHR finished
   rendering — not merely "count stopped changing".) Falls back to the existing
   empty-re-read guard on cap-hit.
3. **Fix the outcome classification** (`determineAcceptOutcomes` + caller). Thread a
   per-target **`clicked`** flag out of `openBulkAcceptForLanguage`:
   - target **never clicked** (group `'already-owned'`, or its row didn't attach) but the
     re-read still shows it present + claimable → **retriable** (`'missing'` → resets
     `accept_status` to `'none'`, robustness re-attempts) — NOT terminal `'failed'`.
   - target **clicked** but re-read still claimable → genuine `'failed'` (alert) as today.
   This stops a scan-miss from being mislabeled a terminal `accept_failed` (false alert +
   no retry), which is *worse* than the retriable `missing`.
4. **Regression metric.** Add a structured per-accept log
   `{action:'accept', clicked, reReadRows, targetPresent, acceptAvailable, outcome}` and a
   per-cycle counter `acceptNoClickWhilePresent` (claimed targets that ended no-click while
   still present+claimable). `> 0` over consecutive cycles = the race is back — a true
   detector (the v1 cap-hit log is a false negative: the dangerous case settles fast at a
   partial count and never caps).

---

## Problem B — Due date (and late fields) missing from the Sheet

Job 4717562 (PR Newswire / World Tennis) shows **Due date blank** in PM_Tracking, yet the
SQLite `jobs` row has `due_date = 2026-06-24T16:41+07:00`. The bot read it correctly; the
Sheet just never received it.

### Root cause B

The Sheet row is (re)written **only on a lifecycle transition** (first_seen / relisted /
accepted / missing / removed) or an accept outcome — `xtmPollCycle.reportJob` fires for
`result.events` + `acceptResults.keys()` only. When XTM **sets the Due date after the last
transition** (here: after the 20:42 "Accepted" write), the new value flows to the DB (the
per-cycle `upsertMany`) but **never to the Sheet** — no transition re-triggers a write.
Other cells (Words/Step/Role) were present at write time, so only the late-set Due is blank.

### Fix B — field-change re-sync

After `upsertMany`, for each job **present this cycle** that produced **no transition** and
is **not already being reported**, compare its material display fields against the previous
persisted state (`prev`); on a change, enqueue a **Sheet-only** upsert (no Chat):

- Material fields watched: `due_date`, `words` (the fields XTM can populate late). Keep the
  set minimal (YAGNI); status/accept changes already flow through transitions.
- Distinct outbox `event_id` (e.g. `sheet:fieldsync:<jobKey>|<pollCycleId>`) so the dedup
  never collides with a transition write; only enqueued when a field **actually** changed,
  so it is not a per-cycle write.
- No Chat (a silent Sheet correction, not an announcement).

---

## Components & files

| Change | File |
|---|---|
| target-keyed locate + `waitFor` (A1), `clicked` flag (A3) | `src/portal/xtmAccept.ts` |
| completeness-gated re-read (A2) | `src/portal/xtmClient.ts` (`reReadActive`, near `settleGrid`) |
| outcome classification on `clicked` (A3) | `src/portal/xtmAccept.ts` (`determineAcceptOutcomes`) |
| accept metric / structured log (A4) | `src/runtime/xtmPollCycle.ts` + `src/portal/xtmAccept.ts` |
| field-change re-sync pass (B) | `src/runtime/xtmPollCycle.ts` (after `upsertMany`) |
| pure helper `materialFieldsChanged(prev, next)` (B), `rowMatchesJobKey` locator builder (A1) | `detection/` or `portal/` (testable) |

No change to `decideAccept`, the diff, or the detection read.

## Error handling

- All new waits are **bounded** (~3 s each) and fall back to existing guards (empty-re-read
  → `failed`/retry). A cap-hit is logged loud (Constitution VI). Total added latency is
  bounded; verify steady-state cycle p95 stays well under the 25 s shutdown watchdog
  (`report:latency`).
- The claim→accept→record ordering is unchanged (no new double-accept / stranded-`accepting`
  risk); the only widened window is the bounded waits — keep caps small (3 s).

## Testing

- **Unit (TDD, pure):** `materialFieldsChanged(prev, next)` (Due appears / Words change /
  no change / null↔value); the jobKey→row locator predicate; the classification decision
  (clicked vs not × present vs claimable → outcome).
- **Integration (deterministic race):** a Playwright fixture that **step-renders** the grid
  (owned row first, target row attaches ~200 ms later) to assert the target-keyed
  `waitFor` waits for the target and the scan clicks it — reproduces the race without
  real-world timing.
- **Ops verify (DIAG on):** next live Malay jobs accept on the **first** attempt
  (`action:"accept","outcome":"ok"` per job; `acceptNoClickWhilePresent` stays 0); the Due
  date appears in the Sheet for a job whose due is set post-acceptance.

## Constraints / non-goals

- **FR-011:** all new waits observe the already-loaded DOM — zero extra portal requests;
  poll interval stays ≥ 20 s.
- **Live shared account:** additive waits + a stricter classification; `ACCEPT_MAX_PER_CYCLE`
  stays 0; all fail-loud guards preserved.
- **Not in scope:** the "Removed overwrote Accepted" status display (4717847 — correct
  behaviour: the job was pulled from Active after the bot owned it 5.5 min); the Closed-vs-
  Removed key-match audit (separate, only if a job the user still owns is mislabeled).
