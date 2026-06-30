# XTM Job Identity: Project Disambiguation + Sticky Rejected Status — Design

**Date:** 2026-06-30
**Status:** Approved design — ready for implementation plan
**Scope:** Two related Sheet-correctness fixes surfaced by a live incident (job 4721900, 2026-06-30):

1. **Collision fix** — include the project name in the XTM job identity (`_job_key`) so two different projects that share a file name no longer collapse into one record.
2. **Sticky Rejected fix** — a gate-Rejected Sheet row (status + reason) is no longer overwritten by a later Closed/Missing lifecycle transition.

**Out of scope (deferred, user-initiated):** the WWC switch (feasibility/capacity on File WWC instead of raw words). It is a separate concern; this incident showed both, but they are independent.

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

The project **number** (`4721900-1-3`) and the file **ID** (`91e1bdd17f80`) are identical across the two; only the full project **name** suffix (`EMAIL` vs `EMAIL_1`) differs. Same file + step + role → identical `_job_key` → Job B:

- overwrote Job A's DB + Sheet row (project EMAIL→EMAIL_1; Status Accepted→Rejected→Closed),
- was mistaken for a **relisting** of Job A (Chat "Job Relisted"; inherited Job A's `acceptedAt`),
- Job A's "Accepted" record was lost.

`jobKey.ts:46-49` already anticipated this: *"whether project disambiguation is needed"* — deferred pending recon. Recon (2026-06-30) confirms it is needed.

### 1.2 Sticky Rejected — appearance-overwrite

The Sheet keeps one row per `_job_key`; Status = `lifecycleToSheetStatus(s.lifecycleStatus)` (the current lifecycle). The reject reason lives only in the per-cycle `blockNotes` map — **not persisted**. When a gate-Rejected job later leaves Active (another linguist grabs it / it is withdrawn), the diff transitions it missing→closed and the next Sheet upsert overwrites Status="Closed" with an empty Note — erasing "the bot declined this, and why". Chat keeps every card (append-only); the Sheet loses the rejection.

(In the 4721900 incident this overwrite was actually the **collision** of §1.1, not a single job's appearance sequence. §1.2 is the genuine residual case: one real job, rejected, then gone.)

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

**Call sites.** Five pass a full `XtmRawJob` (projectName already present) — no change: `xtmDiff.xtmAdapter.key`, `xtmClient` (line ~199), `xtmAccept` (lines ~35, ~180), `xtmPollCycle` (line ~329). Two build the key from raw DOM cells and **must read the project column**:

- `xtmInbox.readClosedKeys` (line ~357): read the Closed grid's Project cell. Add `XTM.closed.cell.project = 'td:nth-child(2)'` — recon (2026-06-30) confirmed the Closed grid carries Project at col 2. The closed↔accepted match then keys on the same identity.
- `xtmAccept` (line ~216): read `XTM.active.cell.project` (already defined, `td:nth-child(2)`).

Making `projectName` a **required** member of the `Pick` makes the compiler flag both DOM-read sites until they supply it — no silent miss.

`computeXtmSnapshotHash` already includes `projectName` (no change). `bulkGroupKey` is language-only and independent (no change).

**Migration: none.** New key forward. The 31 existing DB/Sheet rows (all terminal at design time) keep their old `file|step|role` keys. One-time effect: a pre-change job that relists after deploy computes the new key, is not found, and is reported as a **New Job** (one re-notify) with a fresh Sheet row — consistent with the appearance-event model. No in-flight / held jobs at design time, so nothing active is disrupted.

---

## 3. Fix 2 — sticky Rejected Sheet status

1. **Persist the reason.** Add `rejectReason: string | null` to `XtmJobState` and a `reject_reason` TEXT column to the jobs table (mirror the `file_wwc` migration: additive, idempotent, carried through the table-rebuild). **While a job is present and evaluated:** set `rejectReason` to the reason when the gate rejects it this cycle (the value currently placed in `blockNotes`), and to `null` whenever the gate does **not** reject it (accepted or feasible). An **absent** (missing/closed/removed) job is no longer in the snapshot and is not re-evaluated, so its last value **persists** — this is exactly what lets a rejected job's reason survive after it leaves Active.

2. **Sheet status precedence** in `XtmPollCycle.toSheetRow`:
   - If `rejectReason !== null && acceptStatus !== 'accepted'` → Status = `'Rejected'`, Note = `rejectReason`; and when `lifecycleStatus ∈ {missing, closed, removed}` append `" (left Active <DD/MM/YYYY HH:mm Bangkok>)"` to the Note.
   - Otherwise → `lifecycleToSheetStatus(lifecycleStatus)` (unchanged).

3. **Accepted upgrade.** Once `acceptStatus === 'accepted'`, the precedence yields to "Accepted" and `rejectReason` is cleared — a robustness-pass retry that succeeds correctly overwrites the Rejected row.

4. **Enqueue / dedup unchanged.** A still-present rejected job does not re-enqueue every cycle (existing guard, `xtmPollCycle:646`). The missing/closed transition fires exactly one Sheet upsert that writes the "(left Active …)" note. The existing field-sync guard (`xtmPollCycle:658-663`, which preserves the reject note while the job is still rejected) is retained.

The "left Active" timestamp uses the cycle's `capturedAt` rendered in Bangkok via the existing `dateFormat`/`formatReadableDate` helper (consistent with the rest of the Sheet's dates).

---

## 4. Unchanged (explicit non-goals)

- The WWC switch (raw words vs File WWC) — separate, deferred, user-initiated.
- `bulkGroupKey` (language-only), the held-field lock, the accept state machine.
- Capacity / held-list logic: the held list is `lifecycleStatus === 'accepted'`; a rejected job is never in it, so Fix 2's display precedence cannot affect capacity.
- No backfill of existing DB/Sheet rows.

---

## 5. Edge cases

- **Two projects, same file, both Malay, same cycle** → now two distinct keys → two jobs. They remain in the same Malay **bulk group** (bulkGroupKey is language-only — unchanged), so the all-or-nothing across the Malay group is existing behavior, not introduced here.
- **Pre-change job relists after deploy** → New Job + one re-notify + fresh Sheet row (documented one-time effect).
- **Rejected job re-accepted by a robustness pass** → "Accepted", `rejectReason` cleared (upgrade).
- **Rejected job leaves Active, then genuinely relists and is now feasible** → accepted → "Accepted"; the "(left Active …)" note is superseded.
- **`normField(null)`** → `''` (projectName is non-null in `XtmRawJob`, but `normField` already null-guards).

---

## 6. Testing (TDD; detection/state/reporting coverage-gated ≥80%; TZ-explicit `+07:00`, green under `TZ=UTC`)

**Fix 1:**
- `jobKey` unit: key includes the normalized project; **collision test** — same file/step/role + **different** project → **different** keys; same project + same file/step/role → **same** key (relisting dedup intact).
- `readClosedKeys`: reads the Closed Project cell; closed↔accepted match uses project (fixture Closed grid carries a Project col 2).
- `xtmAccept`: accept-time key includes project.
- **Integration (the live regression):** two Malay jobs sharing a file name — project "…EMAIL" (due `2026-06-30T22:51+07:00`) and "…EMAIL_1" (due `2026-07-01T14:21+07:00`) → **two distinct jobs**, two Sheet rows, each evaluated on its own deadline; EMAIL_1 is a New Job (not "relisted") and its `acceptedAt` is not EMAIL's.

**Fix 2:**
- `toSheetRow` unit: `rejectReason` set + lifecycle missing/closed → Status "Rejected", Note = reason + " (left Active …)"; `acceptStatus` accepted → "Accepted" (rejectReason ignored); no rejectReason + closed → "Closed" (regression).
- `xtmJobStore` round-trip `reject_reason` (incl. null).
- `db` migration adds `reject_reason` idempotently (existing table, no error).
- **Integration:** gate-reject a job → Sheet "Rejected" + reason; same job missing the next cycle → **still "Rejected" + reason + "(left Active …)"** (NOT "Closed"); then re-accepted → "Accepted".

---

## 7. Risk

- **Fix 1:** low — pure identity change; no in-flight jobs; no data mutation. The only behavioural change is that previously-colliding jobs are now correctly separate.
- **Fix 2:** moderate — changes the Sheet status derivation, adds a persisted field, and adds a DB migration. Coverage-gated; built TDD. The precedence is **display-only** and never touches capacity/held logic (a rejected job is never held).
- **Combined:** the two fixes touch disjoint areas (identity key vs Sheet-status/state) and compose cleanly; they can ship in one plan.
