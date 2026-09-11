# Research — JobCatch 003: Straker Offer Race

**Date**: 2026-09-11 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

Sources: the recon note (`docs/straker-recon-note.md`, browser-based, 2026-08-25), and — more importantly — **the capture probe running against the live portal since 2026-09-11 11:56 BKK**, which has already corrected the recon note twice.

> Reminder: this file is Spec Kit's research step. It is **not** "Phase 0" in the brief's sense. The brief's Phase 0 is the capture probe, and SC-000 refers to that.

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

**Note for the later key design**: the XTM bot needed a mid-flight fix when two projects sharing a filename collided under a composed key. Straker's identifier is opaque and server-issued, so composition is unnecessary — and should be avoided for exactly that reason.

**Alternatives considered**: A key composed from language, deadline and title. Rejected — it reintroduces the collision class that the XTM bot already paid to fix, for no gain.

---

## R9 — Polling rhythm — **BLOCKED (U2)**

**Decision**: Deferred. The rhythm will be set from the measured offer lifetime, not chosen now.

**Rationale**: SC-000 exists for this. The spec now states the decision as a computable rule rather than a judgement: strike SC-001/SC-002 **only if the shortest sighting lifetime in the sample is 120 seconds or more**, and only when the sample reached 10 offers — below that, keep them. When struck, a 30–60 second rhythm is ample and R3's pooling and R5's proactive renewal both disappear. When kept, the starting point is one second — 20% of the stated budget — tuned afterwards against measured win rate.

**Explicitly rejected reasoning**: that 2–3 offers a day makes the fast rhythm not worth building. Volume is the wrong axis. With that few offers, each one lost is a large share of everything the portal will ever give the team; scarcity raises the value of winning a race rather than lowering it. **Only measured lifetime may strike SC-001/SC-002.**

---

## R10 — Offer model — **BLOCKED (U1)**

**Decision**: Deferred to real fixtures. See [data-model.md](./data-model.md), where the blocked region is marked explicitly.

**Rationale**: The recon note's field list was read out of the front end's own code, with **zero real payloads observed** — at recon time the open list was empty, and the probe has captured none yet either. Committing the model now would mean guessing which field carries effort and which carries the deadline, and those two feed the gate directly (R6). A wrong guess is not a cosmetic error: it would mis-measure every capacity and feasibility decision the bot makes.

**Alternatives considered**: Modelling from the front-end code and correcting later. Rejected — it is precisely what SC-000 forbids, and the recon note has already been wrong twice about this portal (R2, and the assumption about connection warmth in R3).

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

| # | Item | Who closes it |
|---|---|---|
| U1 | Real offer payload shape | The capture probe |
| U2 | Offer lifetime | The capture probe |
| U3 | Meaning of each listing category | **Straker** — not answerable internally |
| U4 | Numeric daily ceiling | The team, once the probe shows volume and size |
| U5 | Whether one throughput figure is honest across 44 directions | The team, once the probe shows the language mix |
| — | Whether the portal's terms permit automated claiming | **A human must read them — this is a release blocker** |
| — | Rotating the account password shared over chat | **Release blocker** |
