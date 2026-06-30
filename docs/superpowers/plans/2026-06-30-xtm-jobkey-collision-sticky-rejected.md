# XTM Job Identity (project) + Sticky Rejected — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two Sheet-correctness fixes — (1) put `projectName` in the XTM job identity `_job_key` so two projects sharing a file name stop colliding; (2) persist a Rejected reason + a Sheet-status precedence so a Rejected row is not overwritten by a later Closed/Missing.

**Architecture:** Fix 1 changes the pure `computeXtmJobKey` (now `projectName|fileName|step|role`), supplies the project to the two DOM-read sites, and one-time re-keys non-terminal DB rows so a held job is not mis-disappeared at the next restart. Fix 2 persists `rejectReason` on the job state and routes the Sheet's Status/Note through a pure, gated helper (`resolveSheetStatusAndNote`) that keeps "Rejected" until the job is accepted, appending "(left Active …)" once it leaves Active.

**Tech Stack:** Node 22 + TypeScript (strict), Vitest, better-sqlite3, Playwright (Chromium). Bangkok time via `src/schedule/bangkokCalendar.ts`. PM2 on Windows.

**Design spec:** `docs/superpowers/specs/2026-06-30-xtm-jobkey-collision-sticky-rejected-design.md` (read it for rationale; this plan is the executable form).

## Global Constraints

- TDD: write the failing test FIRST, run it red, then implement. Coverage gate ≥80% on `detection/`, `state/`, `reporting/`, `schedule/`.
- Tests use TZ-explicit `+07:00` inputs and MUST pass under `TZ=UTC` (CI runs UTC). Verify with `TZ=UTC npx vitest run`.
- `npm run lint` (eslint + prettier) and `npm run typecheck` (tsc --noEmit) must be clean.
- New `_job_key` = `projectName|fileName|step|role`, each trimmed + lowercased (`normField`). The SQL backfill MUST replicate `normField` exactly: `lower(trim(col))`.
- `rejectReason` is a business field: NOT read from `XtmRawJob`; initialised `null` and preserved via `...existing`.
- Lifecycle enum (exact): `new, accepted, skipped, missing, accept_failed, closed, removed, rejected`. `accepting`/`accepted` are `accept_status` values.
- Co-author trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch already exists: `feat/jobkey-collision-sticky-rejected` (spec commits are on it).

## File Structure

| File | Change |
|---|---|
| `src/detection/jobKey.ts` | `computeXtmJobKey` Pick + join add `projectName` |
| `src/portal/xtmInbox.ts` | `readClosedKeys` scrape+key add `project`; drift guard `allProjectNull` |
| `src/portal/xtmAccept.ts` | `readAcceptAvailability` key add project; `rowForTarget` filter project |
| `src/portal/errors.ts` | `AcceptTarget` add `projectName` |
| `src/detection/types.ts` | `XtmJobState` add `rejectReason: string \| null` |
| `src/state/db.ts` | add `reject_reason` to `JOB_V2_COLUMNS`; backfill non-terminal `job_key` |
| `src/state/xtmJobStore.ts` | `XtmJobRow` + `upsertMany` (cols/VALUES/SET/params) + `rowToState` add `reject_reason` |
| `src/detection/xtmDiff.ts` | `buildXtmState` init `rejectReason: null` |
| `src/reporting/sheets.ts` | new pure `resolveSheetStatusAndNote(...)` |
| `src/runtime/xtmPollCycle.ts` | clear/set `rejectReason` (2 sites); `toSheetRow` → helper + `capturedAt`; field-sync uses persisted reason |

No change (verified): `xtmDiff.xtmAdapter.key`, `xtmClient` (~199), `xtmAccept` (~35/180), `xtmPollCycle` (~329) all pass full `XtmRawJob`; `computeXtmSnapshotHash` already hashes `projectName`; `XTM.active.cell.project` and `XTM.closed.cell.project` (`td:nth-child(2)`) already exist in `selectors.ts`.

---

### Task 1: `computeXtmJobKey` includes the project

**Files:**
- Modify: `src/detection/jobKey.ts:51-53`
- Modify: `src/portal/xtmInbox.ts` (`readClosedKeys` scrape map ~333-346 + key ~357)
- Modify: `src/portal/xtmAccept.ts:~212-216` (`readAcceptAvailability`)
- Modify: `tests/integration/xtmInbox.test.ts:194,215` (the two `computeXtmJobKey({fileName,step,role})` calls)
- Test: `tests/unit/jobKey.test.ts`

**Interfaces:**
- Produces: `computeXtmJobKey(job: Pick<XtmRawJob, 'projectName' | 'fileName' | 'step' | 'role'>): string` returning `projectName|fileName|step|role` (normField each).

- [ ] **Step 1: Write the failing tests** — append to `tests/unit/jobKey.test.ts`:

```ts
describe('computeXtmJobKey — project disambiguation', () => {
  const base = { fileName: 'X_Proof.html', step: 'Post-Editing (PE) 1', role: 'Corrector' };
  it('includes the normalized project name', () => {
    expect(computeXtmJobKey({ projectName: '  PR 4721900 EMAIL ', ...base }))
      .toBe('pr 4721900 email|x_proof.html|post-editing (pe) 1|corrector');
  });
  it('two projects sharing file|step|role get DIFFERENT keys (collision fixed)', () => {
    const a = computeXtmJobKey({ projectName: 'PR 4721900-1-3 EMAIL', ...base });
    const b = computeXtmJobKey({ projectName: 'PR 4721900-1-3 EMAIL_1', ...base });
    expect(a).not.toBe(b);
    // negative: file|step|role are byte-identical, so the OLD key WOULD have collided
    expect([base.fileName, base.step, base.role]).toEqual([base.fileName, base.step, base.role]);
  });
  it('same project + same file|step|role is the SAME key (relisting dedup intact)', () => {
    expect(computeXtmJobKey({ projectName: 'PR EMAIL', ...base }))
      .toBe(computeXtmJobKey({ projectName: 'PR EMAIL', ...base }));
  });
});
```

- [ ] **Step 2: Run red** — `npx vitest run tests/unit/jobKey.test.ts` → FAIL (current key omits project; first test expects the `pr 4721900 email|…` prefix).

- [ ] **Step 3: Implement** — `src/detection/jobKey.ts`, replace `computeXtmJobKey`:

```ts
export function computeXtmJobKey(
  job: Pick<XtmRawJob, 'projectName' | 'fileName' | 'step' | 'role'>,
): string {
  return [normField(job.projectName), normField(job.fileName), normField(job.step), normField(job.role)].join('|');
}
```
Update the JSDoc above it: change the "until recon (D2) confirms … whether project disambiguation is needed" note to "project disambiguation: DONE (recon 2026-06-30 — two projects can share a file name)".

- [ ] **Step 4: Fix the compiler-flagged DOM-read sites.** `tsc` now errors at the two sites that pass `{fileName,step,role}`.
  - `src/portal/xtmInbox.ts` `readClosedKeys`: in the `evaluateAll` scrape map (the object near lines 333-346 that lists `kebab/file/step/role`) add `project: sel.project`, add `project: cell(el, sel.project)` to the returned row object, and add `project: XTM.closed.cell.project` to the selector arg object. Then at the key build (~357): `computeXtmJobKey({ projectName: r.project, fileName: r.file, step: r.step, role: r.role })`.
  - `src/portal/xtmAccept.ts` `readAcceptAvailability` (~212-216): read `const project = (await row.locator(XTM.active.cell.project).first().textContent()) ?? '';` (mirror how `fileName` uses `?? ''`), then `const key = computeXtmJobKey({ projectName: project, fileName, step, role });`.
  - `tests/integration/xtmInbox.test.ts:194,215`: add `projectName: '<same project string used by the fixture row>'` to both `computeXtmJobKey({...})` calls so the expected key matches what `readClosedKeys` now produces (use the fixture row's project — see `xtmPages.ts` `malayRow` default project).

- [ ] **Step 5: Run** — `npx vitest run tests/unit/jobKey.test.ts` → PASS; `npm run typecheck` → clean (the required `projectName` in the `Pick` no longer errors anywhere).

- [ ] **Step 6: Commit**

```bash
git add src/detection/jobKey.ts src/portal/xtmInbox.ts src/portal/xtmAccept.ts tests/unit/jobKey.test.ts tests/integration/xtmInbox.test.ts
git commit -m "fix(detection): include projectName in computeXtmJobKey (collision fix)"
```

---

### Task 2: Closed-grid drift guard watches project

**Files:**
- Modify: `src/portal/xtmInbox.ts` (`readClosedKeys` loop ~351-378)
- Test: `tests/integration/xtmInbox.test.ts`

**Interfaces:**
- Consumes: `readClosedKeys` from Task 1 (now reads `r.project`).

- [ ] **Step 1: Write the failing tests** — in `tests/integration/xtmInbox.test.ts`, in the `readClosedKeys` describe block:
  - a Closed grid whose rows all render an empty project (use/extend a fixture like `xtmClosedRowNoWwc` but blank the project cell) → asserts the observer WARN fires (`outcome:layout_drift` / evidence captured) — mirror the existing `allStepRoleNull` drift test.
  - **negative match:** an accepted job keyed `projectA|file|step|role`; a Closed row with the SAME `file|step|role` but `projectB` → `readClosedKeys` returns a key set that does NOT contain the accepted job's key (so it would be classified Removed, not Closed).

- [ ] **Step 2: Run red** — `npx vitest run tests/integration/xtmInbox.test.ts -t "drift"` → FAIL (no project drift detection yet).

- [ ] **Step 3: Implement** — in the `readClosedKeys` loop, alongside `allStepRoleNull`, add `let allProjectNull = true;` and set `if (r.project !== null) allProjectNull = false;`. Keep the per-row skip as-is (`if (!r.file || r.file.trim() === '') continue;` — do NOT add an empty-project continue). Extend the post-loop drift condition to: `if (candidateCount > 0 && (allStepRoleNull || allProjectNull)) { …capture evidence + WARN… }`.

- [ ] **Step 4: Run** — `npx vitest run tests/integration/xtmInbox.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/portal/xtmInbox.ts tests/integration/xtmInbox.test.ts
git commit -m "fix(portal): readClosedKeys drift guard watches the project column"
```

---

### Task 3: Accept-time row identity includes the project

**Files:**
- Modify: `src/portal/errors.ts:84-91` (`AcceptTarget`)
- Modify: `src/portal/xtmAccept.ts` (`rowForTarget` ~325-334)
- Modify: `src/runtime/xtmPollCycle.ts` (the two `AcceptTarget` build sites ~300, ~506)
- Test: `tests/integration/accept.test.ts`

**Interfaces:**
- Produces: `AcceptTarget` now carries `projectName: string`.

- [ ] **Step 1: Write the failing test** — in `tests/integration/accept.test.ts` (near the "exact row match" section ~488): two grid rows `malayRow({ project: 'EMAIL', file: 'x.html' })` and `malayRow({ project: 'EMAIL_1', file: 'x.html' })` (same file/step/role). `rowForTarget` with the EMAIL_1 target must select ONLY the EMAIL_1 row.

- [ ] **Step 2: Run red** — `npx vitest run tests/integration/accept.test.ts -t "row match"` → FAIL (compile: `AcceptTarget` has no `projectName`; or ambiguous `.first()`).

- [ ] **Step 3: Implement**
  - `errors.ts`: add `projectName: string;` to `AcceptTarget`.
  - `xtmPollCycle.ts` (the two places that build an `AcceptTarget` from a job state, ~300 and ~506): add `projectName: s.projectName`.
  - `xtmAccept.ts` `rowForTarget`: add a project predicate to the row filter — match `row.locator(XTM.active.cell.project)` with `exact()` against `target.projectName`, alongside the existing file/step/role `exact()` filters.

- [ ] **Step 4: Run** — `npx vitest run tests/integration/accept.test.ts` → PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/portal/errors.ts src/portal/xtmAccept.ts src/runtime/xtmPollCycle.ts tests/integration/accept.test.ts
git commit -m "fix(portal): AcceptTarget + rowForTarget match on project (row precision)"
```

---

### Task 4: Add `reject_reason` column + persist it in the store

**Files:**
- Modify: `src/detection/types.ts` (`XtmJobState`)
- Modify: `src/state/db.ts` (`JOB_V2_COLUMNS` ~132)
- Modify: `src/state/xtmJobStore.ts` (`XtmJobRow`, `upsertMany` ~102-151, `rowToState`)
- Modify: `src/detection/xtmDiff.ts` (`buildXtmState` ~53)
- Test: `tests/unit/xtmJobStore.test.ts`, `tests/unit/db.migration.test.ts`

**Interfaces:**
- Produces: `XtmJobState.rejectReason: string | null`; DB column `reject_reason TEXT`.

- [ ] **Step 1: Write the failing tests**
  - `xtmJobStore.test.ts`: round-trip — upsert a job with `rejectReason: 'group blocked: x'`, read back → equals; upsert with `rejectReason: null` → null (clear works).
  - `db.migration.test.ts` (**extend the existing combo test ~324** "OLD db missing BOTH file_wwc AND rejected"): also seed without `reject_reason`; after migrate, assert the `reject_reason` column EXISTS and a pre-existing row's other data survived the `widenLifecycleCheck` rebuild.

- [ ] **Step 2: Run red** — `npx vitest run tests/unit/xtmJobStore.test.ts tests/unit/db.migration.test.ts` → FAIL (type error: `rejectReason` missing; column absent).

- [ ] **Step 3: Implement**
  - `types.ts`: add `rejectReason: string | null;` to `XtmJobState` (after `acceptedAt`).
  - `db.ts`: add `{ name: 'reject_reason', ddl: 'reject_reason TEXT' }` to `JOB_V2_COLUMNS` (so `ensureJobColumns` adds it idempotently and `widenLifecycleCheck`'s rebuild carries it via `allColumns`).
  - `xtmJobStore.ts`: add `reject_reason: string | null` to `XtmJobRow`; in `upsertMany` add `reject_reason` to the INSERT column list, to the `VALUES (@…)` list, to the `ON CONFLICT(job_key) DO UPDATE SET` list, and `rejectReason: s.rejectReason ?? null` to the bound params object; in `rowToState` add `rejectReason: r.reject_reason`.
  - `xtmDiff.ts` `buildXtmState`: add `rejectReason: null` to the constructed state. (`applyXtmState` already spreads `...existing` → the field is preserved on re-sync and through the missing transition; nothing reads it from `raw`.)

- [ ] **Step 4: Run** — `npx vitest run tests/unit/xtmJobStore.test.ts tests/unit/db.migration.test.ts` → PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/detection/types.ts src/state/db.ts src/state/xtmJobStore.ts src/detection/xtmDiff.ts tests/unit/xtmJobStore.test.ts tests/unit/db.migration.test.ts
git commit -m "feat(state): persist reject_reason on the job (migration + store + diff init)"
```

---

### Task 5: Migration backfill — re-key non-terminal rows

**Files:**
- Modify: `src/state/db.ts` (the migration that adds `reject_reason` from Task 4 — append the backfill UPDATE)
- Test: `tests/unit/db.migration.test.ts`

**Interfaces:**
- Consumes: the new key format from Task 1 (`projectName|fileName|step|role`, normField = `lower(trim(...))`).

- [ ] **Step 1: Write the failing tests** — `db.migration.test.ts`:
  - seed a NON-terminal row (`lifecycle_status='accepted'`) whose `job_key` is the OLD `file|step|role` and whose `project_name` is set → after migrate, its `job_key` equals `lower(trim(project_name))||'|'||lower(trim(file_name))||'|'||lower(trim(step))||'|'||lower(trim(role))`.
  - seed a TERMINAL row (`lifecycle_status='closed'`) with an old key → after migrate, its `job_key` is UNCHANGED.
  - idempotent: run the migration twice → the non-terminal key is stable (second run is a no-op).

- [ ] **Step 2: Run red** — `npx vitest run tests/unit/db.migration.test.ts -t "backfill"` → FAIL (no backfill yet).

- [ ] **Step 3: Implement** — in `db.ts`, after `ensureJobColumns`/`widenLifecycleCheck` run (so the column set is final), add a one-time UPDATE inside the same migration:

```sql
UPDATE jobs
SET job_key = lower(trim(project_name)) || '|' || lower(trim(file_name)) || '|' || lower(trim(step)) || '|' || lower(trim(role))
WHERE (lifecycle_status IN ('new','accepted','skipped','accept_failed','rejected')
       OR accept_status IN ('accepting','accepted'))
  AND project_name IS NOT NULL
  AND job_key <> lower(trim(project_name)) || '|' || lower(trim(file_name)) || '|' || lower(trim(step)) || '|' || lower(trim(role));
```
Guard it so it runs once (the same gate the other migrations use — e.g. only when the `reject_reason` column was just added, or a `meta`-flagged migration version). The `job_key <>` clause makes it idempotent. Do NOT use `NOT IN ('closed','missing','removed')` (legacy rows may have `lifecycle_status = NULL`).

- [ ] **Step 4: Run** — `npx vitest run tests/unit/db.migration.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state/db.ts tests/unit/db.migration.test.ts
git commit -m "fix(state): backfill non-terminal job_key to the project-qualified key"
```

---

### Task 6: Pure `resolveSheetStatusAndNote` helper

**Files:**
- Modify: `src/reporting/sheets.ts` (add export next to `lifecycleToSheetStatus`)
- Test: `tests/unit/sheets.test.ts`

**Interfaces:**
- Produces:
```ts
export function resolveSheetStatusAndNote(
  state: Pick<XtmJobState, 'lifecycleStatus' | 'acceptStatus' | 'rejectReason'>,
  opts: { note: string | null; capturedAtMs: number },
): { status: SheetStatus; note: string | null }
```

- [ ] **Step 1: Write the failing tests** — `tests/unit/sheets.test.ts` (TZ-explicit `capturedAtMs`):
  - rejected + missing → `{status:'Rejected', note:'group blocked: x (left Active 30/06/2026 18:23)'}` (capturedAtMs = a `+07:00` instant; assert the Bangkok-rendered suffix, green under `TZ=UTC`).
  - rejected + closed and rejected + removed → same "(left Active …)" suffix.
  - rejected + **present** (lifecycle not in missing/closed/removed) → `{status:'Rejected', note:'group blocked: x'}` (NO suffix).
  - accepted overrides: `rejectReason` set but `acceptStatus:'accepted'` → `{status:'Accepted', note:<opts.note>}`.
  - no rejectReason + closed → `{status:'Closed', note:<opts.note>}` (regression: unchanged behaviour).

- [ ] **Step 2: Run red** — `npx vitest run tests/unit/sheets.test.ts -t "resolveSheetStatusAndNote"` → FAIL (not exported).

- [ ] **Step 3: Implement** — in `sheets.ts`:

```ts
const TERMINAL_ABSENT: ReadonlySet<XtmLifecycleStatus> = new Set(['missing', 'closed', 'removed']);

export function resolveSheetStatusAndNote(
  state: Pick<XtmJobState, 'lifecycleStatus' | 'acceptStatus' | 'rejectReason'>,
  opts: { note: string | null; capturedAtMs: number },
): { status: SheetStatus; note: string | null } {
  if (state.rejectReason !== null && state.acceptStatus !== 'accepted') {
    const left = TERMINAL_ABSENT.has(state.lifecycleStatus)
      ? ` (left Active ${formatReadableDate(new Date(opts.capturedAtMs).toISOString())})`
      : '';
    return { status: 'Rejected', note: `${state.rejectReason}${left}` };
  }
  return { status: lifecycleToSheetStatus(state.lifecycleStatus), note: opts.note };
}
```
(Use the existing `formatReadableDate` already imported/available in `sheets.ts`; it renders Bangkok `DD/MM/YYYY HH:mm`.)

- [ ] **Step 4: Run** — `TZ=UTC npx vitest run tests/unit/sheets.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reporting/sheets.ts tests/unit/sheets.test.ts
git commit -m "feat(reporting): pure resolveSheetStatusAndNote (sticky Rejected precedence)"
```

---

### Task 7: Wire the helper + set/clear `rejectReason` in the cycle

**Files:**
- Modify: `src/runtime/xtmPollCycle.ts` (`toSheetRow` ~690 + its 3 call sites 167/606/666; the two `decideAccept` sites 281/333; the gate-reject branch ~427; the field-sync ~663)
- Test: `tests/integration/xtmCycle.test.ts`

**Interfaces:**
- Consumes: `resolveSheetStatusAndNote` (Task 6), `XtmJobState.rejectReason` (Task 4).

- [ ] **Step 1: Write the failing tests** — `tests/integration/xtmCycle.test.ts` (TZ-explicit via `snapAt`):
  - **sticky:** cycle 1 a Malay job is gate-rejected → its Sheet row Status `'Rejected'`, note has the reason, NO "(left Active". Cycle 2 the job is gone (missing) → Sheet row STILL `'Rejected'` + reason + "(left Active …)" (NOT `'Closed'`/`'Missing'`).
  - **clear/upgrade:** a previously-rejected job becomes accepted → Sheet `'Accepted'`; assert DB `reject_reason` is now null.
  - **clear on skip:** a rejected job that next cycle is `skipped` (over `ACCEPT_MAX_WORDS`) → Sheet `'Skipped'` (NOT stale `'Rejected'`).
  - **field-sync F1 (update existing test ~1148):** a still-rejected job whose Due/Words change keeps Status `'Rejected'` + the persisted reason (not null).
  - **idempotent:** after the missing transition, a further cycle does NOT re-enqueue the row.

- [ ] **Step 2: Run red** — `TZ=UTC npx vitest run tests/integration/xtmCycle.test.ts` → FAIL (Sheet shows Closed/Missing after disappear).

- [ ] **Step 3: Implement**
  - `toSheetRow(s, note, capturedAt)`: add a `capturedAt: string` param; compute `const { status, note: resolvedNote } = resolveSheetStatusAndNote(s, { note, capturedAtMs: Date.parse(capturedAt) });` and set `status` + `note: resolvedNote` on the returned `SheetRow` (replace the direct `lifecycleToSheetStatus`/`note`). Update the 3 call sites to pass `snapshot.capturedAt` (167 = `'crash mid-accept'`; 606/666 in the enqueue/field-sync). Call 167 has `rejectReason=null` → helper's left-Active branch never fires there.
  - **Clear rejectReason — TWO sites, before `decideAccept`:**
    - event pass (~281): set `s.rejectReason = null` for the present job **after** the `if (ev.eventType === 'missing') { … continue }` block (266-278) — never before it.
    - robustness pass (~333): set `s.rejectReason = null` before `decideAccept` there too.
  - **Set on gate-reject (~427-429):** where the gate builds `const note = \`group blocked: ${blockReason}\`;` and sets `lifecycleStatus='rejected'`, also set `s.rejectReason = note;`.
  - **Field-sync (~663):** the `syncNote` is now redundant — the helper owns precedence via the persisted `rejectReason`. Pass `note: null` (or keep `syncNote` reading the persisted `s.rejectReason ?? null`); either way assert the F1 test shows Status `'Rejected'`.

- [ ] **Step 4: Run** — `TZ=UTC npx vitest run tests/integration/xtmCycle.test.ts` → PASS; `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/runtime/xtmPollCycle.ts tests/integration/xtmCycle.test.ts
git commit -m "feat(runtime): route Sheet status through sticky-Rejected helper + set/clear rejectReason"
```

---

### Task 8: Live-regression integration — EMAIL vs EMAIL_1

**Files:**
- Test: `tests/integration/xtmCycle.test.ts`
- Modify (if needed): `tests/fixtures/xtmPages.ts` (a two-projects-same-file fixture helper override)

**Interfaces:**
- Consumes: all prior tasks (project in key, sticky helper).

- [ ] **Step 1: Write the failing test** — reproduce the incident with TZ-explicit deadlines + separate cycles via `snapAt`:
  - cycle A (`snapAt('2026-06-29T19:51:00+07:00')` or similar): a Malay job project `'PR Newswire Release 4721900-1-3 (Basecamp Research) Affiliate EMAIL'`, file `'4721900-1-6 (ID-91e1bdd17f80)_Proof.html'`, due `2026-06-30T22:51:00+07:00` → accepted.
  - cycle B (`snapAt('2026-06-30T18:21:00+07:00')`): the SAME file name but project `'…EMAIL_1'`, due `2026-07-01T14:21:00+07:00`.
  - Assert: the two produce DISTINCT job keys → **two** Sheet rows; the EMAIL_1 appearance is a **New Job** (not "relisted") and its `acceptedAt` is NOT EMAIL's; each is evaluated on its own deadline (EMAIL's effective-day vs EMAIL_1's).

- [ ] **Step 2: Run red** — `TZ=UTC npx vitest run tests/integration/xtmCycle.test.ts -t "EMAIL"` → write the test so it would FAIL on the OLD key (collapsed to one job); confirm it PASSES on the new key (it should already pass after Tasks 1-7, so this is a regression lock — if it fails, a prior task is incomplete).

- [ ] **Step 3: (no new impl)** — this task is a regression test only. If red, fix the responsible prior task.

- [ ] **Step 4: Run full suite** — `TZ=UTC npx vitest run` → all green; `npm run lint`; `npm run typecheck`; `npm run test:coverage` (detection/state/reporting/schedule ≥80%).

- [ ] **Step 5: Commit**

```bash
git add tests/integration/xtmCycle.test.ts tests/fixtures/xtmPages.ts
git commit -m "test(integration): EMAIL vs EMAIL_1 collision regression lock"
```

---

## Self-Review

- **Spec coverage:** Fix 1 key (T1), DOM reads (T1), drift guard (T2), AcceptTarget/rowForTarget (T3), migration backfill (T5) + reject_reason column (T4); Fix 2 field+store+diff (T4), pure helper (T6), set/clear + wiring + field-sync (T7); integration (T8). §8 recon already DONE (no task). bulkGroupKey/held-lock/capacity unchanged (no task — verified). All spec sections map to a task.
- **Type consistency:** `computeXtmJobKey` Pick (T1) ↔ DOM-read callers (T1) ↔ AcceptTarget.projectName (T3); `XtmJobState.rejectReason` (T4) ↔ `resolveSheetStatusAndNote` Pick (T6) ↔ cycle set/clear (T7); `toSheetRow(s, note, capturedAt)` (T7) consistent across its 3 call sites.
- **Ordering:** T4 (column/field) precedes T5 (backfill needs the migration) and T6/T7 (helper needs the field). T1 precedes T5 (backfill key format) and T3 (project plumbing). T8 last (locks the whole).
- **No placeholders:** every code step shows the actual edit; commands are exact.
