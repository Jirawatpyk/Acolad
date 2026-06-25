# Contract: Notifications (Google Chat) — feature 002

All messages flow through the outbox (at-least-once, Constitution IV).
Time: ISO 8601 Asia/Bangkok (+07:00).
1 event = 1 outbox row = 1 message (no batching).
Channels: `chat` = system webhook (`GOOGLE_CHAT_WEBHOOK_SYSTEM`);
`team` = team webhook (`GOOGLE_CHAT_WEBHOOK_TEAM`).

---

## §1 Job-level events (channel: `chat`)

All job-level messages are **cardsV2** cards built by `src/reporting/xtmNotifier.ts`.
See that file for the exact template; field labels and values are in English.

### 1a) New job detected (`lifecycle_status = 'new'`, post-baseline)

Sent for every language pair including non-Malay.

Header: `🆕 New job on XTM`
Rows: Project, File, Language pair, Due date, Words, Step/Role, Status
(Status = `Eligible (Malay) — accepting` or `Not Malay — logged only`)

### 1b) Job accepted (`accept_status → 'accepted'`)

Header: `✅ Job accepted (XTM)`
Rows: Project, File, Language pair, Due date, Words, Accepted at

One card per `job_key` even for bulk accepts (1 message per job rule).

### 1c) Accept failed / snatched (`accept_status → 'failed'` or `'missing'`)

Header: `⚠️ Accept failed (XTM)`
Rows: Project, File, Language pair, Cause, Needs human check, Time

---

## §2 System alerts (channel: `chat`)

System alerts are **cardsV2** cards built by `src/reporting/systemAlerts.ts`
via `buildCard` from `src/reporting/chatCard.js`.

### Card shape

```
Header:  {severity-emoji} {title}
         🔴 = critical  |  ⚠️ = warn

Rows:
  Impact  — what stops working
  Action  — what the operator must do
  Detail  — raw cause string passed to raiseAlert()
```

`cardId` = `alert-{dedupKey}` sanitized to `[A-Za-z0-9-]`.

### Trigger table

| Kind | Severity | Recovered? | Title |
|---|---|---|---|
| `login_failed` | critical | yes | Login failed |
| `captcha` | critical | yes | CAPTCHA / identity check detected |
| `layout_changed` | critical | yes | Job list layout changed — cannot be read |
| `pagination` | warn | no | Pagination indicator detected |
| `portal_down` | warn | yes | Portal unreachable for over 10 minutes |
| `outbox_dead` | critical | yes | Notifications stuck — delivery failed |
| `cold_start_repeat` | warn | no | State store may be lost (cold start repeated within 7 days) |
| `db_corrupt` | critical | no | State store corrupt — reset to cold start |
| `accept_failed` | critical | no | Job accept failed (could not confirm) |
| `daily_report_dead` | warn | no | Daily report delivery failed |

`daily_report_dead` is raised on channel `chat` (not `team`) when the
`daily:<date>` outbox row dies. The `onDead` hook in `xtmPollLoop.ts`
branches on `eventId.startsWith('daily:')` to select this trigger;
all other dead rows raise `outbox_dead`.

### SYSTEM_RECOVERED card shape

```
Header:  ✅ Recovered · {title}

Rows:
  Down for — duration string (e.g. "12 min")
```

Only triggers with `hasRecovered: true` emit this card.

---

## §3 Daily in-progress report (channel: `team`)

Sent once per calendar day at ≥ 09:00 Bangkok time.
Card built by `src/reporting/dailyReport.ts` (`buildDailyReportCard`).
Event ID: `daily:<YYYY-MM-DD>`.
If delivery fails (dead outbox row), `daily_report_dead` alert is raised
on the `chat` channel so on-call is informed without paging via heartbeat.

---

## §4 Sheet-only states (no Chat message — intentional, N7)

- `Closed` / `Removed` — job finished or cancelled after being accepted
- `Missing` from a job that was never accepted (gone from Active silently)

---

## §5 Invariants (unchanged from 001)

- No secrets / cookies / credentials in any message or payload
- Dedup via `event_id` in the outbox — re-enqueue is safe
- Recon ping (`ACCEPT_RECON=1`) uses plain `{ text: … }` — not a card
