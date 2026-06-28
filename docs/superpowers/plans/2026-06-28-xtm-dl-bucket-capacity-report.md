# XTM Deadline-Bucketed Capacity + Workload Daily Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap auto-accept by **words due per deadline day** and rebuild the 09:00 report around **outstanding workload by deadline**, both derived from the held list (`lifecycle_status='accepted'`) — no persistent counter.

**Architecture:** A finished job returns its deadline-day quota because cap and report both read `XtmJobStore.listByLifecycle('accepted')`. A new store method `wordsDueByDeadline()` groups held words by deadline date; a pure `src/schedule/acceptCapacity.ts` helper decides a bulk group all-or-nothing per deadline day; the cycle seeds buckets from the store and advances them optimistically; the report builder derives Due-today / Overdue / In-progress from held and is throw-safe.

**Tech Stack:** Node 22 + TypeScript strict, better-sqlite3, Vitest, Bangkok time via `src/schedule/bangkokCalendar.ts` (fixed +07:00), Google Chat cardsV2 via `src/reporting/chatCard.ts`.

**Spec:** `docs/superpowers/specs/2026-06-28-xtm-dl-bucket-capacity-report-design.md` (read it — every task's behaviour detail lives there).

## Global Constraints

- **TDD**: write the failing test first, watch it fail, then implement. Coverage gate ≥ 80% on `src/detection`, `src/state`, `src/reporting`, `src/schedule`.
- **TZ rule**: the process has no timezone. ALL Bangkok math is `Date.parse` → `+ 7h` → read UTC parts (use `bangkokDateString`/`bangkokCalendar`, never `getHours()`/`toLocaleString()`). Every date in a test MUST be TZ-explicit (`...+07:00` or `...Z`) and the suite MUST pass under `TZ=UTC npx vitest run`.
- **Single source of truth**: capacity + report read the held list. Do NOT add a meta counter; `src/state/meta.ts` and `tests/unit/meta.test.ts` are UNTOUCHED.
- **Bulk-group all-or-nothing is language-only and covers BOTH feasibility and capacity**: a group is accepted only if EVERY member is feasible AND no deadline-day bucket overflows; otherwise the WHOLE language group is rejected (never partially — owned-but-Rejected is irreversible).
- **Kill-switch**: `ACCEPT_SCHEDULE_ENABLED=0` must remain byte-for-byte the pre-feature accept path. No config/env changes.
- **Commands**: `npx vitest run <file>` (single file), `npm run lint`, `npm run typecheck`, `npm run test:coverage`. Branch `feat/dl-bucket-capacity-report` already exists with the spec commit.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/reporting/dailyReport.ts` | Build the workload card from held (Due-today/Overdue/In-progress), throw-safe | 1 |
| `tests/unit/dailyReport.test.ts` | Migrate to 4-arg builder + new layout; new branch tests | 1 |
| `src/runtime/xtmPollLoop.ts` | Move report build inside try/catch; drop the counter read | 2 |
| `src/state/xtmJobStore.ts` | `wordsDueByDeadline(): Map<string, number>` | 3 |
| `tests/unit/xtmJobStore.test.ts` (or existing state test) | bucket grouping + null-deadline skip | 3 |
| `src/schedule/acceptCapacity.ts` | Pure `decideGroupCapacity` (per-deadline-day, all-or-nothing) | 4 |
| `tests/unit/acceptCapacity.test.ts` | every branch | 4 |
| `src/schedule/acceptSchedule.ts` | drop the capacity check → feasibility-only | 5 |
| `tests/unit/acceptSchedule.test.ts` | delete cap-ordering tests; keep feasibility | 5 |
| `src/runtime/xtmPollCycle.ts` | held-derived seed + decideGroupCapacity + per-day advance; drop counter | 6 |
| `tests/integration/xtmCycle.test.ts` | multi-deadline allow, finished-returns-quota+negative, cross-day all-or-nothing, seed-skips-null, cap_reached-per-day | 6 |

**Order:** Component B (Tasks 1–2) first — it alone fixes night-visibility with near-zero gate risk. Then Component A (Tasks 3–6).

---

## Task 1: Daily report from the held list (throw-safe)

**Files:**
- Modify: `src/reporting/dailyReport.ts` (replace `buildDailyReportCard`; keep `bangkokDate` + `dueDailyReport`)
- Test: `tests/unit/dailyReport.test.ts`

**Interfaces:**
- Consumes: `XtmJobState` (`{ projectName, fileName, dueDate: string|null, dueRaw: string|null, words: number|null }`), `buildCard` from `./chatCard.js` (`CardRow{emoji?,label,value}`), `bangkokCalendar`/`bangkokDateString` from `../schedule/bangkokCalendar.js`, `formatReadableDate` from `./dateFormat.js`.
- Produces: `buildDailyReportCard(held: XtmJobState[], nowMs: number, xtmUrl: string, maxWordsPerDay: number): { cardsV2: unknown[] }` — **never throws**.

- [ ] **Step 1: Write the failing tests** (TZ-explicit; cover spec §7 #4,#5,#6)

```ts
// tests/unit/dailyReport.test.ts — replace the buildDailyReportCard describe block
import { describe, it, expect } from 'vitest';
import { buildDailyReportCard } from '../../src/reporting/dailyReport.js';
import type { XtmJobState } from '../../src/detection/types.js';

const job = (o: Partial<XtmJobState>): XtmJobState =>
  ({ jobKey: o.fileName ?? 'k', xtmTaskId: null, projectName: o.projectName ?? 'P',
     fileName: o.fileName ?? 'f', sourceLang: null, targetLang: 'Malay (Malaysia)',
     dueDate: o.dueDate ?? null, dueRaw: o.dueRaw ?? null, words: o.words ?? null,
     step: null, role: null, eligible: true, lifecycleStatus: 'accepted', acceptStatus: 'accepted',
     acceptedAt: null, status: 'visible', firstSeenAt: '', lastSeenAt: '', snapshotHash: '',
     consecutiveMisses: 0 }) as XtmJobState;
const NOW = Date.parse('2026-06-25T09:00:00+07:00');
const text = (r: { cardsV2: unknown[] }) => JSON.stringify(r);

it('Due-today headline sums held words whose deadline date is today (night accept incl.)', () => {
  const held = [
    job({ fileName: 'a', dueDate: '2026-06-25T18:00:00+07:00', words: 200 }), // today
    job({ fileName: 'b', dueDate: '2026-06-25T02:00:00+07:00', words: 100 }), // today (already past instant)
    job({ fileName: 'c', dueDate: '2026-06-26T18:00:00+07:00', words: 500 }), // tomorrow
  ];
  const card = text(buildDailyReportCard(held, NOW, 'http://x', 1000));
  expect(card).toContain('Due today');
  expect(card).toContain('300 words'); // 200 + 100, NOT 800
  expect(card).toContain('cap 1000/day');
});

it('Overdue (instant-based) row appears only when a held deadline is past; omitted otherwise', () => {
  const overdue = text(buildDailyReportCard(
    [job({ fileName: 'b', dueDate: '2026-06-25T02:00:00+07:00', words: 100 })], NOW, 'http://x', 1000));
  expect(overdue).toContain('Overdue');
  const none = text(buildDailyReportCard(
    [job({ fileName: 'a', dueDate: '2026-06-25T18:00:00+07:00', words: 200 })], NOW, 'http://x', 1000));
  expect(none).not.toContain('Overdue');
});

it('bucket boundary is Bangkok day: 23:59 today counts, next-day 00:00 does not', () => {
  const inDay = text(buildDailyReportCard(
    [job({ dueDate: '2026-06-25T23:59:00+07:00', words: 100 })], NOW, 'http://x', 1000));
  expect(inDay).toContain('100 words');
  const nextDay = text(buildDailyReportCard(
    [job({ dueDate: '2026-06-26T00:00:00+07:00', words: 100 })], NOW, 'http://x', 1000));
  expect(nextDay).toContain('0 words');
});

it('is TOTAL: a null and an unparseable deadline + null words never throw and sort last', () => {
  const held = [
    job({ fileName: 'good', dueDate: '2026-06-25T18:00:00+07:00', words: 100 }),
    job({ fileName: 'bad', dueDate: 'not-a-date', words: null }),
    job({ fileName: 'nul', dueDate: null, words: 50 }),
  ];
  expect(() => buildDailyReportCard(held, NOW, 'http://x', 1000)).not.toThrow();
  const card = text(buildDailyReportCard(held, NOW, 'http://x', 1000));
  expect(card).toContain('100 words'); // bad/nul excluded from the sum
});

it('In-progress shows top 5 by deadline asc; "(+N more)" only when N>0', () => {
  const five = Array.from({ length: 5 }, (_, i) =>
    job({ fileName: `f${i}`, dueDate: `2026-06-2${5 + i}T18:00:00+07:00`, words: 10 }));
  expect(text(buildDailyReportCard(five, NOW, 'http://x', 1000))).not.toContain('more');
  const six = [...five, job({ fileName: 'f6', dueDate: '2026-07-01T18:00:00+07:00', words: 10 })];
  expect(text(buildDailyReportCard(six, NOW, 'http://x', 1000))).toContain('1 more');
});

it('cap=0 → "(no cap)" headline', () => {
  expect(text(buildDailyReportCard(
    [job({ dueDate: '2026-06-25T18:00:00+07:00', words: 100 })], NOW, 'http://x', 0)))
    .toContain('no cap');
});
```

- [ ] **Step 2: Run, verify they fail** — `npx vitest run tests/unit/dailyReport.test.ts` (FAIL: old signature / wording).

- [ ] **Step 3: Implement** — replace `buildDailyReportCard` in `src/reporting/dailyReport.ts`:

```ts
export function buildDailyReportCard(
  held: XtmJobState[],
  nowMs: number,
  xtmUrl: string,
  maxWordsPerDay: number,
): { cardsV2: unknown[] } {
  const today = bangkokDate(nowMs);
  const dueMs = (j: XtmJobState): number => {
    const t = j.dueDate ? Date.parse(j.dueDate) : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY; // unparseable → sorts last
  };

  let dueTodayWords = 0;
  const overdue: XtmJobState[] = [];
  for (const j of held) {
    const ms = dueMs(j);
    if (!Number.isFinite(ms)) continue;
    if (ms < nowMs) overdue.push(j);
    if (bangkokDate(ms) === today) dueTodayWords += j.words ?? 0; // day-based = the cap bucket
  }

  const usage = maxWordsPerDay > 0
    ? `${dueTodayWords} words (cap ${maxWordsPerDay}/day per deadline)`
    : `${dueTodayWords} words (no cap)`;

  const rows: CardRow[] = [{ label: 'Due today', value: usage }];
  if (overdue.length > 0) {
    const w = overdue.reduce((a, j) => a + (j.words ?? 0), 0);
    rows.push({ emoji: '⚠️', label: 'Overdue', value: `${overdue.length} job(s) · ${w} words` });
  }

  const sorted = [...held].sort((a, b) => dueMs(a) - dueMs(b) || a.jobKey.localeCompare(b.jobKey));
  const top = sorted.slice(0, 5);
  const overdueSet = new Set(overdue.map((j) => j.jobKey));
  for (const j of top) {
    rows.push({
      emoji: overdueSet.has(j.jobKey) ? '⚠️' : undefined,
      label: dash(j.projectName),
      value: `${formatReadableDate(j.dueDate ?? j.dueRaw ?? null) || '—'} · ${dash(j.fileName)} · ${j.words != null ? `${j.words}w` : '—'}`,
    });
  }
  const more = sorted.length - top.length;
  if (more > 0) rows.push({ label: '—', value: `(+${more} more)` });

  return buildCard({
    cardId: `daily-${today}`,
    headerTitle: `📋 Daily Report — ${formatReadableDate(`${today}T00:00:00+07:00`)?.slice(0, 10) ?? today}`,
    rows,
    buttonUrl: xtmUrl,
    buttonText: 'Open in XTM',
  });
}
```
(Keep the existing imports; ensure `dash` from `./cardText.js` and `CardRow` type are imported. The header date may use `today` directly if `formatReadableDate` of a date-only is awkward — pin to `📋 Daily Report — ${today}` if simpler; update the test's header assertion to match whatever you ship.)

- [ ] **Step 4: Run** — `TZ=UTC npx vitest run tests/unit/dailyReport.test.ts` (PASS). Fix any other test in the file still on the old 5-arg signature / `📋 Jobs in Progress` header.

- [ ] **Step 5: Commit** — `git add src/reporting/dailyReport.ts tests/unit/dailyReport.test.ts && git commit -m "feat(reporting): daily report from held list — Due today/Overdue/In progress, throw-safe (Component B)"`

---

## Task 2: Move the report build inside the loop try/catch + drop the counter read

**Files:**
- Modify: `src/runtime/xtmPollLoop.ts` (the daily-report block, ~lines 339–386)
- Test: `tests/integration/xtmPollLoop.test.ts`

**Interfaces:**
- Consumes: `buildDailyReportCard(held, nowMs, xtmUrl, maxWordsPerDay)` (Task 1), `this.store.listByLifecycle('accepted')`, `this.cfg.ACCEPT_MAX_WORDS_PER_DAY`.

- [ ] **Step 1: Write the failing test** — a report-build throw must NOT page (spec §7 #7):

```ts
// tests/integration/xtmPollLoop.test.ts — add
it('a daily-report build throw does not page (no heartbeat.fail) and does not advance lastDailyReportDate', async () => {
  // Arrange a loop whose clock returns a 09:00 working-day instant so dueDailyReport→true,
  // a store whose listByLifecycle('accepted') throws, and a spy heartbeat.
  // (Follow the existing harness in this file for building the loop + fakes.)
  // Act: await loop.runOnce()
  // Assert:
  expect(heartbeat.fail).not.toHaveBeenCalled();
  expect(heartbeat.ok).toHaveBeenCalled();           // the cycle still reported healthy
  expect(meta.lastDailyReportDate).not.toBe(todayStr); // not advanced → retries next cycle
});
```
(Use the file's existing loop-construction helpers and fake injection; if `listByLifecycle` is hard to force-throw, make `buildDailyReportCard`’s input throw via a held job the builder is asserted total against — but prefer forcing the DB read to throw to exercise the moved try-scope.)

- [ ] **Step 2: Run, verify it fails** — `npx vitest run tests/integration/xtmPollLoop.test.ts` (FAIL: throw escapes to the outer catch → `heartbeat.fail` called).

- [ ] **Step 3: Implement** — in `src/runtime/xtmPollLoop.ts`, move `listByLifecycle('accepted')` and `buildDailyReportCard(...)` INSIDE the existing report `try {`. Pass `this.cfg.ACCEPT_MAX_WORDS_PER_DAY` (4th arg); delete the `this.meta.acceptedWordsToday(date)` read. Sketch:

```ts
if (dueDailyReport(nowMs, this.meta.lastDailyReportDate, this.cfg.workdays,
                   getThaiHolidays(bangkokYear(nowMs)).holidays)) {
  try {
    const held = this.store.listByLifecycle('accepted');
    const card = buildDailyReportCard(
      held, nowMs, this.cfg.XTM_ACOLAD_OFFERS_URL, this.cfg.ACCEPT_MAX_WORDS_PER_DAY);
    // ...existing enqueue(card) + this.meta.setLastDailyReportDate(date) (unchanged, still inside try)...
  } catch (err) {
    this.logger.warn({ err }, 'daily report build/enqueue failed; will retry next cycle');
  }
}
```
Keep `dueDailyReport` and `const date = bangkokDate(nowMs)` where they are. The `setLastDailyReportDate` must stay inside the try AFTER a successful enqueue (so a failure does not advance it).

- [ ] **Step 4: Run** — `TZ=UTC npx vitest run tests/integration/xtmPollLoop.test.ts` (PASS).

- [ ] **Step 5: Commit** — `git add src/runtime/xtmPollLoop.ts tests/integration/xtmPollLoop.test.ts && git commit -m "fix(runtime): build daily report inside the loop try/catch (no page on report bug); drop counter read"`

---

## Task 3: `XtmJobStore.wordsDueByDeadline()`

**Files:**
- Modify: `src/state/xtmJobStore.ts`
- Test: `tests/unit/xtmJobStore.test.ts` (create if absent; else the existing state test file)

**Interfaces:**
- Consumes: `listByLifecycle('accepted')` (existing), `bangkokDateString` from `../schedule/bangkokCalendar.js`.
- Produces: `wordsDueByDeadline(): Map<string, number>` — Bangkok deadline date `YYYY-MM-DD` → Σ words of held jobs due that day. Jobs with null/unparseable `dueDate` are **skipped** (no key).

- [ ] **Step 1: Write the failing test:**

```ts
// tests/unit/xtmJobStore.test.ts
it('wordsDueByDeadline buckets held words by Bangkok deadline date and skips null/unparseable', () => {
  const store = new XtmJobStore(db); // use the file's existing in-memory db harness
  store.upsertMany([
    accepted({ jobKey: 'a', dueDate: '2026-06-24T18:00:00+07:00', words: 100 }),
    accepted({ jobKey: 'b', dueDate: '2026-06-24T09:00:00+07:00', words: 200 }),
    accepted({ jobKey: 'c', dueDate: '2026-06-25T18:00:00+07:00', words: 50 }),
    accepted({ jobKey: 'd', dueDate: null, words: 999 }),          // skipped
    accepted({ jobKey: 'e', dueDate: 'garbage', words: 999 }),     // skipped
  ]);
  const m = store.wordsDueByDeadline();
  expect(m.get('2026-06-24')).toBe(300);
  expect(m.get('2026-06-25')).toBe(50);
  expect(m.size).toBe(2);
});
```
(`accepted(...)` = a helper building an `XtmJobState` with `lifecycleStatus:'accepted'` — mirror Task 1's `job()`.)

- [ ] **Step 2: Run, verify it fails** — method undefined.

- [ ] **Step 3: Implement** — add to `XtmJobStore` (import `bangkokDateString`):

```ts
/** Σ words of held (lifecycle 'accepted') jobs grouped by Bangkok deadline date.
 *  Null/unparseable deadlines are skipped (never a NaN key). Single source of truth
 *  for the per-deadline-day capacity cap. */
wordsDueByDeadline(): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of this.listByLifecycle('accepted')) {
    const t = s.dueDate ? Date.parse(s.dueDate) : NaN;
    if (!Number.isFinite(t)) continue;
    const d = bangkokDateString(t);
    out.set(d, (out.get(d) ?? 0) + (s.words ?? 0));
  }
  return out;
}
```

- [ ] **Step 4: Run** — `TZ=UTC npx vitest run tests/unit/xtmJobStore.test.ts` (PASS).

- [ ] **Step 5: Commit** — `git add src/state/xtmJobStore.ts tests/unit/xtmJobStore.test.ts && git commit -m "feat(state): XtmJobStore.wordsDueByDeadline() — held words per deadline day"`

---

## Task 4: Pure capacity helper `src/schedule/acceptCapacity.ts`

**Files:**
- Create: `src/schedule/acceptCapacity.ts`
- Test: `tests/unit/acceptCapacity.test.ts`

**Interfaces:**
- Produces:
```ts
export interface CapacityMember { jobKey: string; words: number; deadlineDate: string; }
export type GroupCapacityVerdict =
  | { accept: true; subtotalsByDay: Map<string, number> }
  | { accept: false; reason: string; capExhaustedDay?: string };
export function decideGroupCapacity(
  members: CapacityMember[],
  bucketFor: (deadlineDate: string) => number,
  cap: number,
): GroupCapacityVerdict;
```

- [ ] **Step 1: Write the failing tests** (spec §7 #9 — every branch):

```ts
// tests/unit/acceptCapacity.test.ts
import { describe, it, expect } from 'vitest';
import { decideGroupCapacity, type CapacityMember } from '../../src/schedule/acceptCapacity.js';
const m = (jobKey: string, words: number, deadlineDate: string): CapacityMember => ({ jobKey, words, deadlineDate });
const empty = () => 0;

it('accepts and returns per-day subtotals when every day fits', () => {
  const v = decideGroupCapacity([m('a', 800, '2026-06-23'), m('b', 800, '2026-06-24')], empty, 1000);
  expect(v.accept).toBe(true);
  if (v.accept) { expect(v.subtotalsByDay.get('2026-06-23')).toBe(800); expect(v.subtotalsByDay.get('2026-06-24')).toBe(800); }
});
it('blocks the whole group when one day fills the budget (capExhaustedDay set)', () => {
  const v = decideGroupCapacity([m('a', 300, '2026-06-23')], (d) => (d === '2026-06-23' ? 800 : 0), 1000);
  expect(v).toEqual({ accept: false, reason: expect.stringContaining('daily word cap reached for 2026-06-23'), capExhaustedDay: '2026-06-23' });
});
it('blocks with "exceed the daily cap" (no capExhaustedDay) when one day alone > cap', () => {
  const v = decideGroupCapacity([m('a', 1500, '2026-06-23')], empty, 1000);
  expect(v.accept).toBe(false);
  if (!v.accept) { expect(v.reason).toContain('exceed the daily cap'); expect(v.capExhaustedDay).toBeUndefined(); }
});
it('cap=0 means no limit', () => {
  expect(decideGroupCapacity([m('a', 99999, '2026-06-23')], empty, 0).accept).toBe(true);
});
it('cross-day: one overflowing day blocks the group including the fitting day', () => {
  const v = decideGroupCapacity([m('a', 100, '2026-06-23'), m('b', 1100, '2026-06-24')], empty, 1000);
  expect(v.accept).toBe(false);
  if (!v.accept) expect(v.reason).toContain('2026-06-24');
});
```

- [ ] **Step 2: Run, verify it fails** — module missing.

- [ ] **Step 3: Implement** `src/schedule/acceptCapacity.ts`:

```ts
export interface CapacityMember { jobKey: string; words: number; deadlineDate: string; }
export type GroupCapacityVerdict =
  | { accept: true; subtotalsByDay: Map<string, number> }
  | { accept: false; reason: string; capExhaustedDay?: string };

/** Decide a whole bulk group all-or-nothing, bucketed by deadline day. `bucketFor(d)` =
 *  words already due on day d (held + this cycle's optimistic advances). */
export function decideGroupCapacity(
  members: CapacityMember[],
  bucketFor: (deadlineDate: string) => number,
  cap: number,
): GroupCapacityVerdict {
  const subtotalsByDay = new Map<string, number>();
  for (const mem of members)
    subtotalsByDay.set(mem.deadlineDate, (subtotalsByDay.get(mem.deadlineDate) ?? 0) + mem.words);

  if (cap > 0) {
    for (const [day, subtotal] of subtotalsByDay) {
      const bucket = bucketFor(day);
      if (bucket + subtotal > cap) {
        if (subtotal > cap)
          return { accept: false, reason: `group words due ${day} (${subtotal}) exceed the daily cap (${cap}) — accept manually` };
        return { accept: false, reason: `daily word cap reached for ${day} (${bucket}+${subtotal} > ${cap})`, capExhaustedDay: day };
      }
    }
  }
  return { accept: true, subtotalsByDay };
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/unit/acceptCapacity.test.ts` (PASS).

- [ ] **Step 5: Commit** — `git add src/schedule/acceptCapacity.ts tests/unit/acceptCapacity.test.ts && git commit -m "feat(schedule): pure decideGroupCapacity — per-deadline-day all-or-nothing cap"`

---

## Task 5: `evaluateAcceptSchedule` → feasibility-only

**Files:**
- Modify: `src/schedule/acceptSchedule.ts` (remove the capacity check + its inputs)
- Test: `tests/unit/acceptSchedule.test.ts` (delete the cap-ordering tests)

**Interfaces:**
- Produces: `evaluateAcceptSchedule(i)` where `AcceptScheduleInput` no longer has `acceptedWordsToday` or `maxWordsPerDay`. All callers (the cycle) stop passing them.

- [ ] **Step 1: Update the tests first** — DELETE the two capacity tests (`acceptSchedule.test.ts` ~lines 43-48 "words=0 at the cap still blocks" and ~143-156 "cap check precedes the words check"); they reference removed inputs and won't typecheck. Keep every feasibility/holiday/non-working/disabled test. Add one asserting the disabled early-return is still first:
```ts
it('disabled → allow regardless of feasibility', () => {
  expect(evaluateAcceptSchedule({ ...baseInput, enabled: false }).allow).toBe(true);
});
```
(Remove `acceptedWordsToday`/`maxWordsPerDay` from every `baseInput`/input literal in the file.)

- [ ] **Step 2: Run, verify red** — `npx vitest run tests/unit/acceptSchedule.test.ts` (FAIL typecheck until impl matches).

- [ ] **Step 3: Implement** — in `src/schedule/acceptSchedule.ts`: remove fields `acceptedWordsToday` and `maxWordsPerDay` from `AcceptScheduleInput`, and delete the capacity check block (the `if (i.maxWordsPerDay > 0 && i.acceptedWordsToday >= i.maxWordsPerDay) ...` after the `enabled` guard). Leave the `if (!i.enabled) return { allow: true };` FIRST. The first real check becomes `dueAtMs === null`.

- [ ] **Step 4: Run** — `TZ=UTC npx vitest run tests/unit/acceptSchedule.test.ts` (PASS). (`xtmPollCycle.ts` will not typecheck yet — fixed in Task 6.)

- [ ] **Step 5: Commit** — `git add src/schedule/acceptSchedule.ts tests/unit/acceptSchedule.test.ts && git commit -m "refactor(schedule): evaluateAcceptSchedule is feasibility-only (capacity moves to acceptCapacity)"`

---

## Task 6: Wire the cycle — held-derived seed + decideGroupCapacity

**Files:**
- Modify: `src/runtime/xtmPollCycle.ts` (the schedule-gate block ~275–379; the record txn ~419–437; `scheduleVerdict` call; remove `acceptedWordsToday`/`addAcceptedWords`/`wordsByKey`-for-counter)
- Test: `tests/integration/xtmCycle.test.ts`

**Interfaces:**
- Consumes: `store.wordsDueByDeadline()` (Task 3); `decideGroupCapacity`, `CapacityMember`, `GroupCapacityVerdict` (Task 4); `bangkokDateString`; `evaluateAcceptSchedule` (feasibility-only, Task 5).

- [ ] **Step 1: Write the failing integration tests** (spec §7 #1,#2,#3,#8,#10). Re-key the existing I3a/I3b cap-message tests to deadline-date wording. Add:

```ts
// tests/integration/xtmCycle.test.ts — TZ-explicit; use the file's snapAt/xraw/StubAcceptor helpers
it('multi-deadline ALLOW: two feasible Malay jobs > cap combined but ≤ cap each day → both accepted', async () => {
  fresh(); const acc = new StubAcceptor();
  await new XtmPollCycle(db, schedCfg(), acc).run(snapAt([
    xraw({ fileName: 'tue.docx', projectName: 'P', dueDate: dueTue18, words: 800 }),
    xraw({ fileName: 'wed.docx', projectName: 'P', dueDate: dueWed18, words: 800 }),
  ], MON_10));
  expect(acc.calls.flat()).toHaveLength(2);
  const m = new XtmJobStore(db).wordsDueByDeadline();
  expect(m.get(bangkokDateString(Date.parse(dueTue18)))).toBe(800);
  expect(m.get(bangkokDateString(Date.parse(dueWed18)))).toBe(800);
});

it('finished returns quota (A3) with a negative control', async () => {
  fresh();
  // negative control: Tue bucket already 800 (a held accepted job) → a new 800w-due-Tue is rejected
  new XtmJobStore(db).upsertMany([accepted({ jobKey: 'old', dueDate: dueTue18, words: 800 })]);
  await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(
    snapAt([xraw({ fileName: 'new.docx', dueDate: dueTue18, words: 800 })], MON_10));
  expect(only('new.docx').lifecycleStatus).toBe('rejected'); // 800+800 > 1000
  // free the quota: the old job finishes (leaves 'accepted')
  finishJob(db, 'old'); // set lifecycle_status='closed'
  await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(
    snapAt([xraw({ fileName: 'new.docx', dueDate: dueTue18, words: 800 })], MON_10b));
  expect(acceptedKeys(db)).toContain(jobKeyFor('new.docx')); // now accepted
});

it('cross-deadline all-or-nothing: a Wed-overflow blocks the whole Malay group incl the fitting Tue job', async () => {
  fresh();
  new XtmJobStore(db).upsertMany([accepted({ jobKey: 'w', dueDate: dueWed18, words: 900 })]); // Wed near full
  await new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(snapAt([
    xraw({ fileName: 'tue.docx', dueDate: dueTue18, words: 100 }),
    xraw({ fileName: 'wed.docx', dueDate: dueWed18, words: 200 }), // 900+200 > 1000
  ], MON_10));
  expect(only('tue.docx').lifecycleStatus).toBe('rejected');
  expect(only('wed.docx').lifecycleStatus).toBe('rejected');
  const note = sheetRows().find((r) => r.file === 'tue.docx')?.note ?? '';
  expect(note).toContain(bangkokDateString(Date.parse(dueWed18)));
});

it('capacity seed skips a null-deadline held job without crashing', async () => {
  fresh();
  new XtmJobStore(db).upsertMany([accepted({ jobKey: 'nul', dueDate: null, words: 999 })]);
  await expect(new XtmPollCycle(db, schedCfg(), new StubAcceptor()).run(
    snapAt([xraw({ fileName: 'ok.docx', dueDate: dueTue18, words: 100 })], MON_10))).resolves.toBeDefined();
});
```
(Add `accepted(...)`, `finishJob`, `acceptedKeys`, `dueTue18`/`dueWed18` helpers to the test file mirroring its existing `dueWed18`/`MON_10` style. `MON_10b` = a later instant so the second cycle re-attempts via the robustness pass.)

- [ ] **Step 2: Run, verify they fail** — `npx vitest run tests/integration/xtmCycle.test.ts`.

- [ ] **Step 3: Implement the cycle changes:**

1. Delete `const today = bangkokDateString(detectedMs); let acceptedWordsToday = this.meta.acceptedWordsToday(today);` (lines ~169-170). Replace with a memoizing held-derived bucket reader, seeded ONCE before any accept is recorded:
```ts
const dueSeed = scheduleEnabled ? this.store.wordsDueByDeadline() : new Map<string, number>();
const dueBuckets = new Map<string, number>(); // memoized running buckets for this cycle
const bucketFor = (d: string): number => {
  let v = dueBuckets.get(d);
  if (v === undefined) { v = dueSeed.get(d) ?? 0; dueBuckets.set(d, v); } // memoize on first miss
  return v;
};
const deadlineDateOf = (s: XtmJobState): string | null => {
  const t = s.dueDate ? Date.parse(s.dueDate) : NaN;
  return Number.isFinite(t) ? bangkokDateString(t) : null;
};
```

2. In the ON branch group loop (replace lines ~285-355): keep the feasibility pass that binds the first failing member's reason to block the whole group. Then, only if `blockReason === null`, build `CapacityMember[]` (skip members whose `deadlineDateOf` is null — they failed feasibility already when ON, so this is defensive) and call the helper:
```ts
const cap = this.cfg.ACCEPT_MAX_WORDS_PER_DAY;
for (const members of groups.values()) {
  let blockReason: string | null = null;
  for (const s of members) {
    const verdict = this.scheduleVerdict(s, detectedMs); // no acceptedWordsToday arg now
    if (blockReason === null && !verdict.allow) blockReason = `'${s.fileName}': ${verdict.reason}`;
  }
  let capExhaustedDay: string | undefined;
  if (blockReason === null && cap > 0) {
    const capMembers: CapacityMember[] = members.map((s) => ({
      jobKey: s.jobKey, words: s.words ?? 0, deadlineDate: deadlineDateOf(s)! }));
    const v = decideGroupCapacity(capMembers, bucketFor, cap);
    if (!v.accept) { blockReason = `'${members[0]!.fileName}': ${v.reason}`; capExhaustedDay = v.capExhaustedDay; }
    else for (const [day, sub] of v.subtotalsByDay) dueBuckets.set(day, bucketFor(day) + sub); // advance per day
  }
  if (blockReason === null) {
    for (const s of members) candidates.push(s);
  } else {
    const note = `group blocked: ${blockReason}`;
    for (const s of members) {
      s.lifecycleStatus = 'rejected';
      blockNotes.set(s.jobKey, note);
      summary.scheduleBlocked++;
      summary.scheduleRejects.push({ jobKey: s.jobKey, reason: blockReason, words: s.words, dueDate: s.dueDate });
    }
    if (capExhaustedDay)
      raiseAlert(this.db, this.outbox, 'daily_cap_reached', snapshot.capturedAt,
        `the ${cap}-word daily cap is reached for ${capExhaustedDay}`, {}, `daily_cap_reached:${capExhaustedDay}`);
  }
}
```
Keep the holiday-stale block (lines ~357-378) unchanged.

3. In the record txn (lines ~419-437): delete the `this.meta.addAcceptedWords(today, ...)` call and the `wordsByKey`-for-counter usage. (`wordsByKey` may be removed entirely if unused elsewhere — check; the OFF branch's `wordsByKey.set` was only for the counter, so remove it too.)

4. `scheduleVerdict` (private, ~633): drop the `acceptedWordsToday` parameter and stop passing `acceptedWordsToday`/`maxWordsPerDay` into `evaluateAcceptSchedule`.

- [ ] **Step 4: Run** — `TZ=UTC npx vitest run tests/integration/xtmCycle.test.ts && npm run typecheck` (PASS). Then the FULL suite: `TZ=UTC npx vitest run`.

- [ ] **Step 5: Commit** — `git add src/runtime/xtmPollCycle.ts tests/integration/xtmCycle.test.ts && git commit -m "feat(runtime): cap auto-accept by held words per deadline day (held-derived, all-or-nothing); drop accept-day counter (Component A)"`

---

## Final verification (after Task 6)

- [ ] `npm run lint` — 0 errors.
- [ ] `npm run typecheck` — clean.
- [ ] `TZ=UTC npx vitest run` — all green (the TZ landmine guard).
- [ ] `npm run test:coverage` — detection/state/reporting/schedule ≥ 80% (the new `acceptCapacity.ts` and `wordsDueByDeadline` covered; `dailyReport.ts` branches: overdue present/absent, top-5 at 5/6, null-deadline-last, cap=0).
- [ ] Confirm `src/state/meta.ts` + `tests/unit/meta.test.ts` are UNTOUCHED (`git diff main -- src/state/meta.ts` empty).
- [ ] Grep the accept path for a stray `acceptedWordsToday`/`addAcceptedWords` — none should remain in `xtmPollCycle.ts`.

## Complexity tracking (from the spec)

- **Held-read → over-accept coupling** (§5/§9): mitigated by settleGrid + the 2-miss disappear rule + feasibility + the rarely-hit cap; log `wordsDueOn(deadlineDate)` at the accept decision for an audit trail; cross-ref [[xtm-grid-loads-via-late-xhr]].
- **Two held reads per cycle** (cycle pre-accept seed, loop post-accept report) are intentional — do not merge.
- **Cap-hit rate may rise** — monitor after rollout.
