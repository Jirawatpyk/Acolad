# Notification & Reporting Overhaul — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — ready for writing-plans
**Feature:** 002-xtm-detect-accept (enhancement)

## Goal

Make the bot's Google Chat output professional and team-facing: convert every message
from plain Thai text to an **English cardsV2 card** with **readable dates**, add a second
**team channel** for the people who do the work, and post a **daily 9:00 snapshot of the
jobs the team currently holds**.

## Requirements (from the user, mapped)

1. **Cards** — every Chat message becomes a Google Chat `cardsV2` card (decorated rows + an "Open in XTM" button).
2. **Readable dates** — dates render `DD/MM/YYYY HH:mm` (Bangkok), the same format the Sheet just adopted (`formatSheetDate`).
3. **Daily report 09:00** — once a day, post the jobs the team currently holds.
4. **Team channel** — the daily report AND every accepted job go to a new team Google Chat group (its webhook lives in `.env`).
5. **English** — all bot output (cards, alerts, cold-start) is English. (Replies to the operator in chat stay Thai — this is about the bot's Chat messages only.)

## Decisions (locked in brainstorming)

- Card style: **decorated rows (icon + label + value) + an "Open in XTM" button** (links to `XTM_ACOLAD_OFFERS_URL`).
- Daily report content: **only the jobs currently held** (`lifecycleStatus = 'accepted'`) at 09:00 — no stats, no missed-jobs list.
- Channel routing: **System** channel keeps everything (ops); **Team** channel gets **accepted (real-time, duplicated)** + the **daily report**.
- Daily trigger: inside the **poll loop** (the 24/7 bot), not an external scheduler.

## Architecture

The chat payload changes from `{ text }` to `{ cardsV2 }`. All messages flow through the
**existing single outbox** (at-least-once) — a new outbox channel `team` is added with its
own sender; the daily report is enqueued like any other event (never sent directly). A
shared date formatter is reused by both the Sheet and the cards.

## Components

| # | File | Responsibility |
|---|---|---|
| 1 | `src/reporting/dateFormat.ts` (new) | Move `formatSheetDate` here as `formatReadableDate(iso): string` (`DD/MM/YYYY HH:mm` Bangkok; date-only → `DD/MM/YYYY`; empty → ``; unparseable → passthrough). `sheets.ts` re-imports it (no behaviour change). |
| 2 | `src/reporting/chatCard.ts` (new) | Pure cardsV2 builders. `decoratedRow(label, value, emoji)`, `openXtmButton(url)`, and a `buildCard({headerTitle, headerSubtitle, rows, buttonUrl})` → the `{cardsV2:[...]}` object. |
| 3 | `src/reporting/xtmNotifier.ts` (rewrite) | Each `render*` returns a **card object** (not a string), in **English**, dates via `formatReadableDate`. Covers: new, relisted, accepted, accept-failed/snatched, cold-start. |
| 4 | `src/reporting/googleChat.ts` | `ChatPayload` becomes the card object; `GoogleChatSender.send(payload)` POSTs the card JSON (`{cardsV2}`); `classifyStatus` unchanged. |
| 5 | `src/reporting/dailyReport.ts` (new) | `buildDailyReportCard(heldJobs, at)` → a card "📋 Jobs in Progress (N)" with one row per held job (Project/File · Due · Words), capped at 20; pure `dueDailyReport(now, lastSentLocalDate, hour=9): boolean`. |
| 6 | `src/runtime/xtmPollLoop.ts` | After the cycle, if `dueDailyReport(...)`: query `XtmJobStore` for `lifecycleStatus='accepted'`, build the card, enqueue to `team` (`event_id = daily:<localDate>`), then `meta` records the sent date. |
| 7 | config + `.env` + dispatcher | New `GOOGLE_CHAT_WEBHOOK_TEAM` (zod, secret — added to `secretValues` redaction). New outbox channel `team` → `GoogleChatSender(TEAM webhook)` wired in `bootstrap`/`dispatcher`. (`GOOGLE_CHAT_WEBHOOK_DAILY_REPORT` is superseded → mark deprecated in `.env.example`.) |
| 8 | `src/reporting/systemAlerts.ts` + `specs/.../contracts/notifications.md` | System-alert text → English card; update the contract doc to the English/card templates. |
| 9 | `src/state/meta.ts` | `lastDailyReportDate` getter/setter (persist the daily-sent guard across restarts). |

## Card format (cardsV2, semantic)

Each card: a **header** (`title` = status emoji + label, e.g. `✅ Job Accepted · XTM`;
`subtitle` = project name), a **section of decorated rows** (one per field — icon-prefixed
label + value), and a **button section** with `Open in XTM` (`onClick.openLink.url =
XTM_ACOLAD_OFFERS_URL`).

Per type (English labels, dates via `formatReadableDate`):

- **🆕 New Job · XTM** — File, Language (`EN (USA) → Malay (Malaysia)`), Due, Words, Step (Role), Status (`Malay (MS) — accepting` / `Malay (MS) — auto-accept off` / `Not Malay — logged only`).
- **🔁 Job Relisted · XTM** — subtitle adds `first seen <date>`; same rows as New (no Status).
- **✅ Job Accepted · XTM** — File, Language, Due, Words, Accepted `<date>`.
- **⚠️ Accept Failed · XTM** (failed) / **⚠️ Job Snatched · XTM** (missing) — Project/File, Language, Cause (`clicked but could not confirm — <reason>` / `snatched before we could accept`), Action (`Yes — check XTM` / `No (job already gone)`).
- **📋 XTM Monitor Started** — subtitle `<N> jobs in Active (<eligible> Malay)`; a row per job (cap 20, `…and N more`).
- **📋 Daily — Jobs in Progress (N)** — subtitle the date; a row per held job (`Project / File · Due · Words`; cap 20).

## Data flow

**Per-job (every ~20 s cycle):**
`XtmPollCycle.run` → `reportJob` builds the card via `xtmNotifier` → `outbox.enqueue`:
accepted → BOTH `chat` (system) and `team`; new/relisted/failed → `chat` only; sheet row →
`sheets`. `Dispatcher.flush` sends each channel via its sender (`chat`→system webhook,
`team`→team webhook, both POST `{cardsV2}`; `sheets`→Sheet). 2xx mark-sent, 429/5xx retry,
4xx dead — unchanged.

**Daily 09:00:** `xtmPollLoop.runOnce`, after the cycle, checks `dueDailyReport(now,
meta.lastDailyReportDate)` (true when local date ≠ last-sent AND local hour ≥ 9). If due →
query held jobs → build card → `outbox.enqueue('daily:<localDate>', card, 'team')` →
`meta.lastDailyReportDate = <localDate>`. Bot down at 09:00 → the first cycle after it
returns (still ≥ 9, not sent today) sends once; the meta guard prevents duplicates and
survives restart.

## Channel routing

| Channel | Webhook (.env) | Receives |
|---|---|---|
| System | `GOOGLE_CHAT_WEBHOOK_SYSTEM` (existing) | new, relisted, **accepted**, accept-failed, system alerts, heartbeat — full ops view |
| Team | `GOOGLE_CHAT_WEBHOOK_TEAM` (new) | **accepted** (real-time, duplicated) + **daily 09:00** (held jobs) |

## Error handling

- Card POST uses the existing `SendOutcome` taxonomy (2xx ok / 429,5xx transient / 4xx
  permanent) through the outbox → at-least-once; the team webhook is just another channel,
  so a team-channel failure retries/deads independently of system.
- Daily report missed (bot down at 09:00) → sent once on the first post-09:00 cycle; the
  `meta.lastDailyReportDate` guard makes it idempotent and restart-safe.
- A malformed/oversized card must never crash the cycle — the builders are pure and total
  (null fields → `—`, row count capped).

## Testing

- **Pure (TDD, coverage-gated `reporting/`):** `formatReadableDate` (reuse the existing
  `formatSheetDate` tests); `chatCard` builders (header/rows/button shape, null → `—`);
  `xtmNotifier` card output per type (English labels, correct fields, date format);
  `dailyReport` card (held-jobs list, cap 20, empty case) and `dueDailyReport` time logic
  (before 9, after 9 not-sent, after 9 already-sent, new day).
- **Integration:** channel routing (accepted → both `chat` and `team` outbox rows;
  new/relisted/failed → `chat` only; daily → `team`); `googleChat` posts the card body.
- **Ops verify:** the next accepted Malay job shows the card in BOTH channels; the 09:00
  report lands in the team channel with the held jobs.

## Constraints / non-goals

- **Secret:** `GOOGLE_CHAT_WEBHOOK_TEAM` lives only in `.env` (gitignored) and is in the
  pino + alert redaction list (`secretValues`). Never logged/committed.
- **1 message per job, no batching** (existing rule) is preserved for per-job
  notifications. The daily report is a single *report* card (a deliberate digest), not
  per-job notifications — it does not violate the rule.
- **FR-011 (rate):** the daily report is one extra Chat POST per day; per-job cards are the
  same cadence as today. No portal requests added.
- **Operator-facing language:** chat replies to the human operator stay Thai; only the
  bot's Google Chat output becomes English.
- **Not in scope:** per-task deep links (the button links to the inbox, not a per-task URL);
  interactive card actions/buttons beyond "Open in XTM"; daily-report stats/charts.
- Update `specs/002-xtm-detect-accept/contracts/notifications.md` to the English/card
  templates (the old Thai-text templates are replaced).
