# Effective-Deadline-Day Capacity Bucketing (the "cutoff" fix) — Design

**Date:** 2026-06-30
**Status:** Approved design — ready for implementation
**Scope:** Bucket the auto-accept capacity by the **working day the work actually lands on** (the "effective deadline day"), not the raw deadline calendar date. Feasibility, the accepted metric (raw words — WWC switch is a separate, deferred change), the cap threshold, all-or-nothing, the held-lock, and the kill-switch are unchanged.

---

## 1. Problem

The capacity cap buckets a held job by `bangkokDateString(Date.parse(dueDate))` — the **raw deadline calendar date**. But a deadline whose Bangkok time falls **before the work-day starts (09:00)** cannot be worked on that calendar date — the team must finish it the **previous working day**. So the per-deadline-day bucket under-counts the real same-day workload.

Observed live (2026-06-30): two Malay projects accepted on 30/06 —
- Basecamp 4721900: 858 words, DL 30/06 22:51 → bucket[30/06] = 858.
- STARTRADER 4721408: 381 words, DL **01/07 06:33** (before 09:00) → bucket[**01/07**] = 381.

Each bucket ≤ 1000 → both accepted. But STARTRADER's 06:33 deadline means its work is really done on **30/06**, so 30/06's true load is **858 + 377 = 1235 > 1000**. The cap missed it because it bucketed by the raw calendar date (01/07) instead of the work-day (30/06).

**Feasibility is already correct** — `workingMinutesBetween(now, DL)` counts 0 working minutes on 01/07 before 09:00 and includes 30/06's hours, so it knows the work is 30/06's. Only the **capacity bucket key** is misaligned with that.

## 2. Model — the effective deadline day

A new pure helper computes the Bangkok date the work lands on:

`effectiveDeadlineDay(dueMs: number, hoursStartMin: number, workdays: ReadonlySet<number>, holidays: ReadonlyMap<string,string>): string`

Rule (reuses `bangkokCalendar` + `isNonWorkingDay`):
- Let `cal = bangkokCalendar(dueMs)`.
- If `cal.date` **is a working day** AND `cal.minutesOfDay >= hoursStartMin` (deadline is at/after the work-day start) → return `cal.date` (the work lands that day; this covers a same-day after-hours deadline like 22:51, which is still that day's work).
- Otherwise (deadline before the work-day start, or on a non-working day) → walk back day-by-day to the **previous working day** and return its date (its 18:00 is the last working minute at/before the deadline). Bound the walk (≤ 400 iterations, mirroring `workingMinutesBetween`).

For STARTRADER's 01/07 06:33 → 06:33 < 09:00 → previous working day = **30/06**. For Basecamp's 30/06 22:51 → 22:51 ≥ 09:00 → **30/06**. Both bucket to 30/06 → 30/06 = 1235 > 1000 → the second group is correctly blocked.

## 3. Where it applies

- **Capacity seed** (`XtmJobStore.wordsDueByDeadline`): bucket held jobs by `effectiveDeadlineDay` instead of the raw date. The store lacks the work-calendar config, so inject the day-mapper: change `wordsDueByDeadline(dayOf: (dueDate: string|null) => string|null)` (the cycle passes a closure built from `cfg`), keeping its existing `heldJobsMissingDeadline` reporting. (Keep the null-deadline skip + the fail-loud alert from the prior fix.)
- **Cycle per-member bucket key** (`xtmPollCycle` `deadlineDateOf`): use `effectiveDeadlineDay` (built from `cfg.hoursStartMin`/`cfg.workdays` + the resolved holidays). `decideGroupCapacity`, the `daily_cap_reached` dedup key, and `acceptedDueDays` automatically follow (they consume whatever day string they're given).
- **Daily report "Due today"** (`dailyReport.buildDailyReportCard`): bucket by `effectiveDeadlineDay` too, so the report's headline matches the cap. Thread the work-calendar (or the same day-mapper) in from the loop's `cfg`. Note: a job due tomorrow-early-morning (before 09:00) now appears in **today's** "Due today" — correct, its work is today.

## 4. Unchanged (explicit non-goals)

Feasibility (`workingMinutesBetween` — already work-day-aware); the metric is still **raw words** (the WWC switch is a separate deferred change); `ACCEPT_MAX_WORDS_PER_DAY` and the derived throughput; bulk-group all-or-nothing across feasibility+capacity; the held-job field lock; `ACCEPT_SCHEDULE_ENABLED=0` kill-switch; the non-working-day deadline rejection (still rejects DLs on weekends/holidays before this even matters).

## 5. Edge cases

- A deadline that rolls back across a weekend/holiday (e.g. Monday 06:00 → previous **Friday**) — the back-walk skips non-working days. Bounded.
- A deadline exactly at 09:00 (`minutesOfDay === hoursStartMin`) → the **previous working day**. The cutoff is **strictly greater** (`minutesOfDay > hoursStartMin`), not `>=`: a 09:00 deadline has **0 working minutes** available on its own day — `workingMinutesBetween(now, 09:00)` overlaps `[09:00,18:00]` with `[..,09:00]` = 0 — so the work lands the prior working day, exactly as feasibility already allocates it. Bucketing it on its own day (0 working minutes) while feasibility puts the work on the prior day would under-count the prior day → silent over-accept past the cap (the irreversible direction). `09:01` (1 working minute) stays its own day.
- A null/unparseable deadline → unchanged (the gate rejects it when ON; the seed skips + alerts per the prior fix). `effectiveDeadlineDay` is only called for parseable deadlines.

## 6. Testing (TDD; `schedule`/`state`/`reporting` coverage-gated ≥80%; TZ-explicit `+07:00`, pass under `TZ=UTC`)

- **Helper:** before-09:00 deadline rolls to the previous working day; exactly-09:00 rolls to the previous working day (0 working minutes available); 09:01 stays same day (1 working minute); after-18:00 (22:51) stays same day; a Monday-06:00 deadline rolls to the previous **Friday** (across the weekend); a Tuesday-14:00 deadline stays. An all-non-working calendar throws (fail-loud).
- **Cycle (the live regression):** two Malay groups, one due 30/06 22:51 (858w) + one due 01/07 06:33 (377w), `now` on 30/06 → both effective-bucket to 30/06 → combined 1235 > cap 1000 → the second group is **rejected** (it is accepted today). And the inverse: a genuinely-next-working-day deadline (e.g. 01/07 14:00) buckets to 01/07 (its own day), not 30/06.
- **Report:** a held job due tomorrow 06:00 (before 09:00) appears in today's "Due today" sum; a held job due tomorrow 14:00 does not.

## 7. Risk

Low-surface, pure-helper change. The only behavioural change is the bucket **key**; it can only make the cap **stricter** (jobs that previously fit a too-loose split-day bucket now correctly share a work-day bucket) — the safe direction (over-reject is recoverable). Monitor cap-hit rate after rollout.
