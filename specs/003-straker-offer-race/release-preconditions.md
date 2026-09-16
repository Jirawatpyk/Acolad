# Release preconditions RP-1 … RP-5 (T071)

The five things `quickstart.md` requires before `jobcatch-straker` is started for real.
**This file is the record.** RP-2 says it in its own text and it applies to all five: a
named person, a date, a finding. "Someone looked at it" is not a record.

| | Precondition | Status |
|---|---|---|
| RP-1 | Account password rotated | ⬜ **owner** |
| RP-2 | Portal terms on automated claiming read, conclusion written down | ⬜ **owner** |
| RP-3 | Seven-day XTM baseline captured (SC-005a) | ✅ **done 2026-09-16** |
| RP-4 | Lost-race signal confirmed against one real offer, under supervision | ⬜ **owner — gates four guesses** |
| RP-5 | Capture probe stopped before the bot starts | ✅ **done 2026-09-16** |

---

## RP-1 — rotate the password ⬜

The account password was shared over chat and is to be treated as compromised.

Two reasons it is more than hygiene here. The bot signs in on **every** cycle and the
portal's lockout policy is unknown, so a stale credential is a credential being offered
repeatedly. And `state/storageState.json` holds session cookies at the same sensitivity as
the password itself — rotating one without the other leaves a live door open.

**To close**: rotate on the portal, update `STRAKER_PASSWORD` in `.env` (gitignored, in the
pino redaction list), and delete `state/storageState.json` so the next sign-in is clean.
Record who and when below.

> Rotated by: ______________  Date: ____________

---

## RP-2 — read the terms, and write down the conclusion ⬜

**This one cannot be delegated to the bot, and the reason is the point of the precondition.**
The finding is a judgement about what the team is permitted to do, and it needs a name
against it. A summary produced by an agent would be exactly the "someone looked at it" this
requirement was written to prevent.

What the record should answer, because these are what the design has assumed:

1. Does the portal's agreement permit **automated** claiming at all?
2. Does it bound the **rate**? The bot polls every 10 s (≈6 requests/minute) against a
   published budget of 300/minute, and the plan's Complexity Tracking already records that
   rhythm as a deliberate deviation from "human-plausible rates".
3. Does it say anything about **claiming work the account cannot deliver**? The scheduling
   gate exists so the bot only claims what the crew can finish, which is the good-faith
   reading — worth confirming it is also the required one.

> Read by: ______________  Date: ____________
> Finding: ______________________________________________

---

## RP-3 — seven-day XTM baseline ✅

**Captured 2026-09-16**, stored at [`xtm-baseline.md`](./xtm-baseline.md), by read-only
queries against `state/acolad.db` and `logs/acolad.2026-09-*.log`.

It did not say what it was expected to say. **The XTM bot has seen no jobs since
2026-07-15** — ~1,500 cycles a day, every one `ok`, every one zero. The evidence says it is
reading correctly rather than failing silently (unchanged latency across the cliff,
`layout_changed` still alerting and recovering, and the teammate `xtm_yielding` events
stopping within the hour of the last job — a broken reader would still see teammate
sessions).

**Consequence for SC-005, recorded rather than glossed**: check 2 compares against an empty
skip-reason set, so it discriminates nothing in either direction and is marked
armed-but-not-yet-meaningful. Checks 1 and 3 are usable; the range for check 3 is in the
baseline.

---

## RP-4 — confirm the lost-race signal on one real offer ⬜

**The most consequential of the five.** It is the gate on four things the claim path has
never been able to verify, because no claim has ever been made against this portal:

| Guess | Where | What RP-4 settles |
|---|---|---|
| The claim endpoint's **path and body** | `claim.ts` — `claimRequestPath`, `CLAIM_REQUEST_BODY` | Reasoned by analogy with the one confirmed offer-addressing endpoint. Contract §4 is marked NOT YET EXERCISED. |
| The **lost-race signal** | `claimOutcome.ts` — `CONFIRMED_LOST_RACE_SIGNALS` is **deliberately empty** | Until it is filled, *every* rejection classifies as `failed` and alerts. That is the safe direction (FR-005a) and it is also noisy. |
| Whether `due_at` is **Bangkok or New Zealand** | `offerParse.ts` — `STRAKER_DEADLINE_ZONE` | An assigned job shows its deadline in the portal UI. If it is NZ, every deadline is being read five hours late and the bot accepts work it cannot finish. |
| Whether `words` is really the **effort** field | `offerParse.ts` assumption 2 | Confirmed on one independent offer and contradicted by a cent on the other. Effort is what the whole ceiling rests on. |

**How to close it.** Watch a real offer arrive and let the bot claim it, with someone
present. Then, from `state/straker/straker.db` and `logs/jobcatch-straker.*.log`:

- If the claim **won** — open the assigned job in the portal and compare its deadline and its
  word count against the recorded `deadlineMs` and `effortWords`. That settles the zone and
  the effort field in one look.
- If the claim **lost** — the rejection is what RP-4 is named for. `claim.ts` records the
  status and a body excerpt in the event's detail. Read the signal it carried, and if it is a
  genuine lost race rather than a fault, add that value to `CONFIRMED_LOST_RACE_SIGNALS`.
  **That single edit is the whole change** — the list is a constant precisely so this is one
  line, and its test asserts the list is empty until then.

Until this is done the bot is safe but loud: a lost race — the commonest non-win outcome —
pages someone every time.

> Confirmed by: ______________  Date: ____________
> Outcome observed: ⬜ won ⬜ lost · Signal: ______________ · Zone: ⬜ Bangkok ⬜ NZ

---

## RP-5 — stop the capture probe ✅

**Why**: the two must never share the request budget. The probe polls the same account the
bot will, so with both running the pacing rules in `httpClient.ts` govern only half the
traffic and the portal's remainder falls faster than either bot can account for.

**Done (T072, 2026-09-16)** — `recon.config.cjs`, `src/straker/reconMain.ts` and the
`straker:recon` script are removed. `fixtures/straker/offers/` is **kept**: those three
payloads are the parser's test data and the suite reads them off disk.

**Done 2026-09-16**, on the owner's instruction and before RP-1, which is the order that
matters:

```
pm2 delete jobcatch-straker-recon   ✓
pm2 save                            ✓
```

`acolad-bot` was untouched — still online, four days up, zero restarts.

**Why this had to precede RP-1.** The probe signed in **outside** its loop
(`reconMain.ts`, `main().catch(...)`) with `autorestart: true, restart_delay: 5000`. A
refused sign-in therefore killed the process and PM2 restarted it five seconds later — so
rotating the password while it ran would have offered the old credential roughly **17,000
times a day** to an account whose lockout policy is unknown and whose password is being
rotated precisely because it leaked.

### The cost this incurred, now live

**Nothing is watching Straker.** The probe was the only observer, and the parser stands on
**two independent jobs** (three files, of which two are one job split across two languages).
Every offer that arrives between now and the bot's first start is evidence nobody collects —
and `offerParse.ts` is deliberately brittle about anything it has not seen, so that evidence
is the difference between a parser that is right and one that has not been contradicted yet.

That argues for keeping the gap short: RP-1, RP-2 and RP-4 done in one sitting and the bot
released, rather than the portal going unobserved for days.

**What the removal stranded**: `src/straker/captureStore.ts` and `runProbeCycle` in
`src/straker/probe.ts` now have **no production caller** — only their tests. They are the
probe's re-startable core, kept deliberately rather than deleted, because Straker's payload
shape is confirmed on two jobs and resurrecting evidence collection should be cheap. If that
stops being worth it, deleting them is the follow-up; `probe.ts` itself must stay regardless,
since `RawOffer` is used throughout the bot.

> Probe deleted: **2026-09-16**, on the owner's instruction. Password rotation (RP-1) is now safe to perform.
