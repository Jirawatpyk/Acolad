# WWC Switch — effort metric toggle (words → File WWC)

**Date:** 2026-07-01
**Status:** Design approved + revised TWICE after two rounds of a 3-specialist spec review
(reliability / qa / architecture). v3 folds round-2 findings + the user's cap-default & scope decisions.
**Feature area:** `src/schedule/` (gate) + `src/runtime/` wiring + `src/reporting/` (report, alerts,
Chat cards) + `src/config/`

---

## 1. Goal

Let the auto-accept **feasibility** check and the daily **capacity** cap measure a job's
effort by its **File WWC (Weighted Word Count)** — the real work left after Translation
Memory leverage — instead of the raw word count, because the team plans and measures
capacity in WWC. Guarded by a config **toggle** so it reverts to today's raw-words behavior
byte-for-byte (the repo's kill-switch convention).

## 2. Motivation

Incident **4721900** (`Proof.html`): raw `words = 861` → the feasibility gate computed ~7.8 h and
**rejected** the job as un-finishable in the ~5.4 h window, but its `File WWC = 169` (most of the 861
words matched TM) → the real effort was ~1.5 h, easily finishable. `File WWC` is already scraped and
persisted (`file_wwc` DB col, `fileWwc` on `XtmJobState`/`XtmRawJob`, Sheet col I) since PR #18 — so
this changes only *which metric drives the decision*, no new data collection.

## 3. Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Effort under the wwc metric | **`effort = (fileWwc && fileWwc > 0) ? fileWwc : words`** — File WWC when it is a real positive value; fall back to raw `words` when WWC is **null OR 0**. WWC ≤ words → a fallback never makes a job look *smaller* → never over-accepts; the `0`-guard blocks a **scrape returning 0 on a real job** (an irreversible over-accept), at the cost of over-estimating a genuinely-fully-TM-matched job (rare; only *rejects* a free job → recoverable). |
| D2 | Config toggle | **`ACCEPT_EFFORT_METRIC` = `wwc` \| `words`** (kill-switch, like `ACCEPT_SCHEDULE_ENABLED`). |
| D3 | Toggle default | **`wwc`** — WWC live immediately; the toggle is the rollback net. |
| D4 | Daily cap config | Keep `ACCEPT_MAX_WORDS_PER_DAY` (words mode) + add **`ACCEPT_MAX_WWC_PER_DAY` with default `1000`** (a conscious starting ceiling; tune at deploy). Kept both caps so `metric=words` reverts byte-for-byte. NOTE the value implication: `1000 WWC/day` accepts *more real work* than `1000 words/day` (WWC ≤ words) — partly intended (recovers jobs raw-words wrongly rejected); tune down if too much. |
| D5 | Daily report unit | Follows the active metric — WWC on every row when `metric=wwc`, raw words when `metric=words`. |
| D6 | Implementation shape | `effortOf` helper + **metric-agnostic pure modules** — schedule pure modules take a bare `effort` number + `throughputPerHour`; the metric *decision* lives only in the wiring. |
| D7 | Throughput override | Add **`ACCEPT_THROUGHPUT_WWC_PER_HOUR`, symmetric with the two caps** — the metric selects the active override so an `ACCEPT_THROUGHPUT_WORDS_PER_HOUR` value can never be silently reinterpreted across units on a flip. |
| D8 | Reason / alert copy | `metric=words` reproduces **today's exact reason/alert strings byte-for-byte** (incl. the singular "word" adjective — "word count unknown", "daily word cap reached"); `metric=wwc` substitutes the initialism **"WWC"** at each unit site. Achieved by passing the unit word in the **grammatical form each site needs** (an adjective token `word`/`WWC` and, where used, a noun token `words`/`WWC`) — NOT one plural `unitLabel` interpolated into every slot. |
| D9 | Reject telemetry | `scheduleRejects` keeps raw `words` AND adds the `effort` used + `metric`, so logs show the leverage (861 → 169) that drove a reject/accept. |
| D10 | Sequencing | Land the mechanical **rename (`words`→`effort`) as its own commit FIRST — a pure identifier substitution with the reason STRINGS untouched** (so it is provably behavior- and text-preserving); the metric toggle + unit-aware strings go in the second commit. |
| D11 | Chat cards | The human-facing Chat cards (`xtmNotifier` new/relisted/accepted) gain a **`File WWC` row alongside `Words`, always** (both metrics), so the team sees the leverage that drove the decision in Chat, not only in the Sheet. |

## 4. Architecture & data flow

```
config ACCEPT_EFFORT_METRIC ('wwc' default | 'words')
   │
   ├─ config resolves (§5.5), once at load — always finite/defined:
   │     activeMaxPerDay   = (metric==='wwc' ? ACCEPT_MAX_WWC_PER_DAY : ACCEPT_MAX_WORDS_PER_DAY)   // both have defaults → always number
   │     throughputPerHour = active override (WWC/WORDS) ?? activeMaxPerDay ÷ hours/day
   │     unit              = metric==='wwc' ? {adj:'WWC', noun:'WWC'} : {adj:'word', noun:'words'}
   ├─ cycle resolves per job (§5.6): effortOf(s) = (s.fileWwc && s.fileWwc>0) ? s.fileWwc : s.words
   ▼
   a bare `effort` number + `activeMaxPerDay` + `throughputPerHour` (+ `unit` for display only) flow
   into the METRIC-AGNOSTIC pure modules — they never branch on metric and never touch `unit` in math:
       • evaluateAcceptSchedule   — feasibility: ceil(effort / throughputPerHour × 60) ≤ working-minutes-to-deadline
       • decideGroupCapacity      — capacity: Σ effort per deadline day ≤ activeMaxPerDay
       • effortDueByDeadline      — held-list bucket (Σ effort of held jobs per deadline day)
       • dailyReport              — Σ effort per day + active cap + unit
```

**Key invariant:** the metric is *decided* in ONE place (config + per-job `effortOf`). Pure modules
receive a resolved `effort`; `unit` rides alongside for *display only*. **Second touch-point (scope,
not a leak):** every text/label surface that renders a unit word or names the cap env var consumes
`unit` / `activeMaxPerDay` / `metric` (§5.9, §5.11).

## 5. Components

### 5.1 `src/schedule/effort.ts` — NEW (pure, TDD, coverage-gated)
```ts
export type EffortMetric = 'wwc' | 'words';
/** Effort under the active metric. 'wwc': File WWC, falling back to raw words when WWC is null OR 0
 *  (WWC ≤ words → never over-accepts; the 0-guard defends a scrape-0 on a real job). 'words': raw words. */
export function effortOf(job: Pick<XtmJobState, 'words' | 'fileWwc'>, metric: EffortMetric): number | null {
  if (metric === 'words') return job.words;
  return job.fileWwc && job.fileWwc > 0 ? job.fileWwc : job.words;
}
```

### 5.2 `src/schedule/acceptSchedule.ts` — metric-agnostic rename + unit token
- `AcceptScheduleInput.words: number | null` → **`effort: number | null`**; `throughputWordsPerHour` →
  **`throughputPerHour`**; add a **`unit: { adj: string }`** (display only).
- Body: `i.words` → `i.effort`. Null-guard reason `'word count unknown'` → **`'${unit.adj} count unknown'`**
  → words-mode `'word count unknown'` (unchanged), wwc-mode `'WWC count unknown'`.
  The `'throughputWordsPerHour must be positive'` internal reason → `'throughput must be positive'`
  (identifier-neutral). The `'cannot finish in time (need ~Xh, have ~Yh)'` reason is unit-free, unchanged.

### 5.3 `src/schedule/acceptCapacity.ts` — rename + unit token
- `CapacityMember.words: number` → **`effort: number`**. Add `unit: { adj: string; noun: string }`.
  Reasons: `'group words due …'` → `'group ${unit.noun} due …'` (words-mode `'group words due'` unchanged);
  `'daily word cap reached …'` → `'daily ${unit.adj} cap reached …'` (words-mode `'daily word cap reached'`
  unchanged). Logic unchanged.

### 5.4 `src/state/xtmJobStore.ts` — inject the effort mapper
- `wordsDueByDeadline(dayOf)` → **`effortDueByDeadline(dayOf, effortOf)`** where
  `effortOf: (s: XtmJobState) => number`. Body `s.words ?? 0` → `effortOf(s)`. Cycle passes
  `(s) => effortOf(s, metric) ?? 0`; store stays metric-agnostic.

### 5.5 `src/config/index.ts` + `.env.example`
- Add **`ACCEPT_EFFORT_METRIC`**: zod enum `['wwc','words']`, default `'wwc'` (invalid → fail-fast at start).
- Add **`ACCEPT_MAX_WWC_PER_DAY`**: positive int, **default `1000`**.
- Add **`ACCEPT_THROUGHPUT_WWC_PER_HOUR`**: optional positive number override (symmetric to the words one).
- **Config resolves the active values in ONE `.transform`** (as it already does for
  `throughputWordsPerHour`/`workdays`), always **defined & finite**:
  - `activeMaxPerDay = (metric==='wwc' ? ACCEPT_MAX_WWC_PER_DAY : ACCEPT_MAX_WORDS_PER_DAY) ?? 0` (the
    `?? 0` is belt-and-suspenders: both have defaults, so this is a `number`, never `undefined`/NaN — it
    guards against a future default removal re-introducing a NaN throughput; see round-2 N3).
  - `throughputPerHour = (metric==='wwc' ? ACCEPT_THROUGHPUT_WWC_PER_HOUR : ACCEPT_THROUGHPUT_WORDS_PER_HOUR)
    ?? (activeMaxPerDay ÷ workingHoursPerDay)`.
  - `unit = metric==='wwc' ? {adj:'WWC', noun:'WWC'} : {adj:'word', noun:'words'}`.
- **TWO independent refines** (do NOT fold — an override must not except the capacity cap; round-2 N1):
  1. *throughput resolvable:* `!ACCEPT_SCHEDULE_ENABLED || (active override set) || (activeMaxPerDay > 0)`.
  2. *capacity cap positive when gating:* `!ACCEPT_SCHEDULE_ENABLED || activeMaxPerDay > 0` — an explicit
     `0` cap (even with a throughput override set) fails fast, so the daily cap can never be silently
     skipped (`decideGroupCapacity`'s `if (cap > 0)`). Both refines gate behind `ACCEPT_SCHEDULE_ENABLED`
     so the kill-switch always lets an operator disable without fixing unrelated values.
- `.env.example` documents the toggle, the two caps + two overrides (per-metric), and the `1000` default.

### 5.6 `src/runtime/xtmPollCycle.ts` — per-job wiring
Consumes config-resolved `activeMaxPerDay` / `throughputPerHour` / `unit` (no metric branching for
cap/throughput); maps each job to its effort:
- `const metric = this.cfg.ACCEPT_EFFORT_METRIC; const eff = (s) => effortOf(s, metric);`
- Feasibility → `effort: eff(s), throughputPerHour: cfg.throughputPerHour, unit: cfg.unit`.
- Capacity members `{ effort: eff(s) ?? 0, deadlineDate: day }`; `cap = cfg.activeMaxPerDay`; pass `cfg.unit`.
- Bucket seed → `this.store.effortDueByDeadline(effDayOf, (s) => eff(s) ?? 0)`.
- The `daily_cap_reached` alert text (`the ${cap}-word daily cap`, `xtmPollCycle.ts:450`) → `${cfg.unit.adj}`
  (words-mode `-word` unchanged).
- **Telemetry (D9):** `summary.scheduleRejects[]` keeps `words: s.words` AND adds `effort: eff(s)` + `metric`.
  Rename `AcceptedDueDay.resultingBucketWords` → `resultingBucketEffort`.

### 5.7 `src/reporting/dailyReport.ts`
- `buildDailyReportCard(...)` gains a **`unit` parameter** (threaded from config at
  `src/runtime/xtmPollLoop.ts`, which must also pass the **active** cap, not `ACCEPT_MAX_WORDS_PER_DAY`).
  Keep discrete params — do NOT pass the config object.
- Sum `effortOf(j, metric) ?? 0` for Due-today / Overdue / In-progress; the per-job value (`${j.words}w`)
  and headline render the active unit (words-mode `Nw` / "words" unchanged; wwc-mode `N WWC`).

### 5.8 `CLAUDE.md`
- Update the "2 สวิตช์ accept" note to **3** (`ACCEPT_ENABLED`, `ACCEPT_SCHEDULE_ENABLED`,
  `ACCEPT_EFFORT_METRIC`), noting `metric=words` reverts byte-for-byte and the WWC cap default.

### 5.9 Alert surface — `src/reporting/systemAlerts.ts`
`daily_cap_reached` and `held_job_no_deadline` are entries in a **static `TriggerSpec` const map**
(`systemAlerts.ts:159-180`) with literal `title/impact/action`. Making them metric-aware is a small
**refactor of those entries into dynamic builders** that take `unit` + the **active cap env-var name**
(not a string swap): the `daily_cap_reached` action currently names `ACCEPT_MAX_WORDS_PER_DAY` — the
WRONG var in wwc mode (an ops hazard: they'd turn the wrong knob) — so it must name the active cap var
(`ACCEPT_MAX_WWC_PER_DAY` in wwc mode). words-mode copy stays byte-for-byte ("Daily word cap …").

### 5.10 Telemetry / summary types
- `XtmCycleSummary.scheduleRejects[]`: add `effort: number | null` + `metric` beside the kept `words`
  (update the `xtmPollLoop.ts` warn log). `AcceptedDueDay.resultingBucketWords` → `resultingBucketEffort`.

### 5.11 Chat cards — `src/reporting/xtmNotifier.ts` (D11)
`renderXtmNewJob` / `renderXtmRelisted` / `renderXtmAccepted` (currently a single
`{label:'Words', value: wordsValue(job.words)}` row) gain a **`File WWC` row** (`job.fileWwc`, already on
the state) alongside `Words`, always shown (both metrics). Blank WWC renders like a blank word count.

## 6. Error handling & edge cases

- **`fileWwc` null OR 0 in wwc mode** → fallback to `words` (D1); never over-accepts; the 0-guard blocks a
  scrape-0 on a real (`words`>0) job — the one bad-WWC case that would bypass BOTH gates (feasibility sees
  0 time, capacity adds 0) on the irreversible bulk path.
- **Both `fileWwc` and `words` null** → `effortOf` → `null` → feasibility `effort === null` guard rejects
  (`'${unit.adj} count unknown'`); capacity skipped (blocked upstream). Preserved.
- **`metric=words`** → `words` + `ACCEPT_MAX_WORDS_PER_DAY` + words throughput + today's exact strings:
  behavior AND text byte-for-byte. The whole WWC path is gated behind the toggle.
- **Cap always numeric** — both caps have defaults, and the resolution coerces `?? 0`, so `activeMaxPerDay`
  / `throughputPerHour` are never `undefined`/NaN; an explicit `0` cap fails the §5.5 refine (never a
  silently-skipped capacity gate). This closes the round-2 override-escape (N1) and NaN-throughput (N3).
- **Toggle-flip semantics** (reviewed safe — held effort is recomputed fresh each cycle, never carried,
  so no double-count): `wwc→words` re-values held jobs *larger* → buckets tighten → fail-closed;
  `words→wwc` re-values *smaller* → opens capacity, safe with a sane WWC cap.
- **`decideAccept` (per-job `ACCEPT_MAX_WORDS` skip, `src/detection/acceptDecision.ts`)** deliberately
  stays on raw `words` — inert in prod (`=0`) and a *different* gate (per-job language/cap skip). Footnoted
  so "metric decided in one place" is not misread as covering it.
- **Stale/wrong nonzero WWC** → out of scope beyond the 0-guard; `parseXtmWwc` validates the value
  (PR #18); the kill-switch (flip to `words`) is the mitigation.

## 7. Testing strategy (TDD; `schedule`/`state`/`reporting` gated ≥80%)

> **Integration tests carry extra weight:** the toggle *wiring* lives in `runtime/xtmPollCycle.ts` +
> `config/index.ts`, **outside** the ≥80% gate. The four pure modules can be green + the gate pass while
> the toggle is mis-wired — the cycle/config integration tests are the real net.

**Unit — `effort.ts`** (pin values): `wwc`+`fileWwc>0` (`{words:861,fileWwc:169}`)→169; `wwc`+`null`→words;
`wwc`+`0`→words (scrape-0 guard); `words`-mode + **non-null** `fileWwc`→words (ignores WWC); both null→null.

**Unit — `acceptSchedule.ts` / `acceptCapacity.ts`** (rename is not self-proving):
- **PR-A characterization:** keep the boundary + F10-epsilon tests (`acceptSchedule.test.ts:83,113`) with
  identical numbers, field names only. Assert the **CURRENT (singular) reason strings unchanged**
  (`'word count unknown'`, `'daily word cap reached'`, `'group words due'`) — PR-A must not touch text.
  Reviewer confirms the `acceptSchedule.ts`/`acceptCapacity.ts` PR-A diff is a **pure identifier
  substitution** (no string change).
- **PR-B unit-aware strings:** words-mode still emits the exact current strings; wwc-mode emits the
  `WWC` variants (`'WWC count unknown'`, `'daily WWC cap reached'`, `'group WWC due'`). Assert both.

**Unit — `xtmJobStore.effortDueByDeadline`**: sums the injected mapper per day; WWC vs words mapper on the
same held rows → expected totals; a both-null held job → 0 (not NaN). **Fix the `accepted()` seed helper
(`xtmCycle.test.ts:104` hardcodes `fileWwc:null`) to accept `fileWwc`.** Migrate the 7 existing
`wordsDueByDeadline()` call sites.

**Integration — `xtmCycle.test.ts` (the toggle net)** — extend `SCHED_FIELDS` with `ACCEPT_EFFORT_METRIC`,
`activeMaxPerDay`, `throughputPerHour` (rename), `unit`:
- **4721900 lock (pinned):** `xraw({words:861, fileWwc:169, dueDate:'2026-06-22T15:24:00+07:00'})` (= 324
  working-min from `MON_10` = 5.4 h), throughput identical both runs (**set `ACCEPT_MAX_WWC_PER_DAY:1000`**
  in the wwc run so throughput = 1000/9 = words-run's). `metric=words` → **rejected**, reason contains
  `'cannot finish in time'` + `'need ~7.8h'` + `'have ~5.4h'` (feasibility fingerprint, not capacity/holiday).
  `metric=wwc` → **accepted**. TZ-explicit `+07:00`.
- **D1 null-fallback:** `{words:861, fileWwc:null}`, `metric=wwc` → rejected (via 861, not accepted-as-0).
- **D1 zero-guard:** `{words:861, fileWwc:0}`, `metric=wwc` → rejected.
- **Capacity keys off effort:** `{words:1500, fileWwc:800, dueDate:dueWed18}`, `ACCEPT_MAX_WWC_PER_DAY:1000`,
  `metric=wwc` → accepted (WWC 800 ≤ cap); same job `metric=words` → `over_cap_permanent` reject.
- **Seed-under-wwc:** a held job seeded with a real `fileWwc` proves `effortDueByDeadline` buckets WWC.
- **Malformed job (failure-mode):** `{words:null, fileWwc:null}`, `metric=wwc` → rejected `'WWC count unknown'`,
  acceptor not called.
- **D9 telemetry:** the 4721900 words-reject → `r.words===861, r.effort===861, r.metric==='words'`; a
  wwc-reject with a fileWwc → `r.effort===<WWC>, r.metric==='wwc'`.

**Unit — `config.test.ts`:** default `metric='wwc'`; `metric='garbage'` → **throws** (fail-fast
failure-mode); `metric=wwc` → `activeMaxPerDay=ACCEPT_MAX_WWC_PER_DAY`, `throughputPerHour≈cap/9`;
`metric=words` → active = `ACCEPT_MAX_WORDS_PER_DAY` (byte-for-byte); **override isolation (D7):**
`{metric:'wwc', ACCEPT_THROUGHPUT_WORDS_PER_HOUR:50, ACCEPT_MAX_WWC_PER_DAY:900}` → `throughputPerHour≈100`
(from the WWC cap, NOT 50); **explicit-0 cap** `{metric:'wwc', ACCEPT_MAX_WWC_PER_DAY:0}` → **throws** (even
with an override set); **kill-switch escape** `{ACCEPT_SCHEDULE_ENABLED:0, metric:'wwc', cap unset}` → does
**not** throw.

**Unit — `dailyReport.test.ts`** (port the per-job suite; factories `job()`:104 + `makeJob`:358 set
`fileWwc`): `metric=wwc` → Due-today/Overdue/In-progress sum WWC, headline reads WWC, cap = WWC cap, a
`fileWwc=null` held job sums via words fallback; twin `metric=words` → sums words, "words", ignores fileWwc.
Test the new `unit` param + updated call sites; pin the per-job value format (`N WWC`). TZ `+07:00`.

**Unit — `systemAlerts.test.ts`:** render `daily_cap_reached` both modes — wwc → action names
`ACCEPT_MAX_WWC_PER_DAY` + copy reads `WWC`; words → `ACCEPT_MAX_WORDS_PER_DAY` + `word` (byte-for-byte).

**Unit — `xtmNotifier` tests (D11):** the new/relisted/accepted cards render a `File WWC` row (value +
blank case), alongside `Words`.

## 8. Out of scope (YAGNI)
- Parallel words+WWC display in the *report* rows (D5 chose active-metric display; the Chat *card* shows
  both per D11).
- Per-language / per-project WWC caps. Changing how `fileWwc` is scraped (PR #18). A UI/Chat toggle.
- A "WWC wildly < words" anomaly detector beyond the `0`-guard (false-positive risk on genuine
  high-leverage jobs — the point of the feature).

## 9. Complexity Tracking (Constitution)
No new principle violations. Pure modules stay TDD + coverage-gated; `detection/diff.ts` remains the sole
state-transition owner; one config-gated behavior with a byte-for-byte kill-switch, consistent with
`ACCEPT_SCHEDULE_ENABLED`. The two existing Complexity entries are unaffected.

## 10. Implementation sequencing (D10)

1. **Commit/PR A — mechanical rename, behavior- AND text-preserving:** `words`→`effort`,
   `throughputWordsPerHour`→`throughputPerHour`, `CapacityMember.words`→`effort`,
   `wordsDueByDeadline`→`effortDueByDeadline`, `resultingBucketWords`→`resultingBucketEffort`. **Reason/alert
   strings are NOT touched** in PR-A (pure identifier substitution). Existing tests keep their numbers +
   current strings; the characterization + F10 tests stay green unchanged → the "metric=words = today"
   claim is verifiable and bisectable.
2. **Commit/PR B — the metric toggle on top:** `effort.ts`; the two new config vars + the two independent
   refines + active-value resolution + `unit`; `effortOf` wiring + D9 telemetry in the cycle; the
   unit-aware reason strings (§5.2/§5.3); the alert/report/Chat-card surfaces (§5.7/§5.9/§5.11); and all the
   new tests in §7.

(If shipped as one PR, keep the two commits in this order.)
