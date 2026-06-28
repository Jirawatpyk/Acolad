# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

บอทเฝ้าพอร์ทัล Acolad ตลอด 24/7: ตรวจจับงานแปลใหม่ → แจ้งเตือน Google Chat
ภายใน 60 วินาที. ฟีเจอร์ 001 จับงานที่ partner.acolad.com (ถอดออกแล้ว);
**ฟีเจอร์ 002 (ปัจจุบัน) ย้ายไป XTM Cloud (Tasks→Active)** + กดรับงานมาเลย์
อัตโนมัติ (bulk) + บันทึก task ทุกงานลง Google Sheets — กดรับเฉพาะคู่ภาษา
มาเลย์ MS (ดู [[acolad-malay-only-rule]])

**สถานะปัจจุบัน**: ฟีเจอร์ 002 **live** (auto-accept งานมาเลย์ ตั้งแต่ 2026-06-22) +
**accept-scheduling gate live** ตั้งแต่ 2026-06-27 (PR #7/#8). detect + log(Sheets) +
notify(Chat) + auto-accept (กรองด้วย schedule gate) ครบวงจร. 580+ tests ผ่าน,
coverage detection/state/reporting/schedule ≥ 80%, lint + typecheck สะอาด.

> **2 สวิตช์ accept — อย่าสับสน**: `ACCEPT_ENABLED` คุมการกดรับ *ทั้งหมด* (0 =
> detect+notify อย่างเดียว ไม่กดรับ); `ACCEPT_SCHEDULE_ENABLED` คุม *แค่ตาราง* (0 =
> กดรับ 24/7 ไม่จำกัดเวลา/วันหยุด/โควต้า — พฤติกรรมก่อน PR #7). live = ทั้งคู่ `=1`.
> **`ACCEPT_MAX_PER_CYCLE=0` ต้องเป็น 0 เสมอ** (bulk กดทั้งกลุ่มในคลิกเดียว — cap>0
> อันตราย, ดู `acceptDecision.ts`). accept menu D4/D6 ยืนยันจากงานจริง (inline
> `[data-dropdown-menu]`, หลังรับเปลี่ยนเป็น "Finish task"). design:
> `docs/superpowers/specs/2026-06-26-xtm-accept-schedule-capacity-design.md`. ดู
> [[xtm-accept-d6-finish-task]], [[acolad-accept-schedule-feature]].

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:

**Current feature**: 002-xtm-detect-accept
**Current plan**: specs/002-xtm-detect-accept/plan.md
**Spec**: specs/002-xtm-detect-accept/spec.md
**Tasks**: specs/002-xtm-detect-accept/tasks.md (สร้างด้วย /speckit-tasks)
**Design artifacts**: specs/002-xtm-detect-accept/ (research.md, data-model.md, quickstart.md, contracts/)
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
npm run deploy          # รัน 24/7: build + restart แบบ single-instance-safe + verify (ใช้อันนี้เสมอ)
# ห้าม `pm2 restart acolad-bot` ด้วยมือ — มัน skip stop-and-wait แล้วทิ้ง orphan/ชน lock
npm run outbox:requeue  # ops: คืนรายการแจ้งเตือน dead → pending
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
| `schedule/` | accept-scheduling gate (pure, TDD + coverage gate) | `acceptSchedule.ts` (`evaluateAcceptSchedule` — the gate), `workingHours.ts` (`workingMinutesBetween`), `bangkokCalendar.ts` (canonical Bangkok time — อย่า duplicate +7h logic), `parseSchedule.ts` (`resolveThroughput`), `thaiHolidays.ts` + `thaiHolidaysData.ts` (team-curated holidays) |
| `state/` | SQLite (TDD + coverage gate) | `db.ts`, `xtmJobStore.ts` (job state), `jobStore.ts` (accept state machine), `outbox.ts`, `meta.ts` (baseline/cursor) |
| `portal/` | Playwright I/O เฉพาะ XTM | `xtmClient.ts` (impl ของ interface), `xtmInbox.ts` (อ่าน grid ใน iframe), `xtmLogin.ts`, `xtmAccept.ts`, `xtmAcceptRecon.ts`, `selectors.ts` (รวมศูนย์), `evidence.ts`, `htmlSanitize.ts`, `errors.ts` |
| `reporting/` | ส่งออก (TDD + coverage gate) | `dispatcher.ts` (channel→sender + payload-shape routing), `googleChat.ts` (`ChatPayload` union), `chatCard.ts`/`cardText.ts`/`dateFormat.ts` (cardsV2 builder + helpers), `sheets.ts` (Sink + Sender), `xtmNotifier.ts` (EN card builders), `dailyReport.ts` (รายงาน 09:00), `systemAlerts.ts` (EN alert cards) |
| `runtime/` | orchestration + entry points | (ดู Entry points ด้านบน) + `rateLimiter.ts`, `scheduler.ts` |
| `monitoring/` | สุขภาพระบบ | `heartbeat.ts` (Healthchecks), `logger.ts` (pino + redaction) |

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

ตัวคุม accept (`ACCEPT_*`) + tuning (`POLL_INTERVAL_MS` ฯลฯ) มี default
ปลอดภัย — `ACCEPT_ENABLED`/`ACCEPT_RECON` ปริยาย = ปิด. กลุ่ม **`ACCEPT_SCHEDULE_*`**
(schedule gate: `ACCEPT_SCHEDULE_ENABLED` ปริยาย = **เปิด**, `ACCEPT_HOURS_START/END`,
`ACCEPT_WORKDAYS`, `ACCEPT_MAX_WORDS_PER_DAY`, `ACCEPT_THROUGHPUT_WORDS_PER_HOUR`) —
อย่าสับสน `ACCEPT_ENABLED` (กดรับทั้งหมด) กับ `ACCEPT_SCHEDULE_ENABLED` (แค่ตาราง).

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
24/7 ไม่แตะ). กดรับงานมาเลย์ก็ต่อเมื่อครบทุกข้อ: ไม่เกิน **capacity** (≤`ACCEPT_MAX_WORDS_PER_DAY` คำ **due/วันครบกำหนด** — PR #14, ดูด้านล่าง) · รู้ DL ·
รู้คำ · **DL ไม่ตรงวันหยุด/เสาร์-อาทิตย์** · **ทำทันในเวลางาน** (`ชม.ทำงานถึง DL ×
throughput ≥ คำ`). งานที่บล็อก → lifecycle `'rejected'` → Sheet status **`Rejected`** +
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
- **capacity = held-derived per deadline day (PR #14):** cap = ≤`ACCEPT_MAX_WORDS_PER_DAY` คำที่
  **DL ตรงวันเดียวกัน** อ่านจาก held list (`XtmJobStore.wordsDueByDeadline()`) **ไม่ใช่วันกดรับ**
  → **งาน finish คืนโควต้า** (source เดียว = held; ไม่มี meta word-counter แล้ว). ตัดสินด้วย pure
  helper `schedule/acceptCapacity.ts` (`decideGroupCapacity`, all-or-nothing per bulk-group **ครอบทั้ง
  feasibility + capacity** กัน owned-but-Rejected); seed จาก held ครั้งเดียว/รอบ **ก่อน** record
  (memoize, advance per-DL-day). audit: `XtmCycleSummary.acceptedDueDays` log `wordsDueOn` ตอน accept
- daily report 09:00 (`dailyReport.ts`) ส่ง **เฉพาะวันทำการ** (PR #8) — **`📋 Daily Report`:
  Due today (Σ คำ held ที่ DL=วันนี้) / ⚠️ Overdue (instant `dueAtMs<now`) / In progress top-5 by
  deadline** สร้างจาก held list, **throw-safe + อยู่ใน try/catch ของ loop** (bug รายงานไม่ page; PR
  #14). ทุกวันที่ Bangkok ผ่าน `schedule/bangkokCalendar.ts` (canonical)

**runbook ของ gate:**

- **"ทำไมบอทไม่กดงาน X":** เปิด Google Sheet → ดู Status `Rejected` + reason ในคอลัมน์
  Note (และ pino log `module:scheduleGate action:reject` — มี jobKey/reason/words/dueDate) →
  ถ้าเหตุผลผิด (holiday ผิด / throughput ต่ำ / cap) แก้ config แล้ว `npm run deploy`.
- **kill-switch:** `ACCEPT_SCHEDULE_ENABLED=0` + `npm run deploy` = กลับพฤติกรรมก่อน PR #7
  byte-for-byte (config refines ถูก gate ด้วย ENABLED → ปิดได้เสมอแม้ค่าอื่นเพี้ยน).
- **พฤติกรรมปกติ (ไม่ใช่ bug):** Malay = ภาษาเดียว = 1 bulk-group/รอบ → งาน
  infeasible/uncurated 1 ตัว → Malay **ทั้งรอบ**ถูก Reject (conservative all-or-nothing
  กัน owned-but-Rejected) — robustness pass ลองใหม่รอบหน้า.
- **page เพิ่ม:** `holiday_calendar_stale` (ปีปัจจุบัน uncurated) ตอนนี้ **fail heartbeat
  → page** (auto-accept ดับทั้งระบบ); `daily_cap_reached` = warn (Chat) แจ้งครั้งเดียว/**วัน DL
  (deadline day)** ที่ budget คำเต็มจริง (dedup `daily_cap_reached:<วันDL>` — 2 วัน DL ล้นในวัน
  Bangkok เดียวกันได้ 2 alert; PR #15); ไม่ใช่งานเดี่ยวใหญ่เกิน cap (อันนั้น = "accept manually").

## ข้อควรระวังเฉพาะโปรเจกต์

- **Secrets อยู่ใน `.env` เท่านั้น** (gitignored): portal credentials,
  Google Chat webhook URLs, Healthchecks ping URL — ทั้งหมดอยู่ใน pino
  redaction list ห้ามโผล่ใน log/alert/evidence; `state/storageState.json`
  (session cookies) เป็นความลับระดับเดียวกับรหัสผ่าน
- **ห้ามให้ repo อยู่ใต้ Google Drive / OneDrive backup** — .gitignore ไม่กัน cloud
  sync; `.env` + `google-credentials.json` + `state/storageState.json` จะรั่วขึ้น cloud
  (ตรวจในแอป Google Drive → Settings → Folders)
- **single-instance**: บอท bind `127.0.0.1:47811` ตอน start (`SINGLE_INSTANCE_PORT`) —
  ตัวที่ 2 จะ refuse + ping Healthchecks `/fail`. deploy/restart ใช้ `npm run deploy`
  เท่านั้น (ห้าม `pm2 restart` มือ). ดู [[acolad-run-via-pm2-single-instance]]
- **reboot survival**: `pm2-windows-startup` ปลุก PM2 หลัง logon — ต้องเปิด auto-logon
  (`scripts/setup-autologon.ps1` ผ่าน Sysinternals Autologon/LSA) + `pm2 save`. ถ้า reboot
  แล้ว heartbeat ไม่กลับใน 5 นาที → เช็ค auto-logon (password rotation/Windows Update boot) ก่อน
- **Healthchecks**: ตั้ง period 60s / grace 300s — บอทหยุดหรือ lock refuse จะ page ใน ~5 นาที
- PowerShell 5.1 เป็น shell หลักของเครื่องนี้ (ไม่มี `&&` — ใช้ `;`)
- จังหวะเรียก portal มีเพดานเข้มงวด (กันบัญชีถูกระงับ): ห้ามลด interval
  ต่ำกว่า 20s หรือเพิ่มความถี่คำขอโดยไม่แก้ FR-011 ใน spec ก่อน
