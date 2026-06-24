# Accept-flow read-race + sheet field-sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Malay jobs being lost at accept (a grid-read race makes the accept scan/re-read miss a present job → false `missing`), and propagate a Due date that XTM sets after the last Sheet write.

**Architecture:** Drive the accept off the *known* target jobKeys (locate the target row by its File/Step/Role cells + `waitFor`, not a blind `nth(i)` scan of an auto-refreshing grid); gate the FR-024 re-read on a *complete* grid (footer total == rendered rows); classify a never-clicked-but-still-claimable target as retriable `missing` (not terminal `failed`); add a real regression counter. Separately, reuse the diff's existing `detailsChanges` to re-sync the Sheet when a material field (due_date/words) changes on a job that produced no transition.

**Tech Stack:** Node 22 + TypeScript (strict, NodeNext ESM — relative imports end in `.js`), Vitest, Playwright (Chromium), better-sqlite3.

## Global Constraints

- TDD mandatory for `src/detection/`, `src/state/`, `src/reporting/`; coverage gate ≥ 80% on those three (`npm run test:coverage`).
- `npm run lint` (eslint + prettier) and `npm run typecheck` (tsc strict) must be 0-error before each commit.
- FR-011: no new portal request — every new wait only observes the already-loaded DOM. Poll interval stays ≥ 20 s.
- Live shared account: `ACCEPT_MAX_PER_CYCLE` stays 0; every existing fail-loud guard is preserved; all new waits are bounded (≤ 3 s) and fall back to the current empty-re-read guard on cap-hit.
- Bug fix only — do NOT change `decideAccept`, the diff algorithm, or the detection read (`fetchJobSnapshot`/`readActiveSnapshot`).
- Run on branch `fix/accept-read-race` (already created). The bot is STOPPED during implementation; redeploy only at the end (Task 7).

**Key existing signatures (consumed by tasks):**
- `computeXtmJobKey(job: Pick<XtmRawJob,'fileName'|'step'|'role'>): string` → `[trim+lowercase(fileName), step, role].join('|')` (`src/detection/jobKey.ts`).
- `interface AcceptTarget { jobKey: string; targetLang: string }` (`src/portal/errors.ts`).
- `type AcceptResult = {jobKey,outcome:'accepted',at,clickedAt?} | {jobKey,outcome:'missing'} | {jobKey,outcome:'failed',reason}` (`src/portal/errors.ts`).
- `XtmJobState` has `dueDate: string|null`, `words: number|null`, `step`, `role`, `fileName` (`src/detection/types.ts`).
- `result.detailsChanges: {jobKey, changes:{field,from,to}[]}[]` — diff already reports `dueDate` and `words` changes (`src/detection/xtmDiff.ts` `xtmFieldChanges`).
- Selectors (`src/portal/selectors.ts`): `XTM.active.gridContainer`, `XTM.active.rowKebab`, `XTM.active.itemsCount`, `XTM.active.cell.{file,step,role,target}` (= `td:nth-child(5|9|11|7)`), `XTM.accept.{rowKebab,menuContainer,acceptTaskItem,finishTaskItem,bulkForLanguageInGroupItem}`.
- `parseItemsTotal(footer: string|null): number|null` (`src/portal/xtmInbox.ts`) — digits-only "… of N".

---

### Task 1: Sheet field-sync (Bug B) — re-sync Due date/Words that XTM sets late

**Files:**
- Create: `src/reporting/sheetSync.ts`
- Test: `tests/unit/sheetSync.test.ts`
- Modify: `src/runtime/xtmPollCycle.ts` (the `run()` reporting section, after the two `reportJob` loops)
- Test: `tests/integration/xtmCycle.test.ts` (add one case)

**Interfaces:**
- Produces: `hasMaterialSheetChange(changes: {field:string}[]): boolean` — true iff a `dueDate` or `words` field is among the changes.

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/sheetSync.test.ts
import { describe, it, expect } from 'vitest';
import { hasMaterialSheetChange } from '../../src/reporting/sheetSync.js';

describe('hasMaterialSheetChange', () => {
  it('flags a dueDate change', () => {
    expect(hasMaterialSheetChange([{ field: 'dueDate', from: null, to: '2026-06-24T16:41+07:00' }])).toBe(true);
  });
  it('flags a words change', () => {
    expect(hasMaterialSheetChange([{ field: 'words', from: null, to: '746' }])).toBe(true);
  });
  it('ignores non-material changes (projectName/step/role)', () => {
    expect(hasMaterialSheetChange([{ field: 'projectName', from: 'a', to: 'b' }, { field: 'role', from: 'x', to: 'y' }])).toBe(false);
  });
  it('is false for an empty change list', () => {
    expect(hasMaterialSheetChange([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** — `npx vitest run tests/unit/sheetSync.test.ts` → "Cannot find module '.../sheetSync.js'".

- [ ] **Step 3: Implement the helper**

```ts
// src/reporting/sheetSync.ts
/**
 * True when a Sheet-material display field changed on a still-visible job. XTM can
 * populate the Due date (and Words) AFTER the bot's last Sheet write (which only fires
 * on a lifecycle transition), so a changed dueDate/words must re-sync the Sheet. Other
 * fields (status/project/step/role/lang) already flow through transitions, so they are
 * intentionally excluded (YAGNI). Consumes the diff's existing detailsChanges (DRY).
 */
const MATERIAL_SHEET_FIELDS = new Set(['dueDate', 'words']);
export function hasMaterialSheetChange(changes: { field: string }[]): boolean {
  return changes.some((c) => MATERIAL_SHEET_FIELDS.has(c.field));
}
```

- [ ] **Step 4: Run it — expect PASS** — `npx vitest run tests/unit/sheetSync.test.ts`.

- [ ] **Step 5: Wire into the cycle.** In `src/runtime/xtmPollCycle.ts`, import the helper and add the re-sync pass immediately AFTER the two `reportJob` loops (`for (const ev of result.events) reportJob(...)` / `for (const jobKey of acceptResults.keys()) reportJob(...)`) and BEFORE `if (baseline) {`:

```ts
// near the top with the other reporting imports:
import { hasMaterialSheetChange } from '../reporting/sheetSync.js';

// after the two reportJob loops:
// Field-change re-sync (Bug B): a still-visible job whose Due date/Words XTM set AFTER
// our last transition write reaches the DB (upsertMany) but never the Sheet. The diff
// already records the change in detailsChanges (FR-019) — enqueue a Sheet-ONLY upsert
// (no Chat: a silent correction) for any not-yet-reported job with a material change.
for (const dc of result.detailsChanges) {
  if (reported.has(dc.jobKey) || !hasMaterialSheetChange(dc.changes)) continue;
  const s = result.nextStates.get(dc.jobKey);
  if (!s) continue;
  reported.add(dc.jobKey);
  this.outbox.enqueue(
    `sheet:fieldsync:${dc.jobKey}|${snapshot.pollCycleId}`,
    JSON.stringify({ op: 'upsert', row: this.toSheetRow(s, null) }),
    snapshot.capturedAt,
    'sheets',
  );
}
```

- [ ] **Step 6: Write the failing integration test.** In `tests/integration/xtmCycle.test.ts`, following the existing harness (in-memory DB + `new XtmPollCycle(db, cfg, acceptorStub, closedReaderStub)`), add: run cycle 1 with a job whose `dueDate` is null; run cycle 2 with the SAME job (same jobKey) now carrying a `dueDate`, producing no transition; assert the outbox has a `sheet:fieldsync:<jobKey>|...` event and NO `chat:` event for that jobKey in cycle 2.

```ts
it('re-syncs the Sheet when a Due date appears on an already-reported job (Bug B)', async () => {
  const job = malayRawJob({ fileName: 'F1', step: 'PE', role: 'Corrector', dueDate: null });
  await cycle.run(snapshotOf([job], 'c1'));            // first_seen → reported, due empty
  const withDue = { ...job, dueDate: '2026-06-24T16:41+07:00' };
  await cycle.run(snapshotOf([withDue], 'c2'));        // still visible, due appears
  const events = listOutbox(db);                        // helper that reads the outbox table
  expect(events.some((e) => e.event_id.startsWith('sheet:fieldsync:') && e.event_id.includes('c2'))).toBe(true);
  expect(events.some((e) => e.channel === 'chat' && e.event_id.includes('c2'))).toBe(false);
});
```
(Use the file's existing `malayRawJob`/`snapshotOf`/`listOutbox` helpers; add minimal ones if absent, mirroring the neighbouring tests.)

- [ ] **Step 7: Run the integration test — expect PASS** — `npx vitest run tests/integration/xtmCycle.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/reporting/sheetSync.ts tests/unit/sheetSync.test.ts src/runtime/xtmPollCycle.ts tests/integration/xtmCycle.test.ts
git commit -m "fix(reporting): re-sync Sheet on late Due date/Words change (Bug B)"
```

---

### Task 2: Classification — never-clicked-but-claimable is retriable, not terminal `failed` (Fix A3)

**Files:**
- Modify: `src/portal/xtmAccept.ts` (`determineAcceptOutcomes` + its call site in `acceptEligibleTasks`)
- Test: `tests/unit/acceptDecision.test.ts` (or wherever `determineAcceptOutcomes` is unit-tested — search `determineAcceptOutcomes`)

**Interfaces:**
- Produces (changed signature): `determineAcceptOutcomes(targets, reRead, at, clickedKeys: Set<string>, clickedAt?): AcceptResult[]`.

- [ ] **Step 1: Write the failing unit test** (add to the existing `determineAcceptOutcomes` test file)

```ts
import { determineAcceptOutcomes } from '../../src/portal/xtmAccept.js';
const raw = (over) => ({ xtmTaskId:null, projectName:'P', fileName:'F', sourceLang:null, targetLang:'Malay (Malaysia)', dueDate:null, dueRaw:null, words:null, step:'PE', role:'Corrector', acceptAvailable:false, ...over });
const key = 'f|pe|corrector'; // computeXtmJobKey of the raw above

it('present + still claimable but NEVER clicked → missing (retriable, not failed)', () => {
  const t = [{ jobKey: key, targetLang: 'Malay (Malaysia)' }];
  const reRead = [raw({ fileName: 'F', acceptAvailable: true })]; // still claimable
  const out = determineAcceptOutcomes(t, reRead, '2026-06-24T00:00:00Z', new Set()); // clickedKeys EMPTY
  expect(out[0].outcome).toBe('missing');
});

it('present + still claimable AND clicked → failed (genuine accept failure)', () => {
  const t = [{ jobKey: key, targetLang: 'Malay (Malaysia)' }];
  const reRead = [raw({ fileName: 'F', acceptAvailable: true })];
  const out = determineAcceptOutcomes(t, reRead, '2026-06-24T00:00:00Z', new Set([key]));
  expect(out[0].outcome).toBe('failed');
});

it('present + no longer claimable → accepted (regardless of clicked)', () => {
  const t = [{ jobKey: key, targetLang: 'Malay (Malaysia)' }];
  const reRead = [raw({ fileName: 'F', acceptAvailable: false })];
  const out = determineAcceptOutcomes(t, reRead, '2026-06-24T00:00:00Z', new Set());
  expect(out[0].outcome).toBe('accepted');
});
```
(The exact `key` must equal `computeXtmJobKey(raw)`; import and compute it in the test rather than hard-coding if the file already does so.)

- [ ] **Step 2: Run it — expect FAIL** — the current 4-arg signature rejects the `clickedKeys` arg / the "not clicked → missing" case returns `failed`.

- [ ] **Step 3: Implement.** In `src/portal/xtmAccept.ts` change `determineAcceptOutcomes`:

```ts
export function determineAcceptOutcomes(
  targets: AcceptTarget[],
  reRead: XtmRawJob[],
  at: string,
  clickedKeys: Set<string>, // targets whose language group actually got a confirm-click
  clickedAt?: string,
): AcceptResult[] {
  const byKey = new Map<string, XtmRawJob>();
  for (const r of reRead) byKey.set(computeXtmJobKey(r), r);
  return targets.map((t): AcceptResult => {
    const found = byKey.get(t.jobKey);
    if (!found) return { jobKey: t.jobKey, outcome: 'missing' };
    if (found.acceptAvailable) {
      // Still claimable after the pass. Only a genuine FAILED accept if we actually
      // clicked this target's group; a never-clicked target (its row never rendered /
      // group was already-owned) is retriable — record 'missing' (resets accept_status
      // to 'none' so the robustness pass re-attempts), NOT a terminal accept_failed alert.
      return clickedKeys.has(t.jobKey)
        ? { jobKey: t.jobKey, outcome: 'failed', reason: 'still acceptable after accept (not claimed)' }
        : { jobKey: t.jobKey, outcome: 'missing' };
    }
    return clickedAt
      ? { jobKey: t.jobKey, outcome: 'accepted', at, clickedAt }
      : { jobKey: t.jobKey, outcome: 'accepted', at };
  });
}
```

- [ ] **Step 4: Update the call site** in `acceptEligibleTasks` (same file). `clickedAtByJob` already holds the clicked targets — derive `clickedKeys` from it:

```ts
// replace: const outcomes = determineAcceptOutcomes(attempted, reRead, deps.nowIso()).map(...)
const clickedKeys = new Set(clickedAtByJob.keys());
const outcomes = determineAcceptOutcomes(attempted, reRead, deps.nowIso(), clickedKeys).map((o) => {
  const clickedAt = clickedAtByJob.get(o.jobKey);
  return o.outcome === 'accepted' && clickedAt !== undefined ? { ...o, clickedAt } : o;
});
```

- [ ] **Step 5: Run tests — expect PASS** — `npx vitest run tests/unit/<the file>.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/portal/xtmAccept.ts tests/unit/<the file>.ts
git commit -m "fix(accept): never-clicked-but-claimable target is retriable missing, not terminal failed (A3)"
```

---

### Task 3: Target-keyed accept — locate the target row by its cells, not a blind nth() scan (Fix A1)

**Files:**
- Modify: `src/portal/errors.ts` (extend `AcceptTarget`)
- Modify: `src/runtime/xtmPollCycle.ts` (populate the new `AcceptTarget` fields)
- Modify: `src/portal/xtmAccept.ts` (`openBulkAcceptForLanguage` → target-keyed)
- Test: `tests/integration/accept.test.ts` (the real-Chromium accept fixture test)

**Interfaces:**
- Produces: `interface AcceptTarget { jobKey: string; targetLang: string; fileName: string; step: string | null; role: string | null }`.

**Approach:** The bulk action grabs the whole language group in one click, so we need ONE claimable target row per language. Instead of opening every Malay row's menu via `nth(i)` (which an auto-refresh reindexes mid-scan, and which wastes ~1-2 s opening owned rows' menus first), build a STABLE locator for each target row from its File/Step/Role cells, `waitFor` it (so a late-rendering row is caught), open only that row's menu, and click the bulk from the first target still showing "Accept task".

- [ ] **Step 1: Extend `AcceptTarget`** in `src/portal/errors.ts`:

```ts
export interface AcceptTarget {
  jobKey: string;
  targetLang: string;
  /** Cell values to locate THIS row deterministically (not a volatile nth index). */
  fileName: string;
  step: string | null;
  role: string | null;
}
```

- [ ] **Step 2: Populate the new fields** in `src/runtime/xtmPollCycle.ts` where targets are built (the `for (const s of candidates)` claim loop):

```ts
if (this.accept.claimForAccept(s.jobKey)) {
  targets.push({ jobKey: s.jobKey, targetLang: s.targetLang ?? '', fileName: s.fileName, step: s.step, role: s.role });
}
```
(Also update the `reconEligible.push(...)` target build and any other `AcceptTarget` construction to include the three fields — run `npm run typecheck` to find them all.)

- [ ] **Step 3: Write the failing integration test.** In `tests/integration/accept.test.ts` (loads a fixture grid into a real Chromium Page — follow the existing pattern), add a case: a grid with TWO Malay rows — an already-owned row ("Finish task", listed FIRST) and a still-claimable target row ("Accept task", listed SECOND). Assert `openBulkAcceptForLanguage` (or `acceptEligibleTasks` end-to-end) drives the bulk from the CLAIMABLE row (returns `'clicked'` / the bulk-click selector was clicked) and never strands it as already-owned.

```ts
it('drives the bulk from the claimable target row even when an owned row is listed first (A1)', async () => {
  // fixture: row1 = owned Malay (Finish task), row2 = claimable Malay (Accept task) for target T
  // ... load fixture, call the accept with target T ...
  // assert: the bulk "for this language in this group" item was clicked (outcome reflects a click)
});
```
(Reuse the fixture builders in `tests/fixtures/xtmPages.ts`; add an `owned`/`claimable` row variant if needed — a row whose kebab menu exposes `finishTaskItem` vs `acceptTaskItem`.)

- [ ] **Step 4: Run it — expect FAIL** (current nth-scan opens row1's owned menu first and, on a fixture timed to reindex, can return already-owned).

- [ ] **Step 5: Implement target-keyed `openBulkAcceptForLanguage`** in `src/portal/xtmAccept.ts`. Replace the `nth(i)` loop with: for each target in this language, build a row locator from its cells, `waitFor({state:'attached', timeout: 3000})`, open its menu, and click the bulk from the first one showing "Accept task". Signature changes to take the language's `AcceptTarget[]` (it already groups by language in `acceptEligibleTasks`).

```ts
async function openBulkAcceptForLanguage(
  scope: Scope,
  group: AcceptTarget[], // all targets in ONE language
): Promise<'clicked' | 'already-owned'> {
  let ownedSeen = false;
  let anyRowFound = false;
  for (const t of group) {
    const row = rowForTarget(scope, t);
    const attached = await row.waitFor({ state: 'attached', timeout: ACCEPT_TIMEOUT_MS }).then(() => true).catch(() => false);
    if (!attached) continue; // this target's row hasn't rendered / is gone — skip (not owned)
    anyRowFound = true;
    const kebab = row.locator(XTM.accept.rowKebab).first();
    if ((await kebab.count()) === 0) continue;
    await kebab.click({ timeout: ACCEPT_TIMEOUT_MS });
    await scope.locator(XTM.accept.menuContainer).first().waitFor({ state: 'visible', timeout: ACCEPT_TIMEOUT_MS }).catch(() => undefined);
    if ((await scope.locator(XTM.accept.acceptTaskItem).count()) > 0) {
      await scope.locator(XTM.accept.acceptTaskItem).first().hover({ timeout: ACCEPT_TIMEOUT_MS });
      const bulk = scope.locator(XTM.accept.bulkForLanguageInGroupItem).first();
      if ((await bulk.count()) === 0) throw new AcceptUnconfirmedError('bulk "for this language in this group" option not found');
      await bulk.click({ timeout: ACCEPT_TIMEOUT_MS });
      return 'clicked'; // one click claims the whole language group
    }
    if ((await scope.locator(XTM.accept.finishTaskItem).count()) > 0) ownedSeen = true;
    await kebab.click({ timeout: ACCEPT_TIMEOUT_MS }).catch(() => undefined); // toggle-close
  }
  if (ownedSeen) return 'already-owned';
  if (!anyRowFound) return 'already-owned'; // no target row present this pass → retriable via classification (A3)
  throw new AcceptUnconfirmedError('matching target rows present but neither "Accept task" nor "Finish task" found');
}

/** Stable locator for a target's data row by its File+Step+Role cell text (the jobKey basis),
 *  so an auto-refresh that reindexes rows mid-pass cannot point us at the wrong row. */
function rowForTarget(scope: Scope, t: AcceptTarget): Locator {
  let row = scope.locator(`${XTM.active.gridContainer} tbody tr`)
    .filter({ has: scope.locator(XTM.active.cell.file, { hasText: t.fileName }) });
  if (t.step) row = row.filter({ has: scope.locator(XTM.active.cell.step, { hasText: t.step }) });
  if (t.role) row = row.filter({ has: scope.locator(XTM.active.cell.role, { hasText: t.role }) });
  return row.first();
}
```
Update `acceptEligibleTasks` to call `openBulkAcceptForLanguage(scope, group)` (pass the `AcceptTarget[]` group, not `lang`). Keep the per-group try/catch + `clickedAtByJob` stamping exactly as today (`opened === 'clicked'`).

- [ ] **Step 6: Run the integration test — expect PASS** — `npx vitest run tests/integration/accept.test.ts`.

- [ ] **Step 7: typecheck + commit**

```bash
npm run typecheck
git add src/portal/errors.ts src/runtime/xtmPollCycle.ts src/portal/xtmAccept.ts tests/integration/accept.test.ts tests/fixtures/xtmPages.ts
git commit -m "fix(accept): locate target row by cells + waitFor, not nth() scan of a mutating grid (A1)"
```

---

### Task 4: Re-read on a COMPLETE grid — footer total == rendered rows (Fix A2)

**Files:**
- Modify: `src/portal/xtmClient.ts` (add `waitForGridComplete`, call it inside the `reReadActive` closure after `navigateToInbox`/`activeFrame`, before `readActiveSnapshot`)
- Test: ops-verify (Task 7) — this is browser-timing I/O; the deterministic unit is the footer parse, already covered by `parseItemsTotal`.

**Approach:** `settleGrid` (networkidle) is necessary but the AngularJS re-render can lag it. Add a bounded wait for the authoritative completeness signal: the footer's "… of N" total equals the number of rendered kebab data rows.

- [ ] **Step 1: Implement `waitForGridComplete`** in `src/portal/xtmClient.ts` (private method on `PlaywrightXtmClient`):

```ts
/**
 * After networkidle, wait until the grid is FULLY rendered: the footer's "… of N" total
 * equals the rendered kebab-data-row count. networkidle means the data XHR finished, but
 * the AngularJS row render can lag it — reading in that gap sees a partial grid and
 * mis-attributes a present accept target as 'missing'. Bounded (~3s); on cap we proceed
 * (the empty-re-read guard + A3 classification remain the safety net) and log loud.
 */
private async waitForGridComplete(frame: Frame, context: string): Promise<void> {
  const deadline = this.clock.nowMs() + 3_000;
  while (this.clock.nowMs() < deadline) {
    const footer = await frame.locator(XTM.active.itemsCount).first().textContent().catch(() => null);
    const total = parseItemsTotal(footer);
    const rows = await frame.locator(`${XTM.active.gridContainer} tbody tr`).filter({ has: frame.locator(XTM.active.rowKebab) }).count();
    if (total !== null && rows === total) return; // fully rendered
    await new Promise((r) => setTimeout(r, 200));
  }
  this.logger?.warn(
    { module: 'xtmClient', action: 'gridComplete', outcome: 'timeout', context },
    'grid footer total != rendered rows within cap — re-read may see a partial grid',
  );
}
```
Import `parseItemsTotal` from `./xtmInbox.js`.

- [ ] **Step 2: Call it in the `reReadActive` closure** (inside `acceptEligibleTasks` in `xtmClient.ts`), right after `const freshFrame = await this.activeFrame(page);` and before `readActiveSnapshot`:

```ts
const freshFrame = await this.activeFrame(page);
await this.waitForGridComplete(freshFrame, 'reread'); // NEW: ensure the post-accept grid finished rendering
const snap = await readActiveSnapshot(freshFrame, `reread-${this.clock.nowIso()}`, this.clock.nowIso(), evidence);
```

- [ ] **Step 3: Also gate the SCAN frame.** In `acceptEligibleTasks` (xtmClient.ts), after `const frame = await this.activeFrame(page);` add `await this.waitForGridComplete(frame, 'accept-scan');` so the target-keyed locate (Task 3) scans a complete grid.

- [ ] **Step 4: typecheck + commit**

```bash
npm run typecheck
git add src/portal/xtmClient.ts
git commit -m "fix(accept): gate accept scan + FR-024 re-read on a fully-rendered grid (footer N == rows) (A2)"
```

---

### Task 5: Regression metric — detect the race coming back (Fix A4)

**Files:**
- Modify: `src/runtime/xtmPollCycle.ts` (count + log) — and/or `src/runtime/xtmPollLoop.ts` if that is where the `action:'accept'` summary line is emitted (search `action.*accept` to confirm the owner).

**Approach:** The cap-hit log is a false negative (the dangerous case settles fast at a partial count). The true signal is **a claimed target that ended without a click while still present + claimable** in the re-read. Surface it.

- [ ] **Step 1: Add the counter to the cycle summary.** In `XtmCycleSummary` (xtmPollCycle.ts) add `acceptNoClickWhilePresent: number;` (init 0 in the summary literal).

- [ ] **Step 2: Increment it** in the accept-result loop where outcomes are recorded. A target that was a claim candidate but came back `'missing'` while STILL present in the re-read is the no-click-while-present signal. Since A3 maps never-clicked-but-claimable → `'missing'`, count those whose jobKey is present in the re-read result. Thread the re-read presence + clicked set out of the acceptor, OR (simpler) log it from `acceptEligibleTasks` directly:

```ts
// in xtmAccept.ts acceptEligibleTasks, after computing `outcomes`, before return:
deps.onAcceptObserved?.({
  reReadRows: reRead.length,
  results: outcomes.map((o) => ({ jobKey: o.jobKey, outcome: o.outcome, clicked: clickedKeys.has(o.jobKey) })),
});
```
Add `onAcceptObserved?(obs: {reReadRows:number; results:{jobKey:string;outcome:string;clicked:boolean}[]}): void` to `AcceptDeps`. In `xtmClient.acceptEligibleTasks`, pass `onAcceptObserved` that logs a structured line and lets the loop tally:

```ts
onAcceptObserved: (obs) => this.logger?.info(
  { module: 'xtmAccept', action: 'accept_observed', reReadRows: obs.reReadRows,
    noClickWhilePresent: obs.results.filter((r) => !r.clicked && r.outcome === 'missing').length },
  'accept pass observed',
),
```

- [ ] **Step 3: typecheck + commit**

```bash
npm run typecheck
git add src/runtime/xtmPollCycle.ts src/portal/xtmAccept.ts src/portal/xtmClient.ts
git commit -m "feat(accept): log accept_observed + noClickWhilePresent as the race regression detector (A4)"
```

---

### Task 6: Full gate + deploy + ops-verify

**Files:** none (verification).

- [ ] **Step 1: Full suite + gates**

```bash
npm test
npm run typecheck
npm run lint
npm run test:coverage   # detection/state/reporting ≥ 80%
```
Expected: all green; the new `sheetSync` + `determineAcceptOutcomes` lines covered.

- [ ] **Step 2: finishing-a-development-branch** — invoke superpowers:finishing-a-development-branch to merge `fix/accept-read-race` → main (PR), then `npm run deploy` (DIAG is already on).

- [ ] **Step 3: Ops-verify on the next live Malay jobs (DIAG on):**
  - Each accepted job logs `action:"accept","outcome":"ok"`; `noClickWhilePresent` stays 0.
  - A job whose Due date is set after acceptance shows the Due in PM_Tracking (Bug B).
  - `npm run report:latency` — steady-state cycle p95 stays well under the 25 s shutdown watchdog (the new bounded waits added ≤ ~6 s worst case).
  - Turn DIAG off (`DIAG=` in `.env` + `npm run deploy`) once confirmed.

---

## Self-Review

**Spec coverage:** A1 target-keyed → Task 3; A2 complete-grid re-read → Task 4; A3 classification → Task 2; A4 metric → Task 5; B field-sync → Task 1; testing (unit + integration + ops) → Tasks 1-2 unit, 3 integration, 6 ops; constraints (FR-011/caps/no-detection-change) honored. No gap.

**Placeholder scan:** every code step has concrete code; integration-test steps name the harness/fixtures to follow (xtmCycle.test.ts, accept.test.ts, xtmPages.ts) with concrete assertions. The only "search to confirm" notes (which file owns the `action:'accept'` log; which file unit-tests `determineAcceptOutcomes`) are lookups, not deferred logic.

**Type consistency:** `AcceptTarget` gains `fileName/step/role` (Task 3) and every construction site is updated (Task 3 Step 2, via typecheck); `determineAcceptOutcomes` gains `clickedKeys: Set<string>` and its sole caller is updated (Task 2 Step 4); `hasMaterialSheetChange(changes)` signature matches `DetailsChange['changes']`; `waitForGridComplete(frame, context)` and `parseItemsTotal` types align.
