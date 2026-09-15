# Research — JobCatch 003: Straker Offer Race

**Date**: 2026-09-11 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

Sources: the recon note (`docs/straker-recon-note.md`, browser-based, 2026-08-25), and — more importantly — **the capture probe running against the live portal since 2026-09-11 11:56 BKK**, which has already corrected the recon note twice.

> Reminder: this file is Spec Kit's research step. It is **not** "Phase 0" in the brief's sense. The brief's Phase 0 is the capture probe, and SC-000 refers to that.

> **Update 2026-09-15**: the two items this file recorded as BLOCKED — **R9** (polling rhythm)
> and **R10** (offer model) — were both resolved on that date, when the owner decided to
> proceed on the probe's 3-offer sample rather than wait for SC-000's exit at 10 offers or 14
> days. Each entry keeps its original reasoning and carries the resolution beneath it, so the
> gate that existed, and what lifting it early costs, stay legible. The decision itself is in
> spec.md §Clarifications; the sample's limits are in data-model.md §1.

---

## R1 — Transport: HTTP client, not a browser

**Decision**: Read and claim over the portal's structured data interface directly. No Playwright, no browser, no page rendering.

**Rationale**: The portal's own front end is a single-page application that talks to a structured interface for everything. Reading it directly removes the entire class of problems the XTM bot lives with — no frames, no selector drift, no rendering races, no browser recycling, no session-collision yielding. The recon estimate was ~300–400 lines against ~1,400 for a browser port. **Confirmed in practice**: the capture probe's transport, sign-in and list reader together are about 200 lines and work against the live portal today.

**Alternatives considered**: Reusing the XTM bot's browser automation. Rejected — it would inherit every browser failure mode for no benefit, and a browser cannot poll fast enough to compete in a race.

---

## R2 — The portal requires an `Origin` header ★ new, found live

**Decision**: Send `Origin` and a matching `Referer` on every request, derived from the configured base address.

**Rationale**: The very first live run of the probe failed at sign-in with **`403 {"detail":"Invalid or missing Origin"}`**. The browser-based recon never encountered this because browsers set both headers automatically. A direct client must set them itself. This is exactly the class of fact the capture probe exists to find, and it would have surfaced as a mystifying launch failure had it been discovered during implementation instead.

**Alternatives considered**: Omitting the headers and treating the rejection as a transient fault — rejected on sight; it is a hard, deterministic rejection, not a transient one.

---

## R3 — Connection reuse is worth roughly 400 ms ★ measured, not assumed

**Decision**: Treat keep-alive connection pooling as **required if and only if** the capture probe shows offers are short-lived (U2). Build it in Track B, not speculatively.

**Rationale**: The probe logs round-trip time per cycle. Observed on the live portal from Bangkok:

| Condition | Observed |
|---|---|
| Request immediately after sign-in (connection already warm) | **~256 ms** |
| Steady-state cycles 10 seconds apart (connection not reused) | **~645–670 ms** |

The gap of roughly 400 ms matches the recon note's prediction of "+2 round trips for a fresh handshake" almost exactly. In a race decided by hundreds of milliseconds this is the single largest lever available, given that relocating the host nearer the portal has been ruled out.

**Honesty about this measurement**: it is an observation from a running probe, not a controlled experiment — a handful of samples, one network path, one time of day. It is strong enough to justify building pooling *if a race exists*, and not strong enough to quote as a performance guarantee.

**Alternatives considered**: Always building the pool regardless. Rejected — if offers turn out to live for minutes, nobody is racing and the complexity is unpaid-for. Shortening the poll interval instead of reusing connections was rejected: it spends request budget to buy back latency that a warm connection gives for free.

**Outcome 2026-09-15: not built, and the condition is why.** Offers were measured surviving
204–1,938 s before a competitor took them. Against 204 seconds of slack, 400 ms of handshake is
noise, so the "if and only if" above resolves to *not now* — T044 is deferred, `undici` is not
a dependency, and the transport uses the platform `fetch`. The measurement in the table stands;
what changed is that nothing is racing at the scale it matters on. One materially shorter
lifetime reverses this.

---

## R4 — Request budget: follow what the portal reports

**Decision**: Read the budget headers the portal returns on every response, slow down as the remainder falls, and enforce a hard ceiling independent of those headers.

**Rationale**: The portal states a budget of **300 requests per minute** and reports the remainder on each response; the probe has confirmed both are real and that the remainder decrements as expected. The XTM bot's existing limiter is built around a per-hour cap suited to browser polling and cannot express this. A limiter that both respects a hard per-minute floor **and** adapts to the reported remainder satisfies SC-003 with room to spare: the planned rhythm is 20% of the stated allowance.

**Alternatives considered**: Trusting the headers alone — rejected, because a missing or nonsensical header would remove all restraint at the worst moment. A fixed rate with no feedback — rejected, because it cannot react to the budget being consumed by retries or reconciliation.

---

## R5 — Session renewal: ahead of expiry, with exactly one reactive retry

**Decision**: Renew the session proactively before it lapses. Keep a **single** reactive re-sign-in for the rejection that means "expired", and none for any other failure.

**Rationale**: A rejection mid-race costs that race outright. The probe already implements the reactive half and its failure-mode tests cover it: one retry behind a fresh sign-in for the expiry signal, no retry for a server fault, and a hard stop after one attempt so a genuinely rejected credential cannot become a sign-in hammer. The proactive half belongs to Track B because its value depends on whether races are real (U2).

**Alternatives considered**: Reactive-only renewal — rejected for the race path, kept as the safety net beneath the proactive one. Renewing on a fixed short timer regardless — rejected as waste until the session's real lifetime is known (it still is not; the portal exposes a renewal call whose semantics are unconfirmed).

**Outcome 2026-09-15: reactive-only is what runs.** The proactive half was deferred with the
rest of T044 for the reason in R3 — at 204 s of slack a re-sign-in mid-race costs a fraction of
the window rather than the race. So the position R5 called "rejected for the race path" is, for
now, the shipped one: a single reactive re-sign-in on the expiry signal and nothing proactive.
It is a deliberate acceptance of a known cost, not an oversight; reopen it with R3 and T044
together.

---

## R6 — The scheduling gate is reusable **unchanged** ★ verified in code

**Decision**: Call the existing gate directly. Write no Straker-specific scheduling logic.

**Rationale**: Its input was inspected rather than assumed. The gate takes only primitives — current time, deadline, effort, throughput, a working calendar, and a flag for whether the calendar is curated for the span. **There is no portal-specific type anywhere in its input or output.** Everything the XTM bot fought for over five pull requests — working hours, Thai holidays including substitute days, deadline reachability, the effective-deadline-day cutoff — applies to Straker for free.

The only Straker-specific work is supplying two numbers, effort and deadline, from the offer payload — which is precisely what U1 blocks.

**Alternatives considered**: A parallel Straker gate. Rejected outright — it would duplicate the hardest-won correctness in the codebase and guarantee the two drift apart. Extracting the gate into a shared package first — deferred, see the plan's Scope decision.

---

## R7 — A claim is never retried blindly; the record is repaired afterwards

**Decision**: Attempt a claim once. If the outcome is unknown — the request failed without an answer, or the process died before recording — do **not** try again. Repair the record by reconciling against the portal's own list of work assigned to the team.

**Rationale**: A claim is an irreversible commitment to a client. Retrying one whose outcome is unknown risks making the same commitment twice, which is worse than briefly not knowing. The portal knows the truth, so asking it is both cheaper and safer than inferring. This closes the window that the spec deliberately opens by recording *after* claiming (FR-003) — the window cannot be closed on the claim path without slowing it, so it is closed behind it instead.

This is the same failure the XTM bot hit for real: a job accepted on the portal but recorded as failed, producing a false alert and a mismatch that had to be reconciled by hand.

**Alternatives considered**: Writing an "attempting" marker before claiming — rejected, it puts a durable write on the race path, directly contradicting FR-003. Accepting the gap and leaving it to a human — rejected at 2–3 offers a day the gap is small but the cost of missing one is the team silently owing work it does not know about.

---

## R8 — Offer identity and duplicate suppression

**Decision**: Use the offer's own identifier from the portal as the stable key. Model visibility as **sightings**: an offer that disappears and returns starts a new sighting of the same offer.

**Rationale**: The constitution requires a stable unique key and duplicate-free recording. The portal supplies an opaque identifier per offer, which the probe already treats as the key and guards — an entry without one is a hard failure, because an offer with no identity cannot be tracked or deduplicated.

The sighting distinction matters for more than tidiness: the capture probe's exit criterion counts **10 distinct offers** (or 14 days elapsed, whichever comes first), and without it a single offer flickering ten times would appear to satisfy the count. This mirrors the appearance-event model the XTM bot already uses.

**Note for the later key design — corrected 2026-09-15.** This note previously read the XTM
collision as an argument *against* composed keys. It is not one, and the correction matters
because the wrong reading would mislead whoever designs the fallback. What XTM actually did
(PR #22, 2026-07-01): two different projects sharing a file name collided under
`fileName|step|role`, and the fix was to **add** `projectName` — the key is composed to this
day, as `projectName|fileName|step|role`. The lesson is *"if you must compose, compose from
enough fields to be unique"*, a caution about how to build a fallback key, not a case against
building one.

**The real reason Straker does not compose is simply that it does not need to**: the portal
issues an opaque identifier per offer, so there is nothing to compose — no field selection to
get wrong, and no collision class to reason about. That is an absence of a problem, not a
principle.

**Where the XTM lesson does apply**: if `obj_id` ever proves unstable — reissued between
sightings, reused across offers, or absent on some listing type we have not seen — a composed
fallback becomes necessary, and then XTM's experience is the guide: include the fields that
actually distinguish two offers (at minimum the job reference **and** the target language;
the captured sample already contains one job split across two languages, which a job-reference
key alone would collide), and treat a shortfall as a correctness bug rather than a tidiness
one.

**Alternatives considered**: Composing a key from language, deadline and title *while an
opaque identifier exists*. Rejected — it would discard a guaranteed-unique server value in
favour of a guess, taking on the collision class XTM paid to fix for no gain whatever.

---

## R9 — Polling rhythm — **DECIDED 2026-09-15: 10 seconds** *(was BLOCKED on U2)*

**Decision as first written (2026-09-11)**: deferred. The rhythm will be set from the measured
offer lifetime, not chosen now.

**Rationale then**: SC-000 exists for this. The spec states the decision as a computable rule
rather than a judgement: strike SC-001/SC-002 **only if the shortest sighting lifetime in the
sample is 120 seconds or more**, and only when the sample reached 10 offers — below that, keep
them. When struck, a 30–60 second rhythm is ample and R3's pooling and R5's proactive renewal
both disappear. When kept, the starting point was to be one second — 20% of the stated budget
— tuned afterwards against measured win rate.

**Resolved 2026-09-15, without waiting for the probe's exit.** The owner chose to proceed on
the sample in hand: 3 captured offers (two of them one job split across two languages), on day
4.2 of the 14-day branch. Full record in spec.md §Clarifications.

- **The rhythm is 10 seconds**, not one second — and it is now the *measured* choice rather
  than the probe-era default it happens to equal. The shortest observed window between an
  offer appearing and a competitor taking it was **204 s**, so a 10 s rhythm sees an offer with
  roughly 194 s of slack. One second would buy nine of those seconds for ten times the request
  budget. `STRAKER_POLL_INTERVAL_MS` defaults to `10_000` in `src/straker/config.ts`.
- **SC-001 and SC-002 are KEPT**, because the strike rule keeps them below a sample of 10 — even
  though the measurement points the other way. That tension is stated, not resolved, in the
  spec's decision entry.
- **What stays unverified**: whether any offer ever lives less than one poll interval. A
  lifetime measured by polling is blind to exactly that, and three offers from one day cannot
  close it. A single materially shorter observation reopens this entry, R3 and T044 together.

**Explicitly rejected reasoning**: that 2–3 offers a day makes the fast rhythm not worth building. Volume is the wrong axis. With that few offers, each one lost is a large share of everything the portal will ever give the team; scarcity raises the value of winning a race rather than lowering it. **Only measured lifetime may strike SC-001/SC-002.**

---

## R10 — Offer model — **RESOLVED 2026-09-15 from three captured payloads** *(was BLOCKED on U1)*

**Decision as first written (2026-09-11)**: deferred to real fixtures. See
[data-model.md](./data-model.md), where the blocked region was marked explicitly.

**Rationale then**: The recon note's field list was read out of the front end's own code, with
**zero real payloads observed** — at recon time the open list was empty, and the probe had
captured none. Committing the model then would have meant guessing which field carries effort
and which carries the deadline, and those two feed the gate directly (R6). A wrong guess is not
a cosmetic error: it would mis-measure every capacity and feasibility decision the bot makes.

**Resolved 2026-09-15.** The probe captured three payloads (`fixtures/straker/offers/`), the
owner decided not to wait for the 10-offer exit, and `data-model.md` §1 is modelled from those
files — read off payloads, never off the recon note's field list. `offerParse.ts` and its test
are built from the same fixtures. **The deferral was lifted because its premise lapsed**: the
model is no longer being fixed *on assumption*, which is the thing SC-000 forbade.

**What the small sample costs, recorded rather than implied**:

- the shape is confirmed on **two independent jobs** (three payloads, two of them one job split
  across two languages) — anything absent from those two is unseen, not absent;
- the parser answers that by **failing loud on anything it has not seen** (FR-023) rather than
  by absorbing it, which is what makes proceeding on three payloads survivable;
- `listing_type` is `direct_po` on all three and no other value has ever been observed (U3/Q3
  remains Straker's to answer);
- `due_at` carries no timezone; it is read as Bangkok through one named constant
  (`STRAKER_DEADLINE_ZONE` in `offerParse.ts`), which is an assumption, not a finding.

**Alternatives considered**: Modelling from the front-end code and correcting later — rejected
then and never done; the model that shipped came from payloads. Waiting for the full 10 —
rejected on 2026-09-15 on the grounds above, with the thin sample recorded wherever it is used
rather than left implicit.

---

## R11 — Storage isolation

**Decision**: A separate database file in a separate state directory, a separate single-instance lock on port 47812, a separate supervised application.

**Rationale**: This is what makes the bulkhead real rather than claimed. No shared file means no lock contention, no shared schema migration, and no way for one bot's corruption to reach the other. The cost — two ceilings that can sum past the crew's real capacity — is accepted and mitigated by reporting rather than enforcement.

**Alternatives considered**: One database with a portal column. Rejected — it couples the two bots at exactly the point isolation is supposed to protect, and makes "restart one without the other" a lie.

---

## R12 — Coverage gate must be extended ★ gap found during the constitution check

**Decision**: Extend the repository's coverage gate to include the new Straker decision and state logic.

**Rationale**: The constitution requires ≥80% coverage on decision logic, state and reporting. The gate's include list names four directories and `src/straker/` is not among them, so without a change the new bot's logic would be exempt by accident — the requirement would appear satisfied while not applying to any of the new code. This is a configuration gap, not a design problem, but it would silently undermine Principle II.

**Alternatives considered**: Leaving the gate as-is and relying on discipline. Rejected — a gate that does not cover the code it is meant to govern is worse than no gate, because it reports green.

---

## Open items that research cannot close

*Status column added 2026-09-15, when the owner proceeded on a 3-offer sample rather than
waiting for SC-000's exit. "Answered thinly" is not the same as "closed" and is written that
way on purpose.*

| # | Item | Who closes it | Status 2026-09-15 |
|---|---|---|---|
| U1 | Real offer payload shape | The capture probe | **Answered on 3 payloads / 2 independent jobs** — data-model §1, `offerParse.ts`. Unseen fields and unseen listing types remain unseen; the parser fails loud rather than absorbing them |
| U2 | Offer lifetime | The capture probe | **Answered thinly**: 204 s / 587 s / 1,938 s, all ended by a competitor claiming. Rhythm set to 10 s (R9). Blind by construction to anything shorter than one poll interval |
| U3 | Meaning of each listing category | **Straker** — not answerable internally | **Open.** Only `direct_po` has ever been seen, on all three offers, and operator observation confirms those were contested — so the conservative default is validated for that one value, not for the category as a whole |
| U4 | Numeric daily ceiling | The team, once the probe shows volume and size | **Open, and deliberately un-defaulted**: `STRAKER_MAX_WORDS_PER_DAY` is a required config value, so the code refuses to invent one. Observed sizes (2, 2, 4 words) are too thin and too small to set it from |
| U5 | Whether one throughput figure is honest across 44 directions | The team, once the probe shows the language mix | **Open.** Observed directions: `en-us→th`, `en-us→ms-my`, `en-us→zh-tw` — three of forty-four |
| — | Whether the portal's terms permit automated claiming | **A human must read them — this is a release blocker** | **Open** (RP-2) |
| — | Rotating the account password shared over chat | **Release blocker** | **Open** (RP-1) |
