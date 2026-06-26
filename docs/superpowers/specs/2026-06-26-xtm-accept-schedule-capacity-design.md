# XTM Accept Scheduling, Daily Word Capacity & Deadline-Feasibility Override — Design

**Status:** design v1 (brainstormed 2026-06-26)
**Feature area:** auto-accept gating (`src/detection/`, `src/state/`, new `src/schedule/`, `src/runtime/xtmPollCycle.ts`, `src/config/`)
**Builds on:** the live 002 auto-accept pipeline (detect → decide → accept → record) and the auto-yield precedent (config flag + injected clock + meta accessors).

---

## 1. Problem & Goal

The bot auto-accepts eligible Malay jobs 24/7 the moment they appear. The team
wants to **bound when and how much** the bot accepts:

1. **Work-hours window** — only auto-accept during business hours (09:00–18:00).
2. **Daily word capacity** — stop auto-accepting once a cumulative **word**
   budget for the day is reached (default 1000 words/day).
3. **No weekends** — never auto-accept on Saturday/Sunday.
4. **No Thai public holidays** — never auto-accept on นักขัตฤกษ์ไทย.
5. **Deadline-feasibility override** — an *urgent* job whose deadline is close
   enough that the team can still finish it (given throughput) is accepted even
   when the schedule would otherwise block it (e.g. a Sunday job due Monday).

**Non-goals (unchanged behavior):** Detection and Google Chat notification run
24/7 exactly as today. Gating applies **only to the accept click**. A blocked
job is **notify-only**: logged + a Chat card stating *why* it was not accepted,
so a human can grab it manually. Sheets logging is unchanged.

---

## 2. Core Behavior

For each eligible Malay job the cycle would otherwise auto-accept, a **schedule
gate** decides `accept` vs `block`:

- **accept** → the existing bulk-accept path runs unchanged.
- **block** → the job is **not** clicked. It **must still be logged to the
  Google Sheet exactly as today**, with **Status = `Rejected`** and the reason in
  the **Note** column. Internally `lifecycleStatus = 'rejected'` (a new status →
  Sheet `Rejected`), distinct from `'skipped'` (non-Malay) and `'new'`. A Chat
  card is also sent with the reason. `accept_status` stays `'none'`, so if the
  job is still present in a later in-window cycle the existing robustness pass
  will accept it then (free, natural deferral — no extra deferral logic), and the
  Sheet row transitions `Rejected → Accepted`.

The `Rejected` row is written when the block is decided (the first-seen blocking
event reports Sheet + Chat once). A still-present, still-off-schedule job in
subsequent cycles is re-evaluated silently by the robustness pass (no event → no
duplicate Sheet/Chat). If it is never accepted and eventually leaves Active, the
existing missing/closed/removed handling applies.

The gate is a refinement of the **accept** decision only. It runs **after** the
existing `decideAccept()` returns `accept`; jobs that are non-eligible, hit a
per-job/per-cycle cap, or have auto-accept disabled are handled exactly as today
and never reach the schedule gate.

### 2.1 Decision flow (per job that `decideAccept()` says to accept)

```
evaluateAcceptSchedule(input):
  if !XTM_SCHEDULE_ENABLED          → ALLOW            (byte-for-byte today's behavior)

  # (1) Daily word capacity — HARD limit, never overridden by urgency
  if maxWordsPerDay > 0 and acceptedWordsToday >= maxWordsPerDay
                                    → BLOCK "daily word cap reached (N/1000)"

  # (2) In schedule? working day AND inside the hours window
  isWorkingDay = (weekday ∈ workdays) AND (date ∉ holidays)
  inHours      = hoursStartMin <= minutesOfDay < hoursEndMin
  if isWorkingDay and inHours       → ALLOW

  # (3) Off-schedule → only an urgent, still-doable job is rescued
  if feasibleByDeadline(now, dueAt, words, throughput)
                                    → ALLOW            (urgent + can finish in time)

  # (4) Otherwise blocked with the most specific reason
  reason = holidayName ? "Thai holiday (<name>)"
         : (weekday ∉ workdays) ? "weekend"
         : "outside work hours"
  → BLOCK reason + " — not urgent enough to accept off-schedule"
```

### 2.2 Feasibility (the urgency override)

```
feasibleByDeadline(nowMs, dueAtMs, words, throughputWordsPerHour):
  if dueAtMs is null    → false      # deadline unknown/unparseable → no override
  if words   is null    → false      # word count unknown → cannot judge → no override
  hoursRemaining = (dueAtMs - nowMs) / 3_600_000
  if hoursRemaining <= 0 → false     # already due / past → cannot make it
  return hoursRemaining * throughputWordsPerHour >= words
```

- **time-basis = raw clock hours** (deterministic, simple; the Sunday→Monday
  example qualifies). Working-hours-only accounting is a deliberate non-goal.
- `dueAtMs` is parsed by the **caller** from `XtmJobState.dueDate` (the
  parser-produced ISO). When `dueDate` is null the override is unavailable — we
  do not re-parse `dueRaw` or guess (consistent with the project's
  "never accept on uncertainty" rule; a blocked job is still notified, so a
  human can act).

### 2.3 Worked truth table (XTM_SCHEDULE_ENABLED=1, hours 09:00–18:00, cap 1000, throughput 125)

| now (Bangkok) | dueDate | words | acceptedWordsToday | verdict | reason |
|---|---|---|---|---|---|
| Mon 10:00 | any | any | 0 | ALLOW | in window |
| Mon 10:00 | any | 300 | 1000 | BLOCK | daily word cap reached (1000/1000) |
| Sat 10:00 | Mon 18:00 (~56h) | 500 | 0 | ALLOW | off-schedule but feasible (56×125=7000 ≥ 500) |
| Sun 14:00 | Mon 12:00 (~22h) | 500 | 0 | ALLOW | feasible (22×125=2750 ≥ 500) |
| Sun 14:00 | Wed 18:00 | 9000 | 0 | ALLOW | feasible (76×125=9500 ≥ 9000) |
| Sun 14:00 | Mon 12:00 (~22h) | 5000 | 0 | BLOCK | weekend — infeasible (2750 < 5000) |
| Mon 20:00 | Tue 18:00 (~22h) | 1000 | 0 | ALLOW | off-hours but feasible |
| Mon 20:00 | (null) | 1000 | 0 | BLOCK | outside work hours (no override, due unknown) |
| Songkran 10:00 | next-day | 100 | 0 | ALLOW (if feasible) / else BLOCK "Thai holiday (Songkran)" | holiday |

---

## 3. Module Map

New module `src/schedule/` — pure, isolated, independently testable.

| File | Responsibility | Pure? |
|---|---|---|
| `src/schedule/bangkokCalendar.ts` | `bangkokCalendar(epochMs) → { date:'YYYY-MM-DD', weekday:1..7 (ISO, Mon=1), minutesOfDay:0..1439 }`. `bangkokDateString(epochMs)`, `bangkokYear(epochMs)`. Implemented by `new Date(ms + 7*3_600_000)` then reading **UTC** parts (same +07 trick as `reporting/dateFormat.ts`); ISO weekday = `((getUTCDay()+6)%7)+1`. | ✅ |
| `src/schedule/parseSchedule.ts` | `parseHHMM('09:00') → 540` (minutes); `parseWorkdays('1-5') → Set<number>` (ranges and comma lists; ISO 1..7). Used by config validation + transform. | ✅ |
| `src/schedule/thaiHolidayOverrides.ts` | Static override data: `{ [year:string]: { [date:'YYYY-MM-DD']: name } }`. Seeded with 2026 cabinet-declared / special days. Hand-maintained, git-reviewed. | ✅ (data) |
| `src/schedule/thaiHolidays.ts` | `getThaiHolidays(year) → { holidays: Map<'YYYY-MM-DD', name>, dataMissing: boolean }` = `date-holidays`('TH') public holidays for the year ∪ override entries (override adds/wins). `dataMissing = true` when the library yields nothing for the year AND there is no override. Per-year memoized. Library errors are caught → treated as empty (`dataMissing` reflects the merged result). | ผสม |
| `src/schedule/acceptSchedule.ts` | `evaluateAcceptSchedule(input) → { allow:true } \| { allow:false, reason }` implementing §2.1. Internals: `feasibleByDeadline`, window/working-day checks. Calls `bangkokCalendar` internally; takes the year's `holidays` map as input. | ✅ |

Changed files:

| File | Change |
|---|---|
| `src/detection/types.ts` | Add `'rejected'` to `XtmLifecycleStatus`. |
| `src/reporting/sheets.ts` | Add `'Rejected'` to `SheetStatus`; map `rejected → 'Rejected'` in `lifecycleToSheetStatus`. |
| `src/state/meta.ts` | Daily word counter: `acceptedWordsToday(dateStr)`, `addAcceptedWords(dateStr, n)` (reset-on-date-change, one txn). Keys `accepted_words_date`, `accepted_words_count`. |
| `src/config/index.ts` | New env vars + zod validation + `.refine` (see §4). |
| `src/runtime/xtmPollCycle.ts` | Resolve holidays + read `acceptedWordsToday` once per cycle; apply the gate at both accept sites (first-seen + robustness); track optimistic in-cycle words; on confirmed accept `addAcceptedWords`; on block set `lifecycleStatus='rejected'` + reason note (Sheet row written like today); new summary counter `scheduleBlocked`; raise `holiday_data_missing` alert (deduped) when `dataMissing`. |
| `src/reporting/xtmNotifier.ts` | `renderXtmNewJob` note variants: in-window "accepting", schedule-blocked "Rejected — <reason>", existing "auto-accept off" / "Not Malay" preserved. |
| `src/reporting/systemAlerts.ts` | New `TriggerKind` `holiday_data_missing` (severity warn, `hasRecovered:true`). |
| `package.json` | add dependency `date-holidays`. |

`evaluateAcceptSchedule` stays **pure** and decoupled from the DB/outbox: the
cycle resolves holidays and the running word count and passes them in. The
`holiday_data_missing` alert is raised by the cycle (which owns the outbox), not
by the pure evaluator.

### 3.1 `AcceptScheduleInput` (interface)

```ts
interface AcceptScheduleInput {
  enabled: boolean;             // XTM_SCHEDULE_ENABLED
  nowMs: number;                // Date.parse(snapshot.capturedAt) — snapshot-driven, deterministic
  dueAtMs: number | null;       // caller: s.dueDate ? Date.parse(s.dueDate) : null (NaN → null)
  words: number | null;         // s.words
  acceptedWordsToday: number;   // persisted today + optimistic in-cycle running total
  maxWordsPerDay: number;       // 0 = unlimited
  hoursStartMin: number;        // parsed minutes, e.g. 540
  hoursEndMin: number;          // parsed minutes, e.g. 1080
  workdays: Set<number>;        // ISO 1..7
  throughputWordsPerHour: number;
  holidays: Map<string, string>; // date 'YYYY-MM-DD' → holiday name (the current year)
}
type AcceptScheduleVerdict = { allow: true } | { allow: false; reason: string };
```

---

## 4. Config (new env vars; safe defaults in `.env.example`)

| Var | Default | Notes |
|---|---|---|
| `XTM_SCHEDULE_ENABLED` | **ON** | Master switch. `0`/`false`/`off`/`no` → disabled (identical to the yield kill-switch parsing). Disabled = today's behavior exactly. |
| `XTM_ACCEPT_HOURS_START` | `09:00` | `HH:MM` 24h. Validated `^([01]\d\|2[0-3]):[0-5]\d$`. |
| `XTM_ACCEPT_HOURS_END` | `18:00` | `HH:MM`. End is **exclusive** (last accept minute is 17:59). |
| `XTM_ACCEPT_WORKDAYS` | `1-5` | ISO weekdays (Mon=1..Sun=7). Ranges (`1-5`) and lists (`1,2,3`) supported. |
| `XTM_ACCEPT_MAX_WORDS_PER_DAY` | `1000` | Cumulative **words** of confirmed accepts per Bangkok day. `0` = unlimited. |
| `XTM_THROUGHPUT_WORDS_PER_HOUR` | `125` | Team throughput for the feasibility override. Must be > 0. |

Holidays come from the library + override file (no env var for the list).

**zod `.refine` (only enforced when `XTM_SCHEDULE_ENABLED`)** — mirrors the
yield-flag precedent so an operator can always disable the feature without first
fixing an unrelated value:
- `parseHHMM(start) < parseHHMM(end)` — else error on `XTM_ACCEPT_HOURS_END`.
- `XTM_THROUGHPUT_WORDS_PER_HOUR > 0` (zod `.positive()` independent of enabled).
- `HH:MM` format + workdays parse validated at the field level (fail-fast at
  startup, naming the offending var).

---

## 5. Capacity Counting Semantics

- The persisted daily counter (`meta`) is incremented by `job.words` **only on a
  confirmed accept** (`outcome === 'accepted'`), keyed to the **Bangkok** date;
  it resets when the date rolls (a read/write for a new date starts from 0).
- Within one cycle, an **optimistic** running total of queued-candidate words is
  added to `acceptedWordsToday` for the gate, so multiple accepts in the same
  cycle respect the cap. A candidate that later fails/misses simply over-counted
  optimistically for that cycle — strictly more conservative (may block one
  borderline job early), never a silent over-accept.
- `words === null` contributes **0** to the budget (consistent with the existing
  per-job `ACCEPT_MAX_WORDS` "never skip on uncertainty" rule).
- Block condition is `acceptedWordsToday >= cap` (cap reached). Because the
  portal's bulk action grabs the whole language group in one click, a single
  accept can **overshoot** the cap by one group — accepted and documented, the
  same constraint already noted for `ACCEPT_MAX_PER_CYCLE` (see
  `acceptDecision.ts`). This is why the cap is a soft *pre-gate*, not a
  mid-group stop.

---

## 6. Failure Modes (fail-loud, Constitution IV/V)

| Condition | Handling |
|---|---|
| Holiday year missing (`dataMissing`) | Cycle raises `holiday_data_missing` system alert (deduped standing alert, like other alerts) → **fail-open**: weekdays still work, only holiday-skipping is unavailable until the override/library is updated. Avoids the bot going fully dark because next year's holidays were not added. |
| `date-holidays` throws / unavailable | Caught in `getThaiHolidays` → treated as empty; `dataMissing` then reflects whether an override exists. Never crashes the cycle (Constitution IV). |
| Bad `HH:MM`, `start >= end`, `throughput <= 0`, bad workdays | **fail-fast at startup** via zod, message names the var (config never silently wrong). |
| `dueDate` null/unparseable | No feasibility override → off-schedule job is blocked (notify-only). Never throws. |
| `words` null | No feasibility override (cannot compute) + counts 0 toward capacity. |
| Clock/parse anomaly on `capturedAt` | `nowMs = Date.parse(capturedAt)`; if NaN the cycle already fails its normal path — the gate is not reached with a NaN now. |

---

## 7. Testing (TDD; coverage gate ≥ 80% for detection/state; `src/schedule` new)

Write tests first, watch them fail, then implement (Constitution).

- **bangkokCalendar** — UTC inputs that cross the Bangkok midnight boundary (the
  CI-runs-UTC trap: use TZ-explicit ISO inputs, reproduce with `TZ=UTC`); ISO
  weekday mapping (Sun→7), minutesOfDay at 00:00/23:59, year rollover.
- **parseSchedule** — `parseHHMM` valid/invalid; `parseWorkdays` ranges, lists,
  single, out-of-range rejected.
- **thaiHolidays** — library hit for a known 2026 standard holiday; override
  merge (override-only date appears; override name wins); `dataMissing` true for
  a far-future year with no override; library-throw caught.
- **acceptSchedule** — the full §2.3 truth table: in-window allow; cap reached
  block; weekend/holiday/off-hours block; feasibility allow vs infeasible block;
  boundary minutes (08:59 block / 09:00 allow / 17:59 allow / 18:00 block);
  disabled → always allow; null due / null words → no override; deadline already
  passed → infeasible.
- **meta** — counter increments; reset on new Bangkok date; persistence across a
  fresh `MetaStore` (restart) for the same date.
- **xtmPollCycle integration** (stubbed acceptor) — a schedule-blocked eligible
  job: not accepted, `lifecycleStatus='rejected'` → Sheet row enqueued with
  Status `Rejected` + reason in Note, Chat card carries the reason,
  `accept_status` stays `'none'`, counter unchanged; an accepted job: counter +=
  words; cap reached mid-cycle blocks the next candidate; urgent off-hours job is
  accepted; a job rejected off-hours then still present in-window is accepted by
  the robustness pass (`Rejected → Accepted`); `XTM_SCHEDULE_ENABLED=0` path is
  byte-for-byte the pre-feature behavior.
- **config** — defaults; kill-switch literals; refine rejects `start>=end` and
  `throughput<=0` only when enabled; HH:MM/workday parse failures named.

---

## 8. Rollout

- Ships **default ON** (the requested behavior). `XTM_SCHEDULE_ENABLED=0` is the
  one-line rollback.
- `ACCEPT_MAX_PER_CYCLE` stays `0` (untouched — the bulk-accept invariant).
- After deploy: watch a cycle log for `scheduleBlocked` counts and confirm an
  in-hours Malay job still accepts; confirm the `.env` values; confirm the daily
  word counter resets at Bangkok midnight.
- Verify the 2026 Thai holiday override list before enabling holiday-skipping in
  production.

---

## 9. Open / Deferred (YAGNI)

- Working-hours-based feasibility accounting (vs raw clock hours) — deferred.
- Per-weekday different hours — deferred (single window).
- Showing "accepted X/1000 words today" in the 09:00 daily report — optional,
  not in this scope.
- A general "don't accept jobs we can't finish even in-hours" feasibility gate —
  out of scope; feasibility is the off-schedule override only.
