# XTM Accept Scheduling + Working-Hours Feasibility + Daily Word Capacity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the XTM auto-accept click so the bot accepts a Malay job only when the team can finish it within available working hours before its deadline, the deadline is not on a non-working day, and the daily word budget is not spent — blocked jobs are logged `Rejected` + reason and notified, never clicked.

**Architecture:** A new pure module `src/schedule/` computes the per-job verdict (`evaluateAcceptSchedule`) from snapshot time + the team's curated holiday data file. `xtmPollCycle` composes it with the existing `decideAccept` in one `evaluateCandidate` helper, decides **per bulk-accept group all-or-nothing** (a single portal click grabs the whole language group), persists a daily word counter in `meta`, and surfaces a new `'rejected'` lifecycle status to the Sheet + Chat. Throughput is derived from the daily capacity (one knob).

**Tech Stack:** Node 22, TypeScript strict (ESM/NodeNext), better-sqlite3, zod, pino, Vitest. No new runtime dependency.

## Global Constraints

- **TDD mandatory** for `src/detection/`, `src/state/`, `src/reporting/`, **and `src/schedule/`** (add the new dir to the coverage gate ≥ 80%). Write the failing test first; watch it fail before implementing.
- **TZ trap (CI runs UTC):** every date test MUST use TZ-explicit `+07:00` epoch inputs (e.g. `Date.parse('2026-06-22T17:00:00+07:00')`) — NEVER `new Date(y,m,d,...)` local. Bangkok is a fixed +07:00 offset (no DST). No `Date.now()`/`Math.random()` in `src/`.
- **Ship default ON.** `ACCEPT_SCHEDULE_ENABLED` disabled only on `'0'/'false'/'off'/'no'` (mirror the `XTM_YIELD_ENABLED` parser). Disabled ⇒ byte-for-byte today's behavior.
- **`ACCEPT_MAX_PER_CYCLE` stays `0`** (untouched). **Bulk accept grabs the whole language group in one click** — the gate decides per group all-or-nothing (§Task 12).
- Holidays = the team's curated `thaiHolidaysData.ts` (weekends via `ACCEPT_WORKDAYS`; cabinet special/substitution days EXCLUDED — the team works them). No holiday library.
- Defaults: hours `09:00–18:00` (end exclusive), workdays `1-5` (ISO Mon=1), `ACCEPT_MAX_WORDS_PER_DAY=1000`, throughput derived `= capacity ÷ working-hours-per-day` (≈ 111.1 with defaults).
- `lint` = `eslint . && prettier --check .` — run `npm run lint` (NOT just eslint; the `&&` masks prettier when eslint errors). Commit only when lint + typecheck + tests are green.
- New lifecycle status string is exactly `'rejected'` → Sheet display `'Rejected'`. Reason goes in the Sheet **Note** column and the Chat card.

---

## File Structure

**New (`src/schedule/`, all pure):**
- `bangkokCalendar.ts` — canonical Bangkok time helpers (date/weekday/minutes/epoch).
- `parseSchedule.ts` — `parseHHMM`, `parseWorkdays`, `resolveThroughput`.
- `workingHours.ts` — `workingMinutesBetween`, `isNonWorkingDay`.
- `thaiHolidaysData.ts` — `HOLIDAYS` data + `CURATED_YEARS`.
- `thaiHolidays.ts` — `getThaiHolidays(year)`, `resolveHolidaysForSpan(nowMs, dueAtMs)`.
- `acceptSchedule.ts` — `evaluateAcceptSchedule(input)` (the gate) + `AcceptScheduleInput`/`AcceptScheduleVerdict` types.

**Modified:**
- `src/detection/types.ts` — add `'rejected'` to `XtmLifecycleStatus`.
- `src/state/db.ts` — widen the `lifecycle_status` CHECK via a table-rebuild migration.
- `src/reporting/sheets.ts` — add `'Rejected'` to `SheetStatus` + the `lifecycleToSheetStatus` map.
- `src/state/meta.ts` — daily word counter accessors (delegate date keying to `bangkokDateString`).
- `src/config/index.ts` — `ACCEPT_SCHEDULE_*` vars + transforms + derived fields + refine.
- `src/reporting/systemAlerts.ts` — `holiday_calendar_stale` trigger.
- `src/reporting/dailyReport.ts` — capacity usage line.
- `src/runtime/xtmPollCycle.ts` — `evaluateCandidate` helper, per-group all-or-nothing, counter in the accept txn, reason threading.
- `.env.example` — document the new vars.

**Tests:** one `tests/unit/<name>.test.ts` per schedule module; extend `tests/integration/xtmCycle.test.ts` for the cycle; `tests/unit/` for config/sheets/meta/dailyReport/systemAlerts.

---

## Task 1: `bangkokCalendar` (canonical Bangkok time)

**Files:**
- Create: `src/schedule/bangkokCalendar.ts`
- Test: `tests/unit/bangkokCalendar.test.ts`

**Interfaces:**
- Produces:
  - `bangkokCalendar(ms: number): { date: string; weekday: number; minutesOfDay: number }` — `date` = `'YYYY-MM-DD'`, `weekday` ISO 1..7 (Mon=1, Sun=7), `minutesOfDay` 0..1439.
  - `bangkokDateString(ms: number): string` — `'YYYY-MM-DD'`.
  - `bangkokYear(ms: number): number`.
  - `bangkokEpochMs(date: string, minutes: number): number` — epoch ms of `date` at `minutes`-of-day Bangkok.

- [ ] **Step 1: Write the failing tests** (`tests/unit/bangkokCalendar.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import {
  bangkokCalendar,
  bangkokDateString,
  bangkokYear,
  bangkokEpochMs,
} from '../../src/schedule/bangkokCalendar.js';

const at = (iso: string): number => Date.parse(iso); // TZ-explicit inputs only

describe('bangkokCalendar', () => {
  it('reads Bangkok local parts from a +07:00 instant', () => {
    const c = bangkokCalendar(at('2026-06-22T15:30:00+07:00')); // Monday
    expect(c).toEqual({ date: '2026-06-22', weekday: 1, minutesOfDay: 15 * 60 + 30 });
  });

  it('maps Sunday to ISO weekday 7', () => {
    expect(bangkokCalendar(at('2026-06-21T10:00:00+07:00')).weekday).toBe(7); // Sunday
  });

  it('crosses the Bangkok midnight boundary correctly (UTC input)', () => {
    // 2026-06-26T16:30:00Z == 23:30 on the 26th Bangkok
    expect(bangkokDateString(Date.parse('2026-06-26T16:30:00Z'))).toBe('2026-06-26');
    // 2026-06-26T17:30:00Z == 00:30 on the 27th Bangkok
    expect(bangkokDateString(Date.parse('2026-06-26T17:30:00Z'))).toBe('2026-06-27');
  });

  it('minutesOfDay at edges', () => {
    expect(bangkokCalendar(at('2026-06-22T00:00:00+07:00')).minutesOfDay).toBe(0);
    expect(bangkokCalendar(at('2026-06-22T23:59:00+07:00')).minutesOfDay).toBe(23 * 60 + 59);
  });

  it('bangkokYear handles year rollover at Bangkok midnight', () => {
    expect(bangkokYear(Date.parse('2026-12-31T17:30:00Z'))).toBe(2027); // 00:30 Bangkok 1 Jan
  });

  it('bangkokEpochMs round-trips with bangkokCalendar', () => {
    const ms = bangkokEpochMs('2026-06-22', 9 * 60);
    expect(ms).toBe(at('2026-06-22T09:00:00+07:00'));
    const c = bangkokCalendar(ms);
    expect([c.date, c.minutesOfDay]).toEqual(['2026-06-22', 540]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/bangkokCalendar.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** (`src/schedule/bangkokCalendar.ts`)

```ts
/**
 * Canonical Asia/Bangkok time helpers. Bangkok is a FIXED +07:00 offset (no DST):
 * add 7h to the epoch ms then read UTC parts — never getHours()/process.env.TZ.
 * Shared by the schedule gate, the daily word counter, and the daily report.
 */
const BKK_OFFSET_MS = 7 * 3_600_000;
const p2 = (n: number): string => String(n).padStart(2, '0');

export function bangkokCalendar(ms: number): {
  date: string;
  weekday: number;
  minutesOfDay: number;
} {
  const d = new Date(ms + BKK_OFFSET_MS);
  const date = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  const weekday = ((d.getUTCDay() + 6) % 7) + 1; // 0=Sun..6=Sat → 1=Mon..7=Sun
  const minutesOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { date, weekday, minutesOfDay };
}

export function bangkokDateString(ms: number): string {
  return bangkokCalendar(ms).date;
}

export function bangkokYear(ms: number): number {
  return new Date(ms + BKK_OFFSET_MS).getUTCFullYear();
}

export function bangkokEpochMs(date: string, minutes: number): number {
  const hh = p2(Math.floor(minutes / 60));
  const mm = p2(minutes % 60);
  return Date.parse(`${date}T${hh}:${mm}:00+07:00`);
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/unit/bangkokCalendar.test.ts` → PASS. Also `TZ=UTC npx vitest run tests/unit/bangkokCalendar.test.ts` → PASS (CI-parity guard).

- [ ] **Step 5: Commit**

```bash
git add src/schedule/bangkokCalendar.ts tests/unit/bangkokCalendar.test.ts
git commit -m "feat(schedule): canonical Bangkok calendar helpers"
```

---

## Task 2: `parseSchedule` (HH:MM, workdays, throughput)

**Files:**
- Create: `src/schedule/parseSchedule.ts`
- Test: `tests/unit/parseSchedule.test.ts`

**Interfaces:**
- Produces:
  - `parseHHMM(s: string): number` — minutes 0..1439; throws `Error` on a bad format.
  - `parseWorkdays(s: string): Set<number>` — ISO 1..7; accepts ranges (`'1-5'`) and lists (`'1,2,3'`); throws on empty/out-of-range.
  - `resolveThroughput(o: { explicit?: number; maxWordsPerDay: number; hoursStartMin: number; hoursEndMin: number }): number` — `explicit` if set, else `maxWordsPerDay / ((hoursEndMin - hoursStartMin) / 60)`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { parseHHMM, parseWorkdays, resolveThroughput } from '../../src/schedule/parseSchedule.js';

describe('parseHHMM', () => {
  it('parses to minutes', () => {
    expect(parseHHMM('09:00')).toBe(540);
    expect(parseHHMM('18:00')).toBe(1080);
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('23:59')).toBe(1439);
  });
  it.each(['9:00', '24:00', '09:60', 'aa:bb', '', '09'])('rejects %s', (s) => {
    expect(() => parseHHMM(s)).toThrow();
  });
});

describe('parseWorkdays', () => {
  it('parses ranges and lists', () => {
    expect([...parseWorkdays('1-5')]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseWorkdays('1,3,5')].sort()).toEqual([1, 3, 5]);
    expect([...parseWorkdays('6-7')]).toEqual([6, 7]);
  });
  it.each(['', '0-5', '1-8', '8', 'a'])('rejects %s', (s) => {
    expect(() => parseWorkdays(s)).toThrow();
  });
});

describe('resolveThroughput', () => {
  it('derives capacity / working-hours-per-day when no explicit', () => {
    expect(resolveThroughput({ maxWordsPerDay: 1000, hoursStartMin: 540, hoursEndMin: 1080 }))
      .toBeCloseTo(1000 / 9, 5);
  });
  it('explicit override wins', () => {
    expect(resolveThroughput({ explicit: 100, maxWordsPerDay: 1000, hoursStartMin: 540, hoursEndMin: 1080 }))
      .toBe(100);
  });
  it('rescales with a different capacity/window', () => {
    expect(resolveThroughput({ maxWordsPerDay: 900, hoursStartMin: 540, hoursEndMin: 1080 }))
      .toBe(100); // 900 / 9
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
export function parseHHMM(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) throw new Error(`invalid HH:MM time: '${s}'`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function parseWorkdays(s: string): Set<number> {
  const out = new Set<number>();
  for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
    const range = /^([1-7])-([1-7])$/.exec(part);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a > b) throw new Error(`invalid workday range: '${part}'`);
      for (let d = a; d <= b; d++) out.add(d);
    } else if (/^[1-7]$/.test(part)) {
      out.add(Number(part));
    } else {
      throw new Error(`invalid workday token: '${part}'`);
    }
  }
  if (out.size === 0) throw new Error(`ACCEPT_WORKDAYS parsed to an empty set: '${s}'`);
  return out;
}

export function resolveThroughput(o: {
  explicit?: number;
  maxWordsPerDay: number;
  hoursStartMin: number;
  hoursEndMin: number;
}): number {
  if (o.explicit !== undefined) return o.explicit;
  const workingHoursPerDay = (o.hoursEndMin - o.hoursStartMin) / 60;
  return o.maxWordsPerDay / workingHoursPerDay;
}
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schedule/parseSchedule.ts tests/unit/parseSchedule.test.ts
git commit -m "feat(schedule): HH:MM/workdays parsing + throughput resolution"
```

---

## Task 3: `workingHours` (the feasibility engine)

**Files:**
- Create: `src/schedule/workingHours.ts`
- Test: `tests/unit/workingHours.test.ts`

**Interfaces:**
- Consumes: `bangkokCalendar`, `bangkokDateString`, `bangkokEpochMs` (Task 1).
- Produces:
  - `interface WorkCalendar { workdays: Set<number>; hoursStartMin: number; hoursEndMin: number; holidays: Map<string, string> }`
  - `isNonWorkingDay(dateStr: string, weekday: number, workdays: Set<number>, holidays: Map<string, string>): boolean`
  - `workingMinutesBetween(startMs: number, endMs: number, cal: WorkCalendar, capMinutes?: number): number`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { workingMinutesBetween, isNonWorkingDay, type WorkCalendar } from '../../src/schedule/workingHours.js';

const at = (iso: string): number => Date.parse(iso);
const CAL: WorkCalendar = {
  workdays: new Set([1, 2, 3, 4, 5]),
  hoursStartMin: 540, // 09:00
  hoursEndMin: 1080, // 18:00
  holidays: new Map([['2026-06-24', 'Test Holiday']]), // a Wednesday
};

describe('isNonWorkingDay', () => {
  it('weekend and holiday true, weekday false', () => {
    expect(isNonWorkingDay('2026-06-20', 6, CAL.workdays, CAL.holidays)).toBe(true); // Sat
    expect(isNonWorkingDay('2026-06-21', 7, CAL.workdays, CAL.holidays)).toBe(true); // Sun
    expect(isNonWorkingDay('2026-06-24', 3, CAL.workdays, CAL.holidays)).toBe(true); // holiday
    expect(isNonWorkingDay('2026-06-22', 1, CAL.workdays, CAL.holidays)).toBe(false); // Mon
  });
});

describe('workingMinutesBetween', () => {
  it('same-day partial window', () => {
    expect(workingMinutesBetween(at('2026-06-22T15:00:00+07:00'), at('2026-06-22T18:00:00+07:00'), CAL)).toBe(180);
  });
  it('clamps now before 09:00 and deadline after 18:00 to the window', () => {
    expect(workingMinutesBetween(at('2026-06-22T07:00:00+07:00'), at('2026-06-22T20:00:00+07:00'), CAL)).toBe(540);
  });
  it('both ends interior', () => {
    expect(workingMinutesBetween(at('2026-06-22T10:30:00+07:00'), at('2026-06-22T16:30:00+07:00'), CAL)).toBe(360);
  });
  it('overnight gap counts only working windows', () => {
    expect(workingMinutesBetween(at('2026-06-22T17:00:00+07:00'), at('2026-06-23T10:00:00+07:00'), CAL)).toBe(120);
  });
  it('weekend gap (Fri 17:00 -> Mon 10:00) = 60 + 60', () => {
    expect(workingMinutesBetween(at('2026-06-19T17:00:00+07:00'), at('2026-06-22T10:00:00+07:00'), CAL)).toBe(120);
  });
  it('a holiday mid-span is skipped', () => {
    // Tue 17:00 -> Thu 10:00 with Wed 24th a holiday = Tue 17-18 (60) + Thu 9-10 (60)
    expect(workingMinutesBetween(at('2026-06-23T17:00:00+07:00'), at('2026-06-25T10:00:00+07:00'), CAL)).toBe(120);
  });
  it('end <= start returns 0', () => {
    expect(workingMinutesBetween(at('2026-06-22T15:00:00+07:00'), at('2026-06-22T15:00:00+07:00'), CAL)).toBe(0);
  });
  it('deadline exactly 18:00 counts to the boundary; 09:00 gives that day 0', () => {
    expect(workingMinutesBetween(at('2026-06-22T17:30:00+07:00'), at('2026-06-22T18:00:00+07:00'), CAL)).toBe(30);
    expect(workingMinutesBetween(at('2026-06-22T18:30:00+07:00'), at('2026-06-23T09:00:00+07:00'), CAL)).toBe(0);
  });
  it('capMinutes early-exits at/over the cap', () => {
    const got = workingMinutesBetween(at('2026-06-22T09:00:00+07:00'), at('2026-07-31T18:00:00+07:00'), CAL, 100);
    expect(got).toBeGreaterThanOrEqual(100);
  });
  it('far infeasible deadline stays bounded by the 400-day cap', () => {
    // ~3 years out, no cap → bounded iteration, finite large total
    const got = workingMinutesBetween(at('2026-06-22T09:00:00+07:00'), at('2029-06-22T18:00:00+07:00'), CAL);
    expect(Number.isFinite(got)).toBe(true);
    expect(got).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
import { bangkokCalendar, bangkokDateString, bangkokEpochMs } from './bangkokCalendar.js';

export interface WorkCalendar {
  workdays: Set<number>;
  hoursStartMin: number;
  hoursEndMin: number;
  holidays: Map<string, string>;
}

export function isNonWorkingDay(
  dateStr: string,
  weekday: number,
  workdays: Set<number>,
  holidays: Map<string, string>,
): boolean {
  return !workdays.has(weekday) || holidays.has(dateStr);
}

const DAY_MS = 86_400_000;
const MAX_DAYS = 400; // hard safety cap so a pathological deadline never unbounds the loop

/** Working minutes (09:00–18:00 on working days) overlapping [startMs, endMs]. */
export function workingMinutesBetween(
  startMs: number,
  endMs: number,
  cal: WorkCalendar,
  capMinutes?: number,
): number {
  if (endMs <= startMs) return 0;
  let total = 0;
  // Iterate Bangkok dates from the start date to the end date inclusive.
  let cursor = startMs;
  for (let days = 0; days <= MAX_DAYS; days++) {
    const { date, weekday } = bangkokCalendar(cursor);
    if (!isNonWorkingDay(date, weekday, cal.workdays, cal.holidays)) {
      const winStart = bangkokEpochMs(date, cal.hoursStartMin);
      const winEnd = bangkokEpochMs(date, cal.hoursEndMin);
      const overlap = Math.min(endMs, winEnd) - Math.max(startMs, winStart);
      if (overlap > 0) total += overlap / 60_000;
      if (capMinutes !== undefined && total >= capMinutes) return total;
    }
    // Advance to the next Bangkok date (use noon to dodge any boundary edge).
    const next = bangkokEpochMs(date, 0) + DAY_MS + DAY_MS / 2;
    if (bangkokDateString(next) > bangkokDateString(endMs)) break;
    cursor = next;
  }
  return total;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/unit/workingHours.test.ts` and `TZ=UTC npx vitest run tests/unit/workingHours.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schedule/workingHours.ts tests/unit/workingHours.test.ts
git commit -m "feat(schedule): working-minutes feasibility engine"
```

---

## Task 4: `thaiHolidaysData` + `thaiHolidays`

**Files:**
- Create: `src/schedule/thaiHolidaysData.ts`, `src/schedule/thaiHolidays.ts`
- Test: `tests/unit/thaiHolidays.test.ts`

**Interfaces:**
- Consumes: `bangkokYear` (Task 1).
- Produces:
  - `thaiHolidaysData.ts`: `export const CURATED_YEARS: Set<number>`; `export const HOLIDAYS: Record<string, Record<string, string>>` (year → date → name).
  - `thaiHolidays.ts`: `getThaiHolidays(year: number): { holidays: Map<string, string>; curated: boolean }`; `resolveHolidaysForSpan(nowMs: number, dueAtMs: number | null): { holidays: Map<string, string>; curated: boolean }` (merges the now-year and the deadline-year; `curated` = every touched year is in `CURATED_YEARS`).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { getThaiHolidays, resolveHolidaysForSpan } from '../../src/schedule/thaiHolidays.js';

describe('getThaiHolidays', () => {
  it('returns curated=true and a seeded date for 2026', () => {
    const r = getThaiHolidays(2026);
    expect(r.curated).toBe(true);
    expect(r.holidays.get('2026-01-01')).toBeTruthy(); // New Year นักขัตฤกษ์
  });
  it('returns curated=false for a far un-seeded year', () => {
    const r = getThaiHolidays(2099);
    expect(r.curated).toBe(false);
    expect(r.holidays.size).toBe(0);
  });
});

describe('resolveHolidaysForSpan', () => {
  it('merges the deadline-year and reports curated only if all touched years are curated', () => {
    const now = Date.parse('2026-12-31T10:00:00+07:00');
    const due2026 = Date.parse('2026-12-31T18:00:00+07:00');
    expect(resolveHolidaysForSpan(now, due2026).curated).toBe(true);
    const due2099 = Date.parse('2099-01-05T18:00:00+07:00');
    expect(resolveHolidaysForSpan(now, due2099).curated).toBe(false);
  });
  it('null deadline → only the now-year', () => {
    expect(resolveHolidaysForSpan(Date.parse('2026-06-22T10:00:00+07:00'), null).curated).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement the data file** (`src/schedule/thaiHolidaysData.ts`) — seed the **standard Thai นักขัตฤกษ์ public holidays the team observes** for 2026–2027 (NOT cabinet special/substitution days). Use the official นักขัตฤกษ์ set; the team reviews/edits before deploy.

```ts
/**
 * The TEAM'S observed holidays (standard Thai นักขัตฤกษ์). Cabinet special /
 * substitution days (วันหยุดพิเศษ/ชดเชย ครม.) are intentionally EXCLUDED — the team
 * works them. Weekends are handled by ACCEPT_WORKDAYS, not here.
 * Curate the next year before December (an uncurated year pauses auto-accept, C3).
 */
export const CURATED_YEARS: Set<number> = new Set([2026, 2027]);

export const HOLIDAYS: Record<string, Record<string, string>> = {
  '2026': {
    '2026-01-01': "New Year's Day",
    '2026-03-03': 'Makha Bucha Day',
    '2026-04-06': 'Chakri Memorial Day',
    '2026-04-13': 'Songkran Festival',
    '2026-04-14': 'Songkran Festival',
    '2026-04-15': 'Songkran Festival',
    '2026-05-01': 'National Labour Day',
    '2026-05-04': 'Coronation Day',
    '2026-06-01': "Queen Suthida's Birthday",
    '2026-06-03': "Queen Suthida's Birthday (observed date varies — team to confirm)",
    '2026-07-28': "King Vajiralongkorn's Birthday",
    '2026-07-29': 'Asarnha Bucha Day',
    '2026-07-30': 'Buddhist Lent Day',
    '2026-08-12': "Queen Mother's Birthday / Mother's Day",
    '2026-10-13': 'King Bhumibol Memorial Day',
    '2026-10-23': 'Chulalongkorn Day',
    '2026-12-05': "King Bhumibol's Birthday / Father's Day",
    '2026-12-10': 'Constitution Day',
    '2026-12-31': "New Year's Eve",
  },
  '2027': {
    '2027-01-01': "New Year's Day",
    // … team to curate the full 2027 list before December 2026 (placeholder year marker).
    '2027-04-13': 'Songkran Festival',
    '2027-04-14': 'Songkran Festival',
    '2027-04-15': 'Songkran Festival',
    '2027-12-31': "New Year's Eve",
  },
};
```

> **Implementer note:** the exact 2026/2027 dates (esp. lunar Buddhist days + observed dates) MUST be confirmed against an authoritative source by the team before deploy (see §Rollout). The structure is what this task delivers; the dates are reviewed data.

- [ ] **Step 4: Implement `thaiHolidays.ts`**

```ts
import { bangkokYear } from './bangkokCalendar.js';
import { CURATED_YEARS, HOLIDAYS } from './thaiHolidaysData.js';

export function getThaiHolidays(year: number): { holidays: Map<string, string>; curated: boolean } {
  const data = HOLIDAYS[String(year)] ?? {};
  return { holidays: new Map(Object.entries(data)), curated: CURATED_YEARS.has(year) };
}

/** Merge the holidays for every Bangkok year the now→deadline span touches. */
export function resolveHolidaysForSpan(
  nowMs: number,
  dueAtMs: number | null,
): { holidays: Map<string, string>; curated: boolean } {
  const years = new Set<number>([bangkokYear(nowMs)]);
  if (dueAtMs !== null && Number.isFinite(dueAtMs)) years.add(bangkokYear(dueAtMs));
  const holidays = new Map<string, string>();
  let curated = true;
  for (const y of years) {
    const r = getThaiHolidays(y);
    for (const [d, name] of r.holidays) holidays.set(d, name);
    if (!r.curated) curated = false;
  }
  return { holidays, curated };
}
```

- [ ] **Step 5: Run to verify pass** — PASS. Then commit.

```bash
git add src/schedule/thaiHolidaysData.ts src/schedule/thaiHolidays.ts tests/unit/thaiHolidays.test.ts
git commit -m "feat(schedule): team-curated Thai holiday data + span resolver"
```

---

## Task 5: `acceptSchedule` (the gate)

**Files:**
- Create: `src/schedule/acceptSchedule.ts`
- Test: `tests/unit/acceptSchedule.test.ts`

**Interfaces:**
- Consumes: `bangkokCalendar` (Task 1), `workingMinutesBetween`/`isNonWorkingDay`/`WorkCalendar` (Task 3).
- Produces:
  - `interface AcceptScheduleInput` (exactly the §3.1 spec fields): `enabled, nowMs, dueAtMs:number|null, words:number|null, acceptedWordsToday, maxWordsPerDay, hoursStartMin, hoursEndMin, workdays:Set<number>, throughputWordsPerHour, holidays:Map<string,string>, holidaysCuratedForSpan:boolean`.
  - `type AcceptScheduleVerdict = { allow: true } | { allow: false; reason: string }`.
  - `evaluateAcceptSchedule(input: AcceptScheduleInput): AcceptScheduleVerdict`.

- [ ] **Step 1: Write the failing tests** (pin a round throughput 100/h so `ceil` boundaries are exact)

```ts
import { describe, it, expect } from 'vitest';
import { evaluateAcceptSchedule, type AcceptScheduleInput } from '../../src/schedule/acceptSchedule.js';

const at = (iso: string): number => Date.parse(iso);
const base = (over: Partial<AcceptScheduleInput> = {}): AcceptScheduleInput => ({
  enabled: true,
  nowMs: at('2026-06-22T15:00:00+07:00'), // Monday 15:00
  dueAtMs: at('2026-06-22T18:00:00+07:00'),
  words: 300,
  acceptedWordsToday: 0,
  maxWordsPerDay: 1000,
  hoursStartMin: 540,
  hoursEndMin: 1080,
  workdays: new Set([1, 2, 3, 4, 5]),
  throughputWordsPerHour: 100, // round so requiredMin = words * 0.6
  holidays: new Map(),
  holidaysCuratedForSpan: true,
  ...over,
});

describe('evaluateAcceptSchedule', () => {
  it('disabled → always allow', () => {
    expect(evaluateAcceptSchedule(base({ enabled: false, dueAtMs: null }))).toEqual({ allow: true });
  });
  it('capacity reached → block', () => {
    expect(evaluateAcceptSchedule(base({ acceptedWordsToday: 1000 }))).toEqual({
      allow: false,
      reason: 'daily word cap reached (1000/1000)',
    });
  });
  it('deadline unknown → block', () => {
    expect(evaluateAcceptSchedule(base({ dueAtMs: null })).allow).toBe(false);
  });
  it('word count unknown → block', () => {
    expect(evaluateAcceptSchedule(base({ words: null })).allow).toBe(false);
  });
  it('uncurated span year → block', () => {
    expect(evaluateAcceptSchedule(base({ holidaysCuratedForSpan: false })).allow).toBe(false);
  });
  it('deadline on a weekend → block', () => {
    expect(evaluateAcceptSchedule(base({ dueAtMs: at('2026-06-20T12:00:00+07:00') })).allow).toBe(false); // Sat
  });
  it('deadline on a holiday → block', () => {
    expect(
      evaluateAcceptSchedule(
        base({
          dueAtMs: at('2026-06-24T12:00:00+07:00'),
          holidays: new Map([['2026-06-24', 'Test Holiday']]),
        }),
      ).allow,
    ).toBe(false); // Wed holiday
  });
  it('feasibility boundary: avail==required → allow, required-1 → block', () => {
    // 300 words @ 100/h = 180 min required; 15:00→18:00 = 180 avail
    expect(evaluateAcceptSchedule(base({ words: 300 })).allow).toBe(true);
    // 301 words → ceil(180.6)=181 > 180 → block
    expect(evaluateAcceptSchedule(base({ words: 301 })).allow).toBe(false);
  });
  it('deadline already passed → block', () => {
    expect(evaluateAcceptSchedule(base({ dueAtMs: at('2026-06-22T14:00:00+07:00') })).allow).toBe(false);
  });
  it('words=0 → allow (deliverable instantly)', () => {
    expect(evaluateAcceptSchedule(base({ words: 0 })).allow).toBe(true);
  });
  it('far-deadline weekend job is feasible → allow', () => {
    expect(
      evaluateAcceptSchedule(
        base({ nowMs: at('2026-06-21T14:00:00+07:00'), dueAtMs: at('2026-06-26T18:00:00+07:00'), words: 600 }),
      ),
    ).toEqual({ allow: true });
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
import { bangkokCalendar } from './bangkokCalendar.js';
import { isNonWorkingDay, workingMinutesBetween, type WorkCalendar } from './workingHours.js';

export interface AcceptScheduleInput {
  enabled: boolean;
  nowMs: number;
  dueAtMs: number | null;
  words: number | null;
  acceptedWordsToday: number;
  maxWordsPerDay: number;
  hoursStartMin: number;
  hoursEndMin: number;
  workdays: Set<number>;
  throughputWordsPerHour: number;
  holidays: Map<string, string>;
  holidaysCuratedForSpan: boolean;
}

export type AcceptScheduleVerdict = { allow: true } | { allow: false; reason: string };

export function evaluateAcceptSchedule(i: AcceptScheduleInput): AcceptScheduleVerdict {
  if (!i.enabled) return { allow: true };

  if (i.maxWordsPerDay > 0 && i.acceptedWordsToday >= i.maxWordsPerDay)
    return { allow: false, reason: `daily word cap reached (${i.acceptedWordsToday}/${i.maxWordsPerDay})` };

  if (i.dueAtMs === null) return { allow: false, reason: 'deadline unknown' };
  if (i.words === null) return { allow: false, reason: 'word count unknown' };
  if (!i.holidaysCuratedForSpan)
    return { allow: false, reason: `holiday calendar not confirmed for ${bangkokCalendar(i.dueAtMs).date.slice(0, 4)}` };

  const dl = bangkokCalendar(i.dueAtMs);
  if (isNonWorkingDay(dl.date, dl.weekday, i.workdays, i.holidays)) {
    const why = i.holidays.has(dl.date) ? `holiday: ${i.holidays.get(dl.date)}` : 'weekend';
    return { allow: false, reason: `deadline on a non-working day (${why})` };
  }

  if (i.dueAtMs <= i.nowMs) return { allow: false, reason: 'deadline already passed' };

  const cal: WorkCalendar = {
    workdays: i.workdays,
    hoursStartMin: i.hoursStartMin,
    hoursEndMin: i.hoursEndMin,
    holidays: i.holidays,
  };
  const requiredMin = Math.ceil((i.words / i.throughputWordsPerHour) * 60);
  const availMin = workingMinutesBetween(i.nowMs, i.dueAtMs, cal, requiredMin);
  if (availMin >= requiredMin) return { allow: true };
  return {
    allow: false,
    reason: `cannot finish in time (need ~${Math.round(requiredMin / 60 * 10) / 10}h, have ~${Math.round(availMin / 60 * 10) / 10}h before deadline)`,
  };
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/unit/acceptSchedule.test.ts` + `TZ=UTC` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/schedule/acceptSchedule.ts tests/unit/acceptSchedule.test.ts
git commit -m "feat(schedule): accept-schedule gate (feasibility + capacity + holidays)"
```

---

## Task 6: `'rejected'` lifecycle status (types + sheets)

**Files:**
- Modify: `src/detection/types.ts` (the `XtmLifecycleStatus` union), `src/reporting/sheets.ts` (`SheetStatus` + `lifecycleToSheetStatus`)
- Test: `tests/unit/sheets.test.ts` (extend or create)

**Interfaces:**
- Produces: `XtmLifecycleStatus` now includes `'rejected'`; `lifecycleToSheetStatus('rejected') === 'Rejected'`.

- [ ] **Step 1: Write the failing test** (`tests/unit/sheets.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { lifecycleToSheetStatus } from '../../src/reporting/sheets.js';

describe('lifecycleToSheetStatus', () => {
  it('maps rejected → Rejected', () => {
    expect(lifecycleToSheetStatus('rejected')).toBe('Rejected');
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (tsc: `'rejected'` not assignable; or runtime undefined).

- [ ] **Step 3: Implement** — in `src/detection/types.ts` add `| 'rejected'` to `XtmLifecycleStatus`. In `src/reporting/sheets.ts` add `'Rejected'` to the `SheetStatus` union and `rejected: 'Rejected'` to the `lifecycleToSheetStatus` Record (the `Record<XtmLifecycleStatus, SheetStatus>` makes tsc require it).

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/unit/sheets.test.ts` + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/detection/types.ts src/reporting/sheets.ts tests/unit/sheets.test.ts
git commit -m "feat(state): add 'rejected' lifecycle status → Sheet 'Rejected'"
```

---

## Task 7: `db.ts` migration for the `lifecycle_status` CHECK (C2)

**Files:**
- Modify: `src/state/db.ts` (the `JOB_V2_COLUMNS` CHECK at ~line 127-130 + `migrate()`)
- Test: `tests/unit/db.migration.test.ts`

**Why:** the existing `jobs.lifecycle_status` column has `CHECK (... IN ('new','accepted','skipped','missing','accept_failed','closed','removed'))`. The column already exists in production DBs, so editing the DDL string alone does NOT change them — a `'rejected'` write throws `SQLITE_CONSTRAINT_CHECK`. A table-rebuild migration widens it.

**Interfaces:**
- Consumes: existing `openDatabase`/`migrate` (read the current file for the exact helpers).
- Produces: an existing v2 DB accepts a `'rejected'` `lifecycle_status` after `migrate()`.

- [ ] **Step 1: Write the failing test** — open a DB, insert a job row with `lifecycle_status='accepted'` (old schema path), then simulate the post-migration state and assert a `'rejected'` update succeeds. Concretely:

```ts
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/state/db.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('jobs.lifecycle_status migration', () => {
  it('allows rejected after migrate()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acolad-db-'));
    const db = openDatabase(dir); // runs migrate()
    db.prepare(
      `INSERT INTO jobs (job_key, status, first_seen_at, last_seen_at, snapshot_hash, consecutive_misses, lifecycle_status)
       VALUES ('k1','visible','t','t','h',0,'rejected')`,
    ).run();
    const row = db.prepare(`SELECT lifecycle_status AS s FROM jobs WHERE job_key='k1'`).get() as { s: string };
    expect(row.s).toBe('rejected');
  });
});
```

> Read `src/state/db.ts` for the exact `jobs` PK/column list and the `INSERT` column set (the test must satisfy NOT NULL columns). Adjust the `INSERT` to the real required columns.

- [ ] **Step 2: Run to verify failure** — FAIL with `SQLITE_CONSTRAINT_CHECK`.

- [ ] **Step 3: Implement** — (a) update the `JOB_V2_COLUMNS` DDL string to include `'rejected'` in the CHECK (for fresh DBs). (b) Add a `widenLifecycleCheck(db)` step inside `migrate()`'s transaction that detects the old CHECK and rebuilds the table, mirroring `ensureOutboxChannel`:
  - `ALTER TABLE jobs RENAME TO jobs_old;`
  - recreate `jobs` with the widened CHECK (copy the full column list from `JOB_V2_COLUMNS` + base columns + PK),
  - `INSERT INTO jobs (<all cols>) SELECT <all cols> FROM jobs_old;`
  - `DROP TABLE jobs_old;`
  - Guard it so it runs only once (e.g. detect via `sqlite_master.sql LIKE '%rejected%'` on the `jobs` table; skip if already widened). Read `ensureOutboxChannel` for the established rebuild pattern.

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/unit/db.migration.test.ts` + full `npm test` (no regression in state tests) → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/db.ts tests/unit/db.migration.test.ts
git commit -m "fix(state): widen jobs.lifecycle_status CHECK for 'rejected' (table rebuild)"
```

---

## Task 8: daily word counter (`meta`)

**Files:**
- Modify: `src/state/meta.ts`
- Test: `tests/unit/meta.test.ts` (extend or create)

**Interfaces:**
- Consumes: `bangkokDateString` (Task 1) — date keying is computed by the CALLER (cycle) and passed in (keeps `MetaStore` free of time logic, matching the existing accessors).
- Produces:
  - `acceptedWordsToday(dateStr: string): number` — the stored count if `accepted_words_date === dateStr`, else `0`.
  - `addAcceptedWords(dateStr: string, n: number): void` — resets to `n` when the stored date differs, else adds; one transaction.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/state/db.js';
import { MetaStore } from '../../src/state/meta.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const freshMeta = () => new MetaStore(openDatabase(mkdtempSync(join(tmpdir(), 'acolad-meta-'))));

describe('daily word counter', () => {
  it('accumulates within a date', () => {
    const m = freshMeta();
    m.addAcceptedWords('2026-06-22', 300);
    m.addAcceptedWords('2026-06-22', 200);
    expect(m.acceptedWordsToday('2026-06-22')).toBe(500);
  });
  it('resets on a new Bangkok date', () => {
    const m = freshMeta();
    m.addAcceptedWords('2026-06-22', 800);
    expect(m.acceptedWordsToday('2026-06-23')).toBe(0); // read for a new date
    m.addAcceptedWords('2026-06-23', 100);
    expect(m.acceptedWordsToday('2026-06-23')).toBe(100); // reset, not 900
  });
  it('persists across a fresh MetaStore for the same date', () => {
    const db = openDatabase(mkdtempSync(join(tmpdir(), 'acolad-meta-')));
    new MetaStore(db).addAcceptedWords('2026-06-22', 250);
    expect(new MetaStore(db).acceptedWordsToday('2026-06-22')).toBe(250);
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** (add to `MetaStore`, reusing `get`/`set`/`getNumber`)

```ts
  acceptedWordsToday(dateStr: string): number {
    return this.get('accepted_words_date') === dateStr ? this.getNumber('accepted_words_count', 0) : 0;
  }

  addAcceptedWords(dateStr: string, n: number): void {
    const tx = this.db.transaction(() => {
      const cur = this.get('accepted_words_date') === dateStr ? this.getNumber('accepted_words_count', 0) : 0;
      this.set('accepted_words_date', dateStr);
      this.set('accepted_words_count', String(cur + n));
    });
    tx();
  }
```

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/meta.ts tests/unit/meta.test.ts
git commit -m "feat(state): daily accepted-words counter (reset on Bangkok date roll)"
```

---

## Task 9: config (`ACCEPT_SCHEDULE_*` + derived fields)

**Files:**
- Modify: `src/config/index.ts`
- Test: `tests/unit/config.test.ts` (extend or create)

**Interfaces:**
- Consumes: `parseHHMM`, `parseWorkdays`, `resolveThroughput` (Task 2).
- Produces (on `AppConfig`, all derived once at load):
  - `ACCEPT_SCHEDULE_ENABLED: boolean`, `ACCEPT_MAX_WORDS_PER_DAY: number`.
  - `hoursStartMin: number`, `hoursEndMin: number`, `workdays: Set<number>`, `throughputWordsPerHour: number`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/config/index.js';

const envBase = {
  XTM_ACOLAD_PORTAL_URL: 'https://x', XTM_ACOLAD_OFFERS_URL: 'https://x',
  XTM_ACOLAD_Company: 'c', XTM_ACOLAD_Username: 'u', XTM_ACOLAD_Password: 'p',
  GOOGLE_SHEETS_ID: 's', SHEETS_TAB_NAME: 't',
  GOOGLE_CHAT_WEBHOOK_SYSTEM: 'https://x', GOOGLE_CHAT_WEBHOOK_TEAM: 'https://x',
  HEALTHCHECKS_PING_URL: 'https://x',
} as NodeJS.ProcessEnv;

describe('ACCEPT_SCHEDULE config', () => {
  it('defaults: enabled ON, derived throughput 1000/9', () => {
    const c = loadConfig(envBase);
    expect(c.ACCEPT_SCHEDULE_ENABLED).toBe(true);
    expect(c.hoursStartMin).toBe(540);
    expect(c.hoursEndMin).toBe(1080);
    expect([...c.workdays]).toEqual([1, 2, 3, 4, 5]);
    expect(c.throughputWordsPerHour).toBeCloseTo(1000 / 9, 5);
  });
  it("kill-switch '0' disables", () => {
    expect(loadConfig({ ...envBase, ACCEPT_SCHEDULE_ENABLED: '0' }).ACCEPT_SCHEDULE_ENABLED).toBe(false);
  });
  it("empty throughput → derived (not 0)", () => {
    expect(loadConfig({ ...envBase, ACCEPT_THROUGHPUT_WORDS_PER_HOUR: '' }).throughputWordsPerHour)
      .toBeCloseTo(1000 / 9, 5);
  });
  it('explicit throughput override wins', () => {
    expect(loadConfig({ ...envBase, ACCEPT_THROUGHPUT_WORDS_PER_HOUR: '100' }).throughputWordsPerHour).toBe(100);
  });
  it('refine: start>=end rejected when enabled', () => {
    expect(() => loadConfig({ ...envBase, ACCEPT_HOURS_START: '18:00', ACCEPT_HOURS_END: '09:00' })).toThrow();
  });
  it('refine: capacity=0 without explicit throughput rejected when enabled', () => {
    expect(() => loadConfig({ ...envBase, ACCEPT_MAX_WORDS_PER_DAY: '0' })).toThrow();
  });
  it('disabled: bad values do NOT block startup (kill-switch always works)', () => {
    expect(() => loadConfig({ ...envBase, ACCEPT_SCHEDULE_ENABLED: '0', ACCEPT_MAX_WORDS_PER_DAY: '0' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** in `src/config/index.ts` — add fields to the object schema, a top-level `.transform` for the derived fields, and `.refine` (chained after the existing yield refine). Mirror the existing `XTM_YIELD_ENABLED` parser + `.transform`/`.refine` patterns.

```ts
// inside the z.object({...}):
    ACCEPT_SCHEDULE_ENABLED: z
      .string()
      .optional()
      .transform((v) => {
        const s = (v ?? '').trim().toLowerCase();
        return !['0', 'false', 'off', 'no'].includes(s);
      }), // default ON
    ACCEPT_HOURS_START: z.string().default('09:00'),
    ACCEPT_HOURS_END: z.string().default('18:00'),
    ACCEPT_WORKDAYS: z.string().default('1-5'),
    ACCEPT_MAX_WORDS_PER_DAY: z.coerce.number().int().min(0).default(1000),
    ACCEPT_THROUGHPUT_WORDS_PER_HOUR: z.preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.coerce.number().positive().optional(),
    ),
// ...after .object, BEFORE the existing yield .refine, add a .transform that
// derives fields (parseHHMM/parseWorkdays/resolveThroughput from ./schedule/parseSchedule):
  .transform((c) => {
    const hoursStartMin = parseHHMM(c.ACCEPT_HOURS_START);
    const hoursEndMin = parseHHMM(c.ACCEPT_HOURS_END);
    const workdays = parseWorkdays(c.ACCEPT_WORKDAYS);
    const throughputWordsPerHour = resolveThroughput({
      explicit: c.ACCEPT_THROUGHPUT_WORDS_PER_HOUR,
      maxWordsPerDay: c.ACCEPT_MAX_WORDS_PER_DAY,
      hoursStartMin,
      hoursEndMin,
    });
    return { ...c, hoursStartMin, hoursEndMin, workdays, throughputWordsPerHour };
  })
// ...refine (only when enabled):
  .refine((c) => !c.ACCEPT_SCHEDULE_ENABLED || c.hoursStartMin < c.hoursEndMin, {
    path: ['ACCEPT_HOURS_END'],
    message: 'ACCEPT_HOURS_END must be after ACCEPT_HOURS_START',
  })
  .refine(
    (c) =>
      !c.ACCEPT_SCHEDULE_ENABLED ||
      c.ACCEPT_THROUGHPUT_WORDS_PER_HOUR !== undefined ||
      c.ACCEPT_MAX_WORDS_PER_DAY > 0,
    {
      path: ['ACCEPT_THROUGHPUT_WORDS_PER_HOUR'],
      message:
        'set ACCEPT_THROUGHPUT_WORDS_PER_HOUR (>0) or ACCEPT_MAX_WORDS_PER_DAY (>0) so throughput is resolvable',
    },
  )
```

> Note: `parseHHMM`/`parseWorkdays` throw on bad input — a malformed `ACCEPT_HOURS_START` therefore throws inside `.transform`. Wrap the transform body in a try/catch that rethrows a zod-friendly message, OR validate the format with a field-level `.regex` first so the failure is a clean zod issue naming the var. Choose the field-level regex approach for `ACCEPT_HOURS_START/END` (`/^([01]\d|2[0-3]):[0-5]\d$/`) and a `.refine` on `ACCEPT_WORKDAYS` so transforms never throw. Read the existing schema to match the error-formatting style in `loadConfig`.

- [ ] **Step 4: Run to verify pass** — PASS + `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/config/index.ts tests/unit/config.test.ts
git commit -m "feat(config): ACCEPT_SCHEDULE_* vars + derived throughput/hours/workdays"
```

---

## Task 10: `holiday_calendar_stale` system alert

**Files:**
- Modify: `src/reporting/systemAlerts.ts` (the `TriggerKind` union + `TRIGGERS` map)
- Test: `tests/unit/systemAlerts.test.ts` (extend or create)

**Interfaces:**
- Produces: `TriggerKind` includes `'holiday_calendar_stale'`; `TRIGGERS['holiday_calendar_stale']` = `{ severity:'warn', title, impact, action, hasRecovered:true }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { TRIGGERS } from '../../src/reporting/systemAlerts.js';

it('holiday_calendar_stale is a warn trigger that recovers', () => {
  const t = TRIGGERS['holiday_calendar_stale'];
  expect(t.severity).toBe('warn');
  expect(t.hasRecovered).toBe(true);
  expect(t.title.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (tsc: key not in `Record<TriggerKind, …>`).

- [ ] **Step 3: Implement** — add `| 'holiday_calendar_stale'` to `TriggerKind` and an entry to `TRIGGERS`:

```ts
  holiday_calendar_stale: {
    severity: 'warn',
    title: 'Holiday calendar not confirmed for a year in scope',
    impact: 'Auto-accept is paused for jobs whose dates fall in the un-curated year',
    action:
      'Add that year to src/schedule/thaiHolidaysData.ts (HOLIDAYS + CURATED_YEARS), get npm test green, then npm run deploy',
    hasRecovered: true,
  },
```

- [ ] **Step 4: Run to verify pass** — PASS + `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/reporting/systemAlerts.ts tests/unit/systemAlerts.test.ts
git commit -m "feat(reporting): holiday_calendar_stale system alert trigger"
```

---

## Task 11: daily report capacity line

**Files:**
- Modify: `src/reporting/dailyReport.ts` (`buildDailyReportCard` signature + body)
- Test: `tests/unit/dailyReport.test.ts` (extend or create)

**Interfaces:**
- Produces: `buildDailyReportCard(held, nowMs, xtmUrl, acceptedWordsToday: number, maxWordsPerDay: number)` — adds a row `Auto-accepted today: X / Y words` (or `X words (no cap)` when `maxWordsPerDay === 0`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildDailyReportCard } from '../../src/reporting/dailyReport.js';

const flat = (card: { cardsV2: unknown[] }) => JSON.stringify(card);

it('renders the capacity usage line', () => {
  const card = buildDailyReportCard([], Date.parse('2026-06-22T09:00:00+07:00'), 'https://x', 250, 1000);
  expect(flat(card)).toContain('Auto-accepted today');
  expect(flat(card)).toContain('250 / 1000');
});
it('renders no-cap when maxWordsPerDay is 0', () => {
  const card = buildDailyReportCard([], Date.parse('2026-06-22T09:00:00+07:00'), 'https://x', 250, 0);
  expect(flat(card)).toContain('250 words (no cap)');
});
```

- [ ] **Step 2: Run to verify failure** — FAIL (arity / missing text).

- [ ] **Step 3: Implement** — add the two params; prepend a row to `rows`:

```ts
export function buildDailyReportCard(
  held: XtmJobState[],
  nowMs: number,
  xtmUrl: string,
  acceptedWordsToday: number,
  maxWordsPerDay: number,
): { cardsV2: unknown[] } {
  const date = bangkokDate(nowMs);
  const usage =
    maxWordsPerDay > 0
      ? `${acceptedWordsToday} / ${maxWordsPerDay}`
      : `${acceptedWordsToday} words (no cap)`;
  const capacityRow = { label: 'Auto-accepted today', value: usage };
  const jobRows = held.length > 0 ? held.map((j) => ({ /* unchanged */ })) : [{ label: '—', value: 'No jobs in progress' }];
  return buildCard({ /* ...unchanged..., */ rows: [capacityRow, ...jobRows] });
}
```

> Keep the existing job-row mapping verbatim; only prepend `capacityRow`.

- [ ] **Step 4: Update the single caller** in `src/runtime/xtmPollLoop.ts` (the `buildDailyReportCard(held, ...)` call ~line 319) to pass `this.meta.acceptedWordsToday(bangkokDate(this.clock.nowMs()))` and `this.cfg.ACCEPT_MAX_WORDS_PER_DAY`. Run `npm run typecheck`.

- [ ] **Step 5: Run to verify pass** — PASS.

- [ ] **Step 6: Commit**

```bash
git add src/reporting/dailyReport.ts tests/unit/dailyReport.test.ts src/runtime/xtmPollLoop.ts
git commit -m "feat(reporting): daily report shows today's auto-accepted X/Y words"
```

---

## Task 12: cycle integration — gate, bulk-group all-or-nothing, counter, reason (C1/C4/I1/I3)

**Files:**
- Modify: `src/runtime/xtmPollCycle.ts`
- Test: `tests/integration/xtmCycle.test.ts` (extend)

**Interfaces:**
- Consumes: `evaluateAcceptSchedule`+`AcceptScheduleVerdict` (Task 5), `resolveHolidaysForSpan` (Task 4), `bangkokDateString` (Task 1), `MetaStore.acceptedWordsToday/addAcceptedWords` (Task 8), `cfg.ACCEPT_SCHEDULE_*`/derived (Task 9), `raiseAlert/resolveAlert('holiday_calendar_stale')` (Task 10).
- Produces: a blocked job → `lifecycleStatus='rejected'` + reason note (Sheet `Rejected` + Chat once); accepted group → counter += group words in the accept txn; `summary.scheduleBlocked`.

**Key design (read the spec §2.4 + §3):**
- `nowMs = Date.parse(snapshot.capturedAt)`; `today = bangkokDateString(nowMs)`; `let acceptedWordsToday = this.meta.acceptedWordsToday(today)` (read once).
- **C4 helper:** `private scheduleVerdict(s: XtmJobState, optimisticWords: number): AcceptScheduleVerdict` builds the `AcceptScheduleInput` from `s` + cfg + `resolveHolidaysForSpan(nowMs, s.dueDate ? Date.parse(s.dueDate) : null)` (cache the `curated`/holidays per cycle if all jobs share a year — optional). Use it for BOTH the first-seen and robustness passes (no duplicated gate logic; no silent robustness reject).
- **C1 bulk-group all-or-nothing:**
  - `private bulkGroupKey(s: XtmJobState): string` = `` `${s.targetLang ?? ''} ${s.projectName}` `` — the unit one bulk click grabs (language + group). **VERIFY against the live portal/`xtmAccept` that "this group" == project; widen the key if the portal groups more broadly.**
  - Evaluate the verdict for EVERY present eligible Malay job whose `decideAccept()` → `accept` (would-accept set). Group them by `bulkGroupKey`. A group is accepted only if **every** member ALLOWs AND the group's combined words + `acceptedWordsToday` ≤ cap (when cap > 0). Otherwise every member of the group → `lifecycleStatus='rejected'` with the binding reason (the first failing member's reason, prefixed with the file).
  - Accepted groups' members become accept candidates; advance the optimistic `acceptedWordsToday` by each accepted group's total words.
- **I1 counter in txn:** inside the existing `this.db.transaction(() => { for (const r of results) recordAcceptOutcome(...) })`, also `if (r.outcome === 'accepted') this.meta.addAcceptedWords(today, wordsByKey.get(r.jobKey) ?? 0)`.
- **I3 reason → Sheet/Chat:** put each rejected job's reason in a `rejectNotes: Map<string,string>`; in `reportJob`, the Sheet note falls back to `rejectNotes.get(jobKey)`; in `chatForEvent`, add a branch — when `s.lifecycleStatus === 'rejected'`, the new-job note is `Rejected — <reason>` (render via `renderXtmNewJob(s, at, note, xtmUrl)`). Field re-sync (`detailsChanges`) for a `rejected` job must NOT clear the note — re-run the gate and either keep the reject note or transition to accepted.
- **Holiday staleness:** if `resolveHolidaysForSpan(...).curated === false` for any evaluated job, `raiseAlert(... 'holiday_calendar_stale' ...)` (deduped); when a cycle has no uncurated span, `resolveAlert(... 'holiday_calendar_stale' ...)`. Guard both behind `cfg.ACCEPT_SCHEDULE_ENABLED`.
- The gate applies ONLY where `decideAccept()` → `accept`. `skip`/`disabled` paths are unchanged.

- [ ] **Step 1: Write the failing integration tests** (extend `tests/integration/xtmCycle.test.ts`; set `ACCEPT_SCHEDULE_ENABLED` true + a real `dueDate`/`words` on `xraw()` — the default `dueDate:null` would block). Cover, with TZ-explicit `capturedAt`:
  - a finishable in-hours Malay job → accepted; `meta.acceptedWordsToday` += its words.
  - a too-tight Malay job (large words, near deadline) → not accepted; `lifecycleStatus==='rejected'`; the Sheet outbox row has Status `Rejected` and the reason in Note; a Chat row is enqueued; `accept_status` stays `'none'`.
  - **C1:** two Malay jobs in the SAME `(targetLang, projectName)` group, one finishable + one infeasible → BOTH rejected (the group is not accepted).
  - **C1 (separate groups):** an infeasible job in group A does NOT block a finishable job in group B.
  - capacity: with `acceptedWordsToday` seeded near the cap, a group whose total would exceed it → rejected; a group that fits → accepted.
  - run the cycle twice on the same still-present rejected job → no duplicate Sheet/Chat outbox rows the second cycle.
  - `ACCEPT_SCHEDULE_ENABLED=0` with `dueDate:null` → accepted (byte-for-byte pre-feature).
  - a job whose deadline year is uncurated → rejected + a `holiday_calendar_stale` alert row enqueued.

  (Assert against the outbox rows / `XtmJobStore` state the existing tests already inspect — read `xtmCycle.test.ts` for the established harness: `StubAcceptor`, the in-memory DB, outbox querying.)

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement** the cycle changes per the Key design above. Keep `decideAccept` untouched; add the helper + grouping + counter + reason threading. Re-use the existing `claimForAccept`/`recordAcceptOutcome`/`reportJob` machinery.

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/integration/xtmCycle.test.ts` + `TZ=UTC` + full `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/xtmPollCycle.ts tests/integration/xtmCycle.test.ts
git commit -m "feat(runtime): schedule gate in cycle — per-group all-or-nothing + word counter"
```

---

## Task 13: wiring, `.env.example`, full gate green

**Files:**
- Modify: `.env.example`; `vitest.config.*` (coverage `include` for `src/schedule/`); `src/runtime/bootstrap.ts` only if the cycle/loop needs new wiring (read it — the cycle reads cfg + meta it already has, so likely no change).
- Test: full suite + coverage.

- [ ] **Step 1:** Add the new vars to `.env.example` with comments:

```ini
# --- Auto-accept scheduling (working-hours feasibility + daily word cap) ---
ACCEPT_SCHEDULE_ENABLED=1            # 0/false/off/no disables (then today's behavior)
ACCEPT_HOURS_START=09:00            # working-window start (Bangkok)
ACCEPT_HOURS_END=18:00              # working-window end (exclusive)
ACCEPT_WORKDAYS=1-5                 # ISO weekdays Mon=1..Sun=7 (ranges/lists)
ACCEPT_MAX_WORDS_PER_DAY=1000       # daily word budget; the primary knob; 0 = unlimited
ACCEPT_THROUGHPUT_WORDS_PER_HOUR=   # empty = derived (capacity ÷ working-hours/day ≈ 111); set to pin
```

- [ ] **Step 2:** Add `src/schedule/**` to the coverage `include`/gate config so the new module is gated ≥ 80% (read `vitest.config.ts`/`package.json` `test:coverage` for the current gate shape; the spec requires detection/state/reporting/schedule all ≥ 80%).

- [ ] **Step 3:** Run the FULL gate:

```bash
npm run lint && npm run typecheck && npm run test:coverage
```
Expected: lint 0, typecheck 0, all tests pass, coverage ≥ 80% on detection/state/reporting/schedule.

- [ ] **Step 4:** Smoke the config fail-fast:

```bash
# expect a clear startup error naming ACCEPT_HOURS_END
ACCEPT_HOURS_START=18:00 ACCEPT_HOURS_END=09:00 npm run poll:once
```

- [ ] **Step 5: Commit**

```bash
git add .env.example vitest.config.ts
git commit -m "chore: document ACCEPT_SCHEDULE_* + add src/schedule to coverage gate"
```

---

## Self-Review (against the spec)

**Spec coverage:** §2.1 gate → Task 5; §2.2 workingMinutes/throughput → Tasks 2,3; §2.3 truth table → Task 5 tests; §2.4 bulk-group all-or-nothing (C1) → Task 12; §3 modules → Tasks 1–5; types/sheets 'rejected' → Task 6; db CHECK (C2) → Task 7; meta counter → Task 8; config (I2) → Task 9; systemAlerts → Task 10; daily report §5.1 → Task 11; cycle (C4/I1/I3) → Task 12; coverage/.env (I4) → Task 13; C5 TZ-explicit tests → every date task. **Gap check:** C3 fail-closed is realized by Task 5 step-4 (`holidaysCuratedForSpan` → BLOCK) + Task 12 (resolve + alert) — covered.

**Type consistency:** `evaluateAcceptSchedule`/`AcceptScheduleInput` fields match §3.1 and Task 12's call; `workingMinutesBetween(start,end,cal,capMinutes?)` signature identical in Tasks 3 & 5; `bangkokDateString`/`bangkokEpochMs` names identical across Tasks 1,3,8,11; `buildDailyReportCard` new arity updated at its only caller (Task 11 step 4); `lifecycleToSheetStatus('rejected')` defined in Task 6 before Task 12 consumes it.

**Open implementation verifications (flagged, not placeholders):** (a) Task 7 — the exact `jobs` column list for the rebuild + test INSERT (read `db.ts`). (b) Task 12 — confirm the bulk "group" == `projectName` against `xtmAccept`/live portal; widen `bulkGroupKey` if broader. (c) Task 4 — the 2026/2027 นักขัตฤกษ์ dates are reviewed data the team confirms before deploy.
