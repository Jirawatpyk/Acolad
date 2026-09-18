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
| ~~The claim endpoint's **path and body**~~ — **CLOSED 2026-09-18** | `claim.ts` — `claimRequestPath` | `POST …/job-offers/{obj_id}/accept`, read from the portal's web app. The guess `/claim` got a 404 on the first real claim. |
| ~~The **lost-race signal**~~ — **CLOSED 2026-09-18: HTTP 409** | `claimOutcome.ts` — `CONFIRMED_LOST_RACE_SIGNALS = ['http_409']` | The web app shows "Offer no longer available" for a 409 only. Still to observe: one **won** claim end to end. |
| ~~Whether `due_at` is **Bangkok or New Zealand**~~ — **CLOSED 2026-09-17: it is UTC** | `offerParse.ts` — `STRAKER_DEADLINE_ZONE` | Settled exactly as this row said it would be, by an assigned job's deadline in the portal UI. It was neither option offered here. See below. |
| Whether `words` is really the **effort** field | `offerParse.ts` assumption 2 | Confirmed on one independent offer and contradicted by a cent on the other. Effort is what the whole ceiling rests on. |

### The zone question closed itself, 2026-09-17 — and the answer was a third option

**`due_at` on the offer list is UTC.** Not Bangkok, not New Zealand.

It closed without anyone watching for it, because AJ-295 was recorded through *both* of the
portal's endpoints inside twenty minutes:

| Source | What it gave | Read as |
|---|---|---|
| offer list (`/job-offers?status=open`) | `2026-09-17T15:00:00`, no zone | 15:00 +07 — **wrong** |
| assigned list (`/assigned-jobs`) | the same job, with an explicit `Z` | 22:00 +07 — right |
| the portal UI | "17 Sept 2026, 22:00 GMT+7" | 22:00 +07 |

Seven hours apart, which is Bangkok's own offset — the signature of a zone-less UTC string
read as local time. The endpoint that does not require a guess is the one that agreed with
the screen.

**The error ran opposite to the one this table feared.** The row above worried about reading
deadlines *late* and accepting work the team cannot finish — loud, and it would have shown up
as a missed delivery. What actually happened was the quiet direction: every offer deadline was
read **seven hours early**, so work that fitted was refused as `deadline_unreachable` and
nothing looked wrong at all. Two jobs went that way on 2026-09-17 (08:19, 44 words; 17:15,
1,533 words) and the team claimed both by hand.

Fixed in `STRAKER_DEADLINE_ZONE`, which is the single line this was always designed to be.
**RP-4's other halves remain open** — the lost-race signal and whether `words` is really the
effort field. AJ-295 settles neither: it was never claimed by the bot, so no rejection body
was seen, and its word count has not been checked against the delivered file.

**How to close the rest.** Watch a real offer arrive and let the bot claim it, with someone
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

> #### T078 — decided 2026-09-16: **KEEP**, and on evidence rather than sentiment
>
> The follow-up above was left open, so `/speckit-converge` raised it as `unrequested` code.
> The decision is to keep both, and the deciding fact is one nobody had written down:
>
> **The live bot does not preserve raw offer payloads.** It parses, and on a shape it does
> not recognise it fails loud and alerts (FR-023) — but the payload that would let someone
> *fix* the parser is not kept anywhere. `CaptureStore` is the only code in the repository
> that writes one to disk. Deleting it would not remove dead weight; it would remove the only
> means of recovering the evidence, at a moment when `offerParse.ts` still opens by saying the
> evidence is "three files, of which only **two are** independent jobs" — unchanged since RP-5
> — and RP-4 has still not put a single real claim through the path.
>
> **Reopen trigger, so this is a decision and not a deferral**: delete both once the parser has
> been confirmed against ten or more independent offers, or once RP-4 closes and the observed
> payload shapes have held steady for a month. `probe.ts` itself stays regardless — `RawOffer`
> is used throughout the bot.
>
> **Observed while deciding, not acted on**: a third option exists that neither keeping nor
> deleting covers — wiring `CaptureStore` into the parser's *failure* path, so an unrecognised
> payload is written to disk as it alerts. That would turn code with no caller into the thing
> that closes the evidence gap. It is out of T078's scope (which was to decide, not to build)
> and is left here for the owner rather than done unasked.

> Probe deleted: **2026-09-16**, on the owner's instruction. Password rotation (RP-1) is now safe to perform.
