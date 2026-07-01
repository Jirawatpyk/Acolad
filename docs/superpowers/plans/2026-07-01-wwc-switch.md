# WWC Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the auto-accept feasibility + daily-capacity gate measure a job's effort by File WWC instead of raw words, behind an `ACCEPT_EFFORT_METRIC=wwc|words` kill-switch (default `wwc`).

**Architecture:** A pure `effortOf(job, metric)` helper + metric-agnostic schedule modules (they take a bare `effort` number + `throughputPerHour` + a display-only `unit`); the metric decision lives only in config resolution + the cycle's per-job mapping. Spec: `docs/superpowers/specs/2026-07-01-wwc-switch-design.md` (v3) — read it; this plan implements it.

**Tech Stack:** Node 22 + TypeScript strict, Vitest, zod (config), better-sqlite3. Run one test file: `npx vitest run tests/unit/effort.test.ts`. Full gate: `npm run test:coverage`. Lint: `npm run lint`. Typecheck: `npm run typecheck`.

## Global Constraints (copied from the spec — every task implicitly includes these)

- **Two commits in order (D10):** Task 1 = PR-A pure identifier rename, **behavior AND text preserving** (reason/alert STRINGS untouched); Tasks 2–10 = PR-B the toggle. Task 1 must leave the FULL suite green with unchanged numbers + unchanged strings.
- **D1 effort:** `effortOf = (fileWwc && fileWwc > 0) ? fileWwc : words` — fall back to `words` on `fileWwc` null **OR 0**.
- **D3 default:** `ACCEPT_EFFORT_METRIC` default `'wwc'`. **D4:** `ACCEPT_MAX_WWC_PER_DAY` default `1000`.
- **D8 copy:** `metric=words` reproduces today's EXACT reason/alert strings (singular "word": `'word count unknown'`, `'daily word cap reached'`; plural noun `'group words due'`); `metric=wwc` uses `'WWC'`. Pass the unit as `{adj, noun}` tokens, never one plural label.
- **Config always finite:** `activeMaxPerDay` / `throughputPerHour` are always a `number` (both caps have defaults + `?? 0` coerce); two independent refines — an override must NOT except the capacity cap; an explicit `0` cap fails fast; both gated behind `ACCEPT_SCHEDULE_ENABLED`.
- **TDD + coverage:** `schedule`/`state`/`reporting` are gated ≥80% — write the failing test first. Wiring in `runtime`/`config` is NOT gated → integration tests are the safety net. TZ-explicit `+07:00` inputs (CI runs UTC).
- **`ACCEPT_MAX_PER_CYCLE` stays 0; poll interval ≥ 20s; secrets only in .env.**

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/schedule/effort.ts` (NEW) | `effortOf(job, metric)` + `EffortMetric` — the ONE fallback definition | 2 |
| `src/schedule/acceptSchedule.ts` | feasibility — rename `words`→`effort`, `throughputWordsPerHour`→`throughputPerHour`, add `unit.adj` | 1, 5 |
| `src/schedule/acceptCapacity.ts` | capacity — rename `CapacityMember.words`→`effort`, add `unit.{adj,noun}` | 1, 5 |
| `src/state/xtmJobStore.ts` | `wordsDueByDeadline`→`effortDueByDeadline(dayOf, effortOf)` | 1, 4 |
| `src/config/index.ts` | add metric + WWC cap + WWC override; resolve `activeMaxPerDay`/`throughputPerHour`/`unit`; two refines | 3 |
| `src/runtime/xtmPollCycle.ts` | per-job `effortOf`, active cap/throughput/unit into gate; D9 telemetry | 1, 6 |
| `src/runtime/xtmPollLoop.ts` | pass active cap + unit to daily report; log renamed telemetry | 1, 6, 8 |
| `src/reporting/dailyReport.ts` | sum effort, active cap, unit label | 8 |
| `src/reporting/systemAlerts.ts` | `daily_cap_reached`/`held_job_no_deadline` → dynamic builder (unit + active cap var) | 7 |
| `src/reporting/xtmNotifier.ts` | Chat cards gain a `File WWC` row | 9 |
| `CLAUDE.md`, `.env.example` | doc the 3rd switch | 10 |

---

## Task 1 (PR-A): Pure identifier rename — behavior + text preserving

Atomic refactor: `effort`-neutral names, NO string/number/behavior change. The full suite stays green — that green run IS the proof `metric=words` == today.

**Files:**
- Modify: `src/schedule/acceptSchedule.ts` (`AcceptScheduleInput.words`→`effort`; `throughputWordsPerHour`→`throughputPerHour`; body `i.words`→`i.effort`, `i.throughputWordsPerHour`→`i.throughputPerHour`). **Do NOT touch any string literal** (`'word count unknown'`, `'throughputWordsPerHour must be positive'` stay verbatim).
- Modify: `src/schedule/acceptCapacity.ts` (`CapacityMember.words`→`effort`; body `mem.words`→`mem.effort`). Strings (`'group words due'`, `'daily word cap reached'`) stay verbatim.
- Modify: `src/state/xtmJobStore.ts` (`wordsDueByDeadline`→`effortDueByDeadline`; keep signature `(dayOf)` and body `s.words ?? 0` — the mapper param comes in Task 4).
- Modify: `src/runtime/xtmPollCycle.ts` — `capMembers.push({ words: … })`→`{ effort: … }` (line ~390); `scheduleVerdict` feasibility `words: s.words, throughputWordsPerHour: this.cfg.throughputWordsPerHour`→`effort: s.words, throughputPerHour: this.cfg.throughputWordsPerHour` (lines ~862-863; the CONFIG field `cfg.throughputWordsPerHour` keeps its name until Task 3); `this.store.wordsDueByDeadline(...)`→`effortDueByDeadline(...)`; the `XtmCycleSummary.AcceptedDueDay.resultingBucketWords`→`resultingBucketEffort` (type + `summary.acceptedDueDays.push({ day, resultingBucketWords: … })` at line ~413).
- Modify: `src/runtime/xtmPollLoop.ts` — the log site reading `resultingBucketWords`→`resultingBucketEffort`.
- Test: update `tests/unit/acceptSchedule.test.ts`, `tests/unit/acceptCapacity.test.ts`, `tests/unit/xtmJobStore.test.ts`, `tests/integration/xtmCycle.test.ts` (the 7 `wordsDueByDeadline()` call sites + any `resultingBucketWords`/`words:` field refs in these pure-module inputs), `tests/integration/xtmPollLoop.test.ts` — **field names only; assert the SAME strings + numbers as today.**

**Interfaces produced:**
- `AcceptScheduleInput { enabled; nowMs; dueAtMs; effort: number|null; throughputPerHour: number; calendar; holidaysCuratedForSpan }`
- `CapacityMember { effort: number; deadlineDate: string }`
- `XtmJobStore.effortDueByDeadline(dayOf): ReadonlyMap<string, number>`
- `AcceptedDueDay { day: string; resultingBucketEffort: number }`

- [ ] **Step 1: Rename in the pure modules + store + cycle + loop + tests** (mechanical identifier substitution per the Files list; touch NO string literal).
- [ ] **Step 2: Typecheck** — `npm run typecheck` → 0 errors (a stray old name is a compile error, catching partial renames).
- [ ] **Step 3: Full suite** — `npx vitest run` → all green with UNCHANGED assertions. If any string/number assertion had to change, you touched behavior/text — revert that part.
- [ ] **Step 4: Lint** — `npm run lint` → clean.
- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "refactor(schedule): rename words→effort in the gate interfaces (PR-A, no behavior/text change)"
```

---

## Task 2 (PR-B): `effort.ts` — the effort helper

**Files:**
- Create: `src/schedule/effort.ts`
- Test: `tests/unit/effort.test.ts`

**Interfaces produced:** `type EffortMetric = 'wwc' | 'words'`; `effortOf(job: Pick<XtmJobState,'words'|'fileWwc'>, metric: EffortMetric): number | null`.

- [ ] **Step 1: Write the failing test** — `tests/unit/effort.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { effortOf } from '../../src/schedule/effort.js';
import type { XtmJobState } from '../../src/detection/types.js';

const j = (words: number | null, fileWwc: number | null): Pick<XtmJobState, 'words' | 'fileWwc'> => ({
  words,
  fileWwc,
});

describe('effortOf', () => {
  it('wwc: uses File WWC when it is a real positive value', () => {
    expect(effortOf(j(861, 169), 'wwc')).toBe(169);
  });
  it('wwc: falls back to words when fileWwc is null', () => {
    expect(effortOf(j(861, null), 'wwc')).toBe(861);
  });
  it('wwc: falls back to words when fileWwc is 0 (scrape-0 guard)', () => {
    expect(effortOf(j(861, 0), 'wwc')).toBe(861);
  });
  it('words: always raw words, ignoring a non-null fileWwc', () => {
    expect(effortOf(j(861, 169), 'words')).toBe(861);
  });
  it('both null → null (feasibility "effort unknown" guard fires downstream)', () => {
    expect(effortOf(j(null, null), 'wwc')).toBeNull();
  });
});
```
- [ ] **Step 2: Run → FAIL** — `npx vitest run tests/unit/effort.test.ts` → "Cannot find module effort.js".
- [ ] **Step 3: Implement** — `src/schedule/effort.ts`
```ts
import type { XtmJobState } from '../detection/types.js';

export type EffortMetric = 'wwc' | 'words';

/** Effort under the active metric. 'wwc': File WWC, falling back to raw words when WWC is null OR 0
 *  (WWC ≤ words → never over-accepts; the 0-guard defends a scrape-0 on a real job). 'words': raw words. */
export function effortOf(
  job: Pick<XtmJobState, 'words' | 'fileWwc'>,
  metric: EffortMetric,
): number | null {
  if (metric === 'words') return job.words;
  return job.fileWwc && job.fileWwc > 0 ? job.fileWwc : job.words;
}
```
- [ ] **Step 4: Run → PASS**; **Step 5: Commit** `feat(schedule): add effortOf(job, metric) — File WWC with words fallback (null or 0)`

---

## Task 3 (PR-B): Config — metric, WWC cap, WWC override, active resolution, two refines

**Files:**
- Modify: `src/config/index.ts` — add three fields (near `ACCEPT_MAX_WORDS_PER_DAY`, line ~117), extend the `.transform` (line ~127-142), add two `.refine`s (after line ~168).
- Test: `tests/unit/config.test.ts`

**Interfaces produced (on `AppConfig`):** `ACCEPT_EFFORT_METRIC: 'wwc'|'words'`; `ACCEPT_MAX_WWC_PER_DAY: number`; `ACCEPT_THROUGHPUT_WWC_PER_HOUR?: number`; derived `activeMaxPerDay: number`; `throughputPerHour: number`; `unit: { adj: string; noun: string }`.

- [ ] **Step 1: Write failing tests** — `tests/unit/config.test.ts` (use the file's existing `loadConfig({...base})` helper pattern):
```ts
it('defaults ACCEPT_EFFORT_METRIC to wwc', () => {
  expect(loadConfig(base).ACCEPT_EFFORT_METRIC).toBe('wwc');
});
it('rejects an invalid ACCEPT_EFFORT_METRIC at startup (fail-fast)', () => {
  expect(() => loadConfig({ ...base, ACCEPT_EFFORT_METRIC: 'weighted' })).toThrow();
});
it('metric=wwc → active cap = ACCEPT_MAX_WWC_PER_DAY, throughput derived from it', () => {
  const c = loadConfig({ ...base, ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: '900' });
  expect(c.activeMaxPerDay).toBe(900);
  expect(c.throughputPerHour).toBeCloseTo(900 / 9, 5);
  expect(c.unit).toEqual({ adj: 'WWC', noun: 'WWC' });
});
it('metric=words → active cap = ACCEPT_MAX_WORDS_PER_DAY (byte-for-byte), unit words', () => {
  const c = loadConfig({ ...base, ACCEPT_EFFORT_METRIC: 'words', ACCEPT_MAX_WORDS_PER_DAY: '1000' });
  expect(c.activeMaxPerDay).toBe(1000);
  expect(c.throughputPerHour).toBeCloseTo(1000 / 9, 5);
  expect(c.unit).toEqual({ adj: 'word', noun: 'words' });
});
it('D7 override isolation: a WORDS override does not leak into wwc throughput', () => {
  const c = loadConfig({
    ...base, ACCEPT_EFFORT_METRIC: 'wwc',
    ACCEPT_THROUGHPUT_WORDS_PER_HOUR: '50', ACCEPT_MAX_WWC_PER_DAY: '900',
  });
  expect(c.throughputPerHour).toBeCloseTo(100, 5); // 900/9, NOT 50
});
it('explicit-0 WWC cap fails fast even with an override set', () => {
  expect(() => loadConfig({
    ...base, ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: '0',
    ACCEPT_THROUGHPUT_WWC_PER_HOUR: '111',
  })).toThrow();
});
it('kill-switch escape: schedule disabled + wwc + cap 0 does NOT throw', () => {
  expect(() => loadConfig({
    ...base, ACCEPT_SCHEDULE_ENABLED: '0', ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: '0',
  })).not.toThrow();
});
```
- [ ] **Step 2: Run → FAIL** (`activeMaxPerDay`/`unit` undefined, metric field missing).
- [ ] **Step 3: Implement** in `src/config/index.ts`:

Add fields after `ACCEPT_MAX_WORDS_PER_DAY` (line ~117):
```ts
    ACCEPT_EFFORT_METRIC: z.enum(['wwc', 'words']).default('wwc'),
    ACCEPT_MAX_WWC_PER_DAY: z.coerce.number().int().min(0).default(1000),
    ACCEPT_THROUGHPUT_WWC_PER_HOUR: z.preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.coerce.number().positive().optional(),
    ),
```
Inside the `.transform` (after `throughputWordsPerHour` is computed, ~line 141), add:
```ts
    const activeMaxPerDay =
      (c.ACCEPT_EFFORT_METRIC === 'wwc' ? c.ACCEPT_MAX_WWC_PER_DAY : c.ACCEPT_MAX_WORDS_PER_DAY) ?? 0;
    const activeOverride =
      c.ACCEPT_EFFORT_METRIC === 'wwc'
        ? c.ACCEPT_THROUGHPUT_WWC_PER_HOUR
        : c.ACCEPT_THROUGHPUT_WORDS_PER_HOUR;
    const throughputPerHour = resolveThroughput({
      ...(activeOverride !== undefined ? { explicit: activeOverride } : {}),
      maxWordsPerDay: activeMaxPerDay, // param name is legacy; it is the ACTIVE cap
      hoursStartMin,
      hoursEndMin,
    });
    const unit =
      c.ACCEPT_EFFORT_METRIC === 'wwc'
        ? { adj: 'WWC', noun: 'WWC' }
        : { adj: 'word', noun: 'words' };
    return {
      ...c, hoursStartMin, hoursEndMin, workdays, throughputWordsPerHour,
      activeMaxPerDay, throughputPerHour, unit,
    };
```
Add two refines after the existing throughput refine (~line 168):
```ts
  // Capacity cap must be positive when the gate is on — an override must NOT except it, so this is
  // a SEPARATE refine from throughput-resolvability. Both gate behind ACCEPT_SCHEDULE_ENABLED so the
  // kill-switch always lets an operator disable without fixing unrelated values.
  .refine((c) => !c.ACCEPT_SCHEDULE_ENABLED || c.activeMaxPerDay > 0, {
    path: ['ACCEPT_MAX_WWC_PER_DAY'],
    message: 'the active daily cap (ACCEPT_MAX_WWC_PER_DAY in wwc mode / ACCEPT_MAX_WORDS_PER_DAY in words mode) must be > 0',
  })
  .refine(
    (c) => !c.ACCEPT_SCHEDULE_ENABLED || (c.throughputPerHour ?? 0) > 0,
    { path: ['ACCEPT_THROUGHPUT_WWC_PER_HOUR'], message: 'throughput must be resolvable to > 0 for the active metric' },
  );
```
> NOTE: `activeMaxPerDay`/`throughputPerHour`/`unit` are computed in the `.transform`, so the refines (which run after transform) can read them off `c`.
- [ ] **Step 4: Run → PASS** (`config.test.ts`); **Step 5: Typecheck; Step 6: Commit** `feat(config): ACCEPT_EFFORT_METRIC + WWC cap/override + active-value resolution + refines`

---

## Task 4 (PR-B): `effortDueByDeadline` — inject the effort mapper

**Files:**
- Modify: `src/state/xtmJobStore.ts` — `effortDueByDeadline(dayOf)` → `effortDueByDeadline(dayOf, effortOf: (s: XtmJobState) => number)`; body `s.words ?? 0` → `effortOf(s)`.
- Modify: `src/runtime/xtmPollCycle.ts` — the call site (Task 1 renamed it) passes the mapper: `this.store.effortDueByDeadline(effDayOf, (s) => effortOf(s, this.cfg.ACCEPT_EFFORT_METRIC) ?? 0)`.
- Test: `tests/unit/xtmJobStore.test.ts`.

**Interfaces produced:** `effortDueByDeadline(dayOf: (dueDate: string|null) => string|null, effortOf: (s: XtmJobState) => number): ReadonlyMap<string, number>`.

- [ ] **Step 1: Write the failing test** — a WWC mapper and a words mapper on the same held rows give different per-day totals; a both-null row → 0:
```ts
it('effortDueByDeadline buckets via the injected mapper (WWC vs words)', () => {
  const store = new XtmJobStore(db);
  store.upsertMany([accepted({ jobKey: 'a', dueDate: DUE, words: 1500, fileWwc: 800 })]);
  const day = (d: string | null) => d && d.slice(0, 10);
  const wwc = store.effortDueByDeadline(day, (s) => effortOf(s, 'wwc') ?? 0);
  const words = store.effortDueByDeadline(day, (s) => effortOf(s, 'words') ?? 0);
  expect(wwc.get(DUE.slice(0, 10))).toBe(800);
  expect(words.get(DUE.slice(0, 10))).toBe(1500);
});
```
> The `accepted()` helper in this test file (and in `xtmCycle.test.ts:104`) currently hardcodes `fileWwc: null` — extend it to accept a `fileWwc` field (Task 4 fixes both).
- [ ] **Step 2: Run → FAIL** (arity / still sums words).
- [ ] **Step 3: Implement** the mapper param + body `effortOf(s)`; update the cycle call site.
- [ ] **Step 4: Run → PASS; Step 5: Typecheck (cycle call site compiles); Step 6: Commit** `feat(state): effortDueByDeadline takes an effort mapper (metric-agnostic bucket)`

---

## Task 5 (PR-B): Unit-aware reason strings in the pure modules

Add the `unit` param + make reason strings unit-aware; `metric=words` stays byte-for-byte.

**Files:**
- Modify: `src/schedule/acceptSchedule.ts` — add `unit: { adj: string }` to `AcceptScheduleInput`; `'word count unknown'` → `` `${i.unit.adj} count unknown` ``.
- Modify: `src/schedule/acceptCapacity.ts` — add `unit: { adj: string; noun: string }` param to `decideGroupCapacity`; `'group words due …'` → `` `group ${unit.noun} due …` ``; `'daily word cap reached …'` → `` `daily ${unit.adj} cap reached …` ``.
- Test: `tests/unit/acceptSchedule.test.ts`, `tests/unit/acceptCapacity.test.ts`.

- [ ] **Step 1: Write failing tests** — both modes:
```ts
// acceptSchedule.test.ts
it('null-effort reason uses the active unit adjective', () => {
  const words = evaluateAcceptSchedule({ ...baseIn, effort: null, unit: { adj: 'word', noun: 'words' } });
  expect(words).toEqual({ allow: false, reason: 'word count unknown' }); // byte-for-byte today
  const wwc = evaluateAcceptSchedule({ ...baseIn, effort: null, unit: { adj: 'WWC', noun: 'WWC' } });
  expect(wwc).toEqual({ allow: false, reason: 'WWC count unknown' });
});
// acceptCapacity.test.ts — over_cap reason
it('capacity reasons use the active unit (words byte-for-byte, wwc uses WWC)', () => {
  const w = decideGroupCapacity([{ effort: 2000, deadlineDate: '2026-06-22' }], () => 0, 1000, { adj: 'word', noun: 'words' });
  expect(w).toMatchObject({ reason: expect.stringContaining('group words due') });
  const c = decideGroupCapacity([{ effort: 2000, deadlineDate: '2026-06-22' }], () => 0, 1000, { adj: 'WWC', noun: 'WWC' });
  expect(c).toMatchObject({ reason: expect.stringContaining('group WWC due') });
});
```
- [ ] **Step 2: Run → FAIL** (arity / string).
- [ ] **Step 3: Implement** the `unit` param + interpolate `unit.adj`/`unit.noun` at the exact sites named above. Keep the `'cannot finish in time …'` reason unit-free.
- [ ] **Step 4: Run → PASS; Step 5: Commit** `feat(schedule): unit-aware gate reason strings (words byte-for-byte, wwc uses WWC)`

---

## Task 6 (PR-B): Cycle wiring — effortOf per job, active cap/throughput/unit, D9 telemetry

The integration net (this wiring is outside the coverage gate).

**Files:**
- Modify: `src/runtime/xtmPollCycle.ts` —
  - `const cap = this.cfg.ACCEPT_MAX_WORDS_PER_DAY` (line ~354) → `const cap = this.cfg.activeMaxPerDay`.
  - `const metric = this.cfg.ACCEPT_EFFORT_METRIC; const eff = (s: XtmJobState) => effortOf(s, metric);` near the gate block.
  - capacity member (Task 1 made it `{ effort: s.words ?? 0, … }`) → `{ effort: eff(s) ?? 0, deadlineDate: day }`.
  - `decideGroupCapacity(capMembers, bucketFor, cap)` → `decideGroupCapacity(capMembers, bucketFor, cap, this.cfg.unit)`.
  - `daily_cap_reached` alert text `` `the ${cap}-word daily cap …` `` → `` `the ${cap}-${this.cfg.unit.adj} daily cap …` ``.
  - `scheduleVerdict`: `effort: s.words` (Task 1) → `effort: eff(s)`; `throughputPerHour: this.cfg.throughputWordsPerHour` → `throughputPerHour: this.cfg.throughputPerHour`; add `unit: this.cfg.unit` to the `evaluateAcceptSchedule` call.
  - **D9 telemetry:** `summary.scheduleRejects.push({ jobKey, reason, words: s.words, dueDate })` → add `effort: eff(s), metric`.
- Modify: `src/runtime/xtmPollCycle.ts` — `XtmCycleSummary.scheduleRejects[]` type gains `effort: number | null; metric: EffortMetric`.
- Test: `tests/integration/xtmCycle.test.ts` — extend `SCHED_FIELDS` with `ACCEPT_EFFORT_METRIC`, `activeMaxPerDay`, `throughputPerHour` (replaces `throughputWordsPerHour` in the cast), `unit`.

**Interfaces consumed:** `effortOf` (T2), `cfg.activeMaxPerDay`/`throughputPerHour`/`unit` (T3), `effortDueByDeadline(dayOf, mapper)` (T4), `decideGroupCapacity(..., unit)` (T5).

- [ ] **Step 1: Write failing integration tests** in `xtmCycle.test.ts` (add `const dueMon1524 = '2026-06-22T15:24:00+07:00';` and a wwc `schedCfg` override helper):
```ts
const j4721900 = () => xraw({ words: 861, fileWwc: 169, dueDate: dueMon1524 });

it('4721900: metric=words rejects (feasibility keys off effort)', async () => {
  fresh(); const acc = new StubAcceptor();
  await new XtmPollCycle(db, schedCfg({ ACCEPT_EFFORT_METRIC: 'words' }), acc).run(snapAt([j4721900()], MON_10));
  expect(acc.calls.flat()).toHaveLength(0);
  const s = only();
  expect(s.lifecycleStatus).toBe('rejected');
  expect(s.rejectReason).toContain('cannot finish in time');
  expect(s.rejectReason).toContain('need ~7.8h');
  expect(s.rejectReason).toContain('have ~5.4h');
});
it('4721900: metric=wwc accepts the same job (effort=169)', async () => {
  fresh(); const acc = new StubAcceptor();
  await new XtmPollCycle(db, schedCfg({ ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: 1000 }), acc).run(snapAt([j4721900()], MON_10));
  expect(acc.calls.flat()).toHaveLength(1);
  expect(only().lifecycleStatus).toBe('accepted');
});
it('D1 null-fallback: metric=wwc + fileWwc=null → rejected via 861 (not accepted as 0)', async () => {
  fresh(); const acc = new StubAcceptor();
  await new XtmPollCycle(db, schedCfg({ ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: 1000 }), acc)
    .run(snapAt([xraw({ words: 861, fileWwc: null, dueDate: dueMon1524 })], MON_10));
  expect(acc.calls.flat()).toHaveLength(0);
  expect(only().rejectReason).toContain('cannot finish in time');
});
it('D1 zero-guard: metric=wwc + fileWwc=0 → rejected (falls back to words)', async () => {
  fresh(); const acc = new StubAcceptor();
  await new XtmPollCycle(db, schedCfg({ ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: 1000 }), acc)
    .run(snapAt([xraw({ words: 861, fileWwc: 0, dueDate: dueMon1524 })], MON_10));
  expect(acc.calls.flat()).toHaveLength(0);
});
it('capacity keys off effort: WWC fits cap while raw words exceed it', async () => {
  fresh(); const acc = new StubAcceptor();
  await new XtmPollCycle(db, schedCfg({ ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: 1000 }), acc)
    .run(snapAt([xraw({ words: 1500, fileWwc: 800, dueDate: dueWed18 })], MON_10));
  expect(acc.calls.flat()).toHaveLength(1); // accepted (800 ≤ 1000)
});
it('malformed job: metric=wwc + words=null + fileWwc=null → rejected "WWC count unknown"', async () => {
  fresh(); const acc = new StubAcceptor();
  await new XtmPollCycle(db, schedCfg({ ACCEPT_EFFORT_METRIC: 'wwc', ACCEPT_MAX_WWC_PER_DAY: 1000 }), acc)
    .run(snapAt([xraw({ words: null, fileWwc: null, dueDate: dueWed18 })], MON_10));
  expect(acc.calls.flat()).toHaveLength(0);
  expect(only().rejectReason).toContain('WWC count unknown');
});
it('D9 telemetry: a words-mode reject carries raw words + effort + metric', async () => {
  fresh();
  const summary = await new XtmPollCycle(db, schedCfg({ ACCEPT_EFFORT_METRIC: 'words' }), new StubAcceptor())
    .run(snapAt([j4721900()], MON_10));
  const r = summary.scheduleRejects[0]!;
  expect(r.words).toBe(861); expect(r.effort).toBe(861); expect(r.metric).toBe('words');
});
```
- [ ] **Step 2: Run → FAIL** (still keys off words / no metric field).
- [ ] **Step 3: Implement** the cycle edits per the Files list.
- [ ] **Step 4: Run → PASS; Step 5: Typecheck; Step 6: Commit** `feat(runtime): wire the effort metric into feasibility + capacity + bucket + telemetry`

---

## Task 7 (PR-B): systemAlerts — unit-aware `daily_cap_reached` + `held_job_no_deadline`

Convert the two static `TriggerSpec` entries to metric-aware builders (unit + active cap env-var name). **Root ops hazard:** the action currently names `ACCEPT_MAX_WORDS_PER_DAY` — wrong in wwc mode.

**Files:**
- Modify: `src/reporting/systemAlerts.ts` (entries at lines ~159-166, ~173-180) — accept `unit: {adj}` + `capVar: string` (the active cap env-var name) and interpolate: `` `Daily ${unit.adj} cap reached …` ``, `` `… set ${capVar} in .env …` ``, `` `… over-accepted past the daily ${unit.adj} cap` ``. Thread `unit` + `capVar` from the caller (`raiseAlert` / the cycle passes `this.cfg.unit` + the active env-var name `this.cfg.ACCEPT_EFFORT_METRIC === 'wwc' ? 'ACCEPT_MAX_WWC_PER_DAY' : 'ACCEPT_MAX_WORDS_PER_DAY'`).
- Test: `tests/unit/systemAlerts.test.ts`.

- [ ] **Step 1: Write failing tests** — render `daily_cap_reached` both modes:
```ts
it('daily_cap_reached names the ACTIVE cap var + unit (wwc)', () => {
  const card = renderCard('daily_cap_reached', { unit: { adj: 'WWC', noun: 'WWC' }, capVar: 'ACCEPT_MAX_WWC_PER_DAY', ... });
  expect(text(card)).toContain('Daily WWC cap');
  expect(text(card)).toContain('ACCEPT_MAX_WWC_PER_DAY');
  expect(text(card)).not.toContain('ACCEPT_MAX_WORDS_PER_DAY');
});
it('daily_cap_reached is byte-for-byte in words mode', () => {
  const card = renderCard('daily_cap_reached', { unit: { adj: 'word', noun: 'words' }, capVar: 'ACCEPT_MAX_WORDS_PER_DAY', ... });
  expect(text(card)).toContain('Daily word cap reached — auto-accept paused for today');
  expect(text(card)).toContain('ACCEPT_MAX_WORDS_PER_DAY');
});
```
- [ ] **Step 2: Run → FAIL; Step 3: Implement** the builder + thread `unit`/`capVar` (from `raiseAlert` call sites in the cycle); **Step 4: Run → PASS; Step 5: Commit** `feat(reporting): unit-aware cap alerts naming the active cap env var`

---

## Task 8 (PR-B): dailyReport — active cap + unit

**Files:**
- Modify: `src/reporting/dailyReport.ts` — `buildDailyReportCard` gains a `unit: {adj; noun}` param; sum `effortOf(j, metric) ?? 0` (thread `metric` too, or pass a pre-bound effort fn); `${dueTodayWords} words (cap …)` → `${dueTodayEffort} ${unit.noun} (cap ${activeCap}/day …)`; Overdue `w words` → `${w} ${unit.noun}`; per-job `${j.words}w` → `${effortOf(j,metric)} ${unit.adj}` (words-mode still renders `Nw`? — pin the format: words-mode `${n}w`, wwc-mode `${n} WWC`).
- Modify: `src/runtime/xtmPollLoop.ts` — the `buildDailyReportCard(...)` call passes `this.cfg.activeMaxPerDay` (not `ACCEPT_MAX_WORDS_PER_DAY`) + `this.cfg.unit` + `this.cfg.ACCEPT_EFFORT_METRIC`.
- Test: `tests/unit/dailyReport.test.ts` — the `job()`/`makeJob` factories must set `fileWwc`.

- [ ] **Step 1: Write failing tests** (wwc/words twins):
```ts
it('metric=wwc: Due-today sums WWC and labels WWC', () => {
  const held = [job({ dueDate: '2026-06-25T18:00:00+07:00', words: 500, fileWwc: 120 })];
  const card = buildDailyReportCard(held, NOW, URL, 1000, deadlineDayOf, true, { adj: 'WWC', noun: 'WWC' }, 'wwc');
  expect(text(card)).toContain('120 WWC'); expect(text(card)).not.toContain('500 words');
});
it('metric=words: byte-for-byte — sums words, labels words, ignores fileWwc', () => {
  const held = [job({ dueDate: '2026-06-25T18:00:00+07:00', words: 500, fileWwc: 120 })];
  const card = buildDailyReportCard(held, NOW, URL, 1000, deadlineDayOf, true, { adj: 'word', noun: 'words' }, 'words');
  expect(text(card)).toContain('500 words');
});
```
- [ ] **Step 2: Run → FAIL; Step 3: Implement** (param + sums + labels + call site); **Step 4: Run → PASS; Step 5: Commit** `feat(reporting): daily report renders the active effort metric + cap`

---

## Task 9 (PR-B): Chat cards — File WWC row (D11)

**Files:**
- Modify: `src/reporting/xtmNotifier.ts` — `renderXtmNewJob` / `renderXtmRelisted` / `renderXtmAccepted` add a row `{ label: 'File WWC', value: wwcValue(job.fileWwc) }` after the existing `{ label: 'Words', value: … }`. Reuse/extend the existing value formatter for a null → em-dash.
- Test: `tests/unit/xtmNotifier.test.ts`.

- [ ] **Step 1: Write the failing test**:
```ts
it('the new-job card shows a File WWC row next to Words', () => {
  const card = renderXtmNewJob(job({ words: 861, fileWwc: 169 }), ...);
  expect(cardText(card)).toContain('File WWC');
  expect(cardText(card)).toContain('169');
});
it('a blank File WWC renders an em-dash like a blank word count', () => {
  const card = renderXtmNewJob(job({ words: 861, fileWwc: null }), ...);
  expect(rowValue(card, 'File WWC')).toBe('—');
});
```
- [ ] **Step 2: Run → FAIL; Step 3: Implement** the row in all three renderers; **Step 4: Run → PASS; Step 5: Commit** `feat(reporting): show File WWC on the Chat cards (both metrics)`

---

## Task 10 (PR-B): Docs

**Files:**
- Modify: `.env.example` — document `ACCEPT_EFFORT_METRIC` (default wwc), `ACCEPT_MAX_WWC_PER_DAY` (default 1000), `ACCEPT_THROUGHPUT_WWC_PER_HOUR`; note the two caps are per-metric.
- Modify: `CLAUDE.md` — the "2 สวิตช์ accept" note → **3** (`ACCEPT_ENABLED`, `ACCEPT_SCHEDULE_ENABLED`, `ACCEPT_EFFORT_METRIC`); note `metric=words` reverts byte-for-byte and WWC is the team's effort unit.

- [ ] **Step 1: Edit both files** (docs, no test). **Step 2: `npm run lint`** (prettier checks .md). **Step 3: Commit** `docs: document the ACCEPT_EFFORT_METRIC switch`

---

## Final verification (before finishing the branch)

- [ ] `npm run typecheck` → clean
- [ ] `npm run lint` → clean
- [ ] `npm run test:coverage` → all green, ≥80% on detection/state/reporting/schedule (the new `effort.ts` + changed sheets/report/alerts branches covered by Tasks 2/5/7/8/9)
- [ ] Confirm the two-commit ordering (Task 1 alone is behavior+text-preserving — `git show` its diff has NO string/number change)

## Self-review notes (spec coverage)

Every spec §5 component maps to a task: 5.1→T2, 5.2/5.3→T1(rename)+T5(unit), 5.4→T1(rename)+T4(mapper), 5.5→T3, 5.6→T1(rename)+T6, 5.7→T8, 5.8→T10, 5.9→T7, 5.10→T1(rename)+T6, 5.11→T9. D10 sequencing = Task 1 vs Tasks 2–10. All §7 tests are placed in their task's Step 1.
