# Notification & Reporting Overhaul — Design

**Date:** 2026-06-25
**Status:** Approved (brainstorming, **revised v2 after automation + reliability specialist review**) — ready for writing-plans
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

### Plumbing the review surfaced as REQUIRED (must land or the feature breaks)

| # | File | Responsibility |
|---|---|---|
| P1 | `src/state/db.ts` | **Outbox CHECK migration (C1):** the `outbox.channel` CHECK is hardcoded `IN ('chat','sheets')`. Widen to `IN ('chat','sheets','team')` via an **idempotent rebuild** (rename→recreate→copy→drop→reindex), mirroring the existing `ensureOutboxChannel()`; guard with `sql.includes("'team'")` so it runs once. MUST run before the first `enqueue(...,'team')` (else `SQLITE_CONSTRAINT_CHECK` rolls back the accept transaction). |
| P2 | `src/reporting/googleChat.ts` | **Payload contract (C2):** `ChatPayload = { text: string } \| { cardsV2: unknown[] }` (tagged union). `ChatSender.send(payload: ChatPayload)` POSTs `{text}` or `{cardsV2}` verbatim. `classifyStatus` refined: **400 → `permanent` AND flagged as a payload error** (loud, don't retry-forever) vs 401/403/404 → `permanent` (config-fixable). |
| P3 | `src/reporting/dispatcher.ts` | **Routing (C2/C3):** `sendRow` discriminates by **payload shape** (`cardsV2` present → card; else `text` → text; else malformed) so card + text rows coexist on one channel during migration. Route by a **channel→sender map** (`'chat'`→system, `'team'`→team, `'sheets'`→sheet), not the hardcoded `if/else`. A row whose channel has no sender → malformed. |
| P4 | `src/state/outbox.ts` | `OutboxChannel = 'chat' \| 'sheets' \| 'team'`. |
| P5 | `src/state/xtmJobStore.ts` | Add `listByLifecycle(status): XtmJobState[]` (e.g. `WHERE lifecycle_status = ? AND file_name <> ''`) — the daily report's data source (no such query exists today). Coverage-gated (`state/`) → TDD. |
| P6 | `src/runtime/xtmPollLoop.ts` (recon ping, line ~188) | The `${HEALTHCHECKS}`-adjacent **recon ping enqueues `{text}`** and is NOT a notifier — keep it `{text}` (P2's union + P3's shape-discrimination make this safe). Also: the **chat sender is constructed HERE (in the loop), not bootstrap** — inject the new `teamChatSender` via `XtmPollLoopDeps` (mirror `chatSender`/`sheetSender`). |

### Feature components

| # | File | Responsibility |
|---|---|---|
| 1 | `src/reporting/dateFormat.ts` (new) | Move `formatSheetDate` here as `formatReadableDate(iso): string` (`DD/MM/YYYY HH:mm` Bangkok via the existing **+7h-then-read-UTC-parts** trick — TZ-independent; date-only → `DD/MM/YYYY`; empty → ``; unparseable → passthrough). `sheets.ts` re-imports it; re-point (don't duplicate) the existing `formatSheetDate` tests. |
| 2 | `src/reporting/chatCard.ts` (new) | Pure cardsV2 builders → `{cardsV2:[{cardId, card:{header,sections}}]}` (**`cardId` required**, unique per message — derive from event+jobKey). `decoratedRow(label,value,emoji)`, `openXtmButton(url)`, `buildCard({cardId,headerTitle,headerSubtitle,rows,buttonUrl})`. **Bound every field with truncate+ellipsis** (e.g. ≤120 chars) AND cap rows at 20 AND guard the serialized card ≤ ~30 KB (Google's 32 KB message limit) → drop to `…and N more`. Null → `—`. Pure + total (never throws). |
| 3 | `src/reporting/xtmNotifier.ts` (rewrite) | Each `render*` returns a **card object**, **English**, dates via `formatReadableDate`. Covers new, relisted, accepted, accept-failed/snatched, cold-start. |
| 5 | `src/reporting/dailyReport.ts` (new) | `buildDailyReportCard(heldJobs, at)` → card "📋 Jobs in Progress (N)" (rows capped/bounded by chatCard). `dueDailyReport(nowMs, lastSentDate, hour=9): boolean` — **computes the Bangkok date/hour TZ-independently (+7h offset, NOT `getHours()`/process TZ)**; `lastSentDate` is zero-padded `YYYY-MM-DD`. True when bangkokDate ≠ lastSentDate AND bangkokHour ≥ 9. |
| 6 | `src/runtime/xtmPollLoop.ts` | After the cycle, if `dueDailyReport(...)`: `store.listByLifecycle('accepted')` → build card → **in ONE `db.transaction`**: `outbox.enqueue('daily:<bangkokDate>', card, 'team')` + `meta.lastDailyReportDate = <bangkokDate>` (crash-safe; the `(event_id,channel)` unique constraint is the real dedup, meta is the optimization — enqueue BEFORE meta, never swap). |
| 7 | config + `.env` | New **required** `GOOGLE_CHAT_WEBHOOK_TEAM: z.string().url()` added to `SECRET_KEYS` (auto-redacted by `secretValues`). `.env` gets the team webhook (gitignored). `GOOGLE_CHAT_WEBHOOK_DAILY_REPORT` → deprecated: leave in `SECRET_KEYS`, mark deprecated in `.env.example`, optional startup warn if still set. |
| 8 | `src/reporting/systemAlerts.ts` + `contracts/notifications.md` | **English** rewrite of the `TRIGGERS` table (9 triggers × title/impact/action — a real rewrite, not a tweak) emitted as a card; add a dedicated **`daily_report_dead`** trigger (loud, names the date) so a lost daily report is not a generic `outbox_dead`. Update the contract doc to the English/card templates. |
| 9 | `src/state/meta.ts` | `lastDailyReportDate` getter/setter (the daily-sent guard; survives restart). |
| 10 | `src/runtime/xtmPollLoop.ts` (heartbeat, line ~228) | **Team-channel failures must NOT fail the heartbeat (I2):** the `stuck` condition pages on-call via Healthchecks. A bad (hand-pasted) team webhook must raise a *system alert* (visible) but NOT trip `/fail` — exclude `team`-channel dead/permanent from the heartbeat-fail count; system/sheets failures still page. |

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

- Card POST uses the `SendOutcome` taxonomy through the outbox → at-least-once. Each row
  retries/deads independently per `(event_id, channel)`.
- **Team-channel failures do not page on-call (I2):** a team webhook that deads raises a
  visible *system alert* but is excluded from the heartbeat-`stuck`/`/fail` count — the bot
  is healthy (detection/accept work); only system/sheets failures page.
- **A persistently-rejected card (HTTP 400 = bad/oversized payload) is dead + loud (I3),**
  not retry-forever: `classifyStatus` distinguishes 400 (payload — un-fixable by config, so
  dead it and raise an alert) from 401/403/404 (webhook config — keep as permanent/retry).
  The chatCard builder's truncate + 30 KB guard makes a 400-from-size practically
  impossible, but the path is handled, not silent.
- **Daily report missed** (bot down at 09:00) → sent once on the first post-09:00 cycle.
  Idempotent + restart-safe via the `(event_id='daily:<date>', channel='team')` unique
  constraint (the real dedup); the `meta.lastDailyReportDate` write shares the enqueue
  transaction (no crash window). Multi-day outage → sends only TODAY's snapshot once (no
  backfill storm — explicit non-goal). If the day's row ultimately deads, the
  **`daily_report_dead`** alert names the date so it isn't lost silently.
- A malformed/oversized card must never crash the cycle — the builders are pure and total
  (null → `—`, fields truncated, rows capped, byte-size guarded).

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
- **Migration of existing tests (required, or CI goes red):** `tests/unit/dispatcher.test.ts`,
  `tests/integration/sheetsOutbox.test.ts`, `tests/unit/googleChat.test.ts` enqueue/assert
  `{text}` — update to the `ChatPayload` union (text still valid). Add a `db.ts` migration
  test (existing `('chat','sheets')` DB → widened to include `'team'`, idempotent on re-run)
  and an `enqueue(...,'team')` round-trip test.

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
