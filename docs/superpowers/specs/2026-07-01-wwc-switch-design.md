# WWC Switch — effort metric toggle (words → File WWC)

**Date:** 2026-07-01
**Status:** Design approved (brainstorming), pending implementation plan
**Feature area:** `src/schedule/` (accept-scheduling gate) + `src/runtime/` wiring + `src/reporting/` + `src/config/`

---

## 1. Goal

Let the auto-accept **feasibility** check and the daily **capacity** cap measure a job's
effort by its **File WWC (Weighted Word Count)** — the real work left after Translation
Memory leverage — instead of the raw word count, because the team plans and measures
capacity in WWC. The change is guarded by a config **toggle** so it can be reverted to
today's raw-words behavior byte-for-byte (the repo's established kill-switch convention).

## 2. Motivation

Live incident **4721900** (`Proof.html`): raw `words = 861` → the feasibility gate computed
~7.8 h and **rejected** the job as un-finishable in the ~5.4 h window, but its `File WWC = 169`
(most of the 861 words matched existing TM) → the real effort was ~1.5 h, easily finishable.
The bot rejected a job it could comfortably do because it measured effort by raw words, not WWC.
`File WWC` is already scraped and persisted (column I in the Sheet, `file_wwc` in the DB,
`fileWwc` on `XtmJobState`/`XtmRawJob`) since PR #18 — so this is purely a change of *which
metric drives the decision*, with no new data collection.

## 3. Decisions (locked during brainstorming)

| # | Decision | Choice |
|---|---|---|
| D1 | Effort when `fileWwc` is null (in wwc mode) | **Fallback to raw `words`** — `effort = fileWwc ?? words`. Conservative: raw ≥ WWC, so a fallback can never make a job look *smaller* than it is → never over-accepts. |
| D2 | Config toggle | **`ACCEPT_EFFORT_METRIC` = `wwc` \| `words`** (a kill-switch, like `ACCEPT_SCHEDULE_ENABLED`). |
| D3 | Toggle default at first deploy | **`wwc`** — WWC live immediately (fixes 4721900); the toggle is the rollback net. |
| D4 | Daily cap config | **Keep `ACCEPT_MAX_WORDS_PER_DAY` (words mode) + add `ACCEPT_MAX_WWC_PER_DAY` (wwc mode)**; the toggle selects the active cap. Kept both (not a rename) so `metric=words` reverts to *today* byte-for-byte. |
| D5 | Daily report (09:00) unit | **Follows the active metric** — WWC on every row (Due today / Overdue / In progress) when `metric=wwc`; raw words when `metric=words`. |
| D6 | Implementation shape | **`effortOf` helper + metric-agnostic pure modules** — the schedule pure modules take a bare `effort` number + `throughputPerHour`; the metric decision lives only in the wiring layer (config + cycle). |

## 4. Architecture & data flow

```
config ACCEPT_EFFORT_METRIC ('wwc' default | 'words')
   │
   ├─ config resolves (§5.5): activeMaxPerDay = metric==='wwc' ? ACCEPT_MAX_WWC_PER_DAY : ACCEPT_MAX_WORDS_PER_DAY
   │                          throughputPerHour = activeMaxPerDay ÷ workingHoursPerDay   (WWC/h or words/h)
   ├─ cycle resolves per job (§5.6): effortOf(s) = metric==='wwc' ? (s.fileWwc ?? s.words) : s.words
   ▼
   a single `effort` number + `activeMaxPerDay` + `throughputPerHour` flow into the METRIC-AGNOSTIC pure modules:
       • evaluateAcceptSchedule   — feasibility: ceil(effort / throughputPerHour × 60) ≤ working-minutes-to-deadline
       • decideGroupCapacity      — capacity: Σ effort per deadline day ≤ activeCap
       • effortDueByDeadline      — held-list bucket that seeds capacity (Σ effort of held jobs per day)
       • dailyReport              — Σ effort per day, label by metric
```

**Key invariant:** the metric is decided in exactly ONE place (the cycle wiring, driven by config).
Every pure module below it receives an already-resolved `effort` and does not know or care whether
it is WWC or words. This keeps the schedule math untouched and testable in isolation, and makes the
toggle a pure wiring concern.

## 5. Components

### 5.1 `src/schedule/effort.ts` — NEW (pure, TDD, coverage-gated)

```ts
export type EffortMetric = 'wwc' | 'words';

/** The effort a job costs under the active metric. In 'wwc' mode, File WWC is the real
 *  post-TM effort; a null WWC falls back to raw words (raw ≥ WWC → never under-counts →
 *  never over-accepts). In 'words' mode, always the raw word count (today's behavior). */
export function effortOf(
  job: Pick<XtmJobState, 'words' | 'fileWwc'>,
  metric: EffortMetric,
): number | null {
  if (metric === 'words') return job.words;
  return job.fileWwc ?? job.words;
}
```

### 5.2 `src/schedule/acceptSchedule.ts` — rename to metric-agnostic

- `AcceptScheduleInput.words: number | null` → **`effort: number | null`**
- `AcceptScheduleInput.throughputWordsPerHour` → **`throughputPerHour`**
- Body: `i.words` → `i.effort`; the `words === null` guard becomes `effort === null` with reason
  `'effort unknown'` (was `'word count unknown'`). All arithmetic unchanged.

### 5.3 `src/schedule/acceptCapacity.ts` — rename

- `CapacityMember.words: number` → **`effort: number`**. `decideGroupCapacity` body: `mem.words` →
  `mem.effort`. Reason strings change `words` → `effort` (or a metric-neutral phrasing). Logic unchanged.

### 5.4 `src/state/xtmJobStore.ts` — inject the effort mapper

- `wordsDueByDeadline(dayOf)` → **`effortDueByDeadline(dayOf, effortOf)`** where
  `effortOf: (s: XtmJobState) => number`. Body: `s.words ?? 0` → `effortOf(s)`. The store stays
  metric-agnostic — the cycle passes `(s) => effortOf(s, metric) ?? 0`.
- The sibling helper that classifies "missing-deadline" held jobs is unchanged (it keys off
  deadline parseability, not the effort value).

### 5.5 `src/config/index.ts` + `.env.example`

- Add **`ACCEPT_EFFORT_METRIC`**: zod enum `['wwc','words']`, default `'wwc'`.
- Add **`ACCEPT_MAX_WWC_PER_DAY`**: positive int, default `1000` (tune at deploy).
- **Config resolves the active values in ONE place** (so the cycle + report just consume, no
  duplicated metric branching):
  - `activeMaxPerDay` = `metric==='wwc' ? ACCEPT_MAX_WWC_PER_DAY : ACCEPT_MAX_WORDS_PER_DAY`.
  - `resolveThroughput` derives `throughputPerHour` from **`activeMaxPerDay` ÷ workingHoursPerDay**.
    An explicit `ACCEPT_THROUGHPUT_WORDS_PER_HOUR` override, if set, still wins (unchanged
    precedence) and is interpreted in the **active unit** (WWC/h in wwc mode, words/h in words mode).
- `.env.example` documents the toggle + that the two caps are per-metric and the toggle picks one.

### 5.6 `src/runtime/xtmPollCycle.ts` — the single per-job wiring point

The cycle consumes the config-resolved `activeMaxPerDay` + `throughputPerHour` (no metric branching
for cap/throughput — that lives in config, §5.5) and only maps each job to its effort:

- Resolve once per `run()`: `const metric = this.cfg.ACCEPT_EFFORT_METRIC;`
  `const eff = (s) => effortOf(s, metric);`.
- Feasibility call (currently `words: s.words, throughputWordsPerHour: cfg.throughputWordsPerHour`)
  → `effort: eff(s), throughputPerHour: cfg.throughputPerHour`.
- Capacity members (currently `{ words: s.words ?? 0, deadlineDate: day }`)
  → `{ effort: eff(s) ?? 0, deadlineDate: day }`; `cap` = `cfg.activeMaxPerDay`.
- Bucket seed (currently `this.store.wordsDueByDeadline(effDayOf)`)
  → `this.store.effortDueByDeadline(effDayOf, (s) => eff(s) ?? 0)`.

### 5.7 `src/reporting/dailyReport.ts`

- Sum `effortOf(j, metric) ?? 0` instead of `j.words ?? 0` for Due-today, Overdue, and
  In-progress rows; the unit label reads `WWC` when `metric==='wwc'`, else `words`. The daily
  report already receives the config; thread `metric` (+ the active cap) through its input.

### 5.8 `CLAUDE.md`

- Document the switch and update the "2 สวิตช์ accept" note to **3** (`ACCEPT_ENABLED`,
  `ACCEPT_SCHEDULE_ENABLED`, `ACCEPT_EFFORT_METRIC`), noting `metric=words` reverts to raw-words
  byte-for-byte.

## 6. Error handling & edge cases

- **`fileWwc` null in wwc mode** → fallback to `words` (D1). Never over-accepts (raw ≥ WWC).
- **Both `fileWwc` and `words` null** → `effortOf` returns `null` → the existing feasibility
  `effort === null` guard rejects with `'effort unknown'`. Preserved end-to-end.
- **`metric=words`** → uses `words` + `ACCEPT_MAX_WORDS_PER_DAY` + words-derived throughput. This is
  today's exact behavior; the entire WWC path is gated behind the toggle so an off-state cannot
  drift. (Verified by a "toggle=words reproduces today" test.)
- **Stale/wrong WWC from XTM** → out of scope for this feature; `parseXtmWwc` already validates the
  scraped value (PR #18). The mitigation for a bad WWC source is flipping the toggle to `words`.
- **Cap re-denomination awareness** → with `metric=wwc` and the same numeric cap, more jobs fit per
  day (WWC ≤ words). The team sets `ACCEPT_MAX_WWC_PER_DAY` to their real WWC/day capacity at deploy.

## 7. Testing strategy (TDD; `schedule`/`state`/`reporting` are coverage-gated ≥80%)

- **`effort.ts`**: `wwc` + `fileWwc` present → WWC; `wwc` + `fileWwc` null → words; `words` mode →
  words regardless of `fileWwc`; both null → null.
- **`acceptSchedule.ts` / `acceptCapacity.ts`**: rename-only; existing tests updated to the new field
  names, values unchanged — proving the math is metric-agnostic.
- **`xtmJobStore.effortDueByDeadline`**: sums the injected mapper per deadline day (a WWC mapper and
  a words mapper produce the expected per-day totals).
- **cycle integration (the 4721900 lock)**: with `metric=wwc`, a job `words=861, fileWwc=169` in a
  ~5.4 h window is **accepted**; the SAME job under `metric=words` is **rejected** — one test file,
  two configs, proving the switch fixes the incident and the off-state reproduces it.
- **config**: default `wwc`; both caps parse; throughput derives from the active cap; explicit
  throughput override still wins.
- **dailyReport**: Due-today / Overdue / In-progress totals + unit label are WWC under `metric=wwc`,
  words under `metric=words`. TZ-explicit `+07:00` inputs (CI runs UTC).

## 8. Out of scope (YAGNI)

- Tracking words and WWC in parallel in the report (D5 chose WWC-only display when on).
- Per-language or per-project WWC caps.
- Any change to how `fileWwc` is scraped/parsed (already shipped in PR #18).
- A UI/Chat toggle — the switch is a deploy-time env var, consistent with the other accept switches.

## 9. Complexity Tracking (Constitution)

No new principle violations. The pure modules remain TDD + coverage-gated; `detection/diff.ts` stays
the sole state-transition owner (untouched); the change adds one config-gated behavior with a
byte-for-byte kill-switch, consistent with `ACCEPT_SCHEDULE_ENABLED`. The two pre-existing
Complexity-Tracking entries (daily-summary deferral, at-least-once window) are unaffected.
