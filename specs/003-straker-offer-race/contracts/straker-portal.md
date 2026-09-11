# Contract — What the bot depends on from the Straker portal

**Date**: 2026-09-11 | **Status**: partially confirmed against the live portal; the offer payload region is **BLOCKED** by SC-000

> **This contract is reverse-engineered.** The portal publishes no specification — its own documentation endpoints are closed — so every statement here is an observation, not a guarantee the vendor has made. That is exactly why the rule below exists.

## The governing rule

**Any departure from this contract must fail loud and stop that action. It must never be absorbed, guessed around, or read as "there is no work".**

The specific failure to prevent: a fault, an unexpected shape, or an empty-looking response being interpreted as "no open offers". That would mark every live offer as vanished, stamp fabricated lifetimes on them, and corrupt both the record and the ledger — silently. The XTM bot lost 38 minutes of work to this exact class of bug.

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
| Everything the eligibility and scheduling decisions need is present in the **list** reply | Claimed by recon, **not yet verified** — verification needs a real payload (U1). Until verified, no code may depend on a named field. |
| An empty list genuinely means "no open offers" | True **only for a successful read**. This is why a failed read must never reach the tracker. |

## 3. Request budget — CONFIRMED live 2026-09-11

| Expectation | Status |
|---|---|
| Every response reports the allowance, the remainder, and when it resets | Confirmed; the remainder decrements as expected |
| The allowance is **300 per minute** | Confirmed |

The client reads the remainder after every response and responds in defined steps (FR-019): below 120 remaining it suspends deferrable work, below 60 it pauses reading until the budget resets. **Independently of those headers** it enforces a hard ceiling, so a missing or nonsensical value cannot remove all restraint. Target: never exceed 300/minute, never let the remainder fall below 60 (SC-003).

## 4. Claiming an offer — NOT YET EXERCISED

**Nothing in the capture probe claims anything.** This section is what the implementation will verify first, on a real offer, under supervision.

| Expectation | Status |
|---|---|
| Claiming addresses one offer at a time; there is no group action | From recon. Means the XTM bot's all-or-nothing group rule does not apply here at all. |
| A distinct rejection means "another vendor already took it" | From recon — **the single most important thing to confirm on the first real claim**, since the whole outcome model depends on telling a lost race apart from a fault |
| A claim is irreversible | Assumed, and treated as certain. No blind retry, ever (R7). |

**Until the lost-race signal is confirmed on a real offer, an unrecognised rejection is a fault** — it alerts, and reconciliation settles what actually happened. Confirming it under supervision on the first real claim is release precondition **RP-4**.

## 4a. Account blocked or suspended — NOT OBSERVED

Distinct from an expired session, which self-heals by signing in again. A rejection meaning the account itself is barred must alert immediately and stop claiming; it must never be retried around as though it were transient. The two are easy to conflate because both arrive as a refusal on an authenticated request — and conflating them turns a suspension into a sign-in loop against a portal that has already said no.

## 5. Reading work already assigned to the team — NOT YET EXERCISED

Reconciliation (FR-016a) depends on being able to ask the portal what it believes the team already holds. Recon observed such a list, returned as an envelope with a count. It is the authority when our record and the portal disagree — the portal is the source of truth, our record is a copy.

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
