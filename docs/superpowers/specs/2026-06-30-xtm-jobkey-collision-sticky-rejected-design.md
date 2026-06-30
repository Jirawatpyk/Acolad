# XTM Job Identity: Project Disambiguation + Sticky Rejected Status — Design

**Date:** 2026-06-30
**Status:** Approved design (revised after 3-specialist review: reliability + playwright + qa) — ready for implementation plan
**Scope:** Two related Sheet-correctness fixes surfaced by a live incident (job 4721900, 2026-06-30):

1. **Collision fix** — include the project name in the XTM job identity (`_job_key`) so two different projects that share a file name no longer collapse into one record.
2. **Sticky Rejected fix** — a gate-Rejected Sheet row (status + reason) is no longer overwritten by a later Closed/Missing lifecycle transition.

**Out of scope (deferred, user-initiated):** the WWC switch (feasibility/capacity on File WWC instead of raw words). Independent; this incident showed both, but they are separate.

---

## 1. Problem

### 1.1 Collision — `_job_key` lacks the project

`computeXtmJobKey` is `fileName|step|role` (no project). Live incident — two **distinct** projects, evidenced by the append-only outbox (the mutable jobs row was already overwritten):

| field | Job A (outbox #137, 02:51) | Job B (outbox #194, 18:21) |
|---|---|---|
| project | …Affiliate **EMAIL** | …Affiliate **EMAIL_1** |
| file | `4721900-1-6 (ID-91e1bdd17f80)_Proof.html` | same file name |
| due | **30/06 22:51** | **01/07 14:21** |
| words | 854 | 861 |
| status | Accepted (02:52) | Rejected |

The project **number** (`4721900-1-3`) and file **ID** (`91e1bdd17f80`) are identical; only the full project **name** suffix (`EMAIL` vs `EMAIL_1`) differs. Same file + step + role → identical `_job_key` → Job B overwrote Job A's DB + Sheet row, was mistaken for a **relisting** of Job A (Chat "Job Relisted"; inherited Job A's `acceptedAt`), and Job A's "Accepted" record was lost. `jobKey.ts:46-49` already anticipated this ("whether project disambiguation is needed"). Recon (2026-06-30) confirms it is needed.

### 1.2 Sticky Rejected — appearance-overwrite

The Sheet keeps one row per `_job_key`; Status = `lifecycleToSheetStatus(s.lifecycleStatus)` (the current lifecycle). The reject reason lives only in the per-cycle `blockNotes` map — **not persisted**. When a gate-Rejected job later leaves Active (another linguist grabs it / it is withdrawn), the diff transitions it missing→closed and the next Sheet upsert overwrites Status="Closed" with an empty Note — erasing "the bot declined this, and why". Chat keeps every card; the Sheet loses the rejection. (In the 4721900 incident this overwrite was actually the **collision** of §1.1; §1.2 is the genuine residual case: one real job, rejected, then gone.)

---

## 2. Fix 1 — project in the job identity

`computeXtmJobKey` becomes `projectName|fileName|step|role`, each trimmed + lowercased:

```ts
export function computeXtmJobKey(
  job: Pick<XtmRawJob, 'projectName' | 'fileName' | 'step' | 'role'>,
): string {
  return [normField(job.projectName), normField(job.fileName), normField(job.step), normField(job.role)].join('|');
}
```

**Call sites.** Five pass a full `XtmRawJob` (projectName already present) — no change: `xtmDiff.xtmAdapter.key`, `xtmClient` (~199), `xtmAccept` (~35, ~180), `xtmPollCycle` (~329). Two build the key from raw DOM cells and **must read the project cell** (the selectors already exist — N1):

- `xtmInbox.readClosedKeys` (~357): the Closed-grid scrape map (~333-346) must add `project` via the **existing** `XTM.closed.cell.project` (`td:nth-child(2)`); pass it into `computeXtmJobKey`.
- `xtmAccept.readAcceptAvailability` (~216): read the **existing** `XTM.active.cell.project`, with `?? ''` (mirror how `fileName` is read), and pass it into the key.

Making `projectName` a **required** member of the `Pick` makes the compiler flag both DOM-read sites (and the two `computeXtmJobKey({fileName,step,role})` test calls in `tests/integration/xtmInbox.test.ts:194,215`) until they supply it — no silent miss. `computeXtmSnapshotHash` already includes `projectName` (no change). `bulkGroupKey` is language-only and independent (no change).

**Closed-grid drift guard (extend).** `readClosedKeys`' existing detector (`xtmInbox.ts:364`, fires on `candidateCount>0 && allStepRoleNull`) does not watch project. After Fix 1 a blank/missing Closed project cell would make every key start `|file|step|role` and never match Active → all finished jobs misclassified. Extend the detector to also WARN when candidate rows exist but **every** row reads project = null (symmetric with step/role), and `continue` (skip) a Closed row whose project is empty (mirroring the existing empty-`file` skip) so a blank project never forms a false-matching key.

**Accept-time row identity (extend).** `rowForTarget` (`xtmAccept.ts:325`) and `AcceptTarget` (`errors.ts:84-91`) locate the kebab row by file/step/role text only — **project-blind**. After Fix 1 the EMAIL/EMAIL_1 edge (two projects, same file/step/role, both Malay, same cycle — §5) yields two identical rows → `rowForTarget(...).first()` is ambiguous. This is **benign** (bulk accept is by-language-group; `determineAcceptOutcomes` resolves each target with the full re-read key incl. project — worst case a 1-cycle delay, not corruption), but for row precision add `projectName` to `AcceptTarget` and filter the project cell (`exact()`) in `rowForTarget`.

**Cross-grid project-string identity (recon — see §8).** The closed↔accepted join (`xtmPollCycle.ts:489-495`) requires the project string read from the **Closed** grid to equal the one read from the **Active** grid (after `normField` trim+lowercase). `normField` absorbs case/whitespace but not DOM truncation / tooltip-vs-cell / extra child nodes. **Blast radius if mismatched is Sheet-status only** — a finished accepted job would be labelled "Removed" instead of "Closed"; **both release the daily quota** (lifecycle leaves `'accepted'` either way), so this is FR-014 (Closed-vs-Removed) correctness, **not** quota loss. Verify before/at implementation (§8); the drift guard above is the runtime safety net.

**Migration — targeted backfill of non-terminal rows.** "New key forward, no backfill" is **unsafe**: the bot auto-accepts Malay jobs 24/7 and a job accepted-but-not-yet-finished stays **held** in Active (`lifecycleStatus 'accepted'`). At the next `npm run deploy` restart, held/`accepting` rows under the OLD key would (a) mis-disappear → be misclassified **Removed** (Accepted record lost, quota released), and (b) reappear under the NEW key → a fake **New Job** + a re-accept attempt on a job we already own (fake "Accepted" card, new `acceptedAt`, ~2-cycle capacity double-count) — **the same failure mode as 4721900**. Therefore the migration **re-keys every NON-TERMINAL row** (`lifecycleStatus IN ('new','present','accepted','accepting','rejected','skipped')` OR `accept_status IN ('accepting','accepted')` — i.e. anything not closed/missing/removed) to the new composite, computed deterministically from the row's stored `project_name|file_name|step|role`. Terminal rows (closed/missing/removed) keep their old keys (never re-read). The held job's pre-existing Sheet row (old key in col N) remains and the bot appends one fresh row under the new key on the next upsert — a cosmetic duplicate per held job, acceptable. The backfill runs once, inside the same DB migration that adds `reject_reason` (idempotent: a row whose key already equals its new composite is a no-op).

---

## 3. Fix 2 — sticky Rejected Sheet status

1. **Persist the reason.** Add `rejectReason: string | null` to `XtmJobState` and a `reject_reason TEXT` column to the jobs table — add `{ name: 'reject_reason', ddl: 'reject_reason TEXT' }` to `JOB_V2_COLUMNS` (`db.ts:132`) so `ensureJobColumns` adds it idempotently and `widenLifecycleCheck`'s rebuild carries it via `allColumns` (`db.ts:205`). It is a **business field, not from-raw** (unlike `file_wwc`): `buildXtmState` (`xtmDiff.ts:53`) initialises `rejectReason: null`; `applyXtmState` (`:87`) preserves it via `...existing` (there is nothing to read from the raw snapshot).

2. **Precise set/clear** (the cycle owns this; `blockNotes` holds skip reasons too, so do **not** set from it blindly): at the start of handling each **present, evaluated** job — before `decideAccept` — set `s.rejectReason = null`. Then **only** the gate-reject branch (`xtmPollCycle.ts:~429`, `lifecycleStatus='rejected'`) sets `s.rejectReason = <reason>`. Every other present path (first_seen/relisted pre-decide, `skipped`, `ACCEPT_ENABLED`-off `new`, kill-switch candidate, accepted) thus leaves it null. An **absent** (missing/closed/removed) job is not in the snapshot and is not re-evaluated, so its last value **persists** — this is what makes a rejected job's reason survive after it leaves Active. (Clearing on every non-reject present path is what prevents a `skipped`/`new`/`accept_failed` job from showing a stale "Rejected".)

3. **Sheet status precedence as a PURE, GATED helper.** Extract the decision into `src/reporting/sheets.ts` (next to `lifecycleToSheetStatus`), so it is unit-testable and under the **reporting** coverage gate (the current `XtmPollCycle.toSheetRow` is private and in `runtime/`, which is **not** gated):

   ```ts
   export function resolveSheetStatusAndNote(
     state: Pick<XtmJobState, 'lifecycleStatus' | 'acceptStatus' | 'rejectReason'>,
     opts: { note: string | null; capturedAtMs: number },
   ): { status: SheetStatus; note: string | null }
   ```
   Rule:
   - If `rejectReason !== null && acceptStatus !== 'accepted'` → `status='Rejected'`, `note=rejectReason`; and when `lifecycleStatus ∈ {missing, closed, removed}` append ` (left Active <DD/MM/YYYY HH:mm Bangkok>)` (rendered from `capturedAtMs` via the existing `dateFormat`/`formatReadableDate`).
   - Otherwise → `status=lifecycleToSheetStatus(lifecycleStatus)`, `note=opts.note` (unchanged behaviour).

   `toSheetRow` calls this helper (and gains a `capturedAt` parameter — three call sites `xtmPollCycle.ts:167, 606, 666`; the `:167` crash-mid-accept call has `rejectReason=null` so the left-Active branch never fires there).

4. **Accepted upgrade.** Once `acceptStatus === 'accepted'`, the precedence yields to "Accepted" and `rejectReason` is set null (step 2) — a robustness-pass retry that succeeds correctly overwrites the Rejected row.

5. **Enqueue / dedup unchanged; field-sync uses the persisted reason.** A still-present rejected job does not re-enqueue every cycle (existing guard `xtmPollCycle:645-647`). The missing/closed transition fires exactly one Sheet upsert that writes the "(left Active …)" note; the outbox `event_id` (`sheet:<key>|missing|<cycle>`) makes it idempotent. The field-sync guard (`xtmPollCycle:658-663`), which today reads the reject note from `blockNotes`, switches to the **persisted** `rejectReason` so a still-rejected job's silent field re-sync keeps Status "Rejected" + the binding reason.

---

## 4. Unchanged (explicit non-goals)

- The WWC switch (raw words vs File WWC) — separate, deferred, user-initiated.
- `bulkGroupKey` (language-only), the held-field lock, the accept state machine.
- Capacity / held-list logic: held = `lifecycleStatus === 'accepted'`; a rejected job (acceptStatus `'none'`) is never in it, so Fix 2's display precedence cannot affect capacity.
- Terminal DB/Sheet rows (closed/missing/removed) are not re-keyed; the Sheet's existing rows are not rewritten.

---

## 5. Edge cases

- **Held / `accepting` job present at deploy** → re-keyed by the targeted backfill (§2) → recognised under the new key on the first post-deploy cycle (no mis-disappearance, no fake re-accept).
- **Two projects, same file, both Malay, same cycle** → two distinct keys → two jobs; still one Malay **bulk group** (language-only — unchanged); `rowForTarget` gains project for row precision.
- **Rejected job re-accepted by a robustness pass** → "Accepted", `rejectReason` cleared (upgrade).
- **Rejected job leaves Active, then relists feasible** → accepted → "Accepted"; the "(left Active …)" note is superseded.
- **`skipped` / `ACCEPT_ENABLED`-off / `accept_failed` job that was previously rejected** → `rejectReason` cleared on the present-evaluate path → shows its true status, not stale "Rejected".
- **`normField(null)`** → `''` (projectName is non-null in `XtmRawJob`; `normField` null-guards regardless).

---

## 6. Testing (TDD; detection/state/reporting coverage-gated ≥80%; TZ-explicit `+07:00`, green under `TZ=UTC`)

**Fix 1:**
- `jobKey` unit: key includes normalized project; **collision** — same file/step/role + different project → different keys; **negative** — assert the two jobs' `file|step|role` are byte-identical (so the OLD key would have collided); **dedup** — same project + same file/step/role → same key; `computeXtmSnapshotHash` changes when `projectName` changes (lock the invariant that project is in the hash).
- `readClosedKeys` (`tests/integration/xtmInbox.test.ts`): reads the Closed Project cell into the key; **positive** match (same project both grids); **negative** — a finished job whose file appears in Closed under a **different** project must NOT match → not "closed"; the extended drift guard fires when all rows read project=null; empty-project row is skipped. Fix the two `computeXtmJobKey({fileName,step,role})` calls (lines 194/215) to pass project.
- `xtmAccept` (`tests/integration/accept.test.ts:488`): accept-time key includes project; **wrong-row** scenario — two rows `malayRow({project:'EMAIL',file:'x'})` + `malayRow({project:'EMAIL_1',file:'x'})` resolve to distinct keys / correct rows.
- **Migration backfill** (`tests/unit/db.migration.test.ts`): a NON-terminal row (lifecycle 'accepted') is re-keyed to `project|file|step|role`; a terminal row keeps its old key; idempotent re-run is a no-op.
- **Integration regression** (`tests/integration/xtmCycle.test.ts`, separate cycles via `snapAt(...)`, TZ-explicit): cycle 1 sees project "…EMAIL" (due `2026-06-30T22:51:00+07:00`); a later cycle sees "…EMAIL_1" (due `2026-07-01T14:21:00+07:00`), same file name → **two distinct jobs**, two Sheet rows, each on its own deadline; EMAIL_1 is a **New Job** (not "relisted") and its `acceptedAt` is not EMAIL's.

**Fix 2:**
- `resolveSheetStatusAndNote` unit (`tests/unit/sheets.test.ts`, **all branches**): rejected+missing / rejected+closed / rejected+**removed** → "Rejected" + reason + "(left Active …)"; accepted (rejectReason set) → "Accepted" (override); no rejectReason + closed → "Closed" (regression). "(left Active …)" timestamp asserted against a TZ-explicit `+07:00` `capturedAt` (green under `TZ=UTC`), appearing **once** (no nesting).
- `xtmJobStore` round-trip `reject_reason` incl. null; **clear** — re-accept sets it null in the DB.
- `db` combo migration (**extend** `db.migration.test.ts:324`): an OLD db missing BOTH `file_wwc`/`reject_reason` AND the `'rejected'` lifecycle value → `reject_reason` is added **before** the widen rebuild and its value is **preserved** + column present after the rebuild.
- **State-level persistence** (`xtmJobStore`/cycle): a job that goes missing/closed keeps `reject_reason` in the DB (the diff's missing-state carries it via `...existing`).
- **Set/clear** (cycle): a present job that flips rejected→skipped/disabled clears `rejectReason` (Sheet not stale "Rejected"); a present-rejected job's note has **no** "(left Active" suffix.
- **Field-sync** (`xtmCycle.test.ts:1148` F1 test, update): a still-rejected job whose Due/Words change keeps Status "Rejected" + the **persisted** reason (not null).
- **Idempotency**: after the missing transition, further cycles do not re-enqueue the row.

---

## 7. Risk

- **Fix 1 key change:** low — pure identity; the only behavioural change is that previously-colliding jobs are now correctly separate.
- **Fix 1 migration (targeted backfill):** low — deterministic from stored `project_name`, idempotent, eliminates the deploy restart window. Residual: a cosmetic duplicate Sheet row per held job (old-key row + new-key row).
- **Cross-grid project string (§8):** medium-likelihood, low-severity (Sheet status Closed-vs-Removed; both release quota). Verified by recon + guarded by the drift detector.
- **Fix 2:** moderate — extracts a pure helper, adds a persisted field + DB migration, and re-points the field-sync guard. Coverage-gated (the helper lives in `reporting/`); display-only (never touches capacity/held). Built TDD.
- **Combined:** the two fixes touch disjoint areas (identity key + migration vs Sheet-status/state) and compose cleanly in one plan.

---

## 8. Pre-implementation recon (one item)

Before (or during) implementation, verify on the live XTM (via the user's authenticated browser) that the **project cell `td:nth-child(2)` textContent is byte-identical after `.trim()` between the Active and Closed grids for the same job**. The Active side is already proven (the incident recorded "…EMAIL" vs "…EMAIL_1" distinctly from the Active grid); only the Closed side is unverified. If they differ, normalize further or choose a project anchor before relying on the closed↔accepted join. Not a blocker for the plan (blast radius is Sheet-status, and the drift guard catches a systematic mismatch), but cheap to confirm.
