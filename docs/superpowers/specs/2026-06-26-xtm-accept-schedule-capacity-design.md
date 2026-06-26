# XTM Accept: Working-Hours Feasibility + Daily Word Capacity — Design

**Status:** design v2 (brainstormed 2026-06-26 — model revised to working-hours feasibility)
**Feature area:** auto-accept gating (`src/detection/`, `src/state/`, new `src/schedule/`, `src/runtime/xtmPollCycle.ts`, `src/config/`)
**Builds on:** the live 002 auto-accept pipeline (detect → decide → accept → record) and the auto-yield precedent (config flag + injected clock + meta accessors).

---

## 1. Problem & Goal

The bot auto-accepts eligible Malay jobs 24/7 the moment they appear. The team
wants the bot to accept **only work it can actually deliver**, bounded by daily
volume. One coherent rule:

> **Accept a job only if the team can FINISH it within its available working
> hours before the deadline — and the day's word budget is not yet spent.**

This yields the team's requirements as consequences of one model:

1. **Work-hours window** (09:00–18:00) and **no weekends / no Thai holidays** —
   these define *when work happens*. Non-working time simply contributes **zero**
   working hours to the feasibility calculation, so a job that can't be finished
   in the available working time is not accepted.
2. **Deadline on a non-working day** (weekend or Thai holiday) → **not accepted**
   (the deadline can't be met on a day nobody works).
3. **Daily word capacity** — stop accepting once a cumulative **word** budget for
   the day is reached (default 1000 words/day, a hard cap). This is the single
   business knob; it is config-adjustable for future increases.
4. **Throughput is derived from capacity** — `dailyCapacity ÷ working-hours-per-day`
   — so raising the capacity automatically scales the rate (no second knob to keep
   in sync). With the defaults: `1000 ÷ 9h ≈ 111 words/hour`. An explicit
   `XTM_THROUGHPUT_WORDS_PER_HOUR` may override the derived value. Throughput
   converts a job's word count into the working time it needs, and keeps the model
   self-consistent: a `capacity`-word job needs exactly one full working day.

**Non-goals (unchanged behavior):** Detection and Google Chat notification run
24/7 exactly as today. Gating applies **only to the accept click**. A blocked
job is **notify-only**: logged to the Sheet + a Chat card stating *why* it was
not accepted, so a human can grab it manually.

---

## 2. Core Behavior

For each eligible Malay job the cycle would otherwise auto-accept, a **schedule
gate** decides `accept` vs `block`:

- **accept** → the existing bulk-accept path runs unchanged.
- **block** → the job is **not** clicked, but **is logged to the Google Sheet
  exactly as today**, with **Status = `Rejected`** and the reason in the **Note**
  column. Internally `lifecycleStatus = 'rejected'` (a new status → Sheet
  `Rejected`), distinct from `'skipped'` (non-Malay) and `'new'`. A Chat card is
  also sent with the reason.

The `Rejected` row is written when the block is decided (the first-seen blocking
event reports Sheet + Chat once). `accept_status` stays `'none'`, so the
robustness pass re-evaluates the job each cycle while it remains in Active:
- a **capacity** reject can become acceptable after the daily reset;
- a **feasibility** reject only gets tighter as time passes (less working time
  before the deadline), so it stays rejected;
- a **deadline-on-non-working-day** reject never becomes acceptable.

If a re-evaluation later allows it, the Sheet row transitions `Rejected →
Accepted`. If the job leaves Active first, the existing missing/closed/removed
handling applies. The gate runs **after** the existing `decideAccept()` returns
`accept`; non-eligible / capped / auto-accept-disabled jobs are handled exactly
as today and never reach the gate.

### 2.1 Decision flow (per job that `decideAccept()` says to accept)

```
evaluateAcceptSchedule(input):
  if !XTM_SCHEDULE_ENABLED                 → ALLOW   (byte-for-byte today's behavior)

  # (1) Daily word capacity — HARD volume cap
  if maxWordsPerDay > 0 and acceptedWordsToday >= maxWordsPerDay
                                           → BLOCK "daily word cap reached (N/1000)"

  # (2) Deadline must be known (never accept on uncertainty)
  if dueAtMs is null                       → BLOCK "deadline unknown"

  # (3) Word count must be known (needed to judge feasibility)
  if words is null                         → BLOCK "word count unknown"

  # (4) Deadline must NOT fall on a non-working day (weekend OR Thai holiday)
  dl = bangkokCalendar(dueAtMs)
  if isNonWorkingDay(dl.date, dl.weekday, workdays, holidays)
                                           → BLOCK "deadline on non-working day (<weekend|holiday name>)"

  # (5) Must be FINISHABLE within available working hours before the deadline
  availMin    = workingMinutesBetween(nowMs, dueAtMs, calendar)   # 09:00–18:00 on workdays, minus holidays
  requiredMin = ceil(words / throughputWordsPerHour * 60)         # throughput resolved per §2.2 (derived | override)
  if availMin >= requiredMin               → ALLOW
  else                                     → BLOCK "cannot finish in time (need ~Rh work, ~Ah left before deadline)"
```

**Effective behavior:** A job is accepted iff its deadline is known, the deadline
is **not** on a non-working day, the team **can finish it** in the working hours
available before that deadline (`availableWorkingHours × throughput ≥ words`), and
the **daily word budget** is not spent. This holds the same in-hours and
off-hours — feasibility is a single general gate, not an off-hours special case.

### 2.2 Working-hours feasibility (`workingMinutesBetween`)

The heart of the feature. Pure: sums the minutes of overlap between the interval
`[nowMs, dueAtMs]` and each day's **working window** `[09:00, 18:00)` (Bangkok),
counting **only working days** (Mon–Fri by `workdays`, excluding Thai holidays).

```
workingMinutesBetween(startMs, endMs, cal, capMinutes?):
  if endMs <= startMs: return 0
  total = 0
  for each Bangkok calendar date D from date(startMs) to date(endMs):   # day-by-day
    if isNonWorkingDay(D, weekday(D), cal.workdays, cal.holidays): continue
    winStart = epochMs(D, cal.hoursStartMin)      # D 09:00 +07:00
    winEnd   = epochMs(D, cal.hoursEndMin)        # D 18:00 +07:00
    overlap  = max(0, min(endMs, winEnd) - max(startMs, winStart))
    total   += overlap / 60000
    if capMinutes !== undefined and total >= capMinutes: return total   # early-exit
  return total
```

- **Bangkok is a fixed +07:00 offset (no DST)** → `epochMs(date, minutes)` is
  `Date.parse(`${date}T${HH}:${MM}:00+07:00`)`. Deterministic, no `Date.now()`.
- **Early-exit** via `capMinutes = requiredMin` bounds iteration: a feasible job
  stops as soon as it has enough; an infeasible near-deadline job iterates only a
  few days. A hard safety cap (e.g. 400 days) backstops a pathological far
  deadline.
- `nowMs = Date.parse(snapshot.capturedAt)` (snapshot-driven, deterministic, the
  same clock the cycle already uses for latency). `dueAtMs = Date.parse(s.dueDate)`
  (null when `s.dueDate` is null or unparseable).

**Throughput resolution** (`resolveThroughput`, pure) — the single business knob
is the daily capacity; throughput follows it:

```
resolveThroughput({ explicit, maxWordsPerDay, hoursStartMin, hoursEndMin }):
  if explicit is set (XTM_THROUGHPUT_WORDS_PER_HOUR) → return explicit
  workingHoursPerDay = (hoursEndMin - hoursStartMin) / 60     # 9 with defaults
  return maxWordsPerDay / workingHoursPerDay                  # 1000 / 9 ≈ 111.1
```

So raising `XTM_ACCEPT_MAX_WORDS_PER_DAY` automatically scales the rate — bigger
capacity → bigger jobs become finishable — with no second value to keep in sync.
The model stays self-consistent: a `capacity`-word job needs exactly
`workingHoursPerDay` of work (one full working day). Resolved once per cycle by
the caller and passed into the gate as `throughputWordsPerHour`.

`isNonWorkingDay(dateStr, weekday, workdays, holidays)` = `weekday ∉ workdays OR
holidays.has(dateStr)`.

### 2.3 Worked truth table (XTM_SCHEDULE_ENABLED=1, hours 09:00–18:00, Mon–Fri, cap 1000, throughput derived ≈ 111.1/h)

`requiredMin = ceil(words / 111.1 × 60) ≈ words × 0.54` (e.g. 300 words ≈ 162 min;
equivalently `words × workingMinutesPerDay / capacity = words × 540 / 1000`).

| now (Bangkok) | dueDate | words | acceptedToday | avail vs required | verdict | reason |
|---|---|---|---|---|---|---|
| Mon 10:00 | Wed 18:00 | 800 | 0 | ~1500m ≥ 432m | ALLOW | finishable |
| Mon 15:00 | Mon 18:00 | 300 | 0 | 180m ≥ 162m | ALLOW | finishable |
| Mon 15:00 | Mon 18:00 | 500 | 0 | 180m < 270m | BLOCK | cannot finish (need 270m, have 180m) |
| Sun 14:00 | Fri 18:00 | 600 | 0 | ~2700m ≥ 324m | ALLOW | finishable |
| Sun 14:00 | Mon 12:00 | 5000 | 0 | 180m < 2700m | BLOCK | cannot finish (need 2700m, have 180m) |
| Fri 17:00 | Mon 10:00 | 200 | 0 | 120m ≥ 108m | ALLOW | finishable (Fri17–18 + Mon09–10) |
| Fri 17:00 | Mon 10:00 | 800 | 0 | 120m < 432m | BLOCK | cannot finish (need 432m, have 120m) |
| any | Sat / Sun / holiday | 100 | 0 | — | BLOCK | deadline on non-working day |
| Mon 10:00 | (null) | 300 | 0 | — | BLOCK | deadline unknown |
| Mon 10:00 | Wed 18:00 | (null) | 0 | — | BLOCK | word count unknown |
| Mon 10:00 | Wed 18:00 | 300 | 1000 | — | BLOCK | daily word cap reached (1000/1000) |

---

## 3. Module Map

New module `src/schedule/` — pure, isolated, independently testable.

| File | Responsibility | Pure? |
|---|---|---|
| `src/schedule/bangkokCalendar.ts` | `bangkokCalendar(epochMs) → { date:'YYYY-MM-DD', weekday:1..7 (ISO, Mon=1), minutesOfDay:0..1439 }`; `bangkokDateString(epochMs)`; `bangkokYear(epochMs)`; `bangkokEpochMs(date, minutes)`. Uses the fixed +07:00 offset (read UTC parts of `ms + 7*3_600_000`, same trick as `reporting/dateFormat.ts`); ISO weekday = `((getUTCDay()+6)%7)+1`. | ✅ |
| `src/schedule/parseSchedule.ts` | `parseHHMM('09:00') → 540` (minutes); `parseWorkdays('1-5') → Set<number>` (ranges and comma lists; ISO 1..7); `resolveThroughput({ explicit, maxWordsPerDay, hoursStartMin, hoursEndMin }) → number` (§2.2 — explicit override else `capacity ÷ working-hours-per-day`). Used by config validation + the cycle. | ✅ |
| `src/schedule/workingHours.ts` | `workingMinutesBetween(startMs, endMs, cal, capMinutes?) → number` (§2.2) and `isNonWorkingDay(dateStr, weekday, workdays, holidays) → boolean`. The calendar integration core. | ✅ |
| `src/schedule/thaiHolidayOverrides.ts` | Static override data `{ [year]: { [date]: name } }`. Seeded with 2026 cabinet-declared / special days. Hand-maintained, git-reviewed. | ✅ (data) |
| `src/schedule/thaiHolidays.ts` | `getThaiHolidays(year) → { holidays: Map<'YYYY-MM-DD', name>, dataMissing: boolean }` = `date-holidays`('TH') public holidays ∪ override entries (override adds/wins). `dataMissing = true` when the library yields nothing AND there is no override. Per-year memoized; library errors caught → treated as empty. | ผสม |
| `src/schedule/acceptSchedule.ts` | `evaluateAcceptSchedule(input) → { allow:true } \| { allow:false, reason }` implementing §2.1. Composes `bangkokCalendar` + `workingHours`; takes the year's `holidays` map as input. | ✅ |

Changed files:

| File | Change |
|---|---|
| `src/detection/types.ts` | Add `'rejected'` to `XtmLifecycleStatus`. |
| `src/reporting/sheets.ts` | Add `'Rejected'` to `SheetStatus`; map `rejected → 'Rejected'` in `lifecycleToSheetStatus`. |
| `src/state/meta.ts` | Daily word counter: `acceptedWordsToday(dateStr)`, `addAcceptedWords(dateStr, n)` (reset-on-date-change, one txn). Keys `accepted_words_date`, `accepted_words_count`. |
| `src/config/index.ts` | New env vars + zod validation + `.refine` (see §4). |
| `src/runtime/xtmPollCycle.ts` | Resolve the year's holidays + read `acceptedWordsToday` once per cycle; apply the gate at both accept sites (first-seen + robustness); track optimistic in-cycle words; on confirmed accept `addAcceptedWords`; on block set `lifecycleStatus='rejected'` + reason note (Sheet row written like today); new summary counter `scheduleBlocked`; raise `holiday_data_missing` alert (deduped) when `dataMissing`. |
| `src/reporting/xtmNotifier.ts` | `renderXtmNewJob` note variants: "accepting", rejected "Rejected — <reason>", existing "auto-accept off" / "Not Malay" preserved. |
| `src/reporting/systemAlerts.ts` | New `TriggerKind` `holiday_data_missing` (severity warn, `hasRecovered:true`). |
| `package.json` | add dependency `date-holidays`. |

`evaluateAcceptSchedule` stays **pure** and decoupled from the DB/outbox: the
cycle resolves holidays and the running word count and passes them in. The
`holiday_data_missing` alert is raised by the cycle (which owns the outbox).

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
  throughputWordsPerHour: number; // resolved by caller: explicit override OR derived from capacity (resolveThroughput)
  holidays: Map<string, string>; // date 'YYYY-MM-DD' → holiday name (covers the now..deadline span)
}
type AcceptScheduleVerdict = { allow: true } | { allow: false; reason: string };
```

> The `holidays` map must cover every date the feasibility scan can touch
> (now → deadline), which can cross a year boundary. The cycle resolves
> `getThaiHolidays(bangkokYear(nowMs))` merged with the next year when the
> deadline falls in it.

---

## 4. Config (new env vars; safe defaults in `.env.example`)

| Var | Default | Notes |
|---|---|---|
| `XTM_SCHEDULE_ENABLED` | **ON** | Master switch. `0`/`false`/`off`/`no` → disabled (identical to the yield kill-switch parsing). Disabled = today's behavior exactly. |
| `XTM_ACCEPT_HOURS_START` | `09:00` | `HH:MM` 24h. Validated `^([01]\d\|2[0-3]):[0-5]\d$`. Daily working-window start. |
| `XTM_ACCEPT_HOURS_END` | `18:00` | `HH:MM`. Working-window end (exclusive). |
| `XTM_ACCEPT_WORKDAYS` | `1-5` | ISO weekdays (Mon=1..Sun=7). Ranges (`1-5`) and lists (`1,2,3`). |
| `XTM_ACCEPT_MAX_WORDS_PER_DAY` | `1000` | **The primary knob.** Cumulative **words** of confirmed accepts per Bangkok day; also the basis for derived throughput. `0` = unlimited *volume* cap (then throughput must be set explicitly — see refine). |
| `XTM_THROUGHPUT_WORDS_PER_HOUR` | *(unset → derived)* | OPTIONAL override. Empty/unset → derived `maxWordsPerDay ÷ working-hours-per-day` (≈ 111 with defaults). Set to a positive number to pin the rate independent of capacity. |

Holidays come from the library + override file (no env var for the list).

**zod `.refine` (only enforced when `XTM_SCHEDULE_ENABLED`)** — mirrors the
yield-flag precedent so an operator can always disable the feature without first
fixing an unrelated value:
- `parseHHMM(start) < parseHHMM(end)` — else error on `XTM_ACCEPT_HOURS_END`.
- A throughput must be **resolvable**: `XTM_THROUGHPUT_WORDS_PER_HOUR` is set
  (and > 0), **or** `XTM_ACCEPT_MAX_WORDS_PER_DAY > 0` (so it can be derived) —
  else error naming both vars. When the override is set it must be > 0.
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
  optimistically that cycle — strictly more conservative, never a silent
  over-accept.
- Block condition is `acceptedWordsToday >= cap`. Because the portal's bulk
  action grabs the whole language group in one click, a single accept can
  **overshoot** the cap by one group — accepted and documented, the same
  constraint already noted for `ACCEPT_MAX_PER_CYCLE` (see `acceptDecision.ts`).
  The cap is a soft *pre-gate*, not a mid-group stop.
- A `words === null` job is **rejected** by the feasibility gate (§2.1 step 3),
  so it is never accepted while the schedule is enabled and never reaches the
  counter. (With the schedule disabled it follows today's behavior.)

---

## 6. Failure Modes (fail-loud, Constitution IV/V)

| Condition | Handling |
|---|---|
| Holiday year missing (`dataMissing`) | Cycle raises `holiday_data_missing` system alert (deduped) → **fail-open**: the missing year's holidays are treated as ordinary working days (feasibility may over-count and the deadline-on-holiday check won't fire for them) until the override/library is updated. Avoids the bot going dark because next year's holidays weren't added. |
| `date-holidays` throws / unavailable | Caught in `getThaiHolidays` → treated as empty; `dataMissing` reflects whether an override exists. Never crashes the cycle (Constitution IV). |
| Bad `HH:MM`, `start >= end`, `throughput <= 0`, bad workdays | **fail-fast at startup** via zod, message names the var. |
| `dueDate` null/unparseable | BLOCK "deadline unknown" (notify-only). Never throws. |
| `words` null | BLOCK "word count unknown" (notify-only). |
| Deadline far in the future | `workingMinutesBetween` early-exits at `requiredMin`; a 400-day hard cap backstops a pathological deadline so iteration is always bounded. |
| Clock/parse anomaly on `capturedAt` | `nowMs = Date.parse(capturedAt)`; if NaN the cycle already fails its normal path before the gate. |

---

## 7. Testing (TDD; coverage gate ≥ 80% for detection/state; `src/schedule` new)

Write tests first, watch them fail, then implement (Constitution).

- **bangkokCalendar** — UTC inputs crossing the Bangkok midnight boundary (the
  CI-runs-UTC trap: TZ-explicit ISO inputs, reproduce with `TZ=UTC`); ISO weekday
  mapping (Sun→7); `minutesOfDay` at 00:00 / 23:59; `bangkokEpochMs` round-trip;
  year rollover.
- **parseSchedule** — `parseHHMM` valid/invalid; `parseWorkdays` ranges, lists,
  single, out-of-range rejected; `resolveThroughput` derives `1000 ÷ 9 ≈ 111.1`,
  an explicit override wins, and a different capacity/window rescales the derived
  value.
- **workingHours** — `workingMinutesBetween`: same-day partial window (15:00→18:00
  = 180); start/end outside the window clamps; an overnight gap (Mon 17:00 → Tue
  10:00 = 60+60); a weekend gap (Fri 17:00 → Mon 10:00 = 120); a holiday in the
  span is skipped; a multi-day full span; `end <= start` → 0; deadline before the
  window start that day; `capMinutes` early-exit returns ≥ cap. `isNonWorkingDay`:
  weekend true, holiday true, normal weekday false.
- **thaiHolidays** — library hit for a known 2026 standard holiday; override merge
  (override-only date appears; override name wins); `dataMissing` true for a
  far-future year with no override; library-throw caught.
- **acceptSchedule** — the full §2.3 truth table: capacity reached; deadline
  unknown; word count unknown; deadline on weekend/holiday; finishable vs not
  (boundary "พอดี" cases 180≥180, 120≥120); disabled → always allow.
- **meta** — counter increments; reset on new Bangkok date; persistence across a
  fresh `MetaStore` (restart) for the same date.
- **xtmPollCycle integration** (stubbed acceptor) — a blocked eligible job: not
  accepted, `lifecycleStatus='rejected'` → Sheet row enqueued with Status
  `Rejected` + reason in Note, Chat card carries the reason, `accept_status` stays
  `'none'`, counter unchanged; an accepted job: counter += words; cap reached
  mid-cycle blocks the next candidate; `XTM_SCHEDULE_ENABLED=0` path is
  byte-for-byte the pre-feature behavior.
- **config** — defaults (capacity 1000, throughput unset → derived); kill-switch
  literals; refine rejects `start>=end`, an explicit `throughput<=0`, and
  `capacity=0` with no explicit throughput — all only when enabled; HH:MM/workday
  parse failures named.

---

## 8. Rollout

- Ships **default ON** (the requested behavior). `XTM_SCHEDULE_ENABLED=0` is the
  one-line rollback.
- `ACCEPT_MAX_PER_CYCLE` stays `0` (untouched — the bulk-accept invariant).
- After deploy: watch a cycle log for `scheduleBlocked` counts; confirm an
  in-hours, finishable Malay job still accepts; confirm a too-tight or
  non-working-day-deadline job is `Rejected` with reason on the Sheet; confirm the
  daily word counter resets at Bangkok midnight.
- Verify the 2026 Thai holiday override list before relying on holiday handling.

---

## 9. Open / Deferred (YAGNI)

- Per-weekday different hours — deferred (single window for all workdays).
- "Available working time" assumes one shared throughput; per-job or per-step
  throughput is out of scope.
- Showing "accepted X/1000 words today" in the 09:00 daily report — optional, not
  in this scope.
- Counting partial credit for a deadline that lands mid-working-window on a
  non-working day is moot — such deadlines are rejected outright (§2.1 step 4).
