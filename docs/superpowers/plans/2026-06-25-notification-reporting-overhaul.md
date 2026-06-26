# Notification & Reporting Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Google Chat message becomes an English `cardsV2` card with readable dates; a new team channel receives accepted jobs (real-time) + a daily 09:00 snapshot of currently-held jobs.

**Architecture:** Plumbing first (outbox gains a `team` channel; the chat payload becomes a `{text}|{cardsV2}` tagged union the dispatcher routes by shape via a channel→sender map), then the feature (a pure card builder + a shared date formatter + an English notifier + a daily-report trigger in the poll loop). Everything flows through the existing at-least-once outbox.

**Tech Stack:** Node 22 + TypeScript strict (NodeNext ESM — relative imports end in `.js`), Vitest, better-sqlite3, Google Chat incoming webhooks.

## Global Constraints

- TDD mandatory for `src/detection/`, `src/state/`, `src/reporting/`; coverage ≥ 80% on those (`npm run test:coverage`).
- `npm run lint` + `npm run typecheck` 0-error before each commit; `git add` only your touched files (never `-A` — there is unrelated `.specify`/`.claude` noise).
- FR-011: no new portal request. 1 message per job, no batching (the daily report is a single report card, not per-job).
- Secret: `GOOGLE_CHAT_WEBHOOK_TEAM` lives only in `.env` (gitignored) + in `SECRET_KEYS` redaction. Never logged/committed.
- Operator-facing chat stays Thai; only the bot's Google Chat OUTPUT becomes English.
- Branch `feat/notification-overhaul` (already checked out). Bot is running pid 28832 — implement on branch, deploy at the end (Task 12).
- Bangkok time everywhere is computed TZ-independently (+7h then read UTC parts — the `formatSheetDate` pattern), NEVER `Date.getHours()` / process TZ.

**Key existing signatures:**
- `Outbox.enqueue(eventId, payloadJson, nowIso, channel='chat'): boolean` (INSERT OR IGNORE on `(event_id, channel)`); `OutboxChannel='chat'|'sheets'` (`src/state/outbox.ts`).
- `db.ts`: outbox DDL CHECK `channel IN ('chat','sheets')` (line 52) + `ensureOutboxChannel(db)` migration (lines 169-193, guard `row.sql.includes("'sheets'")`).
- `MetaStore.get(key)/set(key,value)` (`src/state/meta.ts`).
- `classifyStatus(status): SendOutcome` ('ok'|'transient'|'permanent'); `ChatSender.send(text)`; `ChatPayload={text}` (`src/reporting/googleChat.ts`).
- `Dispatcher` ctor `(outbox, sender, logger, hooks, sheetSender?)`; `sendRow` hardcodes `if channel==='sheets' … else chat reads .text` (`src/reporting/dispatcher.ts`).
- `formatSheetDate(value): string` (`src/reporting/sheets.ts:70`) — `DD/MM/YYYY HH:mm` Bangkok via +7h/UTC-parts; date-only→`DD/MM/YYYY`; ''→''; unparseable→passthrough.
- `XtmJobStore` (`src/state/xtmJobStore.ts`): `loadAll(): Map`, `upsertMany(states)`; rows have `lifecycle_status`, `file_name`.
- `XtmJobState` (`src/detection/types.ts`): `projectName, fileName, sourceLang, targetLang, dueDate, dueRaw, words, step, role, acceptedAt, lifecycleStatus, firstSeenAt`.

---

## PHASE 1 — Plumbing (must land before the feature, or accept breaks)

### Task 1: Outbox `team` channel (P1 + P4)

**Files:** Modify `src/state/db.ts` (DDL line 52 + `ensureOutboxChannel`), `src/state/outbox.ts` (type). Test: `tests/unit/db.migration.test.ts`.

**Produces:** `OutboxChannel = 'chat' | 'sheets' | 'team'`; outbox accepts `channel='team'`.

- [ ] **Step 1: Failing test** — add to `tests/unit/db.migration.test.ts` (follow its existing open-db pattern): open a fresh db, `new Outbox(db,…).enqueue('e1','{}','2026-06-25T00:00:00Z','team')` returns true and the row is queryable; and an idempotency case: run `migrate` twice (reopen) — no throw, `'team'` present.

```ts
it('outbox accepts the team channel and migration is idempotent', () => {
  const { db } = openDatabase(tmpDir, '2026-06-25T00:00:00Z');
  const ob = new Outbox(db, 10, 6);
  expect(ob.enqueue('t1', '{"text":"x"}', '2026-06-25T00:00:00Z', 'team')).toBe(true);
  expect(ob.due('2026-06-25T01:00:00Z').some((r) => r.channel === 'team')).toBe(true);
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='outbox'").get() as {sql:string}).sql;
  expect(sql).toContain("'team'");
});
```

- [ ] **Step 2: Run — FAIL** (`SQLITE_CONSTRAINT_CHECK` on `'team'`). `npx vitest run tests/unit/db.migration.test.ts`.

- [ ] **Step 3: Implement.** In `src/state/db.ts`: change the DDL outbox CHECK (line 52) to `CHECK (channel IN ('chat','sheets','team'))`. In `ensureOutboxChannel`: change the guard to `if (!row || row.sql.includes("'team'")) return;` and the rebuilt `CREATE TABLE outbox` CHECK to `('chat','sheets','team')` (so a fresh db with the new DDL is skipped; a v1/v2 db is rebuilt to add `team`). In `src/state/outbox.ts:4`: `export type OutboxChannel = 'chat' | 'sheets' | 'team';`.

- [ ] **Step 4: Run — PASS.** Then full `npx vitest run` (existing db/outbox tests still green).

- [ ] **Step 5: Commit** — `git add src/state/db.ts src/state/outbox.ts tests/unit/db.migration.test.ts` → `feat(state): add 'team' outbox channel (P1)`.

---

### Task 2: Chat payload union + sender + classifyStatus (P2)

**Files:** Modify `src/reporting/googleChat.ts`. Test: `tests/unit/googleChat.test.ts`.

**Produces:** `type ChatPayload = { text: string } | { cardsV2: unknown[] }`; `ChatSender.send(payload: ChatPayload): Promise<SendOutcome>`; `classifyStatus(400)` → `'permanent'` AND a helper `isPayloadRejection(status)`/flag.

- [ ] **Step 1: Failing tests** (extend `googleChat.test.ts`): `classifyStatus(400)` is `'permanent'`; a new `isPayloadRejection(400)===true`, `isPayloadRejection(403)===false`; `send({cardsV2:[{cardId:'c',card:{}}]})` posts a body whose JSON has `cardsV2` (mock `fetch`, assert `JSON.parse(body).cardsV2` present); `send({text:'hi'})` still posts `{text:'hi'}`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** in `src/reporting/googleChat.ts`:

```ts
export type ChatPayload = { text: string } | { cardsV2: unknown[] };
export interface ChatSender { send(payload: ChatPayload): Promise<SendOutcome>; }

/** 400 = the payload itself is bad (oversized/malformed card) — un-fixable by config,
 *  so the caller deads + alerts rather than retrying forever; 401/403/404 = webhook
 *  config (retry slowly). */
export function isPayloadRejection(status: number): boolean { return status === 400; }

// classifyStatus unchanged for 'permanent' on 4xx; 400 stays 'permanent' (the dispatcher
// uses isPayloadRejection to decide dead-vs-retry).

export class GoogleChatSender implements ChatSender {
  constructor(private readonly webhookUrl: string, private readonly timeoutMs = 10_000) {}
  async send(payload: ChatPayload): Promise<SendOutcome> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return classifyStatus(res.status);
    } catch { return 'transient'; }
  }
}
```

- [ ] **Step 4: Run — PASS** (the file's own tests). Typecheck will now break callers (dispatcher) — that's Task 3.

- [ ] **Step 5: Commit** — `git add src/reporting/googleChat.ts tests/unit/googleChat.test.ts` → `feat(reporting): ChatPayload union (text|cardsV2) + 400 payload-rejection (P2)`. (typecheck of the whole project is deferred to Task 3, which fixes the dispatcher caller — note this in the commit body.)

---

### Task 3: Dispatcher — route by shape + channel→sender map (P3)

**Files:** Modify `src/reporting/dispatcher.ts`. Test: `tests/unit/dispatcher.test.ts` (migrate existing).

**Consumes:** `ChatPayload` union (Task 2), `OutboxChannel` `team` (Task 1).
**Produces:** `Dispatcher` ctor takes a `senders: { chat: ChatSender; team?: ChatSender; sheet?: SheetSender }`; `sendRow` routes by `row.channel` against the map and discriminates chat/team payloads by shape (`cardsV2` present → card; else `text` → text; else malformed). A 400 payload-rejection (Task 2 `isPayloadRejection`) → dead + alert (not retry-forever).

- [ ] **Step 1: Failing tests** (rewrite the `{text}` cases in `dispatcher.test.ts` to the new ctor + add): a `chat` row with `{cardsV2:[…]}` → sent via chat sender (assert the sender received a `{cardsV2}` payload); a `chat` row with `{text:'a'}` → still sent (back-compat); a `team` row → routed to the team sender; a row with neither field → malformed/dead; a 400 from the sender → `dead` + `onDead` called (not `permanentFailures`).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Change the ctor to `constructor(outbox, senders: { chat: ChatSender; team?: ChatSender; sheet?: SheetSender }, logger, hooks={})`. Replace `sendRow`:

```ts
private async sendRow(row: OutboxRow): Promise<'malformed' | { outcome: SendOutcome; latencyMs: number; payloadRejected?: boolean }> {
  const start = Date.now();
  if (row.channel === 'sheets') { /* unchanged: parse {row}, this.senders.sheet, malformed if absent */ }
  const sender = row.channel === 'team' ? this.senders.team : this.senders.chat;
  if (!sender) return 'malformed';
  let payload: ChatPayload | undefined;
  try {
    const p = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (Array.isArray(p.cardsV2)) payload = { cardsV2: p.cardsV2 };
    else if (typeof p.text === 'string' && p.text !== '') payload = { text: p.text };
  } catch { payload = undefined; }
  if (!payload) return 'malformed';
  let outcome: SendOutcome; let payloadRejected = false;
  try {
    // GoogleChatSender returns SendOutcome; to know 400 specifically, expose the status —
    // simplest: GoogleChatSender.send returns SendOutcome and a separate sendStatus? Keep it
    // pure: have GoogleChatSender throw/return a tagged result. SIMPLEST that fits: add an
    // optional `lastStatus` — instead, classify here is impossible. So: GoogleChatSender.send
    // returns SendOutcome; add `sendDetailed(payload): {outcome, status}` used by the dispatcher.
    outcome = await sender.send(payload);
  } catch { outcome = 'transient'; }
  return { outcome, latencyMs: Date.now() - start, payloadRejected };
}
```
Refine: to surface a 400 to the dispatcher, give `GoogleChatSender` a `sendDetailed(payload): Promise<{outcome: SendOutcome; status: number}>` (the plain `send` delegates to it for back-compat), and in `sendRow` set `payloadRejected = isPayloadRejection(status)`. In `flush`, when `outcome==='permanent' && payloadRejected` → treat as **dead** (mark sent/drop + `onDead`) with a distinct log, instead of `recordPermanentFailure`.

Update the wiring sites that build `Dispatcher` (search for `new Dispatcher(`) to the `senders` object form (the loop in `xtmPollLoop.ts` — Task 8 passes `team`).

- [ ] **Step 4: Run — PASS** (`dispatcher.test.ts`), then full `npx vitest run` + `npm run typecheck` (callers compile).

- [ ] **Step 5: Commit** — `git add src/reporting/dispatcher.ts tests/unit/dispatcher.test.ts` → `feat(reporting): dispatcher routes by channel map + payload shape; 400 card → dead (P3)`.

---

### Task 4: `XtmJobStore.listByLifecycle` (P5)

**Files:** Modify `src/state/xtmJobStore.ts`. Test: `tests/unit/xtmJobStore.test.ts`.

**Produces:** `listByLifecycle(status: XtmLifecycleStatus): XtmJobState[]`.

- [ ] **Step 1: Failing test** — upsert 3 jobs (2 `accepted`, 1 `missing`); `listByLifecycle('accepted')` returns exactly the 2 accepted (mapped to `XtmJobState`), excludes empty-`file_name` rows.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — add a `WHERE lifecycle_status = ? AND file_name <> ''` query that reuses the same row→`XtmJobState` mapper `loadAll()` uses (extract the mapper if needed). Return an array.

- [ ] **Step 4: Run — PASS** + full suite.

- [ ] **Step 5: Commit** — `feat(state): XtmJobStore.listByLifecycle for the daily report (P5)`.

---

## PHASE 2 — Feature

### Task 5: Shared `formatReadableDate` (move `formatSheetDate`)

**Files:** Create `src/reporting/dateFormat.ts`; modify `src/reporting/sheets.ts` (re-import). Test: move/re-point the existing `formatSheetDate` tests to `tests/unit/dateFormat.test.ts`.

**Produces:** `formatReadableDate(value: string | null): string`.

- [ ] **Step 1:** Move the `formatSheetDate` body verbatim into `src/reporting/dateFormat.ts` exported as `formatReadableDate` (keep the +7h/UTC-parts logic, the `hasTime` guard, the empty→'' and unparseable→passthrough behavior). In `sheets.ts`, `export { formatReadableDate as formatSheetDate } from './dateFormat.js'` (or re-import and re-export) so existing callers/tests are unchanged.
- [ ] **Step 2:** Re-point the existing `formatSheetDate` unit tests to import from `dateFormat.js` (rename file or add `tests/unit/dateFormat.test.ts`); do NOT duplicate — single source of truth.
- [ ] **Step 3: Run** `npx vitest run tests/unit/dateFormat.test.ts` + full suite — PASS (behavior identical).
- [ ] **Step 4: Commit** — `refactor(reporting): extract shared formatReadableDate (date format #2)`.

---

### Task 6: Pure card builder `chatCard.ts`

**Files:** Create `src/reporting/chatCard.ts`. Test: `tests/unit/chatCard.test.ts`.

**Produces:** `buildCard(opts: { cardId: string; headerTitle: string; headerSubtitle?: string; rows: {emoji?:string; label:string; value:string|null}[]; buttonText?: string; buttonUrl?: string }): { cardsV2: unknown[] }`; `truncate(s, max=120)`.

- [ ] **Step 1: Failing tests:** `buildCard` returns `{cardsV2:[{cardId, card:{header:{title,subtitle}, sections:[...]}}]}`; a null row value renders `—`; a value > 120 chars is truncated with `…`; `buttonUrl` produces a `buttonList`→`onClick.openLink.url` widget; with > 20 rows only 20 render + a final "…and N more" widget; the serialized card stays < 32_768 bytes (build with 20 long rows, assert `JSON.stringify(card).length < 32768`).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — pure builders:

```ts
export function truncate(s: string, max = 120): string { return s.length > max ? s.slice(0, max - 1) + '…' : s; }
const MAX_ROWS = 20;
export function buildCard(o: {...}): { cardsV2: unknown[] } {
  const shown = o.rows.slice(0, MAX_ROWS);
  const widgets = shown.map((r) => ({ decoratedText: {
    topLabel: `${r.emoji ? r.emoji + ' ' : ''}${r.label}`,
    text: truncate((r.value ?? '—') || '—'),
  }}));
  if (o.rows.length > MAX_ROWS) widgets.push({ decoratedText: { text: `…and ${o.rows.length - MAX_ROWS} more` } } as any);
  const sections: unknown[] = [{ widgets }];
  if (o.buttonUrl) sections.push({ widgets: [{ buttonList: { buttons: [{ text: o.buttonText ?? 'Open in XTM', onClick: { openLink: { url: o.buttonUrl } } }] } }] });
  return { cardsV2: [{ cardId: o.cardId, card: { header: { title: truncate(o.headerTitle, 200), subtitle: o.headerSubtitle ? truncate(o.headerSubtitle, 200) : undefined }, sections } }] };
}
```
(Add a defensive: if `JSON.stringify` of the result exceeds ~30_000 bytes, drop trailing rows until under — implement as a small loop, with a test.)

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(reporting): pure cardsV2 builder with truncate + size guard (#1)`.

---

### Task 7: `xtmNotifier` → English cards

**Files:** Modify `src/reporting/xtmNotifier.ts`. Test: `tests/unit/xtmNotifier.test.ts`.

**Consumes:** `buildCard` (Task 6), `formatReadableDate` (Task 5).
**Produces:** each `render*` returns `{ cardsV2: unknown[] }`; signatures unchanged otherwise (callers in `xtmPollCycle.ts` already pass these args — they enqueue the returned object as JSON).

- [ ] **Step 1: Failing tests** — for each renderer assert the returned card's header title (English: `🆕 New Job · XTM`, `🔁 Job Relisted · XTM`, `✅ Job Accepted · XTM`, `⚠️ Accept Failed · XTM` / `⚠️ Job Snatched · XTM`, `📋 XTM Monitor Started`), that the rows include the right English labels (File/Language/Due/Words/Step/Status/Accepted), and that `dueDate` renders via `formatReadableDate`. Use `cfg.XTM_ACOLAD_OFFERS_URL` for the button (pass the url in; see note).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — rewrite each renderer to `buildCard(...)`. English labels + status notes: `Malay (MS) — accepting` / `Malay (MS) — auto-accept off` / `Not Malay — logged only`; accept-failed cause `clicked but could not confirm — <reason>` (failed) / `snatched before we could accept` (missing); action `Yes — check XTM` / `No (job already gone)`. The button needs the inbox URL — add an `xtmUrl: string` param to each renderer (callers in `xtmPollCycle.ts` pass `this.cfg.XTM_ACOLAD_OFFERS_URL`) OR a module-level setter; prefer the explicit param. `cardId` = `${type}-${jobKey}` sanitized.

- [ ] **Step 4: Update callers** in `src/runtime/xtmPollCycle.ts` (`chatForEvent`/`reportJob`): pass the xtm url; the returned card object is enqueued via `JSON.stringify(card)` (it already `JSON.stringify`s the chat payload — now it's `{cardsV2}`). Run `npm run typecheck`.

- [ ] **Step 5: Run — PASS** (notifier tests + full suite).
- [ ] **Step 6: Commit** — `feat(reporting): English cardsV2 notifications (#1/#3/#5)`.

---

### Task 8: Config `GOOGLE_CHAT_WEBHOOK_TEAM` + team sender wiring

**Files:** Modify `src/config/index.ts` (zod + `SECRET_KEYS`), `.env.example`, `src/runtime/xtmPollLoop.ts` (build team sender, pass to Dispatcher `senders.team`; add to `XtmPollLoopDeps`). Test: `tests/unit/config.test.ts`.

- [ ] **Step 1: Failing test** — config requires `GOOGLE_CHAT_WEBHOOK_TEAM` (a config without it throws); `secretValues(cfg)` includes the team url.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — add `GOOGLE_CHAT_WEBHOOK_TEAM: z.string().url()` to the schema (required, like `GOOGLE_CHAT_WEBHOOK_SYSTEM`); add its key to `SECRET_KEYS`. In `.env.example`: add `GOOGLE_CHAT_WEBHOOK_TEAM=` (with a comment) and mark `GOOGLE_CHAT_WEBHOOK_DAILY_REPORT` deprecated. In `xtmPollLoop.ts`: build `new GoogleChatSender(cfg.GOOGLE_CHAT_WEBHOOK_TEAM)`, pass to `Dispatcher` as `senders.team`; add `teamChatSender?` to `XtmPollLoopDeps` for test injection (mirror `chatSender`).
- [ ] **Step 4:** Add `GOOGLE_CHAT_WEBHOOK_TEAM=<provided team webhook>` to `.env` (NOT committed — gitignored). Run `npm run typecheck` + config test.
- [ ] **Step 5: Commit** — `git add src/config/index.ts .env.example src/runtime/xtmPollLoop.ts tests/unit/config.test.ts` → `feat(config): required GOOGLE_CHAT_WEBHOOK_TEAM + team sender wiring (#7)`.

---

### Task 9: Route accepted jobs to the team channel

**Files:** Modify `src/runtime/xtmPollCycle.ts` (`reportJob`). Test: `tests/integration/xtmCycle.test.ts`.

**Consumes:** `team` channel (Task 1), card notifier (Task 7).

- [ ] **Step 1: Failing test** — when a job's outcome is `accepted`, the outbox has BOTH a `chat:`-channel row AND a `team:`-channel row for it; a `new`/`relisted`/`failed` job has only `chat`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — in `reportJob`, after enqueuing the `chat` card, if the accept outcome is `accepted` (i.e. `acceptResults.get(jobKey)?.outcome === 'accepted'`), also `this.outbox.enqueue(\`team:${base}\`, JSON.stringify(card), capturedAt, 'team')` with the SAME card. Use the same `base` (jobKey|lifecycle|cycle) with channel `team`.
- [ ] **Step 4: Run — PASS** + full suite.
- [ ] **Step 5: Commit** — `feat(reporting): accepted jobs also notify the team channel (#4)`.

---

### Task 10: Daily report + 09:00 trigger

**Files:** Create `src/reporting/dailyReport.ts`; modify `src/runtime/xtmPollLoop.ts` (trigger + heartbeat team-no-page), `src/state/meta.ts` (`lastDailyReportDate`). Test: `tests/unit/dailyReport.test.ts` + `tests/integration/xtmPollLoop.test.ts`.

**Consumes:** `listByLifecycle` (Task 4), `buildCard` (Task 6), `formatReadableDate` (Task 5), `team` channel.
**Produces:** `dueDailyReport(nowMs, lastSentDate, hour=9): boolean`; `bangkokDate(nowMs): string` (`YYYY-MM-DD`); `buildDailyReportCard(heldJobs, nowMs, xtmUrl): {cardsV2}`.

- [ ] **Step 1: Failing tests** (pure): `bangkokDate(Date.parse('2026-06-24T18:00:00Z'))` === `'2026-06-25'` (UTC 18:00 = Bangkok 01:00 next day) — proves +7 TZ-independence; `dueDailyReport`: before 09:00 Bangkok → false; ≥09:00 & lastSent ≠ today → true; ≥09:00 & lastSent === today → false; new day resets. `buildDailyReportCard([j1,j2],…)` → header `📋 Jobs in Progress (2)`, a row per held job; empty list → `(0)` with a "no jobs" line.

```ts
it('bangkokDate is +7 TZ-independent', () => {
  expect(bangkokDate(Date.parse('2026-06-24T18:00:00Z'))).toBe('2026-06-25');
});
it('dueDailyReport gates on hour and last-sent', () => {
  const am10 = Date.parse('2026-06-25T03:00:00Z'); // 10:00 Bangkok
  const am8  = Date.parse('2026-06-25T01:00:00Z'); // 08:00 Bangkok
  expect(dueDailyReport(am8, '2026-06-24')).toBe(false);
  expect(dueDailyReport(am10, '2026-06-24')).toBe(true);
  expect(dueDailyReport(am10, '2026-06-25')).toBe(false);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `dailyReport.ts`:**

```ts
export function bangkokDate(nowMs: number): string {
  const d = new Date(nowMs + 7 * 3_600_000); const p = (n:number)=>String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())}`;
}
function bangkokHour(nowMs: number): number { return new Date(nowMs + 7 * 3_600_000).getUTCHours(); }
export function dueDailyReport(nowMs: number, lastSentDate: string | null, hour = 9): boolean {
  return bangkokHour(nowMs) >= hour && bangkokDate(nowMs) !== lastSentDate;
}
export function buildDailyReportCard(held: XtmJobState[], nowMs: number, xtmUrl: string): { cardsV2: unknown[] } {
  const rows = held.map((j) => ({ label: dash(j.projectName), value: `${dash(j.fileName)} · due ${formatReadableDate(j.dueDate ?? j.dueRaw)} · ${dash(j.words)}w` }));
  return buildCard({ cardId: `daily-${bangkokDate(nowMs)}`, headerTitle: `📋 Jobs in Progress (${held.length})`, headerSubtitle: bangkokDate(nowMs), rows: rows.length ? rows : [{label:'—', value:'No jobs in progress'}], buttonUrl: xtmUrl });
}
```

- [ ] **Step 4: Add `MetaStore.lastDailyReportDate`** getter (`this.get('last_daily_report_date') ?? null`) + setter.

- [ ] **Step 5: Wire the trigger** in `xtmPollLoop.runOnce`, after the cycle: 
```ts
if (dueDailyReport(this.clock.nowMs(), this.meta.lastDailyReportDate)) {
  const held = this.store.listByLifecycle('accepted');
  const card = buildDailyReportCard(held, this.clock.nowMs(), this.cfg.XTM_ACOLAD_OFFERS_URL);
  const date = bangkokDate(this.clock.nowMs());
  this.db.transaction(() => {   // crash-safe: enqueue THEN meta in one txn
    this.outbox.enqueue(`daily:${date}`, JSON.stringify(card), this.clock.nowIso(), 'team');
    this.meta.set('last_daily_report_date', date);
  })();
}
```
(Inject what's missing — the loop needs `store`/`meta`/`db`; follow how it already reaches the outbox.)

- [ ] **Step 6: Heartbeat team-no-page** — in the loop's `stuck` computation (`~line 228`), exclude `team`-channel dead rows from the heartbeat-fail condition: replace `this.outbox.countByStatus('dead') > 0` with a count that ignores `team` (add `Outbox.countDeadExcludingChannel('team')` or filter). A team failure still surfaces via the `onDead` system alert, just not `/fail`.

- [ ] **Step 7: Run** the new pure tests + an integration test (inject a clock at 10:00 Bangkok, 2 accepted jobs → a `daily:<date>` team outbox row appears once; a second cycle same day → no new row). Full suite + typecheck.

- [ ] **Step 8: Commit** — `feat(reporting): daily 09:00 held-jobs report to team channel (#3/#6/#9)`.

---

### Task 11: English system alerts + `daily_report_dead`

**Files:** Modify `src/reporting/systemAlerts.ts` (English `TRIGGERS` + new trigger + card), `src/runtime/xtmPollLoop.ts` (recon ping stays `{text}` — verify), `specs/002-xtm-detect-accept/contracts/notifications.md`. Test: `tests/unit/systemAlerts.test.ts`.

- [ ] **Step 1: Failing tests** — each alert renders an English card (assert no Thai chars in title/impact/action, header present); a `daily_report_dead` trigger exists and its text names the date.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** — translate ALL 9 `TRIGGERS` entries' `title`/`impact`/`action` from Thai to English (e.g. `cold_start_repeat`: title "Cold start repeated", impact "started with no baseline twice in 7 days", action "check the state DB"); render the alert as a card via `buildCard` (header = severity emoji + title; rows = Impact, Action, Detail). Add `daily_report_dead` trigger. Wire the dispatcher `onDead` for a `daily:`-prefixed event to raise `daily_report_dead` with the date.
- [ ] **Step 4: Update `contracts/notifications.md`** to the English/card templates (replace the Thai text templates).
- [ ] **Step 5: Run — PASS** + full suite.
- [ ] **Step 6: Commit** — `feat(reporting): English system-alert cards + daily_report_dead (#5/#8)`.

---

### Task 12: Full gate + migrate remaining tests + deploy

- [ ] **Step 1:** Grep for any remaining `{ text:` enqueues / `.send('` string calls / Thai strings in `src/reporting/` and `src/runtime/`; migrate stragglers (e.g. `sheetsOutbox.test.ts` payloads) to the union. 
- [ ] **Step 2: Full gate:** `npm test` (all green), `npm run typecheck`, `npm run lint`, `npm run test:coverage` (detection/state/reporting ≥ 80%).
- [ ] **Step 3:** superpowers:finishing-a-development-branch — merge `feat/notification-overhaul` → main, then `npm run deploy`.
- [ ] **Step 4: Ops-verify:** next accepted Malay job shows the English card in BOTH system + team channels; at 09:00 the held-jobs report lands in the team channel; dates read `DD/MM/YYYY HH:mm`; no false heartbeat page from a team hiccup.

---

## Self-Review

**Spec coverage:** req1 cards → T6/T7; req2 dates → T5; req3 daily 09:00 → T10; req4 team channel → T1/T8/T9/T10; req5 English → T7/T11. Plumbing P1→T1, P2→T2, P3→T3, P4→T1, P5→T4, P6→T8(team sender)/T11(recon ping). All Critical/Important review items have a task. No gap.

**Placeholder scan:** code steps carry real code; the dispatcher 400-status surfacing (T3) is spelled out via `sendDetailed`; the systemAlerts translation (T11) gives the approach + an example + names all 9 triggers to translate (the strings are transcribed from the existing Thai by the implementer — not deferred logic).

**Type consistency:** `ChatPayload`/`ChatSender.send(payload)` (T2) consumed by T3 dispatcher + T8 senders; `OutboxChannel 'team'` (T1) used by T3/T9/T10; `buildCard` opts (T6) consumed by T7/T10/T11; `formatReadableDate` (T5) by T7/T10; `listByLifecycle` (T4) by T10; `dueDailyReport`/`bangkokDate` (T10) self-consistent; `lastDailyReportDate`/`set('last_daily_report_date')` consistent.
