# Quickstart & Acceptance — JobCatch 003: Straker Offer Race

**Date**: 2026-09-11 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

How to run this feature and how to prove it works. The **V-table is the acceptance gate** — the same convention feature 002 uses, where success criteria outrank functional requirements when the two are measured against each other.

---

## Prerequisites

```powershell
npm install
Copy-Item .env.example .env      # then fill the STRAKER_* values
```

Required before anything runs:

| | |
|---|---|
| Straker credentials | `STRAKER_BASE_URL`, `STRAKER_LOGIN_ID`, `STRAKER_PASSWORD` in `.env` (never committed) |
| Straker's own limits | its **own** daily ceiling and throughput — never the XTM bot's values |
| Own state directory | separate from the XTM bot's; a separate database file |
| Own single-instance port | **47812** (the XTM bot holds 47811) |
| Own tracking file + announcement channel | separate from the XTM bot's; alerts go to the existing shared operations channel |
| Own liveness signal | monitored independently of the XTM bot's |

### Release preconditions — full statement in spec §Release Preconditions

- [ ] **RP-1** Account password rotated (it was shared over chat).
- [ ] **RP-2** Portal terms on automated claiming read, **and the conclusion written down** — a named person, a date, a finding. "Someone looked at it" is not a record.
- [ ] **RP-3** Seven-day XTM baseline captured and stored (SC-005a) — SC-005 cannot be evaluated without it.
- [ ] **RP-4** Lost-race signal confirmed against one real offer, under supervision (FR-005a).
- [ ] **RP-5** Capture probe stopped before the bot starts — they must never share the request budget.

---

## Running

```powershell
npm run lint ; npm run typecheck ; npm test      # must all be clean before anything else

npm run straker:recon      # the capture probe — READ ONLY, already running in production
npm run straker:once       # one cycle, then exit (smoke test)
pm2 start recon.config.cjs # the probe under supervision
```

The XTM bot is released and restarted exactly as before. **Releasing or restarting either bot must never touch the other** — that is itself an acceptance item (V12).

---

## Acceptance table

Legend: **A** = buildable now · **B** = waits for the capture probe · **P** = the probe itself

| # | What is checked | Track | Proves | How |
|---|---|---|---|---|
| **V1** | An eligible offer, inside the schedule and within the ceiling, ends up claimed, recorded and announced with no human involved | B | US1, FR-001..005 | Integration test with a stub portal; then one supervised real offer |
| **V2** | Another vendor claiming first is recorded as a lost race — **no alert, loop continues** | A | SC-007, FR-006 | Failure-mode test; stub returns the lost-race signal |
| **V3** | An offer outside the eligibility rules is never claimed, and the skip reason is recorded | B | FR-010/011 | Unit + integration |
| **V4** | An offer that would exceed the ceiling, or cannot be finished in working time, is refused with a readable reason | A | FR-008/009/010 | Gate is reused unchanged; test the wiring and the Straker-owned ceiling |
| **V5** | A deadline in a year with no curated holiday calendar **refuses** rather than assuming no holidays | A | FR-012 | Existing gate behaviour; assert it reaches the Straker path |
| **V6** | **A failed read never marks live offers as vanished** | A | FR-023, contract rule | Stub returns a fault mid-run; assert the tracker state is unchanged and no lifetime was recorded |
| **V7** | A reply that stops being the expected shape fails loud instead of reading as zero offers | A | FR-023 | Stub returns an envelope where a bare list is expected |
| **V8** | An expired session is renewed and the run continues; a server fault is **not** retried | A | FR-021, constitution VI | Already covered by the probe's failure-mode tests; extend to the claim path |
| **V9** | A claim whose outcome is unknown is **never retried**; reconciliation repairs the record and marks it recovered | A | FR-016a/b, SC-009, R7 | Kill the process between claim and record; restart; assert the record converges and the row is marked recovered |
| **V10** | Every offer seen produces a row — won, lost and skipped alike | A | US2, FR-014, SC-004 | Run a mixed scenario; reconcile the row count against offers seen |
| **V11** | A reporting destination being down loses no outcome | A | FR-016 | Stub the destination as failing, then recovering |
| **V12** | **Releasing or restarting either bot leaves the other untouched** | A | SC-008, FR-024/026 | Restart each in turn; assert the other's uptime and restart count are unchanged |
| **V13** | Killing the Straker side raises an alert **naming it**, while the XTM side keeps running | A | SC-010, FR-026a/b | Stop the Straker process; confirm the alert names the portal |
| **V14** | **The XTM bot's behaviour is unchanged** | A | **SC-005** | Full suite green with the coverage gate intact; compare XTM detect/accept figures for 7 days before and after release |
| **V15** | Never exceeds 300 requests/minute; the reported remainder never falls below 60 | A | SC-003 | Count requests over a sustained run; assert against the logged budget headers |
| **V16** | Zero claims bypassed the schedule gate or the ceiling | A | SC-006 | Audit the stored record against the gate's decisions |
| **V17** | The daily summary shows both portals separately and combined, and says so plainly when one record is unreadable | A | FR-018, US3 | Make one record unreadable; assert the summary reports the readable one and states the gap |
| **V18** | The coverage gate actually covers the new decision and state logic | A | Constitution II, R12 | `npm run test:coverage` — assert the Straker modules appear in the report |
| **V23** | Reaching the ceiling does not stop reading; skips are still recorded and reconciliation still runs | A | FR-007a | Drive the ledger to its ceiling in a stub run; assert reads continue and rows keep appearing |
| **V24** | Reconciliation failing three times running raises an alert | A | FR-016c | Stub the assigned-work read as failing |
| **V25** | Recovered work is counted even when it pushes the day past its ceiling, and warns | A | FR-016d | Seed a near-full day, then recover an offer into it |
| **V26** | An offer missing the effort or the deadline is skipped **and alerts** | A | FR-023a | Stub an offer with the field absent |
| **V27** | An account-blocked rejection alerts immediately and stops claiming, without a sign-in retry loop | A | Edge case, Contract §4a | Stub the blocked rejection |
| **V28** | Alerts de-duplicate once per offer identity per outcome | A | FR-019a | Repeat the same condition on one offer, then on a second |
| **V29** | Below 120 remaining budget deferrable work stops; below 60 reading pauses | A | FR-019 | Drive the stubbed budget headers down through both thresholds |
| **V19** | **Probe exit reached: 10 distinct offers captured, or 14 days elapsed — whichever first — with lifetimes measured** | **P** | **SC-000 — gates the rest** | `fixtures/straker/offers/` and the probe's event log. A sample under 10 is recorded as an explicit limitation. |
| **V20** | Detect→claim ≤ 400 ms at p95 | B *(conditional)* | SC-001 | Only if V19 shows offers are short-lived; otherwise **struck** |
| **V21** | Gap between consecutive successful checks ≤ 1.3× the configured rhythm | B *(conditional)* | SC-002 | As V20 |
| **V22** | Win rate measured and reported from the first day | A | SC-004 | A target is set only after a baseline; at 2–3 offers a day an early figure is a weak signal |

**V19 gates V1, V3, V20 and V21.** Everything marked A can be built and accepted before a single offer is captured.

---

## The one decision the probe makes for you

When V19 completes, apply the rule exactly as the spec states it. It is computable, not a judgement call:

| Sample | Shortest sighting lifetime | Consequence |
|---|---|---|
| 10 or more offers | **≥ 120 s** | Nobody is racing. **Strike SC-001 and SC-002**, drop V20/V21, relax to a 30–60 second rhythm, and drop the pooling and proactive-renewal work entirely. |
| 10 or more offers | **< 120 s** | The race is real. Keep SC-001/SC-002 (V20/V21). Build keep-alive pooling and proactive session renewal. Start at a one-second rhythm — 20% of the stated budget — and tune against win rate. |
| **Fewer than 10** (exited on the 14-day branch) | any | **Keep** SC-001/SC-002. A few long-lived offers cannot show that no short-lived ones exist; the conservative direction is to build for the race. |

Why the **shortest** lifetime rather than the median: at a sample of ten a median is a weak statistic, and missing even one offer a day is a large share of a 2–3 offer day. Why 120 s: it is one full slow-poll interval doubled, which also absorbs the measurement's own error — a lifetime measured by polling is a lower bound, uncertain by one poll interval.

**Offer volume is never a reason to strike SC-001/SC-002.** At 2–3 offers a day each lost race is a large share of everything the portal will ever give the team. Only measured lifetime decides this.

---

## Tearing down the capture probe

When V19 is satisfied, the probe has done its job:

```powershell
pm2 delete jobcatch-straker-recon
```

Then delete `recon.config.cjs` and `src/straker/reconMain.ts`. **Keep** `fixtures/straker/offers/` — those payloads are the test data the parser is built against — and keep the probe's transport, sign-in, list reader and tracker, which the bot reuses directly.
