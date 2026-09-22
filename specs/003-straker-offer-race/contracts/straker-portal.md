# Contract — What the bot depends on from the Straker portal

**Date**: 2026-09-11, offer-payload region updated 2026-09-15 | **Status**: partially confirmed against the live portal. The offer payload region was **blocked by SC-000** until 2026-09-15, when the owner proceeded on three captured payloads (two independent jobs) rather than wait for the 10-offer exit — see spec.md §Clarifications. §2 is now confirmed against those files; §4, §4a and §5 remain **unexercised**, and the claim path is still the part of this contract nothing has tested against the real portal.

> **This contract is reverse-engineered.** The portal publishes no specification — its own documentation endpoints are closed — so every statement here is an observation, not a guarantee the vendor has made. That is exactly why the rule below exists.

## The governing rule

**Any departure from this contract must fail loud and stop that action. It must never be absorbed, guessed around, or read as "there is no work".**

The specific failure to prevent: a fault, an unexpected shape, or an empty-looking response being interpreted as "no open offers". That would mark every live offer as vanished, stamp fabricated lifetimes on them, and corrupt both the record and the ledger — silently.

**Why the XTM bot's 38-minute incident is cited here, precisely** (corrected 2026-09-15): the
mechanism does not carry over, only the consequence does. XTM's cause was a **browser DOM
race** — the inbox grid rendered its shell and a "0 - 0 of 0" footer before a later XHR filled
the rows, so a read that *succeeded* against a not-yet-populated page saw zero rows. There was
no fault, no unexpected shape and no error response; a still-loading grid was simply
indistinguishable from an empty one. It polled ~114 times over ~38 minutes while a real Malay
job sat in the list, and the fix was to wait for the network to settle before reading
(`settleGrid()`).

Straker is read over HTTP with no browser, so it **cannot** have that mechanism at all. What it
can have is the same *consequence* — believing there are no offers when there are — reached by
a different route: a fault read as an empty list, an envelope where a bare list was expected, a
shape guard that absorbs instead of refusing. The precedent is worth citing not for how it
happened but for how it ended: the wrong answer was **plausible**, so nothing alerted, and it
went unnoticed for 38 minutes. A silent zero is the failure mode that does not announce itself,
whichever layer produces it.

---

## 1. Sign-in — CONFIRMED live 2026-09-11

| Expectation | Status |
|---|---|
| Sign-in takes an identifier and a password, and optionally a one-time code | Confirmed |
| A one-time code is **not** currently required, but the field exists server-side | Confirmed — configuration must carry the field ready for the day it is switched on |
| The session is returned as a cookie the client must store and replay | Confirmed — the runtime has no cookie jar of its own, so the client keeps one |
| **`Origin` and `Referer` headers are required on every request** | Confirmed the hard way: without them, sign-in is refused outright. Browsers set these automatically, which is why the browser-based recon never saw it. |
| The vendor identity is read back from the portal after sign-in | Confirmed — the value matched what recon observed. **Never pin it in configuration**: it changes under impersonation or an account switch, and a stale one would poll another vendor's work. |
| A rejection meaning "expired session" is distinguishable from a server fault | Confirmed in the failure-mode tests: the expiry signal earns exactly one re-sign-in; a server fault earns none. |

## 2. Reading open offers — CONFIRMED live 2026-09-11

| Expectation | Status |
|---|---|
| The open list is addressed per vendor and filtered to open items | Confirmed |
| The reply is a **bare list**, not an envelope with a count | Confirmed. The assigned-work reply *is* an envelope — the two differ, so the shape is checked on every read rather than assumed. If this ever becomes an envelope, the read fails loud instead of quietly reading zero offers. |
| Every entry carries its own opaque identifier | Enforced — an entry without one is a hard failure, because an offer with no identity cannot be tracked or deduplicated |
| Everything the eligibility and scheduling decisions need is present in the **list** reply | **Confirmed 2026-09-15** against three captured payloads: the language direction, the word count and the deadline all arrive in the list reply, so no detail fetch is needed before claiming (FR-002). Verified on two independent jobs only — the parser fails loud on any field it has not seen rather than absorbing it. |
| An empty list genuinely means "no open offers" | True **only for a successful read**. This is why a failed read must never reach the tracker. |

## 3. Request budget — CONFIRMED live 2026-09-11

| Expectation | Status |
|---|---|
| Every response reports the allowance, the remainder, and when it resets | Confirmed; the remainder decrements as expected |
| The allowance is **300 per minute** | Confirmed |

The client reads the remainder after every response and responds in defined steps (FR-019): below 120 remaining it suspends deferrable work, below 60 it pauses reading until the budget resets. **Independently of those headers** it enforces a hard ceiling, so a missing or nonsensical value cannot remove all restraint. Target: never exceed 300/minute, never let the remainder fall below 60 (SC-003).

## 4. Claiming an offer — confirmed from the portal's web app (2026-09-18)

**Request:** `POST /api/vendors/{vendorId}/job-offers/{obj_id}/accept`, no body — read from the portal's own front-end code, whose Accept button calls exactly this (`decline` is the sibling). The earlier guess `/claim` was the first real claim sent (offer `4b7be68e`, 18/09 12:22) and got `404 {"detail":"Not Found"}` while the offer stayed open two more minutes.

**Lost race:** HTTP **409**. The web app shows "Offer no longer available — this offer may have been accepted by another vendor" for a 409 and a generic error for anything else. A won claim's reply has still not been observed.

| Expectation | Status |
|---|---|
| Claiming addresses one offer at a time; there is no group action | From recon. Means the XTM bot's all-or-nothing group rule does not apply here at all. |
| A distinct rejection means "another vendor already took it" | **Confirmed: 409** (from the web app's handling). Every other rejection stays a fault. |
| A claim is irreversible | Assumed, and treated as certain. No blind retry, ever (R7). |

**An unrecognised rejection is a fault** — it alerts, and reconciliation settles what actually happened. RP-4 stays open only for observing a won claim end to end.

## 4a. Account blocked or suspended — NOT OBSERVED

**What the web app says (2026-09-18):** nothing that equates a 403 with a barred account. Its API layer special-cases only a 401 (back to sign-in); its `/403` page is a *route* guard for impersonation and agency-translator accounts; and a failed accept that is not a 409 shows a generic "Something went wrong". So a 403 on accept means "forbidden" — possibly for this one offer — not proven to mean "banned". The bot still stops claiming on any 403 until `straker:unbar` (the conservative reading, kept deliberately), which means a per-offer 403 would halt claiming until a human looks.

Distinct from an expired session, which self-heals by signing in again. A rejection meaning the account itself is barred must alert immediately and stop claiming; it must never be retried around as though it were transient. The two are easy to conflate because both arrive as a refusal on an authenticated request — and conflating them turns a suspension into a sign-in loop against a portal that has already said no.

## 5. Reading work already assigned to the team — exercised 2026-09-22

Reconciliation (FR-016a) depends on being able to ask the portal what it believes the team already holds. `GET /api/vendors/{vendorId}/assigned-jobs?limit=&offset=` returns `{ items, total, limit, offset }`; each item carries `obj_id` (its **own** id, not the offer's), `external_job_id` (the job reference, e.g. `aj-310`), `title`, `source_lang`, `target_lang`, `service`, `words`, `due_at` (with `Z`) and `status` (`in_progress`, `delivered`, …). It is the authority when our record and the portal disagree — the portal is the source of truth, our record is a copy.

## 5a. Purchase orders — where won work waits for a person (observed 2026-09-22)

A won claim does **not** go straight to the assigned list. The portal issues a purchase order, which sits `pending` until someone on the team accepts it and names a translator — hours, sometimes a day — and only then does an assigned job appear, under yet another id.

`GET /api/hitl/vendor/purchase-orders?vendor_id=&sort_by=created_at&sort_order=desc&page=&page_size=` (the call the portal's own web app makes) returns `{ items, total, page, page_size }`. Each item: `po_obj_id`, `status`, `job_ref`, `source_language_code`, `target_language_code` (both empty on a DTP order), `po_type` (`translation`, `dtp_prep`), `due_at`, amounts. **No word count.**

| Status | Assigned job | Meaning |
|---|---|---|
| `pending` | none yet | Won, waiting for a person — **still owed** |
| `accepted` | `in_progress` | Being worked |
| `confirmed`, `approved` | `delivered` | Done |
| `revoked` | none | Withdrawn |

**The three stages share only `job_ref` + target language + service**; across 27 orders that triple never repeated. `src/straker/workKey.ts` makes it the key (target missing, empty or equal to the source is one value, for DTP). Matching on `obj_id` alone is what released every won claim within one reconcile pass and then recorded it again as "found by reconciliation".

## 6. Deliberately not used

Per the spec's non-goals, the bot never declines an offer, never fetches an offer's detail or files before claiming (it would spend a round trip it cannot afford), never uploads or delivers work, and never touches time tracking, invoicing or rates.

---

## Change detection

| Change | Response |
|---|---|
| Open list stops being a bare list | Fail loud, alert, stop reading. **Never** read as zero offers. |
| An entry arrives with no identifier | Fail loud — identity is not optional |
| A field the parser depends on disappears or changes type | Fail loud, capture the payload as evidence, alert |
| Budget headers disappear | Fall back to the hard ceiling and warn — never to unrestrained polling |
| `Origin` rejection reappears | Fail loud; it means the portal's rules changed again |
| An unrecognised rejection on a claim | Treat as a fault, alert, and let reconciliation determine the truth |
| The portal is repeatedly unreachable or failing | Back off exponentially with jitter up to a defined cap, then alert (FR-019b). Never keep reading at the normal rhythm: that means hammering a system already in trouble, and a failing portal may send no budget headers to restrain it. The **claim** path never backs off, because it never retries at all |
