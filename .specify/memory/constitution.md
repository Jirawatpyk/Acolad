<!--
Sync Impact Report
==================
Version change: (template, unversioned) → 1.0.0 (initial ratification)
Modified principles: none (all newly defined)
Added sections:
  - Core Principles I–VIII (Code Quality; Testing Standards; User Experience
    Consistency; Reliability & Recovery; Observability; Robustness;
    Idempotency & State; Performance Requirements)
  - Operational Constraints & Security
  - Development Workflow & Quality Gates
  - Governance
Removed sections: none (template placeholders replaced)
Templates status:
  - .specify/templates/plan-template.md ✅ aligned (generic Constitution Check
    gate resolves against this file; no edit required)
  - .specify/templates/spec-template.md ✅ aligned (Success Criteria section
    carries measurable performance/reliability outcomes; no edit required)
  - .specify/templates/tasks-template.md ✅ updated (test tasks for core
    automation logic are now mandatory per Principle II)
  - .specify/templates/checklist-template.md ✅ aligned (no constitution
    references; no edit required)
Follow-up TODOs:
  - RESOLVED 2026-06-10: docs/Auth.txt was migrated to .env
    (ACOLAD_EMAIL/ACOLAD_PASSWORD) and removed from the project;
    .gitignore guards docs/Auth.txt and .env against reintroduction.
-->

# Acolad Job Automation Constitution

System scope: an unattended automation that monitors the Acolad Partner
Portal, accepts available jobs ("กดรับงาน"), and reports every action to
Google Chat and Google Sheets, operating continuously 24/7.

## Core Principles

### I. Code Quality

- The system MUST be organized into distinct modules with clear interfaces:
  portal interaction (browser/HTTP), job decision logic, state store,
  reporting adapters (Google Chat, Google Sheets), and runtime/scheduler.
- Reporting targets MUST share one reusable reporting interface; adding a new
  target (e.g., email) MUST NOT require changes to decision logic.
- Linting and formatting MUST pass with zero errors before any merge; the
  toolchain is pinned in the repository and runs in CI or a pre-commit hook.
- Public functions and module boundaries MUST carry explicit types
  (TypeScript strict mode or Python type hints checked by a type checker).
- No dead code, no copy-pasted logic between modules: duplication found in
  review MUST be extracted into a shared component before merge.

Rationale: a 24/7 bot is modified while it is in service; only strictly
modular, statically checked code keeps changes safe and reviewable.

### II. Testing Standards

- Core decision logic — job parsing, acceptance criteria, deduplication, and
  state transitions — MUST be developed test-first (red → green → refactor).
- Integration tests MUST cover the critical path end-to-end with mocked
  external services: job detected → accepted → recorded → reported.
- A failure-mode suite MUST exist and pass, covering at minimum: portal
  login failure, session expiry, request timeout, malformed/missing job
  fields, Google API quota or auth errors, and process restart mid-cycle.
- Line coverage for core modules (decision logic, state store, reporting
  adapters) MUST be ≥ 80%; a release MUST NOT ship with failing tests.
- Live-portal tests MUST be isolated behind an explicit flag and MUST never
  run in CI by default.

Rationale: the bot acts autonomously on a real business portal; untested
logic translates directly into wrongly accepted or missed jobs.

### III. User Experience Consistency

- Every Google Chat notification MUST follow a single message schema: event
  type, job ID, action taken, outcome, timestamp, and a portal link when
  available.
- Google Sheets rows MUST conform to a fixed, versioned column schema; any
  schema change MUST be applied as a documented migration, never by writing
  rows that diverge from existing columns.
- The same event type MUST render identically across runs and across
  channels; error notifications MUST state what failed, the impact, and the
  required human action in plain language.
- All user-facing timestamps MUST use ISO 8601 in Asia/Bangkok (UTC+07:00).

Rationale: the Chat feed and the Sheet ARE the product's UI; operators must
be able to scan, filter, and trust them without decoding format drift.

### IV. Reliability & Recovery

- The process MUST run under a supervisor (e.g., PM2, systemd, Task
  Scheduler with restart) that restarts it automatically on crash.
- All transient failures (network, portal latency, Google API 5xx/429) MUST
  be retried with exponential backoff plus jitter, with a defined retry cap;
  exhausted retries MUST raise an operator alert, never fail silently.
- After any restart, the system MUST resume from persisted state with no
  lost jobs and no duplicate processing (see Principle VII).
- A heartbeat MUST be emitted at a fixed interval; absence of a heartbeat
  for more than 10 minutes MUST trigger a Google Chat alert.
- Reporting failures MUST NOT block job acceptance: if Sheets is down, the
  event queues locally and Chat still receives the alert; if Chat is down,
  the event is persisted and flushed when connectivity returns.

Rationale: for an unattended 24/7 system, recovery behavior is not an edge
case — it is the primary operating mode over any long horizon.

### V. Observability

- All logs MUST be structured (JSON) and include timestamp, level, module,
  job ID (when applicable), action, and outcome.
- Every acceptance attempt MUST be logged with its result and end-to-end
  latency; every external call failure MUST be logged with the error detail.
- A daily summary MUST be posted to Google Chat and appended to Google
  Sheets: jobs seen, accepted, failed, retries performed, and uptime.
- On any unexpected portal state, the system MUST capture diagnostic
  evidence (screenshot or response payload) before recovering or alerting.
- Logs MUST rotate with a defined retention period (minimum 14 days) so that
  any incident within that window can be reconstructed.

Rationale: nobody watches the bot in real time; logs and reports are the
only way to answer "what did it do at 03:00?" after the fact.

### VI. Robustness

- All external input — portal DOM, API responses, configuration — MUST be
  validated before use; missing or malformed fields MUST route the job to a
  quarantine/alert path, never into the acceptance flow.
- The bot MUST NOT interact with unrecognized page elements: if expected
  selectors are absent or the layout changes, it MUST stop that action,
  capture evidence, and alert — silent best-effort clicking is forbidden.
- Every network and browser operation MUST have an explicit timeout; no
  unbounded waits.
- Session expiry MUST be detected and re-login performed automatically, with
  an alert raised if re-login fails after the retry cap.

Rationale: the portal is an external system that changes without notice;
the bot must fail safe and loud, not guess.

### VII. Idempotency & State

- Every job MUST be identified by a stable unique key; the acceptance flow
  MUST check persisted state before acting so the same job is never accepted
  or processed twice — including across crashes and restarts.
- All writes to Google Sheets MUST be deduplicated by job key and event type
  (upsert semantics); re-running any flow MUST NOT produce duplicate rows or
  duplicate Chat messages.
- Processed-job state MUST live in durable storage (e.g., SQLite or
  equivalent), never only in memory; state writes MUST be committed before
  the action is reported as complete.
- Every operation MUST be safe to retry: partial failures MUST converge to a
  consistent state on the next attempt rather than compounding.

Rationale: in a job-grabbing system, double acceptance is a real-world
commitment error toward the client — idempotency is a business requirement,
not an implementation nicety.

### VIII. Performance Requirements

- New jobs MUST be detected within 30 seconds of appearing on the portal
  (polling interval ≤ 30s, or faster where the portal permits push/refresh).
- Acceptance MUST complete within 5 seconds (p95) from detection to
  confirmed click, since job availability is competitive.
- Reporting MUST land in Google Chat and Google Sheets within 60 seconds of
  the triggering event under normal conditions.
- Steady-state memory MUST stay below 1 GB with no monotonic growth over a
  24-hour window; browser sessions MUST be recycled on a schedule to prevent
  leaks.
- Google API usage MUST respect published rate limits, using batching for
  Sheets writes where multiple events occur close together.

Rationale: detection-to-acceptance latency directly determines how many
jobs are won; resource ceilings keep a 24/7 process from degrading slowly.

## Operational Constraints & Security

- Credentials (portal login, Google service account keys, webhook URLs,
  heartbeat ping URLs) MUST be supplied via environment variables or a
  secret store and MUST NOT be committed to the repository in plaintext.
  The former `docs/Auth.txt` violated this rule and was migrated to `.env`
  and removed on 2026-06-10.
- Google APIs MUST be accessed via a dedicated service account holding the
  minimum scopes required (Sheets append/update, Chat webhook post only).
- Portal interaction MUST be throttled to human-plausible rates; the system
  MUST NOT hammer endpoints in a way that risks account suspension.
- The system operates in Asia/Bangkok time on a designated always-on host;
  deployment changes MUST preserve the supervisor + auto-restart setup.
- Logs and Sheets MUST NOT store passwords or tokens; secrets MUST be
  redacted from all diagnostic output, including captured screenshots where
  feasible.

## Development Workflow & Quality Gates

- Every feature follows the Spec Kit flow: `/speckit-specify` →
  `/speckit-plan` → `/speckit-tasks` → `/speckit-implement`; the plan's
  Constitution Check gate MUST evaluate Principles I–VIII explicitly.
- A change MUST NOT merge unless: lint and type checks pass, the full test
  suite passes, new core logic arrived test-first, and idempotency plus
  observability impact were stated in the review.
- Any production incident (missed jobs, duplicate acceptance, silent
  outage) MUST produce a short postmortem note in `docs/` and, where the
  cause is systemic, a follow-up amendment or test.
- Deviations from any principle MUST be recorded in the plan's Complexity
  Tracking table with a justification and the rejected simpler alternative.

## Governance

This constitution supersedes all other development practices for this
project. Where guidance conflicts, the constitution wins; user instructions
in `CLAUDE.md` remain authoritative over tooling defaults.

- **Amendments**: proposed as a change to this file with a written
  rationale, reviewed and approved by the project owner, and applied
  together with updates to all dependent templates and documents.
- **Versioning policy**: semantic versioning of this document — MAJOR for
  removing or redefining a principle in a backward-incompatible way, MINOR
  for adding a principle or materially expanding guidance, PATCH for
  clarifications and wording fixes.
- **Compliance review**: every plan MUST pass the Constitution Check gate
  before Phase 0 research and again after Phase 1 design; every PR review
  MUST verify the quality gates above; quarterly, the operator reviews
  daily-summary metrics against Principle VIII targets and amends them if
  reality demands different numbers.

**Version**: 1.0.1 | **Ratified**: 2026-06-10 | **Last Amended**: 2026-06-10
