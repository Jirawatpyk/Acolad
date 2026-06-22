# Feature Specification: XTM Job Detection + Auto-Accept + Sheets Logging

**Feature Branch**: `002-xtm-detect-accept`

**Created**: 2026-06-19

**Status**: Draft

**Input**: User description: "002-xtm-detect-accept"

## Context

Feature 001 monitored the **Acolad Partner Portal** (`partner.acolad.com`) Offers →
Pending tab. Live operation revealed that real translation jobs never appear there —
they arrive in a **different system, XTM Cloud** (`xtm.acolad.com`), on the
**Tasks → Active** list. The 001 bot was watching the wrong portal and reported zero
jobs while real Malay jobs were arriving and being lost.

This feature re-points monitoring to XTM Cloud and adds two capabilities the
constitution always envisioned: **automatically accepting eligible jobs** and
**logging every detected job to Google Sheets**. The proven domain layers from 001
(appearance-based detection, durable state, reliable reporting queue, heartbeat) are
reused unchanged; only the portal-interaction layer and the Sheets reporting target
are new.

**Operating facts (from the operator):**

- Malay jobs are available to accept for **under 1 minute** before another vendor
  takes them — speed is the difference between winning and losing a job.
- Volume is low: roughly **4–5 jobs per day**. Every job matters.
- The team accepts **only Malay (Malaysia / MS)** jobs.
- New jobs appear directly in the **Active** list. The Active list also contains
  already-accepted jobs that are awaiting translation. Completed jobs leave Active
  (they move to Closed).

## Clarifications

### Session 2026-06-19

- Q: When several Malay tasks appear at once (one project → multiple files/steps), accept per-task or in one bulk action? → A: Bulk — use "Accept all tasks for this language (Malay) in this group" in a single action for speed (verify the exact scope of "this group" during recon so it does not claim other teams' work).
- Q: At startup, when Active already contains Malay jobs, accept them or only baseline+summarize? → A: Accept still-acceptable pre-existing Malay jobs too (don't miss opportunities), relying on the Accept control being absent for already-claimed jobs; fall back to baseline-only if recon shows acceptable-vs-accepted cannot be told apart reliably. Still post the one-time pre-existing summary.
- Q: Is the XTM login a dedicated bot account, or shared with humans? → A: A single shared account (also used by human translators/PMs); concurrent logins invalidate the session frequently, so frequent automatic re-login is normal and expected (not an incident), and the system must avoid session churn that repeatedly evicts an active human user.
- Q: SC-001 "90% of jobs that appear" is unmeasurable (undetected misses have no denominator). How to make it measurable? → A: Re-base the automated gate on the **detected** denominator (Accepted ÷ Accepted+Missing+Accept failed for Malay rows, from the Sheet) AND add a weekly reconciliation against XTM's actual arrivals to bound undetected misses (so the blind spot is surfaced, not hidden).
- Q: How is each job's accept outcome determined for a bulk action, on partial success or a crash mid-action? → A: By **re-reading the Active list after the action** (authoritative post-state), not by trusting transient UI signals: target no longer acceptable & owned → Accepted; vanished → Missing; still acceptable → Accept failed. This attributes bulk/partial outcomes per job and recovers after a crash (re-reading on restart yields the truth).
- Q: Is auto-accept intentionally unbounded by job size/quantity, or capped? → A: Unbounded by default and intentionally so (the team accepts all Malay; a missed accept loses the job). Provide configurable caps (max word count, max accepts per cycle) that **default to "no limit"** so a capacity limit can be added later via config without a code change.
- Q: When an accepted job leaves Active, is it always Closed, or could it be cancelled/reassigned (mislabeled)? → A: Do a targeted check of the Closed list only when an accepted job disappears: found in Closed → `Closed`; not found → new terminal status `Removed` (cancelled/reassigned). Checking only on disappearance keeps it cheap and avoids mislabeling cancellations as completed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Win Malay jobs by accepting them automatically (Priority: P1)

A new Malay (Malaysia) job appears in the XTM Active list. The system detects it and
clicks Accept on the team's behalf within the competitive window, before another
vendor can take it. The operator does nothing; the job is secured.

**Why this priority**: This is the entire reason the feature exists. Jobs are lost
today because acceptance is manual and the window is under a minute. Winning jobs is
the business outcome.

**Independent Test**: With a fixture/recorded XTM Active page containing one Malay
job not previously seen, the system attempts an Accept action against that job and
records the outcome. Fully testable without the other stories.

**Acceptance Scenarios**:

1. **Given** the system is running and has an established baseline, **When** a new
   job with target language Malay (Malaysia) appears in Active, **Then** the system
   accepts it and records the result as `Accepted`.
2. **Given** a new job whose target language is not Malay, **When** it appears in
   Active, **Then** the system does **not** accept it and records it as `Skipped`.
3. **Given** a new Malay job that is taken by another vendor before the system can
   act, **When** the Accept attempt finds the job gone or un-acceptable, **Then** the
   system records `Missing` and does not error.
4. **Given** the same Malay job is observed across several detection cycles, **When**
   the system has already accepted it once, **Then** it is never accepted a second
   time — including after a restart.
5. **Given** the system has just started, **When** the Active list already contains a
   still-acceptable Malay job, **Then** the system accepts it; already-accepted
   pre-existing jobs are left untouched, and a one-time summary of all pre-existing
   jobs is posted.

---

### User Story 2 - A complete, trustworthy record of every job in Google Sheets (Priority: P2)

Every job the system detects — regardless of language or outcome — is written to the
shared Google Sheet as one row, and its status is kept current as the job moves
through its lifecycle. The operator can open the Sheet at any time and see exactly
what arrived and what happened to it.

**Why this priority**: The Sheet is the durable business record and the audit trail.
Logging works even when acceptance is disabled, so it delivers value on its own.

**Independent Test**: Feed the system a set of detected jobs and verify that each one
produces exactly one Sheet row matching the existing column layout, with status
transitions applied as outcomes occur. No acceptance click required to test logging.

**Acceptance Scenarios**:

1. **Given** any job is detected (any language), **When** it is first seen, **Then**
   a single row is appended with status `New` and the job's project, file, source
   language, target language, due date, and word count.
2. **Given** a logged job is subsequently accepted, snatched, skipped, or fails to
   accept, **When** that outcome occurs, **Then** the same row's status is updated to
   `Accepted` / `Missing` / `Skipped` / `Accept failed` (no duplicate row created).
3. **Given** an accepted job later leaves the Active list, **When** the system
   observes its disappearance, **Then** it checks the Closed list and sets the row's
   status to `Closed` (found) or `Removed` (not found — cancelled/reassigned).
4. **Given** the Google Sheets service is temporarily unavailable, **When** rows are
   produced during the outage, **Then** no row is lost and none is duplicated once
   the service recovers.

---

### User Story 3 - Real-time awareness in Google Chat (Priority: P3)

For every detected job and every acceptance outcome, the team's Google Chat channel
receives a clear message in Thai with the job details and what the system did, so the
team knows in real time what is happening without watching the Sheet.

**Why this priority**: Notifications make the system observable and build operator
trust, but the business value (winning jobs, keeping records) is delivered by P1/P2.

**Independent Test**: Trigger a detection and an accept outcome and verify a
correctly formatted Chat message is enqueued for each, using the fixed message
schema.

**Acceptance Scenarios**:

1. **Given** a new job is detected, **When** it is first seen, **Then** a Chat
   message announces the job (project, file, language pair, due date).
2. **Given** a Malay job is accepted, **When** the accept succeeds, **Then** a Chat
   message confirms `✅ รับงานแล้ว` with the job details.
3. **Given** an accept attempt fails or the job is snatched, **When** the outcome is
   determined, **Then** a Chat message states what happened and whether human action
   is needed.

---

### Edge Cases

- **Partial bulk accept**: a bulk action may accept some targets while others are
  snatched mid-action, or crash before completing; each target's outcome is resolved
  independently by the post-action re-read (FR-024), so partial results are recorded
  correctly rather than all-or-nothing.
- **One file, multiple steps/rows**: a single file can appear as multiple Active rows
  (e.g., different workflow steps or roles). Each row is tracked and logged as its own
  job by a stable key. When several Malay rows are available together, a single bulk
  accept action claims them all (FR-006), after which each claimed row is recorded
  individually.
- **Already-accepted job on first sight**: if a job is already accepted (by a human
  or teammate) when first seen, the Accept action is unavailable → recorded `Missing`,
  no error, no double-click.
- **Disappearance is ambiguous**: a job the system never accepted leaving Active →
  `Missing` (taken by another). An accepted job leaving Active is confirmed via a
  targeted Closed-list check → `Closed` if found, `Removed` if not (cancelled/
  reassigned) — so a cancellation is not mislabeled as completed (FR-014).
- **Session expiry**: the XTM session expires → the system re-authenticates
  automatically; if re-login fails after the retry cap, it raises an operator alert.
- **Shared-account session contention**: the XTM account is shared with human users,
  so the bot's session can be invalidated at any time (including mid-cycle) by a
  concurrent human login. The system MUST detect the logged-out state, re-authenticate,
  and resume without alerting on routine re-logins, and MUST avoid a re-login loop that
  would repeatedly evict an active human user.
- **Unrecognized layout**: if the Active list markers/columns are missing or changed,
  the system stops the action, captures sanitized evidence, and alerts — it never
  guesses which element to click.
- **Accept disabled**: when auto-accept is switched off for operations, detection,
  logging, and notification still run; eligible jobs are recorded but not clicked.
- **Cold start with pending jobs**: at startup, still-acceptable pre-existing Malay
  jobs are accepted, already-accepted ones are baselined, and all pre-existing jobs
  are summarized once (FR-005).
- **Language ambiguity**: only an exact match to Malay (Malaysia) is eligible for
  acceptance; any other or unclear target language is treated as non-eligible.
- **Reporting outage**: Google Chat or Sheets unavailable → events queue durably and
  flush on recovery without loss or duplication.

## Requirements *(mandatory)*

### Functional Requirements

**Detection**

- **FR-001**: System MUST monitor the XTM Active task list and detect jobs that newly
  appear while the system is running.
- **FR-002**: System MUST identify each job by a stable, unique key so the same job is
  recognized across detection cycles and restarts. (Exact key composition — expected
  to combine the file identifier with workflow step and role — is confirmed during
  portal evidence capture; see Assumptions.)
- **FR-003**: System MUST detect a newly appeared job within 30 seconds of its
  appearance, while keeping request frequency within human-plausible limits that do
  not risk account suspension.
- **FR-004**: System MUST read each job's target language, project, file, source
  language, due date, and word count.
- **FR-005**: At system startup, the system MUST evaluate jobs already present in
  Active: any Malay (Malaysia) job that is still acceptable MUST be accepted per
  FR-006, while jobs that are already accepted / no longer acceptable are baselined
  without action. The system MUST post a one-time summary of all pre-existing jobs.
  (Fallback: if portal evidence capture shows the system cannot reliably distinguish a
  still-acceptable job from an already-accepted one in Active, it MUST baseline all
  pre-existing jobs without accepting and rely on the summary for human action.)

**Acceptance**

- **FR-006**: For a newly appeared job whose target language is exactly Malay
  (Malaysia), the system MUST attempt to accept it automatically. When multiple Malay
  tasks are available at once, the system MUST prefer a single bulk acceptance action
  ("Accept all tasks for this language in this group") over accepting each task
  individually, to minimize the number of interactions within the competitive window.
  The exact scope claimed by the bulk action MUST be verified during portal evidence
  capture to ensure it does not accept work belonging to other teams.
- **FR-007**: For a newly appeared job whose target language is not Malay (Malaysia),
  the system MUST NOT accept it and MUST record it as `Skipped`.
- **FR-008**: The system MUST accept any given job at most once; acceptance MUST check
  durable state before acting so no job is accepted twice across cycles, crashes, or
  restarts.
- **FR-009**: The acceptance action MUST be prioritized ahead of logging and
  notification so that, for an eligible job, the accept attempt lands as early as
  possible within the competitive window.
- **FR-010**: If, at the moment of acceptance, the job is no longer available (taken
  by another vendor or already accepted), the system MUST record `Missing` and MUST
  NOT treat this as an error.
- **FR-011**: If an acceptance attempt errors or its success cannot be confirmed (per
  the FR-024 re-read), the system MUST record `Accept failed`, MUST NOT assume success,
  and MUST raise an operator alert.
- **FR-024**: After any accept action, the system MUST determine each targeted job's
  outcome by **re-reading the Active list (authoritative post-state)** rather than
  trusting transient UI signals (toast/dialog): a target no longer acceptable and shown
  as owned → `Accepted`; a target that vanished → `Missing`; a target still acceptable
  → `Accept failed`. This makes bulk and partial-success outcomes attributable per job,
  and makes a crash mid-action recoverable — re-reading on restart yields the true
  state, so no job is re-accepted (supports FR-008).
- **FR-025**: The system MUST accept all eligible (Malay) jobs without an intrinsic
  limit on word count or quantity (intentional — the team accepts all Malay; a missed
  accept loses the job). The system MUST also support optional configurable caps
  (maximum word count per job, maximum accepts per cycle) that **default to "no limit"**,
  so a capacity limit can be introduced later via configuration without a code change;
  a job skipped due to a configured cap is recorded `Skipped` with the reason and
  notified for human decision.
- **FR-012**: The system MUST provide an operations switch to disable auto-accept
  while leaving detection, logging, and notification fully active.

**Lifecycle & status**

- **FR-013**: The system MUST maintain a status for each job using the controlled set:
  `New` → `Accepted` / `Skipped` / `Missing` / `Accept failed`, and terminal `Closed`
  or `Removed`.
- **FR-014**: When an accepted job later leaves the Active list, the system MUST
  confirm its fate with a targeted check of the Closed list: found in Closed → `Closed`;
  not found (cancelled/reassigned) → `Removed`. When a job the system never accepted
  leaves Active, the system MUST set its status to `Missing`. The Closed-list check is
  performed only on disappearance of an accepted job (not every cycle) to respect rate
  limits.
- **FR-015**: `In progress` status is explicitly **out of scope** for this feature
  until a reliable XTM signal for "translation started" is confirmed (the progress
  percentage is known to be unreliable as it reflects machine/translation-memory
  leverage, not human work).

**Google Sheets logging**

- **FR-016**: The system MUST append every detected job (all languages, all outcomes)
  as exactly one row in the shared Google Sheet, conforming to the existing column
  schema (Received date, Status, Project name, File, Source language, Target
  languages, Due date, Words) extended with `Step`, `Role`, `Accepted at`, and
  `Note`.
- **FR-017**: The system MUST update an existing job's row in place as its status
  changes; it MUST NOT create duplicate rows for the same job (upsert by job key).
- **FR-018**: Sheet writes MUST be reliable (at-least-once) and survive transient
  Sheets outages without losing or duplicating rows.
- **FR-026**: Pre-existing Sheet rows that lack the system's job-key column MUST be
  treated as historical/external records: the system MUST NOT update, claim, or delete
  them, and MUST manage only rows it created (identified by its job-key column). A job
  that was manually logged before the system began may therefore appear both as a
  historical row and as a system-created row; this is accepted and bounded, since the
  alternative (matching human-entered rows heuristically) risks overwriting human data.

**Notifications**

- **FR-019**: The system MUST post a Google Chat message for each newly detected job
  and for each acceptance outcome, using the project's fixed Thai message schema with
  ISO 8601 timestamps in Asia/Bangkok.
- **FR-020**: Chat delivery MUST be reliable (at-least-once) and MUST NOT block or
  delay the acceptance action.

**Portal access & safety**

- **FR-021**: The system MUST authenticate to XTM using the configured company,
  username, and password, and MUST re-authenticate automatically on session expiry.
  Because the account is shared with human users, session invalidation is frequent and
  EXPECTED: routine successful re-logins MUST be silent (no operator alert and not
  counted as incidents). The system MUST re-login only when it actually needs to act,
  minimizing session churn so it does not repeatedly evict a concurrently working human
  user. An operator alert MUST be raised only when re-login fails after the retry cap.
  The re-login trigger is concrete: re-login occurs only when a cycle needs to read or
  accept **and** the session is observed logged-out. To bound churn, the system MUST
  NOT re-login more than once per cycle and MUST NOT re-login on consecutive cycles
  merely to refresh a session that is still working — so a concurrently working human
  is not repeatedly evicted.
- **FR-022**: On any unrecognized portal state (missing markers, changed layout,
  unexpected interstitial), the system MUST stop the affected action, capture
  sanitized diagnostic evidence, and raise an alert — it MUST NOT guess or interact
  with unrecognized elements.
- **FR-023**: All credentials and secrets MUST remain outside the repository and MUST
  be redacted from logs, alerts, and captured evidence.
- **FR-027**: The system MUST count every XTM page read within a cycle — the
  Active-list read, any post-accept re-read (FR-024), and any targeted Closed-list
  check (FR-014) — against the same human-plausible request budget, and MUST stay
  within the configured polite request rate even on cycles that perform an accept, so
  the added reads never push request frequency into account-suspension territory
  (FR-003).
- **FR-028**: The system MUST emit a heartbeat at a fixed interval to the dead-man
  switch monitor; absence of a heartbeat beyond the configured grace MUST trigger an
  operator alert. The configured grace MUST default to and not exceed 10 minutes, to
  honor Constitution IV. (Reused from the feature-001 monitoring infrastructure.)

### Key Entities *(include if feature involves data)*

- **Job (Task appearance)**: a row observed in the XTM Active list, described by
  project name, file, source language, target language, due date, word count,
  workflow step, and role. Identified by a stable unique key. Carries a lifecycle
  status.
- **Appearance event**: a single instance of a job appearing in Active. Detection,
  notification, and acceptance are reasoned about per appearance; a job that
  disappears and reappears is a new appearance.
- **Acceptance attempt**: an attempt to accept an eligible job, with its outcome
  (`Accepted`, `Missing`, `Accept failed`) and the time it completed.
- **Sheet record**: the single Google Sheet row representing a detected job and its
  current status, keyed by the job's stable key.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 90% of Malay (Malaysia) jobs **that the system detects** are
  accepted (rather than ending as `Missing` or `Accept failed`), measured weekly from
  the Google Sheet as Accepted ÷ (Accepted + Missing + Accept failed) over Malay rows.
  This denominator is countable because every detected job is logged (FR-016).
- **SC-009**: A weekly reconciliation compares the count of jobs the system detected
  against XTM's actual arrivals for the same period; the undetected-miss rate is
  reported so it is surfaced rather than hidden by SC-001's detected-only denominator.
- **SC-002**: New jobs are detected within 30 seconds of appearing in Active.
- **SC-003**: For an eligible Malay job, the acceptance action lands within 60 seconds
  of the job appearing (target: under 40 seconds), under normal conditions.
- **SC-004**: 100% of detected jobs (every language, every outcome) appear as exactly
  one row in the Google Sheet with a correct, current status.
- **SC-005**: Zero double-acceptances: no job is ever accepted more than once,
  including across restarts.
- **SC-006**: Every detection and every acceptance outcome produces a corresponding
  Google Chat message.
- **SC-007**: Zero silent failures: every login failure, unrecognized-layout event,
  and failed acceptance produces an operator alert with captured evidence where
  applicable.
- **SC-008**: After any restart, the system resumes with no job processed twice and no
  previously handled job re-accepted.

## Assumptions

- **XTM is the sole source of jobs** for this feature; the Acolad Partner Portal
  monitored in feature 001 is no longer the detection target.
- The **monitored page is the XTM Tasks → Active list**. The exact Active-list URL is
  confirmed during portal evidence capture; the configured `XTM_ACOLAD_OFFERS_URL`
  may be adjusted to point at the Active view.
- The **stable job key** is expected to be the file identifier combined with workflow
  step and role (one file can produce multiple rows); the exact composition is
  confirmed during evidence capture before parser logic is finalized.
- **Target-language matching for acceptance** is an exact match to "Malay (Malaysia)"
  (MS). Any other or ambiguous value is non-eligible.
- The **acceptance window is under one minute**; a polling-based approach at the
  fastest rate that stays within safe rate limits is sufficient to win the large
  majority of jobs. A push/email-triggered fast path is a documented future
  enhancement (credentials for it already exist) to be added only if observed misses
  warrant it.
- The **Google Sheet already exists** with the documented column layout and is shared
  with the system's service account; the system extends it with the additional
  columns rather than redesigning it.
- **Acceptance is genuinely confirmable**: the portal exposes an observable success
  signal after Accept; if no such signal can be confirmed during evidence capture,
  the outcome is treated as `Accept failed` per FR-011 rather than assumed.
- The reused domain layers from feature 001 (appearance-based detection, durable
  state, reliable reporting queue, heartbeat/recovery) remain valid; only portal
  interaction and the Sheets reporting target are new.
- The XTM login is a **single shared account** also used by human translators/PMs.
  Concurrent logins frequently invalidate the bot's session, so frequent automatic
  re-login is normal — not an error. A dedicated bot account would remove this
  contention and is a recommended future improvement, out of scope here.
- **Out of scope**: `In progress` status tracking, daily summary reports, push/email
  detection, and acceptance of any non-Malay language.
