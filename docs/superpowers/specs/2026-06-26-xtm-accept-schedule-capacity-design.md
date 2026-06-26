# XTM Accept: Working-Hours Feasibility + Daily Word Capacity — Design

**Status:** design v3 (brainstormed 2026-06-26; revised after 3-specialist review — reliability/qa/architecture)
**Feature area:** auto-accept gating (`src/detection/`, `src/state/`, new `src/schedule/`, `src/runtime/xtmPollCycle.ts`, `src/config/`, `src/reporting/`)
**Builds on:** the live 002 auto-accept pipeline (detect → decide → accept → record) and the auto-yield precedent (config flag + injected clock + meta accessors).

---

## 1. Problem & Goal

The bot auto-accepts eligible Malay jobs 24/7 the moment they appear. The team
wants the bot to accept **only work it can actually deliver**, bounded by daily
volume. One coherent rule:

> **Accept a job only if the team can FINISH it within its available working
> hours before the deadline — and the day's word budget is not yet spent.**

Consequences of the one model:

1. **Work-hours window** (09:00–18:00) and **no weekends / no Thai holidays**
   define *when work happens*; non-working time contributes **zero** working
   hours to feasibility.
2. **Deadline on a non-working day** (weekend or Thai holiday) → **not accepted**.
3. **Daily word capacity** — the single business knob; stop accepting once the
   cumulative **word** budget for the day is reached (default 1000, hard cap).
4. **Throughput is derived from capacity** (`capacity ÷ working-hours-per-day`),
   so raising capacity auto-scales the rate.

**Non-goals (unchanged behavior):** Detection and Google Chat notification run
24/7. Gating applies **only to the accept click**. A blocked job is
**notify-only**: logged to the Sheet (**Status `Rejected`** + reason in Note) and
a Chat card, so a human can grab it manually.

---

## 2. Core Behavior

For each eligible Malay job the cycle would otherwise auto-accept, a **schedule
gate** decides `accept` vs `block`:

- **accept** → the existing bulk-accept path runs unchanged.
- **block** → the job is **not** clicked, but **is logged to the Sheet** with
  **Status = `Rejected`** and the reason in the **Note** column
  (`lifecycleStatus = 'rejected'`, a new status, distinct from `'skipped'` =
  non-Malay and `'new'`). A Chat card is also sent with the reason.

`accept_status` stays `'none'`, so the robustness pass re-evaluates each cycle
while the job remains in Active: a **capacity** reject can clear after the daily
reset; a **feasibility** reject only tightens with time; a
**deadline-on-non-working-day** reject never clears. A later allow transitions the
Sheet `Rejected → Accepted`. The gate runs **after** the existing
`decideAccept()` returns `accept`; non-eligible / capped / auto-accept-disabled
jobs are handled exactly as today and never reach the gate.

### 2.1 Per-job verdict (pure `evaluateAcceptSchedule`)

```
evaluateAcceptSchedule(input):
  if !ACCEPT_SCHEDULE_ENABLED              → ALLOW   (byte-for-byte today's behavior)

  # (1) Daily word capacity — HARD volume cap (group total, see §2.4)
  if maxWordsPerDay > 0 and acceptedWordsToday >= maxWordsPerDay
                                           → BLOCK "daily word cap reached (N/1000)"

  # (2) Deadline must be known (never accept on uncertainty)
  if dueAtMs is null                       → BLOCK "deadline unknown"

  # (3) Word count must be known (needed to judge feasibility)
  if words is null                         → BLOCK "word count unknown"

  # (4) Holiday calendar must be CONFIRMED for the span (see §6 C3 / fail-closed)
  if not holidaysCuratedForSpan            → BLOCK "holiday calendar not confirmed for <year>"

  # (5) Deadline must NOT fall on a non-working day (weekend OR Thai holiday)
  dl = bangkokCalendar(dueAtMs)
  if isNonWorkingDay(dl.date, dl.weekday, workdays, holidays)
                                           → BLOCK "deadline on non-working day (<weekend|holiday name>)"

  # (6) Must be FINISHABLE within available working hours before the deadline
  if dueAtMs <= nowMs                       → BLOCK "deadline already passed"
  availMin    = workingMinutesBetween(nowMs, dueAtMs, calendar)
  requiredMin = ceil(words / throughputWordsPerHour * 60)   # throughput resolved per §2.2
  if availMin >= requiredMin               → ALLOW
  else                                     → BLOCK "cannot finish in time (need ~Rh, ~Ah left before deadline)"
```

`words === 0` → `requiredMin = 0` → trivially finishable → **ALLOW** (a real
0-word task is deliverable instantly; intentional, pinned by test). `words ===
null` (unknown) is the rejected case, step 3.

### 2.2 Working-hours feasibility (`workingMinutesBetween`)

Pure: sums the minutes of overlap between `[nowMs, dueAtMs]` and each day's
working window `[09:00, 18:00)` (Bangkok), counting only working days (by
`workdays`, excluding Thai holidays).

```
workingMinutesBetween(startMs, endMs, cal, capMinutes?):
  if endMs <= startMs: return 0
  total = 0; days = 0
  for each Bangkok date D from date(startMs) to date(endMs) INCLUSIVE:   # day-by-day
    if ++days > 400: break                       # hard safety cap (bounded iteration)
    if isNonWorkingDay(D, weekday(D), cal.workdays, cal.holidays): continue
    winStart = bangkokEpochMs(D, cal.hoursStartMin)   # D 09:00 +07:00
    winEnd   = bangkokEpochMs(D, cal.hoursEndMin)     # D 18:00 +07:00
    overlap  = max(0, min(endMs, winEnd) - max(startMs, winStart))
    total   += overlap / 60000
    if capMinutes !== undefined and total >= capMinutes: return total    # early-exit
  return total
```

- **Bangkok = fixed +07:00 (no DST)** → `bangkokEpochMs(date, minutes)` =
  `Date.parse(`${date}T${HH}:${MM}:00+07:00`)`. Deterministic, no `Date.now()`.
- The end date is iterated **inclusive** (the `Mon 15:00 → Mon 18:00 = 180` case
  depends on it). The 400-day cap lives **in code**, not just prose.
- `nowMs = Date.parse(snapshot.capturedAt)` (snapshot-driven, deterministic, the
  same clock the cycle already uses for latency). `dueAtMs = Date.parse(s.dueDate)`;
  `s.dueDate` is produced by `normalizeXtmDue` and **always carries a time**
  (`YYYY-MM-DDTHH:MM+07:00`) — verified, so there is no date-only→07:00 pitfall in
  the gate. (If XTM ever emits a time-less deadline, that is a `normalizeXtmDue`
  concern, out of scope here; flag during implementation if real samples differ.)

**Throughput resolution** (`resolveThroughput`, pure) — capacity is the single
knob; throughput follows it:

```
resolveThroughput(explicit, maxWordsPerDay, hoursStartMin, hoursEndMin):
  if explicit is set (ACCEPT_THROUGHPUT_WORDS_PER_HOUR) → return explicit
  workingHoursPerDay = (hoursEndMin - hoursStartMin) / 60     # 9 with defaults
  return maxWordsPerDay / workingHoursPerDay                  # 1000 / 9 ≈ 111.1
```

Computed **once in `loadConfig`** as a derived field on `AppConfig` (§3/§4), not
per-cycle — single source of truth, type-safe `number`. A `capacity`-word job
needs exactly one full working day.

`isNonWorkingDay(dateStr, weekday, workdays, holidays)` = `weekday ∉ workdays OR
holidays.has(dateStr)`.

### 2.3 Worked truth table (ENABLED, hours 09:00–18:00, Mon–Fri, cap 1000, throughput derived ≈ 111.1/h)

`requiredMin = ceil(words / 111.1 × 60) ≈ words × 0.54` (e.g. 300 words ≈ 162 min).

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

### 2.4 Bulk-group all-or-nothing (Critical — C1)

The portal's bulk action **"Accept all tasks for this language in this group"**
claims the **whole language-group in one click** (the reason `ACCEPT_MAX_PER_CYCLE`
must be `0` — see `acceptDecision.ts`). A **per-job** gate therefore creates a
data-corruption hazard: if a small sibling is ALLOWed and a larger sibling is
BLOCKed (infeasible, or the capacity boundary falls mid-group), accepting the
small one **grabs the blocked sibling on the portal too**, yet the bot records it
`Rejected` → the team sees "Rejected", never delivers a job they actually own →
**irreversible SLA breach.**

**Rule:** the gate is decided at the granularity of a **bulk-accept unit** — the
set of sibling tasks one bulk click grabs (the **same grouping key the
`XtmAcceptor` uses**; the implementer MUST read `src/portal/xtmAccept.ts` and
align on it, e.g. project/group + target language):

1. Collect every would-accept candidate (jobs where `decideAccept()` → `accept`),
   from both the first-seen and robustness passes.
2. Group candidates by the bulk-accept key.
3. For each group: run the per-job verdict (§2.1) on **every** member, and check
   the group's **combined** words against the remaining daily capacity.
4. **Accept the group only if every member ALLOWs and the group total fits
   capacity.** Otherwise **Reject the entire group** — mark every member
   `lifecycleStatus = 'rejected'` with the binding reason (the first/worst failing
   member's reason, e.g. "group blocked: cannot finish '<file>' in time").

This preserves the bulk invariant safely and makes capacity a per-group check
(no mid-group split). A genuinely solo job is just a group of one.

---

## 3. Module Map

New module `src/schedule/` — pure, isolated, independently testable.

| File | Responsibility | Pure? |
|---|---|---|
| `src/schedule/bangkokCalendar.ts` | **Canonical** Bangkok time helpers: `bangkokCalendar(epochMs) → { date, weekday:1..7, minutesOfDay }`; `bangkokDateString`, `bangkokYear`, `bangkokEpochMs(date, minutes)`. Fixed +07:00 (read UTC parts of `ms + 7*3_600_000`); ISO weekday `((getUTCDay()+6)%7)+1`. **`dailyReport.bangkokDate` and the meta word-counter date keying delegate here** (one source for "Bangkok date"). | ✅ |
| `src/schedule/parseSchedule.ts` | `parseHHMM('09:00') → 540`; `parseWorkdays('1-5') → Set<number>` (ranges/lists, ISO 1..7, **rejects empty**); `resolveThroughput(...)` (§2.2). | ✅ |
| `src/schedule/workingHours.ts` | `workingMinutesBetween(start, end, cal, capMinutes?)` (§2.2, 400-day cap, inclusive end) and `isNonWorkingDay(...)`. | ✅ |
| `src/schedule/thaiHolidaysData.ts` | The **team's observed holidays** per year `{ [year]: { [date]: name } }` + `CURATED_YEARS: Set<number>`. Seeded with the standard Thai นักขัตฤกษ์ public holidays the team is off for 2026–2027. **The team does NOT observe cabinet-declared special / substitution days (วันหยุดพิเศษ/ชดเชย ครม.)** — those are intentionally excluded (the team works them). Hand-maintained, git-reviewed. | ✅ (data) |
| `src/schedule/thaiHolidays.ts` | `getThaiHolidays(year) → { holidays: Map<date,name>, curated: boolean }` = a **pure lookup** from `thaiHolidaysData.ts`; `curated = year ∈ CURATED_YEARS`. **No external library** — a generic Thai-holiday library would include cabinet/substitution days the team works and wrongly reject those jobs; the team's own curated list is the correct source. | ✅ |
| `src/schedule/acceptSchedule.ts` | `evaluateAcceptSchedule(input) → { allow:true } \| { allow:false, reason }` (§2.1). Composes `bangkokCalendar` + `workingHours`; takes the resolved `holidays` + `holidaysCuratedForSpan` as input. | ✅ |

Changed files:

| File | Change |
|---|---|
| `src/detection/types.ts` | Add `'rejected'` to `XtmLifecycleStatus`. |
| **`src/state/db.ts`** | **(C2)** Widen/drop the `lifecycle_status` CHECK (db.ts:127-130 lists only 7 statuses; the column already exists in prod, so an `ADD COLUMN` is skipped). Add a **table-rebuild migration** for `jobs` inside `migrate()`'s tx (rename → recreate with the widened/dropped CHECK → copy all ~14 columns → drop old), mirroring `ensureOutboxChannel`. Without it, persisting `'rejected'` throws `SQLITE_CONSTRAINT_CHECK` and crashes the cycle. |
| `src/reporting/sheets.ts` | Add `'Rejected'` to `SheetStatus`; map `rejected → 'Rejected'` in the exhaustive `lifecycleToSheetStatus` Record (tsc enforces the addition). |
| `src/state/meta.ts` | Daily word counter: `acceptedWordsToday(dateStr)`, `addAcceptedWords(dateStr, n)` (reset-on-date-change, one txn). Keys `accepted_words_date`, `accepted_words_count`. Date keying via `bangkokDateString` (canonical). |
| `src/config/index.ts` | New `ACCEPT_SCHEDULE_*` env vars; field-level transforms (hours→minutes, workdays→Set); **derived fields** on `AppConfig` (`throughputWordsPerHour`, parsed hours/workdays); `.refine` (§4). |
| `src/runtime/xtmPollCycle.ts` | **(C4)** One `evaluateCandidate()` helper composing `decideAccept` + the schedule verdict, called from **both** accept sites (no drift, no silent robustness-pass reject). Group candidates per bulk-accept unit and apply §2.4 all-or-nothing. Resolve the year(s)' holidays + `acceptedWordsToday` once per cycle; **(I1)** `addAcceptedWords` **inside the same txn as `recordAcceptOutcome`** (only `outcome==='accepted'`); set `lifecycleStatus='rejected'` + thread the reason via a `rejectNotes` map; new `summary.scheduleBlocked`; raise/resolve `holiday_calendar_stale` (deduped, guarded behind ENABLED). |
| `src/runtime/xtmPollCycle.ts > chatForEvent` | **(I3)** Add a `rejected` branch → note `"Rejected — <reason>"` from `rejectNotes` (today it would wrongly say "Malay (MS) — accepting"). **`renderXtmNewJob` already takes `statusNote` — `xtmNotifier.ts` likely needs NO change.** Field re-sync (`detailsChanges`) for a `rejected` job must **preserve the reason note and re-run the gate** (a new dueDate/words may flip it to Accepted) instead of writing `note=null`. |
| `src/reporting/systemAlerts.ts` | New `TriggerKind` `holiday_calendar_stale` (severity warn, `hasRecovered:true` — needs a resolve call site in the cycle). |
| `src/reporting/dailyReport.ts` | `buildDailyReportCard` gains the day's capacity usage line (§5.1): new params `acceptedWordsToday: number` + `maxWordsPerDay: number`; the cycle (`xtmPollLoop`) reads `meta.acceptedWordsToday(bangkokDate(now))` + `cfg.ACCEPT_MAX_WORDS_PER_DAY` and passes them. |
| `.env.example` | Document the new `ACCEPT_SCHEDULE_*` vars. |
| `package.json` | **No new runtime dependency** — the holiday list is a checked-in data file, not a library. |
| `specs/.../contracts/config.md`, `contracts/sheets.md` | Add the new vars + the `Rejected` status (code cites these as source-of-truth). |

`evaluateAcceptSchedule` stays **pure**; the cycle resolves holidays/curation and
the running word count and passes them in. Alerts are raised by the cycle.

### 3.1 `AcceptScheduleInput` (interface)

```ts
interface AcceptScheduleInput {
  enabled: boolean;                 // ACCEPT_SCHEDULE_ENABLED
  nowMs: number;                    // Date.parse(snapshot.capturedAt)
  dueAtMs: number | null;           // s.dueDate ? Date.parse(s.dueDate) : null (NaN → null)
  words: number | null;             // s.words
  acceptedWordsToday: number;       // persisted today + optimistic in-cycle running total
  maxWordsPerDay: number;           // 0 = unlimited
  hoursStartMin: number; hoursEndMin: number;  // resolved minutes
  workdays: Set<number>;            // ISO 1..7
  throughputWordsPerHour: number;   // resolved (derived from capacity OR explicit override)
  holidays: Map<string, string>;    // every date the now..deadline span can touch
  holidaysCuratedForSpan: boolean;  // every year the span touches is in CURATED_YEARS (C3)
}
type AcceptScheduleVerdict = { allow: true } | { allow: false; reason: string };
```

> The cycle resolves `holidays` for **every year the now→deadline span touches**
> (can cross a year boundary; the 400-day cap bounds it to ≤ 2 years) and sets
> `holidaysCuratedForSpan` accordingly.

---

## 4. Config (new env vars, `ACCEPT_SCHEDULE_*` family; safe defaults in `.env.example`)

| Var | Default | Notes |
|---|---|---|
| `ACCEPT_SCHEDULE_ENABLED` | **ON** | Master switch. `0`/`false`/`off`/`no` → disabled (yield-flag parsing). Disabled = today's behavior exactly. |
| `ACCEPT_HOURS_START` | `09:00` | `HH:MM`. Transformed to minutes. Working-window start. |
| `ACCEPT_HOURS_END` | `18:00` | `HH:MM`. Working-window end (exclusive). |
| `ACCEPT_WORKDAYS` | `1-5` | ISO weekdays (Mon=1..Sun=7); ranges + lists; transformed to a **non-empty** `Set`. |
| `ACCEPT_MAX_WORDS_PER_DAY` | `1000` | **The primary knob.** Cumulative **words** of confirmed accepts per Bangkok day; also the basis for derived throughput. `0` = unlimited *volume* cap (then throughput must be explicit — see refine). Distinct from the existing per-job `ACCEPT_MAX_WORDS`. |
| `ACCEPT_THROUGHPUT_WORDS_PER_HOUR` | *(unset → derived)* | OPTIONAL override. Empty/unset → derived `maxWordsPerDay ÷ working-hours-per-day` (≈ 111). |

**Config shape (I2):** parse with field-level transforms + an optional-numeric
guard, then expose **derived fields** so the cycle never recomputes:
- `ACCEPT_THROUGHPUT_WORDS_PER_HOUR`: `z.preprocess(v => v === '' || v === undefined ? undefined : v, z.coerce.number().positive().optional())` — distinguishes "unset" from `0` (`Number('') === 0` trap).
- Top-level `.transform` adds `throughputWordsPerHour`, `hoursStartMin`, `hoursEndMin`, `workdays` to the parsed object (one source of truth on `z.infer`).

**zod `.refine` (only when `ACCEPT_SCHEDULE_ENABLED`)** — mirrors the yield-flag
precedent so the kill-switch always works:
- `hoursStartMin < hoursEndMin` — else error on `ACCEPT_HOURS_END`.
- Throughput resolvable: `ACCEPT_THROUGHPUT_WORDS_PER_HOUR` set (`> 0`) **or**
  `ACCEPT_MAX_WORDS_PER_DAY > 0` — else error naming both.
- `ACCEPT_WORKDAYS` parses to a non-empty set; `HH:MM` format valid — field-level,
  fail-fast naming the var.

Holidays come from the checked-in `thaiHolidaysData.ts` data file (the team's
observed นักขัตฤกษ์ list; no env var, no library).

---

## 5. Capacity Counting Semantics

- The persisted counter (`meta`) increments by the **group's accepted words** —
  **inside the same transaction as `recordAcceptOutcome`** (I1), only for
  `outcome === 'accepted'`, keyed to the **Bangkok** date; it resets when the date
  rolls. A crash between commit and counting would otherwise under-count
  permanently and over-accept.
- Within one cycle, an **optimistic** running total of queued-candidate words is
  added to `acceptedWordsToday` for the gate, so multiple groups in one cycle
  respect the cap; an over-counted candidate that later fails/misses is strictly
  conservative, never a silent over-accept.
- Block condition: `acceptedWordsToday >= cap` (group total checked per §2.4).
  Bulk grabs the whole group, so a single accepted group may **overshoot** the cap
  by its size — accepted and documented (same class as `ACCEPT_MAX_PER_CYCLE`); the
  cap is a soft per-group pre-gate.
- `words === null` is **rejected** by the gate (§2.1 step 3) and never reaches the
  counter while enabled.

### 5.1 Daily report capacity line

The 09:00 Bangkok daily report (`buildDailyReportCard`) shows a usage line for the
budget. Per the 2026-06-26 decision it reports **today's running total** (a direct
read of the live counter for the report's Bangkok date — no extra history/snapshot
storage):

- `Auto-accepted today: X / Y words` where `X = meta.acceptedWordsToday(today)` and
  `Y = ACCEPT_MAX_WORDS_PER_DAY`; when `Y = 0` (unlimited) render `X words (no cap)`.
- Rendered as a header/first row of the existing card (keeps the "Jobs in Progress"
  list intact). At 09:00 `X` is typically small (the counter reset at midnight and
  work hours start at 09:00); this is expected — it is a live gauge, not a prior-day
  summary.

---

## 6. Failure Modes (fail-loud, Constitution IV/V)

| Condition | Handling |
|---|---|
| **(C2)** `'rejected'` vs the `lifecycle_status` CHECK | Table-rebuild migration in `db.ts` widens/drops the CHECK before any `'rejected'` write. A startup smoke (existing) plus a migration test guard it. |
| **(C3)** Holiday calendar not confirmed for a span's year | Signal = **whether the year is in the curated data file**: `curated = year ∈ CURATED_YEARS`. **Uniform fail-closed:** if ANY year the now→deadline span touches is uncurated → `holidaysCuratedForSpan=false` → the gate **BLOCKs** (§2.1 step 4, `"holiday calendar not confirmed for <year>"`) + the cycle raises `holiday_calendar_stale` (loud, deduped). If the **current** year is uncurated this pauses auto-accept entirely until the year's holidays are added — but detect+notify keep running 24/7 (nothing is missed; humans accept manually), and accept is irreversible so safe-by-default wins. Resolve the alert once the year is curated. |
| Bad `HH:MM`, `start >= end`, explicit `throughput <= 0`, `capacity=0` w/o throughput, empty `workdays` | **fail-fast at startup** via zod/refine, naming the var. |
| `dueDate` null / `words` null | BLOCK "deadline unknown" / "word count unknown" (notify-only). |
| `dueAtMs <= nowMs` (past/now) | BLOCK "deadline already passed" (distinct, clearer than "cannot finish"). |
| Deadline far in the future | `workingMinutesBetween` early-exits at `requiredMin`; the **400-day cap (in code)** bounds iteration. |
| Holiday resolution / `holiday_calendar_stale` while **disabled** | Guarded behind `ACCEPT_SCHEDULE_ENABLED` — a disabled feature never resolves holidays or pages. |
| Clock/parse anomaly on `capturedAt` | `nowMs = Date.parse(capturedAt)`; NaN fails the cycle's normal path before the gate. |

---

## 7. Testing (TDD; coverage gate ≥ 80% for **detection / state / reporting / src/schedule**)

Write tests first, watch them fail, then implement. **Add `src/schedule/` to the
coverage gate** (riskiest logic). **(C5) TZ trap:** the project's CI runs UTC;
every date test below MUST use TZ-explicit `+07:00` epoch inputs (never
`new Date(y,m,d,...)` local) and include one `TZ=UTC npx vitest run` repro — this
applies to `bangkokCalendar`, `workingMinutesBetween`, the **truth-table weekday
labels**, and the **meta midnight reset**, not just `bangkokCalendar`.

- **bangkokCalendar** — UTC inputs crossing Bangkok midnight; ISO weekday (Sun→7);
  `minutesOfDay` 00:00/23:59; `bangkokEpochMs` round-trip; year rollover.
- **parseSchedule** — `parseHHMM` valid/invalid; `parseWorkdays` ranges/lists/single,
  out-of-range + **empty rejected**; `resolveThroughput` derives `1000/9 ≈ 111.1`,
  explicit override wins, different capacity/window rescales.
- **workingHours** — `workingMinutesBetween`: same-day partial (15:00→18:00=180),
  both-ends-interior (10:30→16:30=360), clamp when now<09:00 / now>18:00→next day,
  overnight gap (Mon17:00→Tue10:00=120), weekend gap (Fri17:00→Mon10:00=120), a
  holiday skipped mid-span flips ALLOW→BLOCK, full multi-day span, `end<=start→0`,
  deadline exactly 18:00 / exactly 09:00 (that day=0), `capMinutes` early-exit,
  **400-day cap + far infeasible deadline → bounded iteration → BLOCK**.
  `isNonWorkingDay`: weekend/holiday true, weekday false.
- **acceptSchedule** — full §2.3 table; **boundary pinned to a round throughput
  (100/h)** so ceil is exact: `availMin == requiredMin → ALLOW` vs `requiredMin-1
  → BLOCK` (e.g. 300 words → 180m, avail 180 ALLOW / 179 BLOCK; `334 vs 333` ceil
  edge); capacity at-cap / one-under / unlimited / over-cap; deadline past/now;
  `words=0` → ALLOW; uncurated deadline-year → BLOCK; disabled + `dueDate=null` →
  ALLOW (discriminating).
- **thaiHolidays** — pure lookup from the data file: a date present/absent;
  `curated` true (2026) / false (a far uncurated year); a known seeded นักขัตฤกษ์
  date (`2026-01-01`) hits.
- **meta** — increment; **reset across Bangkok-midnight (TZ-explicit epoch)**;
  persistence across a fresh `MetaStore` same date.
- **sheets** — `rejected → 'Rejected'`. **xtmNotifier/chatForEvent** — rejected note
  `"Rejected — <reason>"` (reporting is under the gate).
- **dailyReport** — `buildDailyReportCard` renders `Auto-accepted today: X / Y words`
  for a given counter+cap; `Y=0` → `X words (no cap)`; the line appears alongside the
  existing "Jobs in Progress" list.
- **config** — default `ACCEPT_SCHEDULE_ENABLED` ON (assert); derived throughput;
  refine rejects `start>=end`, explicit `throughput<=0`, `capacity=0`-without-throughput,
  empty workdays — only when enabled; `''` throughput → derived (not 0).
- **xtmPollCycle integration** (stub acceptor; **set the flag true + real
  dueDate/words** — existing `xraw()` defaults `dueDate:null` and would be blocked):
  - blocked job → Sheet `Rejected` + reason in Note + Chat **once**; **re-run the
    cycle twice on the same still-present blocked job → no duplicate Sheet/Chat**;
    `accept_status` stays `'none'`; counter unchanged.
  - **(C1)** a bulk group with one infeasible/over-cap member → the **whole group**
    Rejected (no member left accepted-on-portal-but-Rejected).
  - **(C4)** a robustness-pass block IS reported (not silent).
  - accepted group → counter += group words (in txn); a `failed`/`missing` accept →
    counter unchanged; cap reached mid-cycle blocks the next group.
  - `Rejected → Accepted` after a daily reset.
  - `holiday_calendar_stale` raised + deduped + resolved.
  - `ACCEPT_SCHEDULE_ENABLED=0` → byte-for-byte pre-feature (discriminating input).
- **db migration** — an existing v2 DB with the old CHECK accepts a `'rejected'`
  write after `migrate()`.

---

## 8. Rollout

- Ships **default ON**. `ACCEPT_SCHEDULE_ENABLED=0` is the one-line rollback.
- `ACCEPT_MAX_PER_CYCLE` stays `0`.
- After deploy: confirm an in-hours finishable Malay job still accepts; a too-tight
  or non-working-day-deadline job is `Rejected` with reason on the Sheet; the daily
  word counter resets at Bangkok midnight; `scheduleBlocked` counts look sane.
- **Curate the team's observed นักขัตฤกษ์ list (`CURATED_YEARS` + the 2026–2027
  dates) before deploy** — weekends are covered by `ACCEPT_WORKDAYS`; cabinet
  special / substitution days are intentionally excluded (the team works them).
  Add a yearly checklist to add the next year before December (an uncurated year
  pauses auto-accept per C3).

---

## 9. Open / Deferred (YAGNI)

- Per-weekday different hours — deferred (single window).
- Per-job/per-step throughput — out of scope (one shared rate).
