# XTM Deadline-Bucketed Capacity + Workload Daily Report — Design

**Date:** 2026-06-28
**Status:** Approved design (post 2 rounds of 3-specialist review) — ready for implementation plan
**Scope:** Cap auto-accept by **words due per deadline day** and rebuild the 09:00 report around **outstanding workload by deadline** — both derived from the single source of truth, the **held list** (`lifecycle_status = 'accepted'`). No new persistent counter. Detection, notification, feasibility, holidays, and the kill-switch are unchanged.

> **Decided (Option A):** a finished job **returns** its deadline-day quota — cap and report both read the held (accepted-but-unfinished) list, so they can never diverge. This removes the meta counter, the rename, the cross-txn atomicity invariant, the deploy-day migration, and meta growth a separate counter would have needed. Trade-off (§5/§9): capacity correctness now depends on the held list being read correctly.

---

## 1. Problem

Two coupled defects in the live accept-schedule gate (PR #7/#8):

1. **Capacity is bucketed by the wrong day.** `state/meta.ts` keys the word counter by the **accept day** and caps "≤ `ACCEPT_MAX_WORDS_PER_DAY` accepted per accept-day". Jobs are auto-accepted 24/7, so a job grabbed Monday 22:00 consumes *Monday's* budget though the work is due (and done) later. The cap does not protect the day the work is actually **due**.
2. **The 09:00 report cannot see night accepts.** It reads `acceptedWordsToday(today)` = today 00:00–09:00 only. A job accepted the previous evening counts under the previous date, whose report already ran, and the counter rolls over at midnight — so its words appear in **no** report. Real deadlines cluster in the evening/night (observed 21:38, 22:58, 02:57), so this is the common case.

**User decision:** the meaningful quantity is **words due per deadline day**. "Accept as much per accept-day as you like — but words *due* on any single deadline day must not exceed the cap." A job that finishes before its deadline frees that day's quota.

## 2. Model — one source of truth: the held list

A job's contribution to capacity/workload is bucketed by the **Bangkok date of its deadline** and lives only while the job is **held** (`lifecycle_status = 'accepted'`). There is **no persistent word counter** — `state/meta.ts` is untouched.

- **`wordsDueOn(deadlineDate)`** ≡ Σ `words` of held jobs whose deadline falls on `deadlineDate`. Exposed as a new typed store method **`XtmJobStore.wordsDueByDeadline(): Map<string, number>`** — one `listByLifecycle('accepted')` scan, grouped in-process by `bangkokDateString(Date.parse(due_date))` (date-parsing stays in the store layer, where the column format lives). The lifecycle row is written atomically by the existing `recordAcceptOutcome`, so this value is always consistent, and a finished job (lifecycle leaves `'accepted'`) drops out, returning its quota.
- **Capacity cap (enforcement):** auto-accept a job only if `wordsDueOn(deadlineDate) + job.words ≤ ACCEPT_MAX_WORDS_PER_DAY`. No limit on words accepted per accept-day.
- **Daily report (visibility):** at 09:00, derived from the same held list.

Why deadline-bucketing from `held` fixes both defects: a job accepted Monday night with a Tuesday deadline is a held job carrying a Tuesday deadline, so it counts against **Tuesday's** cap *and* shows in **Tuesday's** report. Nothing depends on when it was accepted.

## 3. Component A — Cap by deadline day (held-derived)

### Pure capacity helper — `src/schedule/acceptCapacity.ts` (new, unit-tested, coverage-gated)

```ts
export interface CapacityMember { jobKey: string; words: number; deadlineDate: string; } // deadlineDate = bangkokDateString(dueAtMs)
export type GroupCapacityVerdict =
  | { accept: true; subtotalsByDay: Map<string, number> }      // per-deadline-day words to advance the buckets by
  | { accept: false; reason: string; capExhaustedDay?: string }; // capExhaustedDay set only for the "budget filled" case (drives daily_cap_reached)

// Decide a whole bulk group all-or-nothing. `bucketFor(d)` = current (held + optimistically-advanced) words due on day d.
export function decideGroupCapacity(
  members: CapacityMember[],
  bucketFor: (deadlineDate: string) => number,
  cap: number,
): GroupCapacityVerdict;
```

Behaviour: sum the group's `words` **per deadline day** into `subtotalsByDay`; for each day `d` (in deadline order), if `cap > 0 && bucketFor(d) + subtotal(d) > cap`, block the **whole** group (all-or-nothing — the bulk click is irreversible):
- `subtotal(d) > cap` → `group words due <d> (<subtotal>) exceed the daily cap (<cap>) — accept manually` (no `capExhaustedDay`; never clears by waiting).
- otherwise → `daily word cap reached for <d> (<bucket>+<subtotal> > <cap>)` with `capExhaustedDay = d`.

On `accept:true` the helper returns `subtotalsByDay` so the cycle advances **each** day's bucket by **its own** subtotal (never lumps a multi-deadline group's words onto one day).

### `evaluateAcceptSchedule` becomes feasibility-only

Remove the capacity check (today's first check) and its `acceptedWordsToday` / `maxWordsPerDay` inputs from `src/schedule/acceptSchedule.ts`. The evaluator decides only: enabled → deadline-known → words-known → throughput → holidays-curated → non-working-day → deadline-passed → feasibility. `if (!enabled) return {allow:true}` stays **first** (kill-switch, byte-for-byte). Capacity is decided **after** feasibility, in the cycle, so an infeasible job is labelled "can't finish", never "cap reached".

### Cycle wiring — `src/runtime/xtmPollCycle.ts` (preserves the bulk-group all-or-nothing guard)

The existing group loop already binds the first failing member's reason and rejects the **whole** language group. That guard must hold for **both** feasibility and capacity:

- **Per-member feasibility first:** if **any** member of a language group fails `evaluateAcceptSchedule`, the **whole group is blocked** (first-failing-reason in the note) — exactly as today. A bulk click claims the entire language group, so a group is never partially accepted; dropping the infeasible member and accepting its siblings would create an irreversible owned-but-Rejected leak. Only when **every** member is feasible does the group proceed to the capacity decision.
- **Capacity (group-level):** seed `const dueBuckets = wordsDueByDeadline()` **once at cycle start** (before this cycle's `recordAcceptOutcome` writes any `'accepted'` row — otherwise a freshly accepted job is counted in both the seed and the advance). `bucketFor(d)` reads `dueBuckets`, **memoizing 0 on first miss** (it must write the default into the map, not just `?? 0`, so a later optimistic advance is not lost). After a group is accepted, advance `dueBuckets` by the verdict's `subtotalsByDay` (each day by its own subtotal). Multiple groups in one cycle (only when >1 accept-language is configured) thus respect the running buckets.
- A capacity-blocked group → all members `lifecycle 'rejected'` + note; if `capExhaustedDay` set, `raiseAlert('daily_cap_reached', …, dedupKey = 'daily_cap_reached:<day>')` (deduped **per deadline day**).
- **No `meta.addAcceptedWords` / counter call remains** in the accept path.
- **Two held reads per cycle are intentional** and must not be merged: the cycle's pre-accept seed (gate state) and `xtmPollLoop`'s post-accept read for the report (current workload) are different instants.
- A held job whose `dueDate` is null/unparseable (reachable only on the `ACCEPT_SCHEDULE_ENABLED=0` path, §5) is **skipped when seeding** — no `NaN-NaN-NaN` key, no throw.

## 4. Component B — Daily report from the held list (throw-safe)

`src/reporting/dailyReport.ts` — `buildDailyReportCard(held, nowMs, xtmUrl, maxWordsPerDay)` (drops `acceptedWordsToday`). It must be **total — never throw** for any `held` (null/unparseable/NaN deadline, null words, empty list). With `dueAtMs = Date.parse(j.dueDate ?? '')`, `today = bangkokDateString(nowMs)`:

- **Due today (headline)** = `wordsDueOn(today)` — Σ `words` of held jobs whose **deadline date == today** (day-based, so it equals the cap bucket the gate enforces — honest cap context). A null/unparseable-deadline held job is excluded.
- **Overdue** (instant-based, a red flag) = held jobs with finite `dueAtMs < nowMs` — count + Σ words. (Instant, not date: a job due today 02:00, read at 09:00, is genuinely overdue. It is *also* in today's day-based headline — that is correct: it still consumes today's cap. The overdue line is a subset warning, not a separate bucket.)
- **In progress** = held sorted by `dueAtMs` ascending, with a **stable tie-break on `jobKey`** for equal deadlines and non-finite deadlines sorting **last** (`+Infinity`); first 5 rows; overflow row `(+N more)` rendered **only when N > 0**.

Card (cardsV2, English, Bangkok `DD/MM/YYYY HH:mm` via existing `dateFormat`/`chatCard`/`cardText`), header **pinned** `📋 Daily Report — DD/MM/YYYY`:

```
📋 Daily Report — 28/06/2026
Due today:        300 words (cap 1000/day per deadline)   [cap 0 → "300 words (no cap)"]
⚠️ Overdue:        1 job · 300 words                        (row omitted when none)
In progress (top 5 by deadline):
  • ⚠️ 27/06/2026 18:00 — Proj-A · file · 300w              (overdue rows prefixed ⚠️, sorted first)
  • 28/06/2026 18:00 — Proj-B · file · 200w
  • 28/06/2026 18:00 — Proj-C · file · 100w
```

Rows are sliced to the top 5 **before** `buildCard`, so its own 20-row/byte overflow never double-fires.

**Caller — `src/runtime/xtmPollLoop.ts`:** move `listByLifecycle('accepted')` and `buildDailyReportCard(...)` **inside** the existing report `try/catch` (they currently run before it, lines ~349-356). A render or DB-read bug then becomes "no report this cycle, retry next" (meta `lastDailyReportDate` not advanced) — never an outer-catch `heartbeat.fail()` page (Constitution IV). Remove the `meta.acceptedWordsToday(date)` read. `dueDailyReport` (PR #8) is unchanged.

## 5. Edge cases & deliberate choices

- **Finished jobs return quota** (Option A): the held list excludes finished jobs, so both cap and report drop them — the correct "outstanding words due per day" semantics, and strictly *less* prone to over-reject than a monotonic counter.
- **Held-derived couples cap correctness to the held read — the one real risk (over-accept, irreversible direction).** If an accepted job were wrongly read *out* of `'accepted'` (e.g. a transient grid 0-read → mis-disappearance → `'removed'`; cf. the late-XHR bug, [[xtm-grid-loads-via-late-xhr]]), its quota frees early and a later same-deadline job could over-accept. Mitigations already in place: `settleGrid()` prevents the 0-read; the diff engine requires **≥2 consecutive misses** before disappearing a job (no single-read drop); feasibility caps per-job load; the cap is a rarely-hit backstop (0 hits to date). **No hard guard added** — but **monitoring is made concrete** (§9): log `wordsDueOn(d)` at every accept decision so a bucket that dropped then over-filled is auditable.
- **Multi-deadline bulk group:** members bucketed per deadline day; any one day overflowing blocks the whole group. Runbook: one Malay job due a full day blocks all Malay that cycle, including jobs due other days — robustness pass retries next cycle.
- **Null/unparseable deadline:** occurs only on the `ACCEPT_SCHEDULE_ENABLED=0` path. Excluded from the capacity seed (§3) and from Due-today/Overdue; sorts last in In-progress; never bucketed.
- **Cap-hit frequency may rise** vs the "0 hits" history (words concentrate on the night-clustered deadline day). Acceptable (over-reject is recoverable) — monitored.

## 6. Unchanged (explicit non-goals)

`state/meta.ts` and its tests; feasibility (`workingMinutesBetween` × derived throughput); holiday calendar + curation fail-closed; `ACCEPT_SCHEDULE_ENABLED=0` byte-for-byte rollback; detection + notification 24/7; per-accept Chat ✅; **bulk-group all-or-nothing being language-only and covering BOTH feasibility and capacity**; the gate's reject **reasons** (only the capacity check leaves the evaluator — §3). No config/env changes.

## 7. Testing (TDD — `schedule`, `reporting` coverage-gated ≥ 80%; all date tests TZ-explicit `+07:00`, must pass under `TZ=UTC`)

Each test below fails on the old behaviour (discriminating):

1. **Multi-deadline ALLOW (per-accept-day cap is gone):** one cycle, two feasible Malay jobs 800w due Tue (`2026-06-23T18:00+07:00`) + 800w due Wed (`2026-06-24T18:00+07:00`), now Mon `2026-06-22T10:00+07:00` (1600 > cap, each day ≤ cap) → **both accepted**; assert `wordsDueByDeadline()` shows Tue=800, Wed=800 (via the held list, **not** a meta method).
2. **Finished returns quota (A3 — the linchpin) with a negative control:** accept 800w due Tue; **negative control** — a second 800w-due-Tue job in a later cycle is **REJECTED** (800+800 > 1000); then transition the first job `accepted → closed` (via the `closedReader` disappear path) or `removed`; re-run → the second job is now **ACCEPTED** (bucket freed). (There is **no `'finished'` status** — use `closed`/`removed`.)
3. **Cross-deadline all-or-nothing:** Malay X (due Tue, fits) + Y (due Wed, overflows Wed) in one group → **both rejected**, note names `<Wed>`.
4. **Night-accept due-today regression (headline sum):** held job due `2026-06-25T18:00+07:00`, now `2026-06-25T09:00+07:00` → counted in the Due-today **headline number** (not just listed).
5. **Boundary/overdue (TZ):** deadline `…T23:59:00+07:00` → today's bucket; `…T00:00:00+07:00` next day → not; `…T02:00:00+07:00` with now `…T09:00:00+07:00` → **Overdue** (instant) **and** in today's day-based headline.
6. **Report robustness + total:** Overdue row present iff an overdue held job exists (else omitted); a held job with `dueDate='not-a-date'` (unparseable, non-null) and `words=null` → **no throw**, card emitted, job excluded from sums and sorted **last**; In-progress top-5 with `(+N more)` only when N>0 (assert at 5 vs 6 jobs); equal deadlines tie-break stably on jobKey (deterministic cut); `cap=0` → headline "(no cap)".
7. **Report-build throw must not page (A6):** in a `dueDailyReport→true` cycle, force `buildDailyReportCard`/`listByLifecycle` to throw → cycle returns normally, `heartbeat.fail()` **not** called, detection result still produced, `lastDailyReportDate` **not** advanced.
8. **Capacity seed skips null-deadline held (accept path, A2):** pre-seed an accepted null-deadline held job (gate-off path) + accept a feasible Malay job → cycle does **not** throw, capacity counts only real-deadline held words.
9. **`acceptCapacity` unit tests (every branch):** fits; `subtotal>cap` (exceed/manual, no `capExhaustedDay`); `bucket+subtotal>cap`, `subtotal≤cap` (filling, `capExhaustedDay` set); `cap=0` ⇒ no limit; multi-day group returns correct `subtotalsByDay`.
10. **`daily_cap_reached` per deadline day:** two different deadline days overflowing → **two** alerts (dedup `:<day>`).
11. **`evaluateAcceptSchedule` after capacity removed:** delete the old `acceptedWordsToday`/`maxWordsPerDay` cap-ordering tests (`acceptSchedule.test.ts:43-48,143-156` won't typecheck); re-pin feasibility-only ordering; `enabled=false` still allows first.

## 8. Acceptance criteria

| # | Criterion |
|---|---|
| A1 | Capacity is bucketed by **deadline date** from the held list; a job accepted 22:00 with next-day 18:00 deadline counts in the **deadline day's** bucket, not the accept day's. |
| A2 | Auto-accept is blocked iff `wordsDueOn(deadlineDate) + job.words > cap`; **no** per-accept-day limit; a null-deadline held job never breaks the seed. |
| A3 | A finished (`closed`/`removed`) job's words **leave** its deadline-day bucket (a blocked same-deadline job becomes acceptable; proven against a negative control). |
| A4 | A bulk (language) group is all-or-nothing across **both** feasibility and capacity; any single deadline day overflowing — or any infeasible member — blocks the whole group. |
| A5 | The 09:00 report's Due-today headline includes a previous-night accept due today; Overdue is instant-based; In progress is deadline-sorted (stable), top 5, "+N more" only when N>0. |
| A6 | `buildDailyReportCard` never throws for any held input; the report build runs inside the loop's try/catch (a report bug does not page on-call). |
| A7 | `ACCEPT_SCHEDULE_ENABLED=0` still disables the whole gate; feasibility/holiday/kill-switch unchanged. |
| A8 | Full suite green incl. `TZ=UTC`; lint + typecheck clean; coverage ≥ 80% on detection/state/reporting/schedule. |

## 9. Sequencing & complexity tracking

- **Sequencing:** Component B (report from held) is independently testable and near-zero gate risk — implement and verify it first (it alone fixes night-visibility), then Component A. One PR with B's commits first, or two PRs.
- **Held-read → over-accept coupling (§5)** — the one residual risk of held-derived. **Action:** cross-ref [[xtm-grid-loads-via-late-xhr]] in the implementation; **log `wordsDueOn(deadlineDate)` at each accept decision** (concrete audit trail); rely on settleGrid + the 2-miss disappear rule + feasibility + the rarely-hit cap as the safety net. Revisit a "don't free quota until disappearance is stable" guard only if monitoring shows a real over-accept.
- **Cap-hit rate may rise (§5)** — monitor; revisit only if good jobs get rejected.
- **`evaluateAcceptSchedule` signature change** (drops capacity inputs) + the new `XtmJobStore.wordsDueByDeadline()` — touch the gate call site + tests; intentional (capacity lives in the pure `acceptCapacity` helper, date-parse lives in the store).
- **Two held reads per cycle** (pre-accept seed, post-accept report) are intentional and annotated — must not be collapsed into one snapshot.
