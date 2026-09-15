# Feature Specification: JobCatch 003 — Straker Offer Race

**Feature Branch**: `feat/003-straker-phase0-probe` (Phase 0 landed here; implementation branch TBD)

**Created**: 2026-09-11

**Status**: Draft — blocked on Phase 0 evidence for the conditional criteria (see SC-000)

**Input**: The "Feature description" section of `docs/003-straker-feature-brief.md`, with `docs/straker-recon-note.md` as the evidence record. Binding context supplied with the request: ADR-001 (no portal SPI), ADR-002 (program name **JobCatch**), DC-1..DC-4 as mandatory design constraints, SC-001/SC-002 conditional on Phase 0, and SC-000 forbidding `/speckit-plan` from locking the data model before Phase 0 delivers fixtures.

---

## Context

> **Terminology, fixed deliberately**: this system **claims** an offer; the XTM bot **accepts** a job. The two words are kept apart on purpose — they name actions with different mechanics, different failure modes and different reversibility, and blurring them would make it impossible to tell which system a requirement is about. "Accept" appears in this document only when describing the XTM bot.

The team already runs one bot (feature 002, live since 2026-06-22) that watches **XTM Cloud** around the clock, filters new jobs through a scheduling gate, auto-accepts Malay work, records it to Google Sheets, and announces it to Google Chat.

Work now also arrives through a **second portal, Straker Vendor Portal**, on the agency account `nztc@eqho.com`. Straker differs from XTM in ways that change the shape of the problem rather than just the destination:

| | XTM (live today) | Straker (this feature) |
| --- | --- | --- |
| How work is read | Reading rendered pages in a browser | A structured data interface the portal's own front end uses |
| How work is claimed | Claim a whole language group in one action | One offer at a time |
| Competition | The job is ours to take; timing is comfortable | **First vendor to claim it wins** — other vendors are competing for the same offer |
| "Someone else took it" | Rare, and treated as a fault | **A normal, expected outcome** that must not raise an alert |

The competitive nature is the defining constraint: for XTM a check every 20 seconds is ample, while for Straker the interval between checks is a direct lever on how much work the team wins.

**The team keeps a single translation crew but each portal enforces its own daily ceiling.** That is a deliberate decision (recorded 2026-09-11): separate ledgers give complete isolation between the two bots at the cost of the two ceilings summing higher than the crew's real capacity. The mitigation is **shared visibility, not shared enforcement** — see User Story 3.

---

## Clarifications

### Session 2026-09-11

- Q: Should the bot claim offers automatically from release, or observe only for a period first? → A: Claim from release (no observe-only period)
- Q: What should happen to a claim that succeeded but was never recorded, because the process died or the connection dropped? → A: Reconcile against the portal's own list of work assigned to the team, on start and periodically
- Q: How should a silent death of the Straker side be noticed, given the XTM side keeps signalling that it is alive? → A: A separate liveness signal per bot, with alerts delivered to the existing single operations channel
- Q: Where should Straker's results be recorded and announced — mixed with XTM's or kept apart? → A: Fully separate — its own tracking file and its own announcement channel
- Q: How many offers does Straker actually send in a day? → A: At most 2-3 per day, and irregularly — some days none
- Q: In SC-001, does "first became visible" mean when the portal published the offer, or when our read observed it? → A: When the response carrying it arrived at the bot — the only instant the bot can observe (restores the precision the brief already had)
- Q: Where is the boundary between "short-lived" and "minutes or longer" that decides whether SC-001/SC-002 survive? → A: Strike only if the shortest sighting lifetime in the sample is >= 120 s; below a sample of 10, keep them
- Q: What happens if the capture probe never reaches 10 offers? → A: Exit at 10 offers or 14 days, whichever comes first; a smaller sample is recorded as a limitation and the conservative defaults apply

### Decision: the polling rhythm stays at 10 seconds, and SC-001/SC-002 are kept — 2026-09-15

Recorded here because SC-000 requires whoever proceeds to write down the decision, the
sample size and the measured shortest lifetime rather than leave it as something someone
remembers deciding.

**The owner decided not to wait for SC-000's exit.** Track B was unblocked on 2026-09-15 with
**3 captured offers of the 10 the criterion asks for, on day 4.2 of 14.** What changed is
that the premise SC-000 rested on — "planning MUST NOT commit to the shape of an offer **on
assumption**" — no longer holds: real payloads exist, and the parser is built from the files
rather than from a field list. What has *not* changed is the sample's thinness, and the
answer to that is a parser that fails loud on anything it does not recognise (FR-023) rather
than a longer wait.

**Sample as recorded**: 3 offers, but only **two are independent** — two of the files are one
job (`job_ref: aj-265`) split across two target languages. Shortest observed lifetime
**204 s** (upper bound 215 s); the others 587 s and 1,938 s. All three were taken by other
vendors, so these are times-until-a-competitor-claimed-it, not expiry times.

**Rhythm: 10 seconds, unchanged — now on evidence rather than on the probe-era guess.** At
10 s the bot sees an offer within ten seconds of it appearing, leaving ~194 s of the shortest
observed window to act in. Polling at one second would buy nine of those 204 seconds and cost
ten times the request budget, against a portal whose allowance the bot must never crowd
(SC-003). The rhythm is a configured value, so this is a setting to revisit, not a rewrite.

**SC-001 and SC-002 are KEPT, per the strike rule as written.** The rule strikes them only at
a sample of 10 or more, and says explicitly that a smaller sample keeps them: a handful of
long-lived offers cannot show that no short-lived ones exist, and a lifetime measured by
polling is blind by construction to anything shorter than one interval.

**Stated plainly, because it is an inconsistency rather than a tidy outcome**: the evidence
points the other way from the rule's verdict. A race decided at 204 seconds is not decided in
the 400 ms SC-001 bounds, so **T044 — keep-alive pooling, proactive session renewal and
critical-path tuning — is deferred as unnecessary at the measured slack**, even though the
criteria it serves are formally kept. Revisit both together if a materially shorter lifetime
ever appears; that single observation, not a larger count of long ones, is what would change
the answer.

### Decision: claiming runs 24/7, and `outside_schedule` retires — 2026-09-15

Building the gate wiring surfaced a gap between two things this spec says. `SkipReason`
lists `outside_schedule` — "Gate — working hours or working day" (data-model §4) — and
FR-008 names working hours among the rules to apply. But **`evaluateAcceptSchedule`, the
gate being reused, never asks whether the team is at work at this instant.** It asks only
whether the work *fits* in working time before its deadline. The XTM bot has never gated on
the current moment, so nothing had exposed the difference.

**Decided: no current-moment refusal. The Straker bot claims at any hour.**

- The Assumptions section says the scheduling rules are **"reused unchanged"**. The reused
  gate has no such check; adding one would be changing the rules, not reusing them.
- The purpose of the working-hours rule is that the **work** can be done, and the
  feasibility check already enforces exactly that. Claiming takes a moment and commits
  nobody to working at that moment.
- The measurement decides it: **two of the three offers the capture probe has captured
  arrived at 06:38 Bangkok and were gone within 204 seconds.** A current-moment refusal
  would turn away two thirds of the observed volume and gain nothing — by 09:00 the offer
  no longer exists.
- A bot built to race but asleep for fifteen hours a day contradicts FR-001, which requires
  a rhythm far faster than the XTM bot's.

**Consequence, recorded rather than left to be discovered**: `outside_schedule` is now a
`SkipReason` that nothing produces. It stays in the vocabulary — data-model §4 settled it,
the store's CHECK constraint is generated from it, and a future decision could reinstate the
refusal — but a test in `gateWiring.test.ts` asserts it is never emitted, so reinstating it
without revisiting this entry will fail loudly rather than quietly.

**What is still enforced, and by the gate where it belongs**: the deadline must fall on a
working day, its year's holiday calendar must be curated, and the work must fit in working
minutes before the deadline at the configured throughput.

### Capture-probe evidence — interim record, 2026-09-15

**This is not an SC-000 decision.** SC-000 is **not satisfied** and Track B stays blocked:
3 distinct offers of the 10 required, on day 4.2 of the 14-day branch (exit falls
2026-09-25 ~11:56 BKK). Recorded here because the Clarifications log is where SC-000 says
probe evidence belongs, and because three of the findings below change what later work
should assume. `data-model.md` §1 is deliberately **left untouched** — replacing it is the
act SC-000 blocks, and it waits for exit.

**Measured so far** (probe `jobcatch-straker-recon`, 10-second rhythm, 0 restarts):

| | |
|---|---|
| Distinct offers | 3 |
| Sighting lifetimes | 204 s, 587 s, 1,938 s (lower bounds; upper bounds 215 s, 598 s, 1,948 s) |
| **Shortest lifetime** | **204 s lower / 215 s upper** |
| Arrival pattern | all three on 2026-09-15 (two at 06:38 ten seconds apart, one at 13:56); **zero on 11–14 Sep** |
| Observed rate | ~0.7 offers/day against the team's stated 2–3 — but over four days with one active day, far too short a window to revise the figure |
| Failed reads | 1 in 4.2 days (2026-09-14 06:49 BKK) |

**Reading of the strike rule, stated but not applied**: the shortest lifetime is already
past the 120-second threshold, so a sample that reached 10 while holding this shape would
strike SC-001 and SC-002. At the observed rate 10 offers arrive at roughly the 14-day mark,
so the likely exit is the time branch with fewer than 10 — where the spec's rule says
**keep** the criteria, because a handful of long-lived offers cannot show that no
short-lived ones exist. A lifetime measured by polling is also blind by construction to any
offer that lived less than one interval.

**Three findings from the real payloads that later work must not assume around:**

1. **`words` is genuine, and the jobs really are that small.** An earlier draft of this note
   guessed the opposite — that a field reading 2, 2 and 4 could not be the effort the gate
   needs. The pricing fields settle it: `budget = unit_cost × total_unit` holds on every
   offer, `total_unit` is **1 project** when `rate_type` is `total_project` and **hours** when
   it is `per_hour`. The third offer is the proof: **4 words against 0.010 hours — 36 seconds
   of work at $18/hour.** Four words in thirty-six seconds is a coherent pair, so the word
   count is real.

   The consequence is not a parsing problem but a **sizing** one. These three offers are worth
   **$1.00, $1.00 and $0.19**. If that is representative, then the daily capacity ceiling
   (U4) will never bind, and the feasibility check — working hours × throughput ≥ words —
   passes trivially for every offer. What the scheduling gate would still genuinely decide is
   the working-day, holiday and deadline-reachability part, not capacity.

   **Three offers from a single day is far too thin to conclude the workload is always this
   small**, and the team's stated 2–3 per day has not been contradicted. But it is thin
   evidence pointing somewhere the plan did not anticipate, and the numeric ceiling that U4
   defers should be set against measured offer sizes rather than an assumed job.
2. **`due_at` carries no timezone** (`2026-09-15T23:20:00`). Parsed bare it is read in the
   host's zone — Bangkok on the office machine, UTC in CI, a seven-hour difference. The open
   question is not how to parse it but **which zone the portal means**; Straker is a New
   Zealand company. Guessing shifts every feasibility and deadline-day decision by hours,
   which is the clock-drift edge case this spec already names.
3. **`listing_type` is `direct_po` on all three offers, and all three were taken by other
   vendors** (operator observation on the portal, 2026-09-15 — not read back through the API).
   An earlier draft of this note read "direct purchase order" as work directed to this vendor
   rather than contested; **that reading is wrong and is corrected here**. `direct_po` is
   contested, so Q3's conservative default — every open offer is treated as contested — turns
   out to be correct rather than merely cautious.

   What this changes about the numbers above: 204–1,938 seconds is not how long an unwanted
   offer takes to expire, it is **how long a contested offer stayed claimable before a
   competitor took it**. That is a far more useful measurement than a lifetime, and it says
   the detection window is generous: the probe saw each of these within ten seconds of it
   appearing, leaving minutes of slack before the offer went. On this evidence all three were
   winnable and were lost only because nothing was claiming — the probe is read-only by
   construction. It is also the first real input to SC-004's win rate, and the baseline is
   **0 of 3**.

   What remains Straker's to answer: what other `listing_type` values exist and what they
   mean. Three offers of one type cannot show that every type behaves this way.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Win an eligible Straker offer without a human watching (Priority: P1)

An offer the team wants appears on Straker at an arbitrary hour. Today nobody sees it unless they happen to reload the portal, and by the time they do another vendor has usually claimed it. With this feature the bot notices the offer, checks it against the team's working rules, and claims it — or reports plainly that another vendor got there first.

**Why this priority**: This is the entire reason the feature exists. Without it the team simply does not receive Straker work. Every other story is about seeing and governing what this one does.

**Independent Test**: Present the system with an offer that satisfies the eligibility rules during working hours and within the remaining daily ceiling; confirm the offer ends up claimed by the team, recorded, and announced, with no human involved. Then present an offer another vendor claims first and confirm the system reports a lost race as a normal outcome.

**Acceptance Scenarios**:

1. **Given** an offer matching the team's eligibility rules appears while the schedule allows work and the daily ceiling has room, **When** the system next reads the offer list, **Then** the offer is claimed for the team, recorded, and announced.
2. **Given** the same offer, **When** another vendor claims it first, **Then** the system records the outcome as a lost race, raises **no** alert, does not stop, and continues to the next offer.
3. **Given** an offer that does not match the eligibility rules, **When** it appears, **Then** the system never attempts to claim it, and records why it was skipped.
4. **Given** an eligible offer that would exceed the remaining daily ceiling, or that cannot be finished in working time before its deadline, **When** it appears, **Then** the system declines to claim it and records the blocking reason in a form a human can read.
5. **Given** the session has expired, **When** the system tries to read the offer list, **Then** it restores the session and continues without losing the polling rhythm.

---

### User Story 2 - See every offer and every outcome, not just the wins (Priority: P2)

The coordinator needs a truthful record: which offers appeared, which the team won, which were lost to other vendors, and which were deliberately skipped and why. Without the losses and the skips the team cannot tell "Straker sends us nothing" from "we keep arriving second".

**Why this priority**: Winning is worthless if nobody can tell whether the team is winning. This record is also the only way to judge whether the polling rhythm is set correctly, and it is the input to every tuning decision after launch.

**Independent Test**: Run the system across a period containing wins, losses, and skips; confirm the recorded log and the announcements together account for every offer that appeared, each with an outcome and a reason.

**Acceptance Scenarios**:

1. **Given** an offer was claimed, **When** the outcome is recorded, **Then** it appears in the team's tracking record and in the announcement channel, distinguishable at a glance from XTM work.
2. **Given** an offer was lost to another vendor, **When** the outcome is recorded, **Then** it is counted for the win-rate measure and does **not** appear as a fault.
3. **Given** an offer was skipped by the rules, **When** the outcome is recorded, **Then** the record names the specific reason (ineligible, outside the schedule, ceiling reached, deadline not reachable).
4. **Given** a reporting destination is unreachable, **When** an outcome must be recorded, **Then** the outcome is not lost and is delivered once the destination recovers.

---

### User Story 3 - See the combined workload across both portals (Priority: P3)

Because each portal enforces its own ceiling, the two ceilings can add up to more than the crew can actually do. The team needs one daily view showing the committed workload from **both** portals together, so a human can lower a ceiling before the crew is over-committed.

**Why this priority**: It is the agreed mitigation for a known and accepted side effect of separate ledgers. It is valuable but not blocking: the team can launch with conservative ceilings and add the combined view immediately after.

**Independent Test**: With work committed on both portals, confirm the daily summary presents the combined committed workload alongside each portal's own figure, and that producing this view never participates in claiming an offer.

**Acceptance Scenarios**:

1. **Given** work is committed on both portals, **When** the daily summary is produced, **Then** it shows each portal's committed workload and the combined total.
2. **Given** one portal's records are unavailable when the summary is produced — a live possibility now that the two live in separate files — **When** the summary runs, **Then** it still reports the portal it can read and states plainly that the other was unreadable, never presenting a partial total as a complete one.
3. **Given** the summary is being produced, **When** an offer arrives at the same moment, **Then** claiming the offer is unaffected by the summary's work.

---

### Edge Cases

- **Another vendor wins the offer** — the single most common non-win outcome. Must be a recorded result, never an alert, and never a reason to stop polling.
- **The claim succeeds but is never recorded** — the process dies, or the connection drops, after the portal has already committed the work to the team. The team then owns work that appears in no record, counts against no ceiling, and reaches nobody. Because claiming deliberately happens before recording (FR-003), this window cannot be closed on the claiming path; it is closed afterwards by reconciling against the portal (FR-016a).
- **The claim request fails without an answer** — the same unknown state seen from the other side: the request may or may not have landed. The system MUST NOT retry it blindly, since a second claim of work already won is the same irreversible commitment twice; reconciliation settles it.
- **The offer disappears between being seen and being claimed** — indistinguishable from a lost race from the outside; must be recorded as an unwon offer, not a fault.
- **The session expires in the middle of a competitive window** — losing a race because the system had to stop and re-authenticate is a real cost; the session must be renewed before it lapses rather than after a rejection.
- **The request budget nears exhaustion** — the system must slow itself using the budget the portal reports back, and must never be the reason the account is throttled or suspended.
- **The offer's shape is not what was expected** (a field missing, a list arriving in a different form) — the interface is reverse-engineered and carries no vendor guarantee, so the system must stop and say so loudly rather than guess. Reading an unexpected response as "no offers" is the specific failure to prevent.
- **The portal is unreachable, slow, or returns a fault** — a failed read must never be interpreted as "there are no offers", because that would silently erase the record of offers already seen.
- **The deadline falls on a weekend, a Thai public holiday, or in a year whose holiday calendar has not been curated** — same governance as XTM; an uncurated year must block claiming rather than permit it.
- **Both portals' ceilings are individually respected but jointly excessive** — accepted by design; surfaced by User Story 3, not prevented by the system.
- **The Straker side dies, cannot authenticate, or is rate-limited** — the XTM bot must be entirely unaffected, and vice versa, **and the stoppage must be noticed on its own** rather than hidden by the surviving bot's healthy signal.
- **Both bots run on the same office machine** — they must not contend for the same single-instance lock, the same stored state, or the same restart procedure.
- **An offer is larger than the entire daily ceiling** — must be reported for a human decision and recorded with a reason distinguishing it from an ordinary ceiling skip, so it cannot recur silently forever.
- **The account is suspended or blocked mid-run** — distinct from an expired session, which self-heals. The system must alert immediately, stop attempting to claim, and never treat the rejection as a transient fault to retry around.
- **The capture probe and the bot run at the same time against the same account** — during the changeover they would share one request budget and produce two views of the same offers. The probe must be stopped before the bot starts; they must never run together.
- **Clock and time-zone drift** — a deadline the portal expresses in one zone must never be read in the host’s local zone, and all working-day and holiday reasoning must go through the same canonical calendar the existing bot uses. A deadline misread by hours would pass or fail the feasibility rule for entirely the wrong reason.

---

## Requirements *(mandatory)*

### Functional Requirements

#### Detecting and claiming

- **FR-001**: The system MUST check Straker for open offers on a fixed rhythm that is configured **independently of the XTM bot's rhythm**, and MUST support a rhythm far faster than XTM's.
- **FR-002**: The system MUST decide whether to claim an offer using only the information present in the offer list itself; it MUST NOT make additional enquiries about an offer before attempting to claim it.
- **FR-003**: Between noticing an eligible offer and attempting to claim it, the system MUST NOT perform recording, announcing, or any other deferrable work. All such work MUST happen after the claim attempt has resolved.
- **FR-004**: The system MUST attempt to claim one offer at a time. Any notion of claiming a whole group in one action (as XTM requires) MUST NOT apply here.
- **FR-005**: The system MUST distinguish three claim outcomes — **won**, **lost to another vendor**, and **failed for another reason** — and MUST treat only the third as a fault.
- **FR-005a**: The signal meaning "another vendor took it" MUST be identified **positively and explicitly**, never inferred from a rejection merely not looking like something else. Until that signal has been confirmed against a real offer, **an unrecognised rejection is a fault**, not a lost race — the conservative direction, since mislabelling a fault as a normal loss would hide a broken claim path behind an outcome that never alerts. Confirming it on the first real claim is a release precondition.
- **FR-006**: The system MUST NOT raise an operational alert when an offer is lost to another vendor, and MUST NOT let that outcome interrupt the polling rhythm.
- **FR-007**: The system MUST NOT decline offers on the portal. Unwanted offers are left to expire.
- **FR-007a**: Reaching the daily ceiling MUST NOT stop the system reading. It continues to read and record, skipping with the ceiling reason, because stopping would corrupt the win-rate denominator (FR-017), blind the team to what it is turning away, and suspend reconciliation.
- **FR-007b**: When several offers arrive in one read and the ceiling cannot accommodate all of them, they MUST be evaluated in **the order the portal returned them**, stopping when the budget is exhausted. Chosen for determinism and speed rather than for value ordering — sorting would add work to the race path for a case that is rare at 2-3 offers a day. Revisit if multi-offer reads become common.

#### Governing what gets claimed

- **FR-008**: The system MUST apply the team's existing scheduling rules — working hours, working days, Thai public holidays, deadline reachability at the team's throughput, and a daily workload ceiling — before claiming any offer.
- **FR-009**: The system MUST enforce a daily ceiling and throughput figure **belonging to Straker alone**, never shared with, and never read from, the XTM bot's figures. Effort MUST be measured as the **raw word count** of the offer, matching the unit the XTM bot currently runs on, so the combined view in User Story 3 adds like for like. *(The ceiling's numeric value remains deferred — see Open Questions.)*
- **FR-010**: The system MUST record, for every offer it declines to claim, a human-readable reason naming which rule blocked it.
- **FR-011**: The system MUST treat an offer as eligible when its language direction is **any of the 44 directions the account is registered for**, identified by the portal's own language identifiers rather than by displayed language names. This is a deliberate departure from the XTM bot, which is restricted to Malay; the two portals do **not** share an eligibility rule.
- **FR-011a**: Because eligibility now spans many languages, the system MUST record the language direction of every offer it claims, so that a direction the crew cannot in practice deliver becomes visible in the record rather than discovered at delivery time.
- **FR-012**: When the deadline year's holiday calendar has not been curated, the system MUST refuse to claim and MUST make the refusal visible, rather than assuming the year has no holidays.
- **FR-013**: The system MUST never claim an offer that the scheduling rules rejected, under any circumstance, including retries after a failure.
- **FR-013a**: The new decision and state logic MUST fall inside the **same automated coverage gate** that governs the existing bot’s equivalent logic. The existing gate names its directories explicitly, so new code is exempt by default unless the gate is extended — and a gate reporting green while not covering the code it governs is worse than no gate at all.

#### Recording and announcing

- **FR-014**: The system MUST record every offer it sees, with its outcome and reason, deduplicated by **offer identity together with event type** — the same offer legitimately produces more than one event, so identity alone would collapse a sighting, a claim and a recovery into one row — in a tracking record **of its own** — a separate file from the XTM record, not a section within it.
- **FR-015**: The system MUST announce claimed offers to an announcement channel **of its own**, separate from the channel carrying XTM work, and every announcement MUST **name the portal in its heading** — a test a reviewer can apply, unlike a judgement about visual distinctiveness. This separation applies to job news only; operational alerts stay unified under FR-026b. **This asymmetry is deliberate and MUST NOT be "made consistent" in either direction**: people choose which work feeds to follow, so job news divides by portal; on-call watches one place for failures, and an alert delivered somewhere nobody watches is the same as no alert.
- **FR-016**: Recording and announcing MUST be durable: an outcome MUST NOT be lost if a destination is temporarily unavailable.
- **FR-016a**: The system MUST compare the work the portal says is assigned to the team against its own record **on start, and at least every 15 minutes while running**, adding anything the portal knows about that the record is missing — counting it against the daily ceiling and announcing it. Fifteen minutes bounds the window in which the team can unknowingly owe work to well inside a working day, at a cost of four reads an hour against a budget of three hundred a minute.
- **FR-016c**: A reconciliation that **itself fails** MUST be retried on its next scheduled pass rather than abandoned, and **three consecutive failures MUST raise an alert**. Its own 15-minute cadence governs it — the exponential backoff of FR-019b does **not** apply here, because a retry that is already a quarter of an hour away cannot meaningfully be slowed down, and layering the two would leave two implementers each able to cite a requirement for a different answer. A reconciliation that has silently stopped looks exactly like one that keeps finding nothing, which is the state this requirement exists to prevent.
- **FR-016d**: Work found by reconciliation MUST be recorded and counted **even when it pushes the day past its ceiling**. The work is already committed on the portal, so this is reporting reality, not making a decision. Exceeding the ceiling this way MUST raise a warning, and the ceiling then blocks further claims for that day as normal.
- **FR-016b**: Any offer added by that comparison MUST be marked as recovered rather than as a normal claim, so that a recurring gap between the two is visible instead of being smoothed over.
- **FR-017**: The system MUST measure and report a **win rate**, defined exactly as **offers won divided by offers that were genuinely winnable**, where winnable means the language direction was eligible **and** the scheduling gate would have permitted the claim. Offers the team’s own rules turned away are excluded from the denominator, because counting them would make the bot look slow when it was in fact obedient.
- **FR-017a**: The system MUST separately report **offers turned away by our own rules**, so a low intake can be traced to the right cause — losing races, or declining to compete. Reporting only one of the two numbers makes the other invisible.
- **FR-018**: The daily summary MUST present the committed workload of **both** portals, each separately and combined, together with **retries performed and uptime** for the period (named by the constitution's observability principle, and the two figures that reveal a bot limping rather than failing), and MUST produce this view without participating in any claim decision. Because the two records now live in separate files, the summary MUST read both and MUST state plainly when either is unreadable rather than presenting a partial total as if it were whole. The combined total MUST be shown only while **both portals measure effort in the same unit**; if either ever switches, the total MUST be suppressed or labelled rather than adding unlike quantities.

#### Behaving safely against the portal

- **FR-019**: The system MUST observe the request budget the portal reports on each response and respond in **defined steps** rather than merely slowing down: while the reported remainder is **below 120** it MUST suspend deferrable work — reconciliation and any enrichment — and continue only reading and claiming; while the remainder is **below 60** it MUST pause reading until the budget resets. A hard per-minute limit MUST hold even when the reported budget is missing or nonsensical.
- **FR-019b**: A transient failure on the **offer-list read** — the fast path whose rhythm is measured in seconds — the portal unreachable, slow, or returning a server fault — MUST be retried with **exponential backoff plus jitter, up to a defined cap**, after which the failure MUST raise an alert rather than being retried forever. It governs the offer-list read only; the reconciliation read is governed by its own schedule (FR-016c). Retrying a failing portal at the normal rhythm would mean hammering a system that is already in trouble, which is exactly how an account earns a block; and the budget headers cannot be relied on to restrain it, because a portal that is failing may not send them at all.
- **FR-019c**: The backoff in FR-019b applies to **reading only**. The claim path is explicitly excluded: a claim whose outcome is unknown is never retried at all, at any interval (FR-005/R7), because the risk there is a duplicate irreversible commitment rather than a wasted request.
- **FR-019a**: Alerts MUST be de-duplicated **once per offer identity per outcome**, so a condition recurring on the same offer does not page repeatedly, while the same condition on a different offer still does.
- **FR-020**: The system MUST keep its connection to the portal warm between checks rather than establishing a new one each time.
- **FR-021**: The system MUST renew its session **before** it lapses, rather than waiting for the portal to reject a request.
- **FR-022**: The system MUST determine which vendor account it is acting for by asking the portal after each sign-in, and MUST NOT rely on a stored identifier.
- **FR-023**: When a response does not match the expected shape, the system MUST stop and report loudly rather than interpret it. In particular, an unreadable or failed response MUST NEVER be treated as "no offers available".
- **FR-023a**: If an offer arrives without the effort or the deadline the scheduling rules need, the system MUST skip it with the matching reason **and raise an alert**. This is not an ordinary skip: it means the recorded-as-unverified assumption that the list carries everything the decision needs has failed, and every later decision rests on it.

#### Isolation from the live XTM bot

- **FR-024**: The Straker side MUST run as a separate process with its own stored state, its own single-instance lock, and its own configuration. No behaviour of the XTM bot may change.
- **FR-025**: A failure, outage, suspension, or restart on either side MUST have no effect on the other.
- **FR-026**: The deployment procedure MUST be able to release or restart either side without restarting the other.
- **FR-026a**: The Straker side MUST emit its **own** liveness signal, monitored independently of the XTM side, so that either bot stopping is noticed on its own rather than being masked by the other still running.
- **FR-026b**: Alerts arising from either side MUST be delivered to the **single existing operations channel**, and MUST name which portal they came from. Splitting alerts across destinations is explicitly rejected: on-call watches one place, and an alert delivered somewhere nobody watches is the same as no alert.

#### Design constraints carried from ADR-001

*Binding; these exist so a shared abstraction can be introduced later as mechanical work rather than a redesign.*

- **FR-027 (DC-1)**: Portal-specific vocabulary MUST be translated into the team's own domain language at the edge of the portal-facing component. Portal-specific result codes MUST NOT appear anywhere in the decision or orchestration logic.
- **FR-028 (DC-2)**: Both portals MUST use the same names, with the same meanings, for the shared concepts — an offer sighting, a claim outcome, a unit of effort, a gate decision — even though no shared interface exists yet.
- **FR-029 (DC-3)**: Both portals' main loops MUST follow the same sequence of named steps, so the two can be compared side by side and real duplication becomes visible.
- **FR-030 (DC-4)**: All transport-level concerns for Straker MUST live in a single place, so that a future third portal of the same family starts by copying one file. **Transport-level** means everything between the decision and the wire: the connection and its reuse, the session cookie, the request headers, the budget accounting and pacing, and the retry-with-backoff of FR-019b. Pure policy — what the thresholds are — may live in configuration, but nothing that issues or paces a request may live outside that file.
- **FR-031 (ADR-001)**: This feature MUST NOT introduce a portal abstraction, plug-in registry, or shared portal interface. Delivering `docs/add-a-portal.md` — a working checklist for adding the next portal — takes its place.
- **FR-032 (ADR-002)**: The program is named **JobCatch**; naming introduced by this feature MUST follow it.

### Key Entities

- **Offer**: A unit of work Straker is offering to vendors. Expected arrival is **2-3 per day at most, irregular, sometimes none**. Low volume rules out *throughput* engineering — batching, parallel handling, bulk anything — but it does **not** weaken the case for speed. The opposite: with only a couple of offers a day, every one lost is a large share of everything this portal will ever give the team, and a bot that loses them all makes the portal worth nothing at all. Scarcity raises the value of winning each race; it does not lower it. Carries its own identity, the language direction, a size measure, a deadline, a budget, and a listing category. Its full shape is deliberately **not fixed by this specification** — see SC-000.
- **Offer sighting**: One continuous period during which a given offer was visible. An offer that disappears and returns is a **new** sighting of the same offer; distinct-offer counts are taken over offer identities, not sightings.
- **Claim outcome**: The result of attempting to claim an offer — won, lost to another vendor, or failed — together with the time taken.
- **Skip reason**: Why an eligible-looking offer was not claimed: ineligible, outside the schedule, ceiling reached, deadline unreachable, or calendar uncurated.
- **Portal ledger**: Per-portal committed workload against a per-portal daily ceiling. There is **one ledger per portal and no shared ledger**; the combined view is produced by reading both at reporting time only.

---

## Success Criteria *(mandatory)*

Numbering follows the brief, which is authoritative over the functional requirements when the two are measured against each other.

### Gating criterion

- **SC-000** *(blocks `/speckit-plan`)*: The capture probe MUST have delivered real offer payloads as fixtures plus measured offer lifetimes **before** planning fixes the data model. Planning MUST NOT commit to the shape of an offer, nor to a polling rhythm, on assumption.
  - **Exit is reached at whichever comes first**: **10 distinct offers** captured, **or 14 days elapsed** since the probe started.
  - Distinct counts by offer identity, never by sighting — one offer appearing ten times is one offer.
  - **If exit is reached on time rather than on count**, the smaller sample MUST be recorded as an explicit limitation wherever it is used, and the conservative defaults below apply.
  - **Who decides it is satisfied**: whoever unblocks planning records the decision, with the date, the sample size and the measured shortest lifetime, in the feature's Clarifications log. The decision is a written artefact, not a judgement someone remembers making.
  - **Exactly what SC-000 blocks**, so a blocked decision can be told from an allowed one without re-deriving the boundary: (a) the portal-native shape of an offer and any code naming its fields; (b) the polling rhythm; (c) whether SC-001/SC-002 stand; (d) the numeric daily ceiling. **Everything else is unblocked** — isolation, reporting, reconciliation, the scheduling-gate wiring, the liveness signal and the combined daily view all rest on no assumption about what an offer looks like.

### Conditional criteria — *in force only if Phase 0 shows offers are short-lived*

> The **only** ground for striking these is offer lifetime — whether a race exists at all. Offer *volume* is not a valid reason: few offers make each race matter more, not less.
>
> **The strike rule, stated so it can be computed rather than argued:**
>
> Strike SC-001 and SC-002 **only if the shortest sighting lifetime in the whole sample is 120 seconds or more.**
>
> - The question the rule answers is "would the slow alternative have seen this offer?" A 60-second rhythm needs an offer to outlive one full interval plus margin; 120 seconds is that interval doubled, which also absorbs the measurement's own error — a lifetime measured by polling is a lower bound, uncertain by one poll interval.
> - The **shortest** lifetime is used, not the median, for two reasons: at a sample of ten a median is a weak statistic, and missing even one offer a day is a large share of a 2-3 offer day.
> - **If the sample is smaller than 10** (exit reached on the 14-day branch), the criteria are **kept, not struck.** A handful of long-lived offers cannot demonstrate that no short-lived ones exist, and the conservative direction is to build for the race.
>
> When struck, the polling rhythm relaxes to 30–60 seconds and the work behind FR-003, FR-020 and FR-021 is dropped as unnecessary. The decision is made on the measurement, not on judgement.

- **SC-001** *(conditional)*: For 95% of won offers, the elapsed time **from the arrival of the response that first carried the offer, to the dispatch of the claim**, is **400 ms or less**. Both instants are observed and logged by the bot itself.
  - This measures the bot's own reaction — decide, then dispatch — and deliberately **excludes** the time the offer sat unseen between two reads, which is governed separately by SC-002. The two together bound the end-to-end delay; neither alone does.
  - The alternative origin — when the portal *published* the offer — is rejected because the bot cannot observe it, which would make the criterion unmeasurable rather than merely hard.
- **SC-002** *(conditional)*: For 95% of consecutive successful checks, the gap between them is no more than **1.3×** the configured rhythm. The factor allows ordinary scheduling jitter and one slow response to pass, while still catching a **skipped cycle**, which would show as roughly 2×. A tighter factor would fail on noise; a looser one would stop distinguishing a missed cycle from a late one.

### Unconditional criteria

- **SC-003**: The system never exceeds **300 requests per minute**, and the portal-reported remaining budget never falls below **60**.
- **SC-004**: Win rate is measured and reported continuously. A target is set only **after two weeks** of baseline measurement, not before. At the stated arrival rate of 2-3 offers a day this baseline is roughly 30 offers, of which only the won ones inform tuning — so the two-week window is a **minimum**, and an early win rate must be read as a weak signal rather than a verdict on the polling rhythm.
- **SC-005**: **The XTM bot's behaviour is unchanged**, decided by three checks that are each yes-or-no rather than a matter of opinion:
  1. Its existing test suite stays green with its coverage gate intact.
  2. For the seven days after release, **no XTM job is skipped for a reason that did not occur in the seven days before** — a new skip reason appearing is the signal that something changed, and it does not depend on job volume, which varies naturally.
  3. Its alert and error counts do not rise above the range seen in those seven days before.
  A percentage tolerance on job counts was rejected: at a handful of jobs a day, normal variation swamps any threshold small enough to be meaningful.
- **SC-005a**: The seven-day XTM baseline that SC-005 compares against MUST be **captured and stored before release**. Without it the criterion cannot be evaluated afterwards, and a criterion that can only be assessed by memory is not a criterion.
- **SC-006**: **Zero** offers are claimed that bypassed the scheduling rules or exceeded the daily ceiling, verified by audit of the stored record.
- **SC-009**: **Zero** offers assigned to the team on the portal remain absent from the team's own record for **more than 15 minutes** — one reconciliation interval (FR-016a) — verified by comparing the two. Expressed as a duration rather than as a count of passes, since a pass that never runs is not a pass that found nothing.
- **SC-007**: A lost race **never** produces an operational alert and **never** halts the loop, demonstrated by a failure-mode test.
- **SC-008**: Killing, blocking, or breaking the sign-in of the Straker side leaves the XTM side unchanged in **four named quantities**: its process uptime, its restart count, its polling cadence, and its alert count. Demonstrated by an isolation test that induces each failure in turn. "No measurable effect" is otherwise unfalsifiable.
- **SC-010**: Stopping either bot while the other keeps running raises an alert naming the stopped one **within 10 minutes**. The figure is stated here rather than by reference to another system's configuration, which could change without anyone noticing this criterion moved with it.

---

## Release Preconditions

These gate the release itself. None is technical, and none can be satisfied by the system passing its own tests — which is precisely why they are listed as gates rather than left in the assumptions where they are easy to read past.

| # | Precondition | Why it gates release |
|---|---|---|
| **RP-1** | The account password has been **rotated**. | It was shared over a chat channel, so it must be treated as exposed. |
| **RP-2** | The portal’s terms on automated claiming have been **read, and the conclusion recorded** — a named person, a date, and the finding, written into this feature’s documents. | Claiming is live from the first release with no observation period, so there is no later checkpoint at which this could be caught. The risk is the account being suspended. Absent that written record, the precondition is unmet — "someone looked at it" is not a record. |
| **RP-3** | The **seven-day XTM baseline** required by SC-005a has been captured and stored. | SC-005 is unevaluable without it. |
| **RP-4** | The **lost-race signal has been confirmed against one real offer** under supervision (FR-005a). | Until then the system cannot tell a normal loss from a broken claim path, and the outcome that never alerts is the dangerous one to get wrong. **Four things the claim path had to guess, all settled by that one supervised claim (added 2026-09-15):** (a) which rejection means a lost race — until one is confirmed, `CONFIRMED_LOST_RACE_SIGNALS` is empty and every rejection is a fault; (b) **403 is currently read as "account barred → stop claiming"**, chosen because guessing that way costs a loud halt while guessing the other way means claiming at a portal that has already barred us — but if this portal answers a lost race with 403, the bot stops at the most ordinary moment there is; (c) **any 2xx is read as won**, so if the portal reports a refusal inside a 200 body we would record a win we never had, and reconciliation could not catch it (it looks for work on the portal missing from our record, not the reverse); (d) the claim endpoint and body are modelled on the confirmed read endpoint and have never been exercised. |
| **RP-5** | The **capture probe has been stopped** before the bot starts. | They would otherwise share one request budget and produce two views of the same offers. |

---

## Assumptions

Recorded where the description left a detail open and a reasonable default exists. Anything genuinely undecidable is marked in the requirements instead.

- **Phase 0 is already running.** A read-only probe is live on the office machine, collecting offer payloads and lifetimes. It performs no claiming and is deleted when Phase 0 ends. SC-000 depends on its output.
- **Where it runs**: the existing office Windows machine, as a separate supervised process. Moving to a cloud host nearer the portal would cut round-trip time substantially but has been explicitly ruled out, so the achievable win rate is capped by that distance and this is accepted.
- **Every open offer is treated as contested** until evidence says otherwise. Some listing categories may turn out to be reserved for the team rather than competitive; until Straker confirms what each category means, the conservative reading applies. Phase 0 collects the actual category values.
- **What the two bots still share is deliberately enumerated**, because "isolated" otherwise reads as more than it is. They share: the **host machine**, the **process supervisor**, the **service-account credentials** used for the tracking files (and that account's usage quota), the **log directory**, and the **operations alert channel**. Each is accepted: the host and supervisor are a deliberate cost decision, the alert channel is a deliberate design choice (FR-026b), and the credentials and quota are shared because splitting them buys little against the chance of exhausting a quota at 2-3 offers a day. What is **not** shared is everything that carries state or decisions: store, ledger, configuration, lock, process, tracking file and announcement channel.
- **Reporting is fully separated per portal** (decided 2026-09-11): Straker gets its own tracking file and its own announcement channel, so neither portal's record or chat traffic can muddle the other's. The cost is that the combined daily view (User Story 3) must gather from two files instead of two tabs, which makes "one source was unreadable" a case the summary has to state rather than hide.
- **Until Q5 is decided, the single throughput figure MUST be set to the slowest direction the crew plausibly handles, not to an average.** With one figure covering 44 language directions it will be wrong for most of them; being wrong in the optimistic direction means promising deadlines the crew cannot meet, which is the failure that reaches the client. Being wrong pessimistically only declines work.
- **Scheduling rules are reused unchanged** — working hours, working days, the hand-curated Thai holiday calendar including substitute days but excluding ad-hoc government bridge days, and deadline reachability. Only the ceiling and throughput **figures** are Straker's own.
- **Offers are not declined**; unwanted ones expire on their own.
- **An exclusion list exists as the lever for the risk above** — a configured list of language directions the bot will not claim, **defaulting to empty** so the agreed behaviour is unchanged. It is the cheap mitigation for a risk that is otherwise carried entirely by noticing after the fact: if a direction turns out to be unstaffable, the team changes a setting rather than waiting for a code change.
- **Eligibility spanning all 44 registered directions assumes the crew can actually deliver them.** The registration list is what the account is signed up for, not proof of available capacity in each language. Claiming is irreversible, so a direction the crew cannot staff becomes a commitment the team must honour. FR-011a exists to make the claimed language mix visible early; narrowing the list later is a configuration change, not a redesign.
- **The interface is reverse-engineered.** The portal publishes no contract, so any shape change is treated as a fault to be reported, never absorbed.
- **The account is in good standing** — earlier concerns about profile completeness and account status were checked on 2026-09-11 and do not block receiving offers.
- **Test-first development applies** to the decision, state, reporting and scheduling logic, with the existing coverage gate, per the project constitution.
- **The account password was shared over chat and must be rotated before release.** Tracked as a release precondition, not a requirement of the system.
- **Straker sends at most 2-3 offers a day, irregularly, and some days none** (stated by the team 2026-09-11). This figure sizes almost everything else in this specification and should be re-checked against Phase 0's measurement rather than trusted indefinitely.
- **Automatic claiming is live from the first release** — there is no observe-only period, decided 2026-09-11. At 2-3 offers a day the absence of an observation window is a small exposure rather than a large one: a mistake in the eligibility or scheduling rules can commit the team to only a couple of jobs before it is noticed, and every claim is announced, so a human sees each one the day it happens. The daily ceiling is therefore a backstop rather than the primary safety net — at this volume it will rarely bind at all.
- **The portal's terms on automation have not yet been read.** Because claiming is live from release, reading and clearing them is a precondition of **release itself**, not of a later switch-on. The risk is commercial — account suspension — not technical.

---

## Open Questions

These block `/speckit-clarify`, not this specification.

### Resolved 2026-09-11

- **Q1 — which offers the team will take: ALL 44 registered language directions.** Not Malay-only as on XTM. The two portals now carry different eligibility rules on purpose. Captured in FR-011, with FR-011a added so the claimed language mix stays visible.
- **Q2 — effort is measured in raw word count**, the same unit the XTM bot currently runs on, so the combined daily view adds like for like. Captured in FR-009.

### Still open

- **Q3 — What does each listing category mean?** **Owner: the team, to raise with Straker.** If it is still unanswered at release, the conservative default — every open offer is treated as contested — stands permanently, and is revisited only if evidence appears that some category is not contested. An unanswered question with a stated default and an owner is a decision; one without them is a hole. Whether a category implies the offer is reserved for the team rather than contested changes whether racing is needed for it at all. Phase 0 collects the values; **Straker must supply the meanings** — this one cannot be answered internally. Until then the conservative reading stands: every open offer is treated as contested.
- **Q4 — What numeric daily ceiling should Straker carry?** Deliberately deferred to Phase 0, which will show how many offers arrive per day and how large they are. Until then a conservative ceiling is set and raised on evidence. This does not block `/speckit-plan`; it blocks release configuration.
- **Q5 — Is one throughput figure adequate across 44 language directions?** Raised by the answer to Q1: the scheduling gate decides "can the crew finish this before the deadline" from a single words-per-hour figure, which was fair when every job was Malay. Across many directions the real rate almost certainly differs per language, so a single figure will be optimistic for some and pessimistic for others. Deciding whether one figure is good enough — or whether the gate needs a per-direction rate — is a team decision informed by Phase 0's language mix.
