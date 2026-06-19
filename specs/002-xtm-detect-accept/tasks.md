---
description: "Task list for ตรวจจับ + กดรับงานบน XTM + บันทึก Google Sheets"
---

# Tasks: ตรวจจับ + กดรับงานบน XTM + บันทึก Google Sheets

**Input**: Design documents from `/specs/002-xtm-detect-accept/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Constitution Principle II บังคับ TDD สำหรับ core automation logic
(eligibility, accept outcome/idempotency, state transitions, sheets adapter) —
test ต้องเขียนก่อนและ **FAIL ก่อน** implement; failure-mode suite เป็นข้อบังคับ

**Organization**: จัดตาม user story — US1 (P1, กดรับมาเลย์ = MVP), US2 (P2, log
Sheets), US3 (P3, แจ้ง Chat). แต่ละ story ทดสอบจบได้อิสระ

**Reuse จาก 001 (ไม่สร้างใหม่)**: `src/portal/browser.ts` (Chromium lifecycle),
`src/detection/diff.ts` (appearance-event, consecutive_misses), `src/state/`
(db/jobStore/outbox/systemEvents/appearanceEvents/meta — ขยายฟิลด์เท่านั้น),
`src/reporting/{googleChat,dispatcher}.ts`, `src/monitoring/`, `src/runtime/
{once,requeue,main}.ts`, heartbeat/PM2 — task ด้านล่างจึง **re-target/extend**
ไม่ใช่เขียนใหม่ทั้งหมด

## Format: `[ID] [P?] [Story] Description`

- **[P]**: รันขนานได้ (คนละไฟล์ ไม่พึ่ง task ที่ยังไม่เสร็จ)
- **[Story]**: US1/US2/US3 เฉพาะ phase ของ user story

## Path Conventions

Single project ตาม plan.md: `src/`, `tests/` ที่ root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: เพิ่ม dependency + config surface ของ 002

- [x] T001 เพิ่ม `googleapis` ใน dependencies + npm scripts ใหม่ (`xtm:recon`,
      `report:catch-rate`) ใน `package.json`; ยืนยัน `playwright`/`better-sqlite3`/
      `pino`/`zod` เดิมยังครบ
- [x] T002 [P] อัปเดต `.env.example`: ลบคีย์ partner (`ACOLAD_*`), เพิ่ม
      `XTM_ACOLAD_{PORTAL_URL,OFFERS_URL,CLOSED_URL,Company,Username,Password}`,
      `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`, `SHEETS_TAB_NAME`, `ACCEPT_ENABLED=0`,
      `ACCEPT_LANGUAGES=Malay (Malaysia)`, `ACCEPT_MAX_WORDS=0`,
      `ACCEPT_MAX_PER_CYCLE=0`, `POLL_INTERVAL_MS=20000` (contracts/config.md)
- [x] T003 [P] ยืนยัน `.gitignore` ครอบ `google-credentials.json` และ
      `state/storageState.json` (กัน secret หลุดเข้า repo)
- [x] T004 [P] ยืนยัน `vitest.config.ts` coverage gate ครอบ glob ใหม่
      (`src/detection/eligibility.ts`, `src/reporting/sheets.ts`) — ยังอยู่ใต้
      `src/{detection,state,reporting}` ≥ 80% (Constitution II)

**Checkpoint**: `npm run lint && npm run typecheck` ผ่าน; dependency ติดตั้งครบ

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: recon + ชั้น XTM/config/DB ที่ **ทุก** user story ต้องใช้

**⚠️ CRITICAL**: ห้ามเริ่ม US ใดจนกว่า phase นี้เสร็จ — โดยเฉพาะ **T005/T006
(recon)** ที่ปลดล็อก selector/job-key/accept-signal (D1–D8)

- [x] T005 สร้าง recon tool `scripts/xtm-recon.ts` (npm `xtm:recon`, gate ด้วย
      `LIVE_PORTAL=1`): login XTM → เปิด Active + Closed → เปิดเมนู Accept (ไม่กดจริง)
      → เก็บ **HTML + screenshot + network log (sanitized)** ลง
      `state/evidence/xtm-recon-<ts>/` ตาม contracts/xtm-portal-adapter.md
- [x] T006 รัน recon (LIVE, มีคนกำกับ) → บันทึกผล **D1–D8** กลับเข้า `research.md`
      (URL Active/Closed, stable job key, สัญญาณ accept สำเร็จ, ค่า "Malay (Malaysia)",
      network endpoint) และ save HTML จริงเป็น fixtures `tests/fixtures/xtm/*.html`
      (Active ว่าง/1งาน/หลายแถว/มาเลย์/ไม่ใช่มาเลย์/พัง, accept dialog, Closed) —
      **gate ของทุก task ที่อิง selector/fixture**
- [x] T007 [P] อัปเดต config zod schema `src/config/index.ts`: คีย์ XTM/Sheets/
      ACCEPT_* (contracts/config.md) + เพิ่ม password/username/company/cred ใน
      pino redaction list
- [x] T008 [P] (TDD) `tests/unit/config.test.ts`: required keys, defaults
      (ACCEPT_ENABLED=0, POLL=20000, caps=0), redaction — เขียนก่อน ต้อง FAIL
- [x] T009 DB migration `src/state/db.ts`: ขยาย `jobs` (xtm_task_id, project_name,
      file_name, source_lang, target_lang, due_date, due_raw, words, step, role,
      eligible, lifecycle_status, accept_status, accepted_at, sheet_synced_status),
      outbox channel `'sheets'`, meta keys ใหม่; bump `schema_version` (data-model.md)
- [x] T010 [P] (TDD) `tests/unit/db.migration.test.ts`: คอลัมน์/CHECK ใหม่, migrate
      idempotent, channel 'sheets' ผ่าน — เขียนก่อน ต้อง FAIL
- [x] T011 [P] นิยาม error taxonomy `src/portal/errors.ts`: เพิ่ม
      `AcceptUnconfirmedError` + types `AcceptTarget`/`AcceptResult` (contracts/
      xtm-portal-adapter.md)
- [x] T012 สร้าง selector registry `src/portal/selectors.ts` ของ XTM จาก evidence
      T006: login fields, Active table/row/columns, เมนู Accept, marker สำเร็จ,
      marker Closed (รวมศูนย์ไฟล์เดียว R9) — **depends on T006**
- [x] T013 (TDD) `tests/integration/xtmLogin.test.ts` ก่อน — login สำเร็จ,
      ตรวจ logged-out, CAPTCHA→error, layout→evidence (fixtures T006)
- [x] T014 implement `src/portal/xtmLogin.ts`: company/user/pass `.jsp`, detect
      logged-out, CAPTCHA guard, retry/lockout, evidence on layout change
- [x] T015 (TDD) `tests/integration/xtmInbox.test.ts` ก่อน — parse Active, หลายแถว/
      ไฟล์, malformed→quarantine, empty confirmed (marker), layout→LayoutChangedError
- [x] T016 implement `src/portal/xtmInbox.ts`: อ่าน Active → `JobSnapshot` (zod
      RawJob + `acceptAvailable`), helper อ่าน Closed (targeted), evidence on layout
- [x] T017 [P] (TDD) `tests/unit/jobKey.test.ts` ก่อน — composite `fileId|step|role`
      unique ข้าม step/role, normalize deterministic
- [x] T018 [P] extend `src/detection/jobKey.ts`: composite key ของ XTM (R3)
- [x] T019 ประกอบ `src/portal/xtmClient.ts` implements `XtmPortalClient`
      (ensureLoggedIn/fetchJobSnapshot/dispose) wiring browser(reuse)+login+inbox

**Checkpoint**: login + อ่าน Active/Closed เป็น JobSnapshot ได้จาก fixtures;
config/DB พร้อม — user stories เริ่มได้

---

## Phase 3: User Story 1 - กดรับงานมาเลย์อัตโนมัติ (Priority: P1) 🎯 MVP

**Goal**: เจองานมาเลย์ใหม่ → กด Accept (bulk) อัตโนมัติภายในหน้าต่าง < 60 วิ และ
บันทึกผลแบบกดครั้งเดียวเป๊ะ

**Independent Test**: ป้อน fixture Active ที่มีงานมาเลย์ใหม่ → ระบบเรียก
`acceptEligibleTasks` แล้วบันทึก `accept_status`/lifecycle ถูกต้อง (ตรวจจาก state+
log โดยไม่ต้องมี Sheets/Chat)

### Tests for US1 (MANDATORY — Constitution II) ⚠️ เขียนก่อน ต้อง FAIL

- [ ] T020 [P] [US1] `tests/unit/eligibility.test.ts`: exact match "Malay (Malaysia)",
      config-driven list, ไม่ใช่มาเลย์ = ไม่ eligible
- [ ] T021 [P] [US1] `tests/integration/accept.test.ts`: ตัดสินผลจาก **re-read
      Active (FR-024)** — accepted/missing/failed; bulk partial (รับบาง โดนแย่งบาง)
- [ ] T022 [P] [US1] `tests/unit/acceptState.test.ts`: state machine
      none→accepting→accepted/failed; at-most-once; restart กลาง accept ไม่กดซ้ำ
- [ ] T023 [P] [US1] `tests/integration/coldStartAccept.test.ts`: กดรับงานมาเลย์ค้าง
      ที่ยังกดได้, ข้ามที่รับแล้ว, สรุปครั้งเดียว (FR-005)
- [ ] T024 [P] [US1] `tests/integration/acceptControl.test.ts`: `ACCEPT_ENABLED=0`
      → ไม่กด; caps (MAX_WORDS/PER_CYCLE) → Skipped + แจ้ง (FR-012/025)

### Implementation for US1

- [ ] T025 [P] [US1] `src/detection/eligibility.ts` (pure): map target_lang → eligible
- [ ] T026 [US1] `src/portal/xtmAccept.ts`: bulk "Accept all for language in group"
      + **FR-024 re-read** ตัดสินผลราย jobKey + timeout 15s + evidence on unconfirmed
      (re-read นับในงบ RateLimiter เดียวกัน — FR-027)
- [ ] T027 [US1] เพิ่ม `acceptEligibleTasks()` ใน `src/portal/xtmClient.ts`
- [ ] T028 [US1] accept_status state machine ใน `src/state/jobStore.ts` (txn guard
      ก่อนกด — Constitution VII)
- [ ] T029 [US1] accept orchestration ใน `src/runtime/pollLoop.ts`: detect→[eligible
      & ใหม่]→**accept ก่อน** log/แจ้ง→record (accept-first, POLL 20s, R7); **wire
      RateLimiter (reuse `src/runtime/rateLimiter.ts`) ให้ครอบทุก read ในรอบ — Active
      read + FR-024 re-read + FR-014 Closed-check — ไม่ให้เกินเพดาน (FR-027, N2)**;
      re-login ≤ 1 ครั้ง/รอบ (FR-021)
- [ ] T030 [US1] cold-start accept (FR-005) ใน `src/runtime/{pollLoop,bootstrap}.ts`:
      baseline + กดรับงานค้างที่ยังกดได้ (fallback baseline-only ถ้าแยกไม่ได้)
- [ ] T031 [US1] kill-switch + caps ใน pollLoop: `ACCEPT_ENABLED`, `ACCEPT_MAX_WORDS`,
      `ACCEPT_MAX_PER_CYCLE` (default ไม่จำกัด) → เกิน=Skipped+แจ้ง (FR-025)
- [ ] T032 [US1] accept_failed → system alert (reuse `src/state/systemEvents.ts` +
      evidence ref) — Constitution V (ห้ามเงียบ)

**Checkpoint**: US1 ทำงานจบอิสระ — เจอมาเลย์ใหม่แล้วกดรับ+บันทึกถูก (MVP กดรับได้)

---

## Phase 4: User Story 2 - บันทึกทุกงานลง Google Sheets (Priority: P2)

**Goal**: ทุกงานที่เจอ (ทุกภาษา) → 1 แถวในชีต + อัปเดตสถานะตลอดวงจร (upsert, ไม่ซ้ำ)

**Independent Test**: ป้อนชุดงานหลายภาษา → ตรวจว่าได้ 1 แถว/งาน (upsert by job_key)
และสถานะไหล New→…→Closed/Removed (mock googleapis)

### Tests for US2 (MANDATORY — Constitution II) ⚠️ เขียนก่อน ต้อง FAIL

- [ ] T033 [P] [US2] `tests/unit/sheets.test.ts` (mock googleapis): append `New`,
      `updateRow` by job_key in place, ไม่มีแถวซ้ำ
- [ ] T034 [P] [US2] `tests/unit/sheetsHeader.test.ts`: ensureHeader v1→v2 เติม I–M
      ไม่ย้ายของเดิม, header แปลก→alert ไม่ทับ (contracts/sheets.md)
- [ ] T035 [P] [US2] `tests/integration/sheetsLifecycle.test.ts`: New→Accepted/
      Missing/Skipped/Accept failed→Closed/Removed sync ลงชีต — **ใช้ fixture สถานะ
      ไม่เรียก accept จริง (คงความอิสระจาก US1, N6)**
- [ ] T036 [P] [US2] `tests/integration/closedCheck.test.ts`: accepted หายจาก Active
      → เช็ค Closed → `Closed` (เจอ)/`Removed` (ไม่เจอ) (FR-014)
- [ ] T037 [P] [US2] `tests/unit/sheetsHistorical.test.ts`: แถวเดิมไม่มี job_key =
      historical → ไม่ claim/ไม่ update (FR-026)
- [ ] T038 [P] [US2] `tests/integration/sheetsOutbox.test.ts`: Sheets 5xx → outbox
      retry, ฟื้นแล้วครบ ไม่ซ้ำ, accept ไม่ถูกบล็อก (FR-018, Constitution IV)

### Implementation for US2

- [ ] T039 [US2] `src/reporting/sheets.ts`: `SheetSink` (ensureHeader/appendRow/
      updateRow upsert by job_key) ผ่าน googleapis service account, scope spreadsheets
- [ ] T040 [US2] outbox channel `'sheets'` + routing ใน `src/reporting/dispatcher.ts`
      (payload append/update) — reuse retry/backoff เดิม
- [ ] T041 [US2] คำนวณ `lifecycle_status` + enqueue outbox sheets/chat ตอน transition
      ใน `src/runtime/pollLoop.ts` + `src/state/jobStore.ts` (ไม่ใส่ logic นี้ใน diff)
- [ ] T042 [US2] Closed-tab targeted check → Closed/Removed (FR-014) ใน pollLoop ใช้
      `xtmInbox.readClosed` (เฉพาะตอน accepted หายจาก Active ≥ 2 รอบ; นับในงบ
      RateLimiter — FR-027)
- [ ] T043 [US2] FR-026 historical-rows guard ใน `src/reporting/sheets.ts`

**Checkpoint**: US1 + US2 ทำงานจบอิสระ — ทุกงานลงชีต + สถานะครบวงจร

---

## Phase 5: User Story 3 - แจ้งเตือน Google Chat เรียลไทม์ (Priority: P3)

**Goal**: ทุกงานที่เจอ + ทุกผลการกดรับ → ข้อความ Chat ภาษาไทย schema คงที่

**Independent Test**: ทริกเกอร์ detection + accept outcome → ตรวจข้อความ Chat ถูก
รูปแบบ (mock webhook)

### Tests for US3 (MANDATORY — Constitution II) ⚠️ เขียนก่อน ต้อง FAIL

- [ ] T044 [P] [US3] `tests/unit/notifier.test.ts`: 🆕 งานใหม่ (eligible/skip),
      ✅ รับงานแล้ว, ⚠️ กดรับไม่สำเร็จ/โดนแย่ง — เวลา ISO 8601 +07:00
      (contracts/notifications.md)
- [ ] T045 [P] [US3] `tests/integration/coldStartSummary.test.ts`: 1 ข้อความสรุป
      งานค้างตอน start (FR-005)

### Implementation for US3

- [ ] T046 [US3] เพิ่ม template ข้อความใหม่ใน `src/reporting/notifier.ts` (new/
      accepted/failed) — reuse formatter เดิม
- [ ] T047 [US3] cold-start summary message + wire ใน bootstrap/pollLoop
- [ ] T048 [US3] wire เหตุการณ์ (new/accepted/failed) → outbox channel `chat` ใน
      `src/runtime/pollLoop.ts` (1 ข้อความ/งาน ไม่ batch)

**Checkpoint**: ทั้ง 3 stories ทำงานจบอิสระ

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T049 [P] Failure-mode suite `tests/integration/failureModes.xtm.test.ts`:
      login fail (บัญชีแชร์→lockout), session expiry **กลางอ่าน & กลาง accept**
      (re-login เงียบ ไม่ alert), accept timeout, malformed rows quarantine, Sheets
      quota/auth, **restart กลาง accept** (re-read แล้วไม่กดซ้ำ) — Constitution II
- [ ] T050 [P] extend `src/runtime/latencyReport.ts` + npm `report:latency`: วัด **2
      เมตริกแยก (N1)** — (a) **click latency** detection→คลิกยืนยัน p95 ≤ 5 วิ
      (Constitution VIII, V16); (b) **outcome-confirmed latency** รวม FR-024 re-read,
      end-to-end ≤ 60 วิ (SC-003, V16b)
- [ ] T051 [P] `src/runtime/catchRateReport.ts` + npm `report:catch-rate`: SC-001
      (Accepted ÷ Accepted+Missing+Accept failed บนมาเลย์ จากชีต) + SC-009
      reconciliation รายสัปดาห์
- [ ] T052 [P] ลบโค้ด partner-portal ที่เลิกใช้ (`src/portal/login.ts`,
      `jobList.ts` เวอร์ชัน partner) — ไม่เหลือ dead code (Constitution I)
- [ ] T053 [P] [ops] อัปเดต `.env` จริงจาก partner→XTM + แชร์ชีตให้ service account
      (Editor) + map `SHEETS_TAB_NAME`/gid (D7)
- [ ] T054 รัน `quickstart.md` V1–V16/V10b (LIVE-gated เท่าที่ต้อง) + coverage ≥ 80%
      + `npm run lint && npm run typecheck` 0 error
- [ ] T055 [P] อัปเดต CLAUDE.md สถานะ 002 + docs; redeploy PM2 single instance
      ([[acolad-run-via-pm2-single-instance]]); ยืนยัน **heartbeat → Healthchecks
      (FR-028, reuse `src/monitoring/heartbeat.ts`)** — เงียบเกิน grace → alert

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (P1)**: เริ่มได้ทันที
- **Foundational (P2)**: หลัง Setup — **BLOCKS ทุก US**; ภายในนี้ **T006 (recon)
  block ทุก task ที่อิง selector/fixture** (T012–T016, US ทั้งหมด)
- **US (P3–P5)**: หลัง Foundational; เริ่มขนานได้ถ้ามีคน — แนะนำเรียง P1→P2→P3
- **Polish (P6)**: หลัง US ที่ต้องการเสร็จ

### User Story Dependencies

- **US1 (P1)**: หลัง Foundational — ไม่พึ่ง US อื่น (บันทึกผลใน state พอ ทดสอบได้)
- **US2 (P2)**: หลัง Foundational — ใช้ `lifecycle_status` ที่ US1 ตั้ง แต่ logging
  ทดสอบแยกได้ด้วย fixture สถานะ; outbox channel sheets เป็นของ US2
- **US3 (P3)**: หลัง Foundational — ฟัง event จาก pollLoop; ทดสอบ formatter แยกได้

### Within Each User Story

- เขียน test ก่อน + ต้อง FAIL → แล้ว implement (Constitution II)
- pure (eligibility) ก่อน adapter (xtmAccept) ก่อน orchestration (pollLoop)

### Parallel Opportunities

- Setup: T002/T003/T004 ขนาน
- Foundational: T007/T008, T010, T011, T017/T018 ขนาน (T012–T016 รอ T006)
- ภายใน US: task test ที่ติด [P] ขนานได้; งาน implement คนละไฟล์ติด [P]
- Polish: T049–T053, T055 ขนาน

---

## Parallel Example: User Story 1

```bash
# เขียน tests US1 พร้อมกัน (ต้อง FAIL ก่อน):
Task: "tests/unit/eligibility.test.ts"
Task: "tests/integration/accept.test.ts"
Task: "tests/unit/acceptState.test.ts"
Task: "tests/integration/coldStartAccept.test.ts"
Task: "tests/integration/acceptControl.test.ts"
```

---

## Implementation Strategy

### MVP First (US1 เท่านั้น)

1. Phase 1 Setup → 2. Phase 2 Foundational (**recon ก่อน**) → 3. Phase 3 US1
4. **หยุด+ตรวจ**: เจอมาเลย์ใหม่แล้วกดรับได้จริง (state/log) → เปิด `ACCEPT_ENABLED=1`
   หลัง recon ยืนยัน accept flow แล้วเท่านั้น

### Incremental Delivery

Setup+Foundational → US1 (กดรับได้ = MVP) → US2 (log ชีต) → US3 (แจ้ง Chat) —
แต่ละ story เพิ่มคุณค่าโดยไม่พังของเดิม

---

## Notes

- [P] = คนละไฟล์ ไม่พึ่งกัน; [Story] = traceability
- **evidence-first**: ห้าม finalize selector/parser ก่อน T006 (recon) เสร็จ
- **ACCEPT_ENABLED ตั้งต้น = 0** — เปิดเป็น 1 หลังยืนยัน accept flow จริง (ปลอดภัย)
- ยืนยัน test FAIL ก่อน implement; commit หลังแต่ละ task/กลุ่ม
- ห้าม poll < 20s; re-login เงียบบนบัญชีแชร์; secrets ไม่โผล่ใน log/evidence
