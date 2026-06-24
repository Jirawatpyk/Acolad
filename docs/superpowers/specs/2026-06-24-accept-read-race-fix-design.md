# Accept-flow grid-read race fix — Design

**Date:** 2026-06-24
**Status:** Approved (brainstorming) — ready for writing-plans
**Feature:** 002-xtm-detect-accept (bug fix)

## Problem

On 2026-06-23/24 eight Malay (eligible) jobs arrived; the bot **detected and
logged all eight** to Sheets/Chat but **accepted only ~3** and lost ~5. The user
confirmed every job stayed available **> 2 minutes** (not snatched in seconds).

Evidence chain (from logs + DIAG + SQLite `jobs` table):

- All 8 jobs `eligible = 1` (Malay (Malaysia)); none were non-Malay → not a
  Malay-only-rule skip.
- The lost jobs (e.g. 4717761, 4717828, 4717469) have lifecycle `missing`,
  `accepted:0`, **no `accept_failed` alert, and no `action:"accept"` log** — the
  bot never completed a click.
- `decideAccept` returns `{action:'accept'}` for them (Malay + ACCEPT_ENABLED=1 +
  ACCEPT_MAX_PER_CYCLE=0) — the bot **did decide to accept**.
- Job 4717761: detected 22:06:32 (`jobs:4`), the accept-flow re-read 3 s later
  read `jobs:2` (job "gone"), yet a fresh detection at 22:06:58 logged it **again**
  → the job was **still present the whole time**; the 22:06:37 read **raced** and
  missed its row.
- Worse with an owned Malay job in the same language group: `4717562` was accepted
  20:42 and stayed in Active ("Finish task"); the four jobs lost between 21:15–22:47
  all arrived **while it was owned**, the ones accepted (20:42, 03:20, 06:58)
  arrived when no owned Malay row competed.

## Root cause

A **grid-read race in the accept flow** (NOT in detection — detection uses
`settleGrid` and read all 8 correctly):

1. `openBulkAcceptForLanguage` (`xtmAccept.ts`) **scans the live grid** for a row
   still showing "Accept task". When the grid is mid-render (the AngularJS data XHR
   re-rendered a **partial** row set), the new job's row is absent → the scan sees
   only the owned row ("Finish task") → returns `'already-owned'` → **no click**.
2. The FR-024 post-accept **re-read** (`reReadActive`) then also sees the partial
   grid → the target is absent → `determineAcceptOutcomes` returns `'missing'`.
3. `missing` resets `accept_status` to `'none'`, so the robustness pass **re-attempts
   next cycle** — but the same race recurs every cycle until the job genuinely leaves
   → final lifecycle `missing`, never accepted.

The existing guard only catches a **wholesale-empty** re-read (`reRead.length === 0`,
xtmAccept.ts:145). A **partial** race (some rows present, the target's row missing) is
**not** guarded → false `missing`. An owned Malay row in the list widens the window:
the scan opens its menu first (~1–2 s) before reaching the new job, giving the
partial-render race more time to bite.

## Fix: row-count stability gate (`settleRows`)

Make the accept-flow reads operate on a **fully-rendered** grid by waiting for the
data-row count to **stabilise** before reading — closing the partial-render window
that both the scan and the re-read fall into.

### Component: `settleRows(scope, opts)` (new, `src/portal/xtmClient.ts`)

After the existing `settleGrid` (networkidle), poll the kebab-data-row count and
return once it is **stable across 2 consecutive samples** (~300 ms apart) or a hard
cap (~4 s) elapses — whichever first. Pure timing/observation only; **issues no
portal request** (FR-011 safe). Bounded so it can never block the cycle.

The stability decision is extracted as a **pure function** for unit testing:

```
isRowCountStable(samples: number[], required: number): boolean
  // true once the last `required` samples are all equal (and ≥ 1 sample taken)
```

`settleRows` samples `scope.locator('<gridContainer> tbody tr')` rows that carry the
per-row kebab (the same data-row predicate the parser uses), feeds the counts to
`isRowCountStable`, and resolves when stable or capped.

### Wiring — two call sites

1. **Before the accept scan** — call `settleRows` on the frame before
   `openBulkAcceptForLanguage` scans, so it sees the new job's "Accept task" row and
   clicks the bulk option.
2. **In the FR-024 re-read** — `reReadActive` calls `settleRows` after `settleGrid`
   and before `readActiveSnapshot`, so the outcome is judged on the full grid →
   `accepted` confirmed (owned row present), never a false `missing`.

No change to `decideAccept`, `determineAcceptOutcomes`, the diff, or the detection
read — the fix is localised to the accept-flow's two reads.

## Data flow (accept cycle, after fix)

```
cycle read snapshot (settleGrid)            → Malay job J detected + claimed
acceptEligibleTasks([J]):
  settleRows(frame)        ← NEW: wait for full render
  openBulkAcceptForLanguage("Malay (Malaysia)")
     scan → finds J's "Accept task" row     → hover → click bulk → 'clicked'
  reReadActive():
     navigate + settleGrid + settleRows      ← NEW
     readActiveSnapshot                       → J present, menu shows "Finish task"
  determineAcceptOutcomes([J], reRead)        → J acceptAvailable=false → 'accepted'
record outcome 'accepted'                     → lifecycle accepted, Chat ✅
```

## Error handling

- `settleRows` is **bounded** (~4 s cap). If the count never stabilises (busy
  network / unusual render), it returns the last observed state and the read
  proceeds — the existing empty-re-read guard (→ `failed`, re-checkable) and the
  robustness re-attempt remain the safety net. Never blocks the cycle.
- A `settleRows` cap-hit is **logged** (loud, like `settleGrid`'s timeout) so a
  changed render profile is diagnosable, not silent (Constitution VI).

## Testing

- **Unit (TDD, pure):** `isRowCountStable` — empty samples, single sample, not-yet-
  stable (counts still changing), stable (last N equal), stable-after-fluctuation.
  This is the load-bearing logic and is fully unit-testable without a browser.
- **Integration (fixture):** none reliably reproduces a *timing* race with static
  HTML (same limitation as the original `settleGrid` race) — covered by ops below.
- **Ops verify (DIAG, already enabled):** after deploy, the next live Malay jobs must
  accept on the **first** attempt — confirmed by an `action:"accept","outcome":"ok"`
  log per job and a DIAG capture showing the full grid (jobsRead matching the visible
  rows) at accept time. Turn DIAG off once confirmed.

## Constraints / non-goals

- **FR-011 (rate):** `settleRows` observes the already-loaded DOM — zero extra portal
  requests. Poll interval stays ≥ 20 s.
- **Do not touch the detection read** — it already works (all 8 detected); only the
  accept-flow reads change.
- **Live shared account:** the change is additive (a wait before two reads) and
  preserves all existing fail-loud guards; `ACCEPT_MAX_PER_CYCLE` stays 0.
- **Not in scope:** speeding up the menu-scan by avoiding owned-row menu opens (D6:
  ownership isn't in the grid cells, so each Malay row's menu must be opened) — the
  stability gate makes the scan reliable, which is what matters; raw speed is moot
  because jobs stay > 2 min.
