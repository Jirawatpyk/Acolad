# WWC Switch — effort metric toggle (words → File WWC)

**Date:** 2026-07-01
**Status:** Design approved + revised after a 3-specialist spec review (reliability / qa / architecture)
**Feature area:** `src/schedule/` (accept-scheduling gate) + `src/runtime/` wiring + `src/reporting/` +
`src/config/` + `src/portal/` (alert copy)

---

## 1. Goal

Let the auto-accept **feasibility** check and the daily **capacity** cap measure a job's
effort by its **File WWC (Weighted Word Count)** — the real work left after Translation
Memory leverage — instead of the raw word count, because the team plans and measures
capacity in WWC. The change is guarded by a config **toggle** so it can be reverted to
today's raw-words behavior byte-for-byte (the repo's kill-switch convention).

## 2. Motivation

Live incident **4721900** (`Proof.html`): raw `words = 861` → the feasibility gate computed
~7.8 h and **rejected** the job as un-finishable in the ~5.4 h window, but its `File WWC = 169`
(most of the 861 words matched existing TM) → the real effort was ~1.5 h, easily finishable.
`File WWC` is already scraped and persisted (`file_wwc` in the DB, `fileWwc` on
`XtmJobState`/`XtmRawJob`, Sheet column I) since PR #18 — so this changes only *which metric
drives the decision*, with no new data collection.

## 3. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Effort under the wwc metric | **`effort = (fileWwc && fileWwc > 0) ? fileWwc : words`** — File WWC when it is a real positive value; fall back to raw `words` when WWC is **null OR 0**. Rationale: WWC ≤ words, so a fallback never makes a job look *smaller* → never over-accepts; and treating a `0` as fallback guards against a **scrape error returning 0 on a real job** (an irreversible over-accept), at the cost of over-estimating a genuinely-fully-TM-matched job (rare, and only *rejects* a free job → recoverable). |
| D2 | Config toggle | **`ACCEPT_EFFORT_METRIC` = `wwc` \| `words`** (a kill-switch, like `ACCEPT_SCHEDULE_ENABLED`). |
| D3 | Toggle default at first deploy | **`wwc`** — WWC live immediately; the toggle is the rollback net. |
| D4 | Daily cap config | Keep `ACCEPT_MAX_WORDS_PER_DAY` (words mode) + add **`ACCEPT_MAX_WWC_PER_DAY`, which is REQUIRED (no default) when `metric=wwc`** — the bot refuses to start otherwise (fail-fast), forcing a deliberate WWC/day ceiling. Kept both caps so `metric=words` reverts to *today* byte-for-byte. |
| D5 | Daily report (09:00) unit | Follows the active metric — WWC on every row when `metric=wwc`, raw words when `metric=words`. |
| D6 | Implementation shape | `effortOf` helper + **metric-agnostic pure modules** — the schedule pure modules take a bare `effort` number + `throughputPerHour` + a display-only `unitLabel`; the metric *decision* lives only in the wiring (config + cycle). |
| D7 | Throughput override | Add **`ACCEPT_THROUGHPUT_WWC_PER_HOUR`, symmetric with the two caps** — the metric selects the active override so an existing `ACCEPT_THROUGHPUT_WORDS_PER_HOUR` value can NEVER be silently reinterpreted across units on a flip. |
| D8 | Reason / alert copy | The gate's reject-reason strings and the cap alerts use the **active unit word ("words"/"WWC")**, not a generic "effort" — so `metric=words` reproduces today's text byte-for-byte and `metric=wwc` reads correctly for ops. |
| D9 | Reject telemetry | `scheduleRejects` keeps the raw `words` AND adds the `effort` value the decision actually used (+ the metric), so ops can see the leverage (861 → 169) that drove a reject/accept. |
| D10 | Sequencing | Land the mechanical **rename (`words`→`effort`) as its own behavior-preserving commit FIRST**, then the metric toggle on top — so "metric=words is byte-for-byte" is verifiable and the diff bisects cleanly. |

## 4. Architecture & data flow

```
config ACCEPT_EFFORT_METRIC ('wwc' default | 'words')
   │
   ├─ config resolves (§5.5), once at load:
   │     activeMaxPerDay   = metric==='wwc' ? ACCEPT_MAX_WWC_PER_DAY (required) : ACCEPT_MAX_WORDS_PER_DAY
   │     throughputPerHour = active override (ACCEPT_THROUGHPUT_WWC/WORDS_PER_HOUR) ?? activeMaxPerDay ÷ hours/day
   │     unitLabel         = metric==='wwc' ? 'WWC' : 'words'
   ├─ cycle resolves per job (§5.6): effortOf(s) = (s.fileWwc && s.fileWwc>0) ? s.fileWwc : s.words
   ▼
   a bare `effort` number + `activeMaxPerDay` + `throughputPerHour` + `unitLabel` flow into the
   METRIC-AGNOSTIC pure modules (they do NOT know it is WWC or words; unitLabel is display-only):
       • evaluateAcceptSchedule   — feasibility: ceil(effort / throughputPerHour × 60) ≤ working-minutes-to-deadline
       • decideGroupCapacity      — capacity: Σ effort per deadline day ≤ activeMaxPerDay
       • effortDueByDeadline      — held-list bucket (Σ effort of held jobs per deadline day) that seeds capacity
       • dailyReport              — Σ effort per day + the active cap + unitLabel
```

**Key invariant:** the metric is *decided* in exactly ONE place (config + the cycle's per-job
`effortOf`). Every pure module receives an already-resolved `effort`. `unitLabel` rides alongside for
*display only* — it never enters the arithmetic, so the math stays metric-agnostic and independently
testable. NOTE (scope, not a leak of the invariant): text/label surfaces are a **second touch-point** —
config exposes `metric`/`unitLabel`/`activeMaxPerDay`, and every consumer that renders a unit word or
names the cap env var must consume them (§5.9).

## 5. Components

### 5.1 `src/schedule/effort.ts` — NEW (pure, TDD, coverage-gated)

```ts
export type EffortMetric = 'wwc' | 'words';

/** Effort under the active metric. In 'wwc' mode, File WWC is the real post-TM effort; a null OR
 *  zero WWC falls back to raw words (WWC ≤ words → never under-counts → never over-accepts; the
 *  zero-guard defends against a scrape returning 0 on a real job). In 'words' mode, always raw words. */
export function effortOf(job: Pick<XtmJobState, 'words' | 'fileWwc'>, metric: EffortMetric): number | null {
  if (metric === 'words') return job.words;
  return job.fileWwc && job.fileWwc > 0 ? job.fileWwc : job.words;
}
```

### 5.2 `src/schedule/acceptSchedule.ts` — metric-agnostic rename + unit label

- `AcceptScheduleInput.words: number | null` → **`effort: number | null`**;
  `throughputWordsPerHour` → **`throughputPerHour`**; add **`unitLabel: string`** (display only).
- Body: `i.words` → `i.effort`; the null guard reason `'word count unknown'` → **`'${unitLabel} count unknown'`**
  (so words mode = `'words count unknown'`, wwc mode = `'WWC count unknown'`). All arithmetic unchanged.
- The `'cannot finish in time (need ~Xh, have ~Yh …)'` reason is unit-free and unchanged.

### 5.3 `src/schedule/acceptCapacity.ts` — rename + unit label

- `CapacityMember.words: number` → **`effort: number`**. Add a `unitLabel` parameter to
  `decideGroupCapacity` (display only). Reason strings: `'group words due …'` /
  `'daily word cap reached …'` → **`'group ${unitLabel} due …'` / `'daily ${unitLabel} cap reached …'`**.
  Logic unchanged.

### 5.4 `src/state/xtmJobStore.ts` — inject the effort mapper

- `wordsDueByDeadline(dayOf)` → **`effortDueByDeadline(dayOf, effortOf)`** where
  `effortOf: (s: XtmJobState) => number`. Body: `s.words ?? 0` → `effortOf(s)`. The cycle passes
  `(s) => effortOf(s, metric) ?? 0`, keeping the store metric-agnostic.

### 5.5 `src/config/index.ts` + `.env.example`

- Add **`ACCEPT_EFFORT_METRIC`**: zod enum `['wwc','words']`, default `'wwc'`. An invalid value fails
  fast at startup.
- Add **`ACCEPT_MAX_WWC_PER_DAY`**: positive int, **no default**.
- Add **`ACCEPT_THROUGHPUT_WWC_PER_HOUR`**: optional positive number override (symmetric to the words one).
- **Config resolves the active values in ONE place** (a `.transform`, as the config already does for
  `throughputWordsPerHour`/`workdays`) so cycle + report + alerts consume, not re-branch:
  - `activeMaxPerDay` = `metric==='wwc' ? ACCEPT_MAX_WWC_PER_DAY : ACCEPT_MAX_WORDS_PER_DAY`.
  - `throughputPerHour` = the **active** override (`metric==='wwc' ? ACCEPT_THROUGHPUT_WWC_PER_HOUR :
    ACCEPT_THROUGHPUT_WORDS_PER_HOUR`) if set, else `activeMaxPerDay ÷ workingHoursPerDay`.
  - `unitLabel` = `metric==='wwc' ? 'WWC' : 'words'`.
- **Update the resolvability refine** (currently `src/config/index.ts:158-168`, tied to
  `ACCEPT_MAX_WORDS_PER_DAY > 0`) to gate on the **active** cap/override per metric, folding in D4:
  `!ACCEPT_SCHEDULE_ENABLED || (active override set) || (activeMaxPerDay > 0)` — and, specifically,
  `metric==='wwc'` requires `ACCEPT_MAX_WWC_PER_DAY` to be set > 0. This closes the "wwc mode +
  wwc-cap 0 + words-cap 1000 → passes validation → throughput 0 → rejects every job silently" hole.
- `.env.example` documents the toggle, that the two caps + two overrides are per-metric, and that
  `ACCEPT_MAX_WWC_PER_DAY` is required in wwc mode.

### 5.6 `src/runtime/xtmPollCycle.ts` — the per-job wiring point

Consumes config-resolved `activeMaxPerDay` / `throughputPerHour` / `unitLabel` (no metric branching
for cap/throughput) and maps each job to its effort:

- `const metric = this.cfg.ACCEPT_EFFORT_METRIC; const eff = (s) => effortOf(s, metric);`
- Feasibility (`words: s.words, throughputWordsPerHour: cfg.throughputWordsPerHour`)
  → `effort: eff(s), throughputPerHour: cfg.throughputPerHour, unitLabel: cfg.unitLabel`.
- Capacity members (`{ words: s.words ?? 0, deadlineDate: day }`) → `{ effort: eff(s) ?? 0, deadlineDate: day }`;
  `cap` = `cfg.activeMaxPerDay`; pass `cfg.unitLabel` to `decideGroupCapacity`.
- Bucket seed (`this.store.wordsDueByDeadline(effDayOf)`) → `this.store.effortDueByDeadline(effDayOf, (s) => eff(s) ?? 0)`.
- **Telemetry (D9):** `summary.scheduleRejects[]` keeps `words: s.words` AND adds `effort: eff(s)` +
  `metric`. Rename `AcceptedDueDay.resultingBucketWords` → `resultingBucketEffort` (a bare effort value).

### 5.7 `src/reporting/dailyReport.ts`

- `buildDailyReportCard(held, nowMs, url, cap, effectiveDay, capEnforced)` gains a **`unitLabel`
  parameter** (threaded from config at the call site `src/runtime/xtmPollLoop.ts`, which must also pass
  the **active** cap, not `ACCEPT_MAX_WORDS_PER_DAY` — else wwc mode shows "X WWC (cap 1000/day)" with a
  words number). Do NOT pass the whole config object — keep the discrete-param shape.
- Sum `effortOf(j, metric) ?? 0` for Due-today, Overdue, and In-progress; the per-job value (`${j.words}w`)
  and the headline unit render `unitLabel`.

### 5.8 `src/config/index.ts` config type + `CLAUDE.md`

- Document the switch; update the "2 สวิตช์ accept" note to **3**
  (`ACCEPT_ENABLED`, `ACCEPT_SCHEDULE_ENABLED`, `ACCEPT_EFFORT_METRIC`), noting `metric=words`
  reverts byte-for-byte and `ACCEPT_MAX_WWC_PER_DAY` is required in wwc mode.

### 5.9 Alert / label surface (the second touch-point)

Every hardcoded "word(s)" that ops or the team reads must consume `unitLabel` / the active cap /
the active env-var name:

- `src/runtime/xtmPollCycle.ts` `daily_cap_reached` alert text (`the ${cap}-word daily cap`) → `unitLabel`.
- `src/reporting/systemAlerts.ts` — the `daily_cap_reached` static card's title/impact/**action names
  `ACCEPT_MAX_WORDS_PER_DAY`**, which is the WRONG env var in wwc mode (ops hazard). Make the action name
  the active cap var (`ACCEPT_MAX_WWC_PER_DAY` in wwc mode) and the copy use `unitLabel`.
- `src/reporting/systemAlerts.ts` `held_job_no_deadline` ("daily word cap") → `unitLabel`.

### 5.10 Telemetry / summary types

- `XtmCycleSummary.scheduleRejects[]`: add `effort: number | null` + `metric` alongside the kept `words`.
- `AcceptedDueDay.resultingBucketWords` → `resultingBucketEffort`; update the `xtmPollLoop.ts` log site.

## 6. Error handling & edge cases

- **`fileWwc` null OR 0 in wwc mode** → fallback to `words` (D1). Never over-accepts; the zero-guard
  defends against a scrape error returning 0 on a real (`words`>0) job — the single most dangerous
  bad-WWC case, since `effort=0` would otherwise pass feasibility AND add 0 to capacity (bypassing both
  gates, on the irreversible bulk-accept path).
- **Both `fileWwc` and `words` null** → `effortOf` returns `null` → the feasibility `effort === null`
  guard rejects (`'${unitLabel} count unknown'`); capacity is skipped (blocked upstream). Preserved.
- **`metric=words`** → uses `words` + `ACCEPT_MAX_WORDS_PER_DAY` + words-derived throughput + "words"
  labels: today's behavior AND text, byte-for-byte. The entire WWC path is gated behind the toggle.
- **`metric=wwc` with `ACCEPT_MAX_WWC_PER_DAY` unset** → config refuses to start (D4, fail-fast) — no
  silent over-accept from a copied default.
- **Toggle-flip semantics** (reviewed safe — no double-count; held effort is recomputed fresh each cycle
  from the held list, never carried across cycles):
  - held jobs are re-valued under the new metric on the next cycle (intentional re-denomination).
  - `wwc→words` re-values held jobs *larger* (WWC ≤ words) → buckets tighten → fail-closed (safe).
  - `words→wwc` re-values held jobs *smaller* → opens capacity; safe **provided `ACCEPT_MAX_WWC_PER_DAY`
    is set correctly first** — enforced by D4's required-in-wwc.
- **`decideAccept` (per-job `ACCEPT_MAX_WORDS` skip, `src/detection/acceptDecision.ts`)** deliberately
  stays on raw `words` — it is inert in prod (`ACCEPT_MAX_WORDS = 0`) and is a *different* gate (per-job
  language/cap skip, not the schedule feasibility/capacity). Footnoted so "metric decided in one place"
  is not misread as covering it.
- **Stale/wrong WWC from XTM** → beyond the 0-guard above, a wrong-but-nonzero WWC is out of scope;
  `parseXtmWwc` validates the scraped value (PR #18), and the kill-switch (flip to `words`) is the
  mitigation.

## 7. Testing strategy (TDD; `schedule`/`state`/`reporting` are coverage-gated ≥80%)

> **Why integration tests carry extra weight here:** the toggle *wiring* lives in `runtime/xtmPollCycle.ts`
> and `config/index.ts`, which are **outside** the ≥80% coverage gate (only detection/state/reporting/
> schedule are gated). The four pure modules can be green and the gate can pass while the toggle is
> mis-wired — so the cycle/config integration tests below are the real safety net, not a nicety.

**Unit — `schedule/effort.ts`** (pin values, not just shape):
- `wwc` + `fileWwc>0` (e.g. `{words:861,fileWwc:169}`) → 169; `wwc` + `fileWwc=null` → words; `wwc` +
  `fileWwc=0` → words (the scrape-0 guard); `words` mode + **non-null** `fileWwc` → words (proves it
  ignores WWC); both null → null.

**Unit — `acceptSchedule.ts` / `acceptCapacity.ts`** (rename is NOT self-proving):
- Keep the load-bearing characterization values fixed after the rename — the boundary + F10 epsilon
  tests (`acceptSchedule.test.ts:83,113`) with identical numbers, only field names changed.
- **Assert the FULL reason string** for each guard whose wording changes:
  `{allow:false, reason:'words count unknown'}` (words), `'WWC count unknown'` (wwc); the
  `'group WWC due …'` / `'daily WWC cap reached …'` capacity reasons.
- Plan note: the reviewer must confirm the `acceptSchedule.ts`/`acceptCapacity.ts` diff is a **pure
  identifier substitution** (+ the `unitLabel` threading) — renaming tests alone is not the gate.

**Unit — `xtmJobStore.effortDueByDeadline`**: sums the injected mapper per deadline day; a WWC mapper and
a words mapper on the same held rows give the expected per-day totals; a both-null held job → contributes
0 (not NaN). Migrate the 7 existing `wordsDueByDeadline()` call sites in `xtmCycle.test.ts`. **Fix the
`accepted()` seed helper (`xtmCycle.test.ts:104` hardcodes `fileWwc:null`) to accept a `fileWwc`** — else
WWC seed tests silently fall back to words.

**Integration — `xtmCycle.test.ts` (the toggle net):**
- **4721900 lock (pinned):** `xraw({words:861, fileWwc:169, dueDate: dueMon1524})` where
  `dueMon1524 = '2026-06-22T15:24:00+07:00'` = 324 working-min from `MON_10` = 5.4 h, throughput
  identical across runs. `metric=words` → **rejected**, assert reason contains `'cannot finish in time'`
  + `'need ~7.8h'` + `'have ~5.4h'` (pins the feasibility fingerprint, not an accidental capacity/holiday
  reject). `metric=wwc` → **accepted**. TZ-explicit `+07:00`.
- **D1 null-fallback (safety):** `xraw({words:861, fileWwc:null, dueDate: dueMon1524})`, `metric=wwc` →
  **rejected** via the 861 fallback (proves null is not treated as 0 → no over-accept).
- **D1 zero-guard:** same job with `fileWwc:0` → **rejected** (proves 0 falls back to words).
- **Capacity keys off effort:** `xraw({words:1500, fileWwc:800, dueDate: dueWed18})`,
  `ACCEPT_MAX_WWC_PER_DAY:1000`, `metric=wwc` → **accepted** (WWC 800 ≤ cap); the SAME job under
  `metric=words` → `over_cap_permanent` reject. Catches a half-wire where only feasibility switched.
- **Seed-under-wwc:** a held job seeded with a real `fileWwc` proves `effortDueByDeadline` buckets the
  WWC, not words.
- **Malformed job (failure-mode):** `xraw({words:null, fileWwc:null})`, `metric=wwc` → **rejected**,
  reason `'WWC count unknown'`, acceptor not called (no crash).

**Unit — `config.test.ts`:**
- default `metric='wwc'`; `metric='garbage'` → **throws at startup** (fail-fast failure-mode);
  `metric=wwc` → `activeMaxPerDay = ACCEPT_MAX_WWC_PER_DAY`, `throughputPerHour ≈ cap/9`;
  `metric=words` → active = `ACCEPT_MAX_WORDS_PER_DAY` (byte-for-byte); active override wins per metric;
  **`metric=wwc` without `ACCEPT_MAX_WWC_PER_DAY` → throws** (D4).

**Unit — `dailyReport.test.ts`** (port the existing per-job value suite; the factories `job()`:104 and
`makeJob`:358 must set `fileWwc`):
- `metric=wwc`: Due-today/Overdue/In-progress sum WWC, headline reads `WWC`, cap is the WWC cap;
  a `fileWwc=null` held job sums via words fallback. Twin `metric=words` → sums words, reads `words`,
  ignores `fileWwc`. Decide + test `buildDailyReportCard`'s new `unitLabel` param (required; update call
  sites). TZ-explicit `+07:00`.

## 8. Out of scope (YAGNI)

- Parallel words+WWC display in the report (D5 chose active-metric display).
- Per-language / per-project WWC caps.
- Changing how `fileWwc` is scraped/parsed (shipped PR #18).
- A UI/Chat toggle — the switch is a deploy-time env var, like the other accept switches.
- A heuristic "WWC wildly < words" anomaly detector beyond the `0`-guard (would risk false positives on
  genuine high-leverage jobs — the whole point of the feature).

## 9. Complexity Tracking (Constitution)

No new principle violations. The pure modules stay TDD + coverage-gated; `detection/diff.ts` remains the
sole state-transition owner (untouched); the change adds one config-gated behavior with a fail-fast
required cap and a byte-for-byte kill-switch, consistent with `ACCEPT_SCHEDULE_ENABLED`. The two existing
Complexity-Tracking entries (daily-summary deferral, at-least-once window) are unaffected.

## 10. Implementation sequencing (D10)

1. **Commit/PR A — mechanical rename, behavior-preserving:** `words`→`effort`,
   `throughputWordsPerHour`→`throughputPerHour`, `CapacityMember.words`→`effort`,
   `wordsDueByDeadline`→`effortDueByDeadline`, `resultingBucketWords`→`resultingBucketEffort`, plus the
   `unitLabel` param threaded with a constant `'words'`. No behavior/text change; existing tests keep
   their numbers (only field names), characterization values fixed. This makes the kill-switch's
   "metric=words = today" claim verifiable and bisectable.
2. **Commit/PR B — the metric toggle on top:** `effort.ts`, the two new config vars + required refine +
   active-value resolution, `effortOf` wiring in the cycle, telemetry (D9), the label/alert surface
   (§5.9/§5.10), the report unit, and all the new tests in §7.

(If shipped as one PR, keep the two commits in this order.)
