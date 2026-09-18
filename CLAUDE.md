# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

บอทเฝ้าพอร์ทัล Acolad ตลอด 24/7: ตรวจจับงานแปลใหม่ → แจ้งเตือน Google Chat
ภายใน 60 วินาที. ฟีเจอร์ 001 จับงานที่ partner.acolad.com (ถอดออกแล้ว);
**ฟีเจอร์ 002 (live อยู่) ย้ายไป XTM Cloud (Tasks→Active)** + กดรับงานมาเลย์
อัตโนมัติ (bulk) + บันทึก task ทุกงานลง Google Sheets — กดรับเฉพาะคู่ภาษา
มาเลย์ MS (ดู [[acolad-malay-only-rule]])

**ฟีเจอร์ 003 (live 2026-09-16)** เพิ่มบอท**ตัวที่สอง** `jobcatch-straker` — HTTP
ล้วน ไม่ใช้ browser — แข่งคว้างานที่พอร์ทัล Straker (`vendr.straker.ai`) ดู
[[straker-bot-live-trial-ceiling]]

> **มีบอทสองตัวรันแยกกันบน PM2 — อย่าคิดว่ามีตัวเดียว**: `acolad-bot` (XTM,
> Playwright, port 47811, `state/acolad.db`) และ `jobcatch-straker` (HTTP, port
> 47812, `state/straker/straker.db`, Sheet + ห้อง Chat ของตัวเอง). แยกขาดจากกัน
> ตั้งใจ (R11) — มีจุดเดียวที่ต่อกันคือรายงาน 09:00 ของ XTM ที่แสดง workload รวม
> สองพอร์ทัล

**สถานะปัจจุบัน**: ฟีเจอร์ 002 **live** (auto-accept งานมาเลย์ ตั้งแต่ 2026-06-22) +
**accept-scheduling gate live** ตั้งแต่ 2026-06-27 (PR #7/#8) + **ฟีเจอร์ 003 live
2026-09-16** (PR #30/#31). 1691 tests ผ่าน, coverage 6 area ≥ 80%
(detection/state/reporting/schedule/straker/shared), lint + typecheck สะอาด.

> **ค้างอยู่และเป็นงานของเจ้าของ (RP-1)**: รหัสผ่าน Straker เคยส่งผ่านแชต ถือว่ารั่ว
> — ต้อง rotate แล้วลบ `state/storageState.json`. บอท sign-in ทุก 10 วินาที

> **3 สวิตช์ accept — อย่าสับสน**: `ACCEPT_ENABLED` คุมการกดรับ *ทั้งหมด* (0 =
> detect+notify อย่างเดียว ไม่กดรับ); `ACCEPT_SCHEDULE_ENABLED` คุม *แค่ตาราง* (0 =
> กดรับ 24/7 ไม่จำกัดเวลา/วันหยุด/โควต้า — พฤติกรรมก่อน PR #7);
> `ACCEPT_EFFORT_METRIC` คุม *metric วัด effort* (`wwc` ค่า default ของโค้ด — cap/throughput
> ใช้ File WWC หลังหัก TM คู่กับ `ACCEPT_MAX_WWC_PER_DAY`;
> `words` = พฤติกรรมเดิม byte-for-byte). **live = `=1`/`=1`/`=words` +
> `ACCEPT_MAX_WORDS_PER_DAY=3500` (สลับจาก wwc/1000 → words/3500 เมื่อ 2026-07-02;
> throughput derived ≈ 389 คำ/ชม.)**.
> **`ACCEPT_MAX_PER_CYCLE=0` ต้องเป็น 0 เสมอ** (bulk กดทั้งกลุ่มในคลิกเดียว — cap>0
> อันตราย, ดู `acceptDecision.ts`). accept menu D4/D6 ยืนยันจากงานจริง (inline
> `[data-dropdown-menu]`, หลังรับเปลี่ยนเป็น "Finish task"). design:
> `docs/superpowers/specs/2026-06-26-xtm-accept-schedule-capacity-design.md`. ดู
> [[xtm-accept-d6-finish-task]], [[acolad-accept-schedule-feature]].

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:

**Current feature**: 003-straker-offer-race (ตรงกับ `.specify/feature.json`)
**Current plan**: specs/003-straker-offer-race/plan.md
**Spec**: specs/003-straker-offer-race/spec.md
**Tasks**: specs/003-straker-offer-race/tasks.md (สร้างด้วย /speckit-tasks)
**Design artifacts**: specs/003-straker-offer-race/ (research.md, data-model.md, quickstart.md, contracts/, release-preconditions.md, xtm-baseline.md)
**ฟีเจอร์ก่อนหน้า**: specs/002-xtm-detect-accept/ (ยัง live — 003 ไม่ได้แทนที่ 002)
**Constitution**: .specify/memory/constitution.md (v1.0.1 — 8 principles, gate ทุก plan/PR)
**Stack**: Node.js 22 + TypeScript strict, Playwright (Chromium), SQLite (better-sqlite3), googleapis (Sheets), pino, zod, PM2 บน Windows 11

> 002 ย้ายเป้าหมายจาก partner.acolad.com → **XTM Cloud (Tasks→Active)** + กดรับงาน
> มาเลย์อัตโนมัติ (bulk) + log ทุกงานลง Google Sheets. แกน 001 (diff/state/outbox/
> dispatcher/heartbeat) reuse — เปลี่ยนแค่ src/portal/ (XTM) + เพิ่ม reporting/sheets.ts.
> งานแรก = recon XTM จริงเก็บ evidence. ดู [[acolad-jobs-live-in-xtm-not-partner]]
<!-- SPECKIT END -->

## Workflow

งานทั้งหมดขับเคลื่อนด้วย Spec Kit: `/speckit-specify` → `/speckit-clarify` →
`/speckit-plan` → `/speckit-tasks` → `/speckit-analyze` → `/speckit-implement`
— feature ที่ active ชี้โดย `.specify/feature.json`

**Constitution เป็นกฎสูงสุด (non-negotiable)** — ข้อที่กระทบงานเขียนโค้ดตรงๆ:

- TDD บังคับสำหรับ core logic (`src/detection/`, `src/state/`,
  `src/reporting/`, `src/schedule/`): เขียน test ก่อน ต้อง FAIL ก่อน implement;
  coverage gate ≥ 80% เฉพาะสี่โมดูลนี้
- Failure-mode suite เป็นข้อบังคับ (login fail, session expiry, timeout,
  malformed jobs, quota/auth error, restart กลางรอบ)
- Live-portal tests อยู่หลัง env flag `LIVE_PORTAL=1` เท่านั้น — **ห้ามรันใน CI**
- ทุกการละเมิดหลักการต้องบันทึกใน Complexity Tracking ของ plan.md
  (มี 2 รายการแล้ว: daily summary deferred, at-least-once window)

## Commands

ติดตั้งครั้งแรก (Windows / PowerShell):

```powershell
npm install
npx playwright install chromium      # บอทใช้ Chromium ของ Playwright เท่านั้น
Copy-Item .env.example .env          # แล้วเติมค่าจริง (ดูหัวข้อ Environment)
# วาง google-credentials.json (service account) ที่ราก repo — gitignored
```

งานประจำ:

```powershell
npm run lint            # ESLint + Prettier — ต้อง 0 error
npm run typecheck       # tsc --noEmit (strict)
npm test                # Vitest unit + integration (fixtures เท่านั้น)
npx vitest run tests/unit/xtmDiff.test.ts  # รัน test ไฟล์เดียว
npm run test:coverage   # gate ≥ 80% บน detection/state/reporting/schedule
npm run poll:once       # รันรอบเดียวจบ (smoke) — เพิ่ม $env:LIVE_PORTAL='1' สำหรับ portal จริง
npm run deploy                      # = -Target xtm (ค่าปริยาย — restart เฉพาะ acolad-bot)
npm run deploy -- -Target straker   # restart เฉพาะ jobcatch-straker
npm run deploy -- -Target both      # xtm ก่อน แล้ว straker; ถ้าตัวแรกล้ม ตัวที่สองไม่รัน
# ห้าม `pm2 restart` ด้วยมือ — มัน skip stop-and-wait แล้วทิ้ง orphan/ชน lock
# แก้โค้ดที่ src/reporting/, src/runtime/, src/straker/combinedSummary.ts = กระทบ XTM ด้วย -> ใช้ both
npm run outbox:requeue  # ops: คืนรายการแจ้งเตือน dead → pending (ฐานข้อมูล XTM)
npm run straker:outbox:requeue  # ops: อันเดียวกันสำหรับ Straker — คนละ db คนละสคริปต์ (R11)
npm run straker:unbar           # ops: ปลดล็อกหลังพอร์ทัลแบนบัญชี (403) — ต้องรันมือเท่านั้น
npm run straker:win-rate        # ops: win rate ของ Straker (FR-017) — อ่านอย่างเดียว
npm run report:combined         # ops: workload สองพอร์ทัลรวมกัน (FR-018) — อ่านอย่างเดียว
npm run report:latency  # สรุป p95 จาก log สำหรับตรวจรับ SC-001/SC-002
npm run report:catch-rate  # สรุปอัตราจับงานทันใน <1 นาที (snatch window)
npm run xtm:recon       # รัน live recon เก็บ evidence โครงสร้าง XTM (ต้องตั้ง .env)
```

เกณฑ์ตรวจรับ = ตาราง V1–V16 ใน `specs/002-xtm-detect-accept/quickstart.md`
(SC เป็น authoritative เหนือ FR ในการวัดผล)

## Architecture

วงจรหลัก (อ่าน plan.md + data-model.md + contracts/ ประกอบ):

```
main/once → bootstrap.createXtmBot() ประกอบทุกชิ้น (DB, browser, client, loop)
  → XtmPollLoop.runOnce()              [src/runtime/xtmPollLoop.ts — orchestration shell]
       (maybeRecycle → ensure Sheet header → fetchJobSnapshot → cycle → flush → heartbeat)
  → PlaywrightXtmClient.fetchJobSnapshot(cycleId)  [src/portal/xtmClient.ts]
       (navigate Active → silent re-login เมื่อ session หมด → อ่าน grid ใน iframe)
  → XtmPollCycle.run(snapshot)         [src/runtime/xtmPollCycle.ts — detect→decide→GATE→accept→record]
       (diffXtm = transition owner · decideAccept + acceptSchedule gate = pure ·
        per bulk-group all-or-nothing · claimForAccept atomic)
  → persist state + enqueue outbox (chat + sheets) ใน SQLite txn   [src/state/]
  → Dispatcher.flush → Google Chat webhook + Google Sheets sink    [src/reporting/]
  → heartbeat ok / fail (เมื่อ outbox dead) Healthchecks           [src/monitoring/]
```

**Entry points** (`src/runtime/`): `main.ts` = ลูป 24/7 (PM2), `once.ts` =
รอบเดียวจบ (`poll:once`), `bootstrap.ts` = `createXtmBot()` ประกอบทุกชิ้น,
`requeue.ts`/`latencyReport.ts`/`catchRateReport.ts` = ops scripts.

**Module map** (`src/`):

| โฟลเดอร์ | หน้าที่ | ไฟล์สำคัญ |
|---|---|---|
| `detection/` | logic บริสุทธิ์ (TDD + coverage gate) | `diff.ts` (engine `diffGeneric`), `xtmDiff.ts`, `eligibility.ts`, `acceptDecision.ts`, `jobKey.ts`, `types.ts` |
| `schedule/` | **มาตรฐานวันเวลารับงานกลาง — ใช้ร่วมทุกบอท** (pure, TDD + coverage gate) | `acceptSchedule.ts` (`evaluateAcceptSchedule` — ทำทันไหม), `windowCapacity.ts` (`decideWindowCapacity` — เพดานแบบ window; Straker `ledger.ts` + XTM cycle เรียกตัวนี้), `workingHours.ts` (`workingMinutesBetween`), `bangkokCalendar.ts` (canonical Bangkok time — อย่า duplicate +7h logic), `parseSchedule.ts` (`resolveThroughput`), `thaiHolidays.ts` + `thaiHolidaysData.ts` (team-curated holidays) |
| `state/` | SQLite (TDD + coverage gate) | `db.ts`, `xtmJobStore.ts` (job state), `jobStore.ts` (accept state machine), `outbox.ts`, `meta.ts` (baseline/cursor) |
| `portal/` | Playwright I/O เฉพาะ XTM | `xtmClient.ts` (impl ของ interface), `xtmInbox.ts` (อ่าน grid ใน iframe), `xtmLogin.ts`, `xtmAccept.ts`, `xtmAcceptRecon.ts`, `selectors.ts` (รวมศูนย์), `evidence.ts`, `htmlSanitize.ts`, `errors.ts` |
| `reporting/` | ส่งออก (TDD + coverage gate) | `dispatcher.ts` (channel→sender + payload-shape routing), `googleChat.ts` (`ChatPayload` union), `chatCard.ts`/`cardText.ts`/`dateFormat.ts` (cardsV2 builder + helpers), `sheets.ts` (Sink + Sender — scrape **File WWC** [Weighted Word Count] จาก Active grid ลง PM_Tracking Sheet; Sheet **v3**: 14 คอลัมน์, File WWC ที่คอลัมน์ **I**, `_job_key` ที่ **N** — ย้ายจาก v2 13 คอลัมน์/`_job_key` ที่ M), `xtmNotifier.ts` (EN card builders), `dailyReport.ts` (รายงาน 09:00), `systemAlerts.ts` (EN alert cards) |
| `runtime/` | orchestration + entry points | (ดู Entry points ด้านบน) + `rateLimiter.ts`, `scheduler.ts` |
| `monitoring/` | สุขภาพระบบ | `heartbeat.ts` (Healthchecks), `logger.ts` (pino + redaction) |
| `shared/` | ใช้ร่วมกัน**สองบอท** (มี coverage gate) | `outboxRetry.ts` (ตารางเวลา retry), `rollingLogger.ts` (rotation/retention/censor), `sqliteOpen.ts` (open→WAL→migrate→quarantine) |
| `straker/` | **บอทตัวที่สอง ครบวงจรในตัวเอง** (มี coverage gate) | `httpClient.ts` (transport ที่เดียว — DC-4), `pollCycle.ts` (fetch→diff→gate→act→persist→notify — ชื่อ step เดียวกับ XTM จงใจ), `claim.ts`/`claimDecision.ts`/`claimOutcome.ts`, `reconcile.ts` (ทุก 15 นาที — คืนโควต้างานที่เสร็จ), `ledger.ts` (เพดานรายวันทำงาน ตัดแบบ earliest-deadline-first — ต่างจาก XTM), `strakerStore.ts`/`outbox.ts`, `notifier.ts`/`trackingSink.ts`/`dispatcher.ts`, `combinedSummary.ts` (อ่านสองพอร์ทัล read-only), `main.ts` (composition root) |

**R11 bulkhead — กฎที่ test บังคับ ไม่ใช่สไตล์**: ไฟล์ใน `src/straker/**` **ห้าม
value-import** `src/state/` หรือ `src/config/` (ข้อยกเว้น type-only ตัวเดียวที่บันทึกไว้:
`outcomePolicy.ts`) และฝั่ง XTM มีไฟล์เดียวที่เอื้อมเข้า `src/straker/` ได้คือ
`runtime/xtmPollLoop.ts` → `combinedReportRows`. เพิ่ม import ใหม่ = `isolation.test.ts`
แดงทันที. อีกกฎคู่กัน **DC-4**: ทุกอย่างที่ยิง request ต้องอยู่ใน `httpClient.ts` ไฟล์เดียว

**XtmPortalClient** (interface ใน `src/portal/xtmClient.ts`) แยก Playwright I/O
ออกจาก orchestration — `XtmPollCycle` พึ่ง interface `XtmAcceptor`/`ClosedReader`
จึงทดสอบได้ด้วย stub (`tests/integration/xtmCycle.test.ts`,
`tests/integration/xtmPollLoop.test.ts`). Clock/RateLimiter inject ได้เพื่อทดสอบ
เวลา/เพดาน. งานจริงอยู่ใน **iframe** ของแท็บ Active (ดู `src/portal/xtmInbox.ts`)

หลักออกแบบที่ต้องรักษา (มาจาก clarifications/analyze/review — ไม่ใช่สไตล์):

- **`detection/diff.ts` เป็นเจ้าของ state transition แต่เพียงผู้เดียว**
  (first_seen / missing เมื่อไม่พบ ≥ 2 รอบติด / relisted) — store แค่ persist
  ผลลัพธ์ ห้ามตัดสินซ้ำ. ปัจจุบัน `diff.ts` export `diffGeneric` + `DiffAdapter`
  (engine กลาง reuse ได้) และ XTM เข้าผ่าน `detection/xtmDiff.ts` (`diffXtm`).
  สถานะ accept แยกเป็น state machine ใน `state/jobStore.ts`
  (`claimForAccept` atomic กัน double-accept → `recordAcceptOutcome`)
- **Appearance-event model**: งานหนึ่งงานมีได้หลาย "การปรากฏ" — dedup ทำ
  ที่ระดับการปรากฏ ไม่ใช่ตลอดชีพงาน; งานที่หายแล้วกลับมา → แจ้งซ้ำพร้อม
  ป้าย "งานกลับมาอีกครั้ง"
- **Outbox pattern**: เหตุการณ์ทุกประเภท (งาน + system alert) ไหลผ่าน
  ตาราง outbox เดียว — ห้ามส่งแจ้งเตือนตรงโดยไม่ผ่าน outbox; การส่งเป็น
  at-least-once (mark sent ทันทีหลัง 2xx — ข้อยกเว้นบันทึกแล้ว)
- **ส่งงานละ 1 ข้อความเสมอ ไม่มี batch** (ตัดสินใจแล้วใน /speckit-analyze
  — อย่าเพิ่มกลับ); แจ้งเตือนเป็น **Google Chat cardsV2 ภาษาอังกฤษ** วันที่อ่านง่าย
  แบบ Bangkok `DD/MM/YYYY HH:mm` (ผ่าน `reporting/dateFormat.ts` + `chatCard.ts` +
  `cardText.ts`) — *ไม่ใช่* Thai/ISO-8601 แบบเดิมแล้ว. งานที่กดรับ + รายงานสรุป
  ประจำวัน 09:00 (`reporting/dailyReport.ts`) ส่งเข้า **team channel** เพิ่ม
  (`GOOGLE_CHAT_WEBHOOK_TEAM`). template อ้างอิงใน contracts/notifications.md
- **Fail loud**: selector/marker หาย, locale เปลี่ยน, เจอ pagination,
  CAPTCHA → เก็บ evidence (sanitized) + system alert — ห้ามเดา parse
  ห้ามทำงานต่อเงียบๆ; selector รวมศูนย์ที่ `src/portal/selectors.ts` ไฟล์เดียว
- **Evidence-first parser** — parser พัฒนาจาก fixtures ใน `tests/fixtures/`
  (`xtmPages.ts` สังเคราะห์จากโครงสร้าง XTM จริงที่เก็บมา) + มี evidence mode
  (`npm run xtm:recon`, `ACCEPT_RECON=1`) เก็บ HTML/screenshot งานจริง
  ตัวแรกไว้ยืนยัน selector ก่อนพึ่ง parse

## Environment

config โหลด+ตรวจด้วย zod ใน `src/config/index.ts` — **fail-fast ตอน start**
พร้อมชื่อ var ที่ผิด. คำอธิบายครบทุกตัวอยู่ใน `.env.example` (อย่า duplicate
ที่นี่). ตัวที่ **required** (ไม่มี = บอทไม่ start):

- XTM: `XTM_ACOLAD_PORTAL_URL`, `XTM_ACOLAD_OFFERS_URL`, `XTM_ACOLAD_Company`,
  `XTM_ACOLAD_Username`, `XTM_ACOLAD_Password`
- Sheets: `GOOGLE_SHEETS_ID`, `SHEETS_TAB_NAME` + ไฟล์ `google-credentials.json`
- แจ้งเตือน/heartbeat: `GOOGLE_CHAT_WEBHOOK_SYSTEM`, `GOOGLE_CHAT_WEBHOOK_TEAM`
  (กลุ่มทีม — daily report + งานที่กดรับ; secret + redacted), `HEALTHCHECKS_PING_URL`

**บอท Straker มี config คนละชุด** (`src/straker/config.ts` — โหลดแยก ไม่ใช้
`src/config/index.ts` เพราะ R11) ตัวที่ required: `STRAKER_BASE_URL`,
`STRAKER_LOGIN_ID`, `STRAKER_PASSWORD`, `STRAKER_MAX_WORDS_PER_DAY`,
**`STRAKER_DTP_MAX_WORDS_PER_DAY`** (เพดานงาน DTP แยกต่างหาก — required ตั้งแต่
2026-09-17), `STRAKER_SHEETS_ID`, `STRAKER_CHAT_WEBHOOK_OFFERS`,
`STRAKER_HEALTHCHECKS_PING_URL` + ใช้ `GOOGLE_CHAT_WEBHOOK_SYSTEM` และ
`GOOGLE_SERVICE_ACCOUNT_KEY_PATH` **ร่วมกับ XTM โดยตั้งใจ** (on-call ดูที่เดียว —
ตัวแปรเดียวกันคือสิ่งที่กันไม่ให้สองบอทหลุดไปคนละห้อง)

ตัวคุม accept (`ACCEPT_*`) + tuning (`POLL_INTERVAL_MS` ฯลฯ) มี default
ปลอดภัย — `ACCEPT_ENABLED`/`ACCEPT_RECON` ปริยาย = ปิด. กลุ่ม **`ACCEPT_SCHEDULE_*`**
(schedule gate: `ACCEPT_SCHEDULE_ENABLED` ปริยาย = **เปิด**, `ACCEPT_HOURS_START/END`,
`ACCEPT_WORKDAYS`, `ACCEPT_MAX_WORDS_PER_DAY`, `ACCEPT_THROUGHPUT_WORDS_PER_HOUR`,
`ACCEPT_MAX_WWC_PER_DAY`, `ACCEPT_THROUGHPUT_WWC_PER_HOUR`) +
**`ACCEPT_EFFORT_METRIC`** (metric toggle: `wwc` ปริยาย — cap/throughput pair เลือกตาม
metric; `words` = พฤติกรรมเดิม) — อย่าสับสน `ACCEPT_ENABLED` (กดรับทั้งหมด) กับ
`ACCEPT_SCHEDULE_ENABLED` (แค่ตาราง) กับ `ACCEPT_EFFORT_METRIC` (metric วัด effort).

## auto-accept (เปิดใช้งานแล้ว — runbook อ้างอิง)

accept **เปิด live แล้ว** ตั้งแต่ 2026-06-22: `ACCEPT_ENABLED=1`,
**`ACCEPT_MAX_PER_CYCLE=0`**, `ACCEPT_RECON=0`. D4/D6 ยืนยันจากงานจริงแล้ว
(ดู [[xtm-accept-d6-finish-task]]). พฤติกรรม + ข้อควรระวัง:

- กดรับงานมาเลย์ที่ present + ยังไม่เคยรับ (ไม่ใช่แค่ตอนปรากฏใหม่) → log "Accepted" + Chat ✅
- **`ACCEPT_MAX_PER_CYCLE` ต้องเป็น 0**: portal bulk กดทั้งกลุ่มในคลิกเดียว — cap>0 ทำให้
  งานพี่น้องในกลุ่มถูกกดบน portal แต่บันทึก 'none' แล้ว robustness pass กดซ้ำ → false alert
  (ดู `acceptDecision.ts`)
- post-accept re-read **reload หน้าก่อนเช็ค** (เมนู Accept→Finish สะท้อนหลัง reload);
  re-read ว่าง = grid race → ตัดเป็น failed (ไม่ใช่ missing); probe ไม่เจอ target → log loud
- เฝ้า latency V16/V16b: `npm run report:latency` + heartbeat เขียว

## accept-scheduling gate (live — PR #7/#8; capacity re-keyed to deadline-day + held-derived workload report — PR #14)

`src/schedule/` กรองการ **"กดรับ"** เพิ่มอีกชั้นหลัง `decideAccept()` (detect+notify ยัง
24/7 ไม่แตะ). กดรับงานมาเลย์ก็ต่อเมื่อครบทุกข้อ: ไม่เกิน **capacity** (window — ดูด้านล่าง) · รู้ DL ·
รู้คำ · **ทำทันในเวลางาน** (`ชม.ทำงานถึง DL × throughput ≥ คำ`). **DL ตรงเสาร์-อาทิตย์/วันหยุด
ไม่ใช่เหตุผลปฏิเสธแล้ว** (มาตรฐานกลาง 2026-09-18) — วันหยุดแค่ไม่มีชั่วโมงทำงาน. งานที่บล็อก → lifecycle `'rejected'` → Sheet status **`Rejected`** +
เหตุผลใน Note + Chat; `accept_status` คง `'none'` (robustness pass ลองใหม่ได้).

- **gate ตัดสินระดับ bulk-group all-or-nothing** — `bulkGroupKey` = **language-only**
  (ตรงกับ `byLang` ของ `xtmAccept.ts`; กลุ่มผ่านเมื่อทุกตัวผ่าน) กัน "owned-but-Rejected"
  ที่ bulk คลิกเดียวคว้าทั้งกลุ่ม (irreversible). **ปิดด้วยข้อมูล (2026-06-27)**: Sheet 14/14
  รอบมี Malay 1 project/รอบ (0 รอบที่มี ≥2 project) → language-only = 1 project/รอบอยู่แล้ว →
  ปรับเป็น `(lang,project)` ได้ผลเหมือนเดิม **ไม่จำเป็น** (revisit เมื่อเริ่มเห็นหลาย project/รอบ)
- **throughput derived จาก capacity** (`ACCEPT_MAX_WORDS_PER_DAY ÷ ชม.ทำงาน/วัน ≈ 111`) —
  ปุ่มเดียว; override ได้ด้วย `ACCEPT_THROUGHPUT_WORDS_PER_HOUR` (config refine ทั้งหมด
  gate หลัง `ACCEPT_SCHEDULE_ENABLED` เพื่อให้ kill-switch ปิดได้เสมอ)
- **วันหยุด = ไฟล์กรอกมือ** `schedule/thaiHolidaysData.ts` (`HOLIDAYS` + `CURATED_YEARS`)
  ไม่มี library — ทีมหยุด **นักขัตฤกษ์ + วันชดเชย (in-lieu)** แต่ไม่หยุด **วันหยุดพิเศษ ครม.**
  (long-weekend bridges → library จะใส่วันพิเศษที่ทีมทำงาน → reject ผิด; ดู
  [[acolad-holidays-nakkhatrik-not-cabinet]]). ปี **uncurated**
  (ไม่อยู่ใน `CURATED_YEARS`) → accept **fail-closed** (Reject + `holiday_calendar_stale`),
  report **fail-open** (ส่งปกติ). **2026 แก้ in-lieu + 2027 เพิ่ม+curated แล้ว (PR #11)** — เหลือ
  reconfirm วันจันทรคติ 2027 (มาฆ/วิสาข/อาสาฬห/เข้าพรรษา) กับประกาศราชกิจจาฯ ทางการเมื่อออก
- **capacity = held-derived, keyed to effective deadline day (PR #14/#19), ตัดสินแบบ window
  (มาตรฐานกลาง 2026-09-18):** งานถูกผูกกับ **effective deadline day** (วันทำงานที่งานไปตกจริง —
  DL เวลาก่อน 09:00 ถูกชาร์จเข้า cap ของ**วันทำงานก่อนหน้า** ไม่ใช่วันที่ DL ดิบ; ดู `schedule/deadlineDay.ts`)
  อ่านจาก held list (`XtmJobStore.effortDueByDeadline()`) **ไม่ใช่วันกดรับ**
  → **งาน finish คืนโควต้า** (source เดียว = held; ไม่มี meta word-counter แล้ว). ทุกวัน DL *d* ตั้งแต่วัน
  แรกของกลุ่ม: งานที่ due ≤ *d* ต้อง ≤ `วันละ × นาทีทำงานที่เหลือถึงสิ้น d ÷ 540` (ขั้นต่ำ 1 วัน);
  `วันละ` = cap หรือ `throughput × ชม.ทำงาน` ถ้าน้อยกว่า. งาน overdue นับเป็นวันนี้. ตัดสินด้วย pure
  helper `schedule/windowCapacity.ts` (`decideWindowCapacity` — **ตัวเดียวกับ Straker**, all-or-nothing
  per bulk-group **ครอบทั้ง feasibility + capacity** กัน owned-but-Rejected); seed จาก held ครั้งเดียว/รอบ **ก่อน** record
  (memoize, advance per-DL-day). audit: `XtmCycleSummary.acceptedDueDays` log `resultingBucketEffort` ตอน accept
- daily report 09:00 (`dailyReport.ts`) ส่ง **เฉพาะวันทำการ** (PR #8) **และเฉพาะเมื่อมี
  อะไรจะรายงาน** (PR #32) — ไม่มีงานถือ + อีกพอร์ทัลก็ว่าง = **ไม่ส่ง** แล้ว log
  `action:daily_report outcome:skipped` แทน (เงียบเพราะออกแบบ ≠ เงียบเพราะพัง — ดูจาก log
  บรรทัดนั้น และ heartbeat ต้องยังเขียว). กฎ fail-safe: แถวที่ระบบไม่รู้จัก = ถือว่ามีเนื้อหา
  แล้วส่ง — **`📋 Daily Report`:
  Due today (Σ คำ held ที่ **effective deadline day = วันนี้** — งานที่ DL เวลาก่อน 09:00 นับเข้า**วันทำงานก่อนหน้า**
  ไม่ใช่วันที่ปฏิทินดิบ; cutoff PR #19) / ⚠️ Overdue (instant `dueAtMs<now`) / In progress top-5 by
  deadline** สร้างจาก held list, **throw-safe + อยู่ใน try/catch ของ loop** (bug รายงานไม่ page; PR
  #14). ทุกวันที่ Bangkok ผ่าน `schedule/bangkokCalendar.ts` (canonical)

**runbook ของ gate:**

- **"ทำไมบอทไม่กดงาน X":** เปิด Google Sheet → ดู Status `Rejected` + reason ในคอลัมน์
  Note (และ pino log `module:scheduleGate action:reject` — มี jobKey/reason/words/effort/metric/dueDate) →
  ถ้าเหตุผลผิด (holiday ผิด / throughput ต่ำ / cap) แก้ config แล้ว `npm run deploy`.
  **หมายเหตุ cutoff:** งานที่ DL เวลาก่อน 09:00 (หรือ DL ตรงวันหยุด/เสาร์-อาทิตย์) ถูกชาร์จเข้า cap ของ
  **วันทำงานก่อนหน้า** (effective deadline day) → วันที่ในเหตุผล reject อาจไม่ตรงกับวัน DL ดิบ.
- **kill-switch:** `ACCEPT_SCHEDULE_ENABLED=0` + `npm run deploy` = กลับพฤติกรรมก่อน PR #7
  byte-for-byte (config refines ถูก gate ด้วย ENABLED → ปิดได้เสมอแม้ค่าอื่นเพี้ยน).
- **พฤติกรรมปกติ (ไม่ใช่ bug):** Malay = ภาษาเดียว = 1 bulk-group/รอบ → งาน
  infeasible/uncurated 1 ตัว → Malay **ทั้งรอบ**ถูก Reject (conservative all-or-nothing
  กัน owned-but-Rejected) — robustness pass ลองใหม่รอบหน้า.
- **page เพิ่ม:** `holiday_calendar_stale` (ปีปัจจุบัน uncurated) ตอนนี้ **fail heartbeat
  → page** (auto-accept ดับทั้งระบบ); `daily_cap_reached` = warn (Chat) แจ้งครั้งเดียว/**วัน DL
  (deadline day)** ที่ budget คำเต็มจริง (dedup `daily_cap_reached:<วันDL>` — 2 วัน DL ล้นในวัน
  Bangkok เดียวกันได้ 2 alert; PR #15); ไม่ใช่งานเดี่ยวใหญ่เกิน cap (อันนั้น = "accept manually").

## jobcatch-straker (live 2026-09-16 — runbook)

บอทตัวที่สอง **HTTP ล้วน ไม่มี browser**: อ่านรายการงานเปิดที่ `vendr.straker.ai`
ทุก 10 วินาที → ตัดสิน → **ยิง claim แข่งกับเวนเดอร์เจ้าอื่น**. ต่างจาก XTM ตรงที่
การคว้างาน**ย้อนกลับไม่ได้** ดีไซน์เลยเอียงไปทาง "ไม่คว้า" เสมอเมื่อไม่แน่ใจ.

**พฤติกรรมที่ดูเหมือน bug แต่ตั้งใจ — อ่านก่อนแจ้งว่าพัง:**

- **แพ้การแข่งแล้ว alert ทุกครั้ง** — `CONFIRMED_LOST_RACE_SIGNALS` ใน `claimOutcome.ts`
  **จงใจว่างเปล่า** จนกว่า RP-4 จะยืนยันสัญญาณจริงจากพอร์ทัล. ระหว่างนี้ทุกการถูกปฏิเสธ
  ถูกจัดเป็น `failed` ซึ่งเป็นฝั่งที่ปลอดภัย (FR-005a) แต่เสียงดัง. **ปิดเคสนี้ = เติมค่า
  เดียวลง array นั้น** หลังเห็นของจริงหนึ่งครั้ง (SC-007 ติดป้าย conditional ไว้แล้ว)
- **เพดานคือ "ต่อวันทำงาน" และ DL มีทุกวันทำงานก่อนหน้าให้ใช้** (2026-09-18 — ต่างจาก XTM):
  งานรับได้เมื่อ ทุกวันครบกำหนด d ตั้งแต่ DL ของงานนี้เป็นต้นไป งานที่ครบกำหนดภายใน d
  ≤ **เวลาทำงานที่เหลือจริงถึงสิ้นวัน d × (เพดาน ÷ 9 ชม.)** แต่ไม่ต่ำกว่าเพดานหนึ่งวัน.
  เช่น จันทร์ 09:00 รับงาน 4,000 คำ DL พุธได้ (27 ชม. = 10,500) แต่ถ้าเห็นตอนจันทร์ 17:45
  จะเหลือแค่ ~3,600. **อย่าเปลี่ยนเป็นนับ "จำนวนวัน"** — รอบแรกทำแบบนั้นแล้ว review เจอว่า
  รับ 6,800 คำตอน 17:45 ได้ (C-1). งานค้างที่เลย DL แล้วนับเป็นงานวันนี้.
  `exceeds_daily_ceiling_entirely` = ใหญ่กว่า**เวลาที่เหลือทั้งหมดก่อน DL** ไม่ใช่ใหญ่กว่าวันเดียว.
  รายงานรวม 09:00 ยังแสดงยอดรายวันครบกำหนด — วันเดียวอาจดูเกินเพดานได้ตามปกติ
- **มีสองเพดาน แยกกันเด็ดขาด** (ตั้งแต่ 2026-09-17): งานแปลใช้
  `STRAKER_MAX_WORDS_PER_DAY` (live = 3,500) งาน DTP/monolingual ใช้
  `STRAKER_DTP_MAX_WORDS_PER_DAY` (live = 30,000) — คนละ ledger คนละ budget
  งานจัดหน้าหนึ่งวันจึงกินโควตางานแปลไม่ได้ และกลับกัน
- **throughput ทั้งสองตัว derive จากเพดานของตัวเอง ÷ 9 ชม.ทำงาน** (3,500/9 ≈ 389,
  30,000/9 ≈ 3,333) — `STRAKER_THROUGHPUT_WORDS_PER_HOUR` และ
  `STRAKER_DTP_THROUGHPUT_WORDS_PER_HOUR` **ควรปล่อยว่าง**. ถ้าจำเป็นต้องใส่ (เช่น ทีม
  ทำได้จริงช้ากว่าเพดาน ÷ 9): gate กับ ledger ใช้**เรตเดียวกัน**แล้ว (2026-09-18) — วันหนึ่ง
  รับได้ = min(เพดาน, เรต × 9 ชม.) ใส่เรตต่ำกว่า = เข้มขึ้นทั้งสองที่; ใส่สูงกว่า = เพดานยังคุม.
  ข้อเสียที่ยังอยู่: แก้เพดานแล้วเรตที่ใส่ไว้จะค้างที่เดิม
  ⚠️ **30,000 ยังไม่ใช่ตัวเลขที่วัดมา** — เห็นงาน DTP จริงมาแล้ว 1 งาน (956 คำ)
  เท่านั้น เงื่อนไขถอนกลับอยู่ใน `plan.md` §Complexity Tracking
- **โดน 403 = หยุดกดรับถาวร** ข้ามรอบและข้าม restart (เก็บใน `straker_meta`).
  ปลดด้วย `npm run straker:unbar` **เท่านั้น** — ไม่มี auto-recovery เพราะบัญชีที่
  login ได้ก็โดนแบนพร้อมกันได้. ระหว่างโดนแบนยัง **อ่าน/บันทึก/reconcile ต่อ**
- **`due_at` ของรายการ offer เป็น UTC ไม่ใช่เวลาไทย** (ปิดประเด็นแล้ว 2026-09-17) —
  พอร์ทัลส่งมาแบบไม่มีโซน (`2026-09-17T15:00:00`) `offerParse.ts` เติม `Z` ให้
  (`STRAKER_DEADLINE_ZONE`). **ก่อนหน้านี้เติม `+07:00` ทำให้ทุก DL เร็วไป 7 ชม.**
  แล้วงานที่ทำทันถูกปฏิเสธเป็น `deadline_unreachable` แบบเงียบ ๆ (เสียไป 2 งานวันที่
  17/09). สังเกต: **สอง endpoint ใช้คนละรูปแบบ** — รายการ offer ไม่มีโซน แต่รายการงาน
  ที่รับแล้วมี `Z` ติดมา `reconcile.ts` จึงแปลงถูกมาตลอด. ถ้าเห็น DL ในชีตไม่ตรงกับ
  พอร์ทัล ให้เทียบแถว skip (มาจาก offer) กับแถว recovery (มาจาก assigned) — ต่างกัน
  7 ชม. เมื่อไหร่ แปลว่าค่าคงที่นี้ผิดอีกแล้ว
  ⚠️ **กับดัก — อ่านก่อนแก้ค่านี้กลับ**: หน้าจอพอร์ทัลแสดงเวลาไทยและเขียน "GMT+7"
  ไว้ตรงนั้นเลย **นั่นจริงสำหรับหน้าจอ ไม่จริงสำหรับ API** — UI แปลงให้ผู้ใช้ที่ login
  อยู่ ส่วน API ส่งค่าที่ backend เก็บ ใครเปิดพอร์ทัล เห็น GMT+7 แล้ว "แก้ให้ถูก"
  จะพาบั๊ก 7 ชม. กลับมาพร้อมความมั่นใจเต็มร้อย เพราะหน้าจอดูเหมือนยืนยันให้
  **วิธีเช็กที่ถูก: เปิดหน้ารายละเอียดของงาน** พอร์ทัลเขียนโซนไว้เองตรงนั้น —
  `Due date  17 Sep 2026 15:00 (UTC)` ส่วนหน้ารายการแสดงเวลาเดียวกันเป็น
  `22:00 GMT+7` และ API ส่งเลขชุดแรก (ยืนยันด้วย AJ-295 เมื่อ 2026-09-17)
- **claim ไม่เคย retry** ไม่ว่ากรณีใด (R7/FR-019c) — ผลลัพธ์ที่ไม่รู้จะถูกปิดโดย
  reconcile ทุก 15 นาทีแทน ไม่ใช่ยิงซ้ำ

**"ทำไมบอทไม่คว้างาน X":** เปิด Google Sheet (`NZTC Tracking` → แท็บ
`Straker_Tracking`) — **มีสามเคส ไม่ใช่สอง**:

1. **มีแถว + มี Skip reason** → อ่านเหตุผลได้ตรง ๆ. ที่เจอบ่อย: เกินเพดานวันนั้น ·
   ทำไม่ทันในเวลาทำงานก่อน DL · อ่าน effort/deadline ไม่ได้ (อันนี้ alert ด้วย — FR-023a).
   **"DL ตรงวันหยุด" ไม่ใช่เหตุผลปฏิเสธของ Straker แล้ว** (2026-09-18) — งานที่ DL ตก
   เสาร์-อาทิตย์/วันหยุดจะถูกวัดว่าทำทันในชั่วโมงทำงานก่อน DL ไหม (วันหยุดไม่มีชั่วโมง
   ทำงาน = ต้องเสร็จภายในวันทำงานก่อนหน้า). แถวเก่าก่อนวันนั้นยังมีเหตุผลนี้อยู่. **XTM ใช้
   มาตรฐานเดียวกัน** (`schedule/` — ไม่มี flag; บอทใหม่ได้กฎนี้เป็นค่าปกติ)
2. **มีแถว sighting แต่ไม่มีแถว skip** → บอท*เห็น*งาน แต่ **parse ไม่ผ่าน** จึงไม่เคย
   ตัดสินใจเรื่องมันเลย (เคสนี้เกิดครั้งแรก 2026-09-17). จะมี alert
   `offer_unreadable` หนึ่งใบต่อหนึ่ง offer id และ log `module:offerParse
   action:parse outcome:unreadable` บอก field ที่อ่านไม่ออก
3. **ไม่มีแถวเลย** → บอทไม่เคยเห็นงานนั้น → ดู log `module:pollCycle action:cycle`
   ว่ารอบนั้น `offers` เป็นเท่าไร. ถ้าเป็น 0 ทั้งที่พอร์ทัลมีงาน ให้สงสัย
   **entry ที่ไม่มี `obj_id`** ซึ่งยังทำให้การอ่านทั้งรอบล้ม (`offersApi.ts` —
   ตั้งใจ เพราะงานที่ไม่มี identity ติดตามไม่ได้) แต่ล้มแบบ**เสียงดัง**: cycle fail
   → heartbeat fail → page

**คำสั่ง ops (อ่านอย่างเดียวทั้งหมด ยกเว้น unbar/requeue):**

```powershell
npm run straker:win-rate        # won / winnable — FR-017; ทั้ง record ถ้าไม่ใส่ --days
npm run report:combined         # workload สองพอร์ทัลรวม + retries + uptime
npm run straker:outbox:requeue  # dead -> pending (รันหลังแก้ปลายทางแล้วเท่านั้น)
npm run straker:unbar           # ปลดล็อกหลัง 403 — ต้องมีคนตัดสินใจ
```

**หยุดบอท:** `pm2 stop jobcatch-straker` (XTM ไม่กระทบ — คนละ process คนละ port).
ยังไม่มี kill-switch แบบ `ACCEPT_ENABLED=0` ของ XTM — ถ้าอยากให้อ่านอย่างเดียว
ต้องหยุดทั้งตัว

**ยังค้าง (งานของเจ้าของ):** RP-1 rotate รหัสผ่าน · RP-2 อ่าน portal terms แล้วบันทึก
ข้อสรุปพร้อมชื่อ · RP-4 เฝ้าดูงานจริง 1 งาน. ทั้งสามอยู่ใน
`specs/003-straker-offer-race/release-preconditions.md`

## ข้อควรระวังเฉพาะโปรเจกต์

- **Secrets อยู่ใน `.env` เท่านั้น** (gitignored): portal credentials,
  Google Chat webhook URLs, Healthchecks ping URL — ทั้งหมดอยู่ใน pino
  redaction list ห้ามโผล่ใน log/alert/evidence; `state/storageState.json`
  (session cookies) เป็นความลับระดับเดียวกับรหัสผ่าน
- **ห้ามให้ repo อยู่ใต้ Google Drive / OneDrive backup** — .gitignore ไม่กัน cloud
  sync; `.env` + `google-credentials.json` + `state/storageState.json` จะรั่วขึ้น cloud
  (ตรวจในแอป Google Drive → Settings → Folders)
- **single-instance**: **คนละ port ต่อบอท** — XTM `127.0.0.1:47811`
  (`SINGLE_INSTANCE_PORT`), Straker `127.0.0.1:47812` (`STRAKER_SINGLE_INSTANCE_PORT`;
  config ปฏิเสธถ้าตั้งเป็น 47811 หรือ state dir ชนกัน). บอท bind ตอน start —
  ตัวที่ 2 จะ refuse + ping Healthchecks `/fail`. deploy/restart ใช้ `npm run deploy`
  เท่านั้น (ห้าม `pm2 restart` มือ). ดู [[acolad-run-via-pm2-single-instance]]
- **reboot survival**: `pm2-windows-startup` ปลุก PM2 หลัง logon — ต้องเปิด auto-logon
  (`scripts/setup-autologon.ps1` ผ่าน Sysinternals Autologon/LSA) + `pm2 save`. ถ้า reboot
  แล้ว heartbeat ไม่กลับใน 5 นาที → เช็ค auto-logon (password rotation/Windows Update boot) ก่อน
- **Healthchecks — ตั้ง period 60s / grace 300s ทั้งสอง check** (ตรวจครบแล้ว 2026-09-16, ดู V-HC
  ใน `specs/003-straker-offer-race/quickstart.md`). ก่อนหน้านั้น**ของจริงเป็น 5 นาที/5 นาทีทั้งคู่**
  ซึ่งทำให้ detect ที่ 10 นาทีพอดี = หลุดขอบ SC-010 ("within 10 minutes") — บรรทัดนี้เคยเขียน
  มาตรฐานไว้โดยที่ไม่มีอะไรบังคับให้ตรง
  - **Period กับ Grace ทำคนละหน้าที่ อย่าตั้งเท่ากันเพราะเข้าใจผิด**: ping ที่ช้ากว่า *Period* แค่ทำให้
    check เป็นสถานะ `late` (เงียบ) — จะ **page ก็ต่อเมื่อเงียบเกิน `Period + Grace`** ดังนั้น 60s+300s
    = ต้องไม่มี ping 6 นาทีเต็ม. หลักฐานว่าปลอดภัย: XTM 7 วัน 26,558 รอบ ช่องว่างแย่สุด 51 วินาที
    เกิน 60s = 0 ครั้ง. **ลด Period ได้ detection เร็วขึ้นฟรี ไม่แลกกับ false alarm**
  - **แต่ละบอทมี check ของตัวเอง** — XTM = `HEALTHCHECKS_PING_URL` (`acolad-bot (XTM)`),
    Straker = `STRAKER_HEALTHCHECKS_PING_URL` (`jobcatch-straker`)
  - **integration ของ Google Chat ต้องติ๊กในแต่ละ check แยกกัน** — check ใหม่จะรับ ping ผ่านหมด
    ดูเขียวสวย แต่ไม่ page ใคร เพราะ integration ไม่สืบทอดจาก check เดิม
  - **ชื่อ check สำคัญ**: ข้อความที่เข้า Google Chat ใช้ชื่อ check เป็นตัวบอกว่าบอทไหนตาย
    (ชื่อเดิมคือ `My First Check` ซึ่งตอนตีสองบอกอะไรไม่ได้เลย)
- **Straker โดนแบน (403)** และพฤติกรรมอื่นที่ดูเหมือน bug แต่ตั้งใจ — ดูหัวข้อ
  **jobcatch-straker (runbook)** ด้านบน
- PowerShell 5.1 เป็น shell หลักของเครื่องนี้ (ไม่มี `&&` — ใช้ `;`)
- จังหวะเรียก portal มีเพดานเข้มงวด (กันบัญชีถูกระงับ): ห้ามลด interval
  ต่ำกว่า 20s หรือเพิ่มความถี่คำขอโดยไม่แก้ FR-011 ใน spec ก่อน
