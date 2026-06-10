---

description: "Task list for ระบบ Login และตรวจจับงานใหม่บน Acolad Partner Portal"
---

# Tasks: ระบบ Login และตรวจจับงานใหม่บน Acolad Partner Portal

**Input**: Design documents from `/specs/001-login-job-detection/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Constitution Principle II บังคับ TDD สำหรับ core automation logic
(job parsing, detection diff, dedup/idempotency, state, reporting) — task
ทดสอบของส่วนเหล่านี้ต้องเขียนก่อนและ FAIL ก่อน implement; failure-mode
suite เป็นข้อบังคับ

**Organization**: จัดตาม user story (US1 = P1, US2 = P2, US3 = P3) ให้แต่ละ
story ทดสอบจบได้อิสระ

## Format: `[ID] [P?] [Story] Description`

- **[P]**: รันขนานได้ (คนละไฟล์ ไม่พึ่ง task ที่ยังไม่เสร็จ)
- **[Story]**: US1/US2/US3 เฉพาะ phase ของ user story

## Path Conventions

Single project ตาม plan.md: `src/`, `tests/` ที่ root — โครงสร้างโมดูลตาม
หัวข้อ Project Structure ของ plan.md

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: โครงโปรเจกต์ + toolchain ตาม Constitution I

- [ ] T001 Initialize Node 22 + TypeScript project: `package.json` พร้อม
      dependencies (playwright, better-sqlite3, pino, pino-roll, zod, dotenv)
      + devDeps (typescript, vitest, @vitest/coverage-v8, eslint, prettier,
      typescript-eslint) + npm scripts ครบ: `lint`, `typecheck`, `test`,
      `test:coverage`, `build`, `poll:once`, `start`, `outbox:requeue`
- [ ] T002 [P] `tsconfig.json` แบบ strict ทั้งหมด (strict, noUncheckedIndexedAccess,
      exactOptionalPropertyTypes) target ES2022 module NodeNext
- [ ] T003 [P] ตั้งค่า ESLint + Prettier: `eslint.config.js`, `.prettierrc`
      — `npm run lint` ต้อง 0 error บนโครงว่าง
- [ ] T004 [P] `vitest.config.ts`: coverage v8 + gate ≥ 80% lines เฉพาะ
      `src/detection/`, `src/state/`, `src/reporting/` (Constitution II)
- [ ] T005 สร้างโครงโฟลเดอร์ตาม plan.md: `src/{config,portal,detection,state,reporting,monitoring,runtime}/`,
      `tests/{unit,integration,fixtures}/` พร้อมไฟล์ `.gitkeep`
- [ ] T006 [P] `ecosystem.config.cjs` สำหรับ PM2: ชื่อ app `acolad-bot`,
      `max_memory_restart: '900M'`, log paths ใต้ `logs/`, autorestart
- [ ] T007 ติดตั้ง browser: `npx playwright install chromium` และยืนยันรันได้
- [ ] T050 [P] ตั้ง GitHub Actions CI ใน `.github/workflows/ci.yml`: รัน
      lint + typecheck + test:coverage ทุก push/PR (ไม่ตั้ง env LIVE_PORTAL
      — live test ห้ามรันใน CI ตาม Constitution II) — บังคับ quality gate
      อัตโนมัติตาม Constitution I (ID ต่อท้ายเพราะเพิ่มจากผล /speckit-analyze)

**Checkpoint**: `npm run lint && npm run typecheck && npm test` ผ่านบนโครงว่าง

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: config / logging / ฐานสถานะ ที่ทุก story ต้องใช้

**⚠️ CRITICAL**: ต้องเสร็จก่อนเริ่ม user story ใดๆ

- [ ] T008 [P] Unit tests (เขียนก่อน ต้อง FAIL): config schema ใน
      `tests/unit/config.test.ts` — ตัวแปรจำเป็นขาด → error ระบุชื่อตัวแปร,
      ขอบเขต `20000 ≤ POLL_INTERVAL_MS ≤ 25000`, defaults ตาม
      contracts/config.md
- [ ] T009 Config loader ใน `src/config/index.ts`: dotenv + zod ตาม
      contracts/config.md ทุกตัวแปร (รวม OUTBOX_RETRY_CAP/OUTBOX_DEAD_AFTER_HOURS)
      — fail fast พร้อมข้อความชัด (FR ที่เกี่ยว: FR-011)
- [ ] T010 Logger ใน `src/monitoring/logger.ts`: pino JSON + pino-roll หมุน
      รายวันเก็บ 14 วันใต้ `LOG_DIR` + redaction list ตาม FR-012 (password,
      email, webhook URLs, ping URL, cookies) — ฟิลด์บังคับ: module, action,
      outcome, latencyMs, jobKey
- [ ] T011 [P] Unit tests (เขียนก่อน ต้อง FAIL): state stores ใน
      `tests/unit/state.test.ts` — jobs upsert/transition (visible→missing
      ต้องไม่พบ ≥ 2 รอบ/relisted), unique `(job_key,event_type,poll_cycle_id)`,
      outbox enqueue ใน txn เดียวกับ state + claim/backoff/dead ตาม cap,
      system_events dedup_key เฉพาะ alert ที่ยัง active
- [ ] T012 DB layer ใน `src/state/db.ts`: better-sqlite3 WAL + migration
      สร้างตาราง jobs, appearance_events, system_events, outbox, meta ตาม
      data-model.md — รวม FR-017: เปิด/migrate ล้มเหลว → ย้ายไฟล์เป็น
      `acolad.db.corrupt-<ts>` + สร้างใหม่ + คืนสถานะ "ต้อง cold start + alert"
- [ ] T013 Job store ใน `src/state/jobStore.ts`: persist ผลลัพธ์ transition
      ที่คำนวณโดย diff (รวม `consecutive_misses` ตาม data-model — jobStore
      ไม่ตัดสิน transition เอง), อัปเดต snapshot_hash + log การเปลี่ยน
      รายละเอียดแบบเงียบ (FR-019), meta helpers (baseline_done,
      login_failure_count, login_lockout_until, last_successful_poll_at,
      first_job_evidence_captured_at)
- [ ] T014 [P] Outbox store ใน `src/state/outbox.ts`: enqueue ใน transaction
      เดียวกับ event (Constitution VII), claim รายการถึงกำหนด, นับ attempts +
      exponential backoff, เปลี่ยนเป็น dead ตาม OUTBOX_RETRY_CAP/
      OUTBOX_DEAD_AFTER_HOURS (FR-018), unique (event_id, channel)
- [ ] T015 [P] System events store ใน `src/state/systemEvents.ts`: สร้าง
      alert พร้อม dedup_key (เรื่องเดิมที่ยัง active ไม่ซ้ำ), resolve →
      ปลดล็อกและสร้างเหตุการณ์ recovered, ประเภท cold_start_summary

**Checkpoint**: `npm test` เขียว — foundation พร้อม ทุก story เริ่มได้

---

## Phase 3: User Story 1 - พบงานใหม่และได้รับแจ้งเตือนทันที (Priority: P1) 🎯 MVP

**Goal**: login → เฝ้ารายการงาน → ตรวจพบใน 30 วิ → แจ้ง Google Chat ใน 60 วิ
ไม่ซ้ำ ไม่ตกหล่น รวม cold start

**Independent Test**: รัน poll กับ fixtures (ว่าง/3 งาน/25 งาน/มีงานเพิ่ม) —
ได้แจ้งเตือนตามรูปแบบ contract ครบงานละครั้ง + V1, V2, V3, V11 ผ่าน

### Tests for User Story 1 (MANDATORY — เขียนก่อน ต้อง FAIL)

- [ ] T016 [P] [US1] Unit tests jobKey ใน `tests/unit/jobKey.test.ts`:
      ใช้ portal id เมื่อมี, fallback hash ตามกติกา serialize null
      (FR-005/data-model) — ค่าเดิม → key เดิมเสมอ (deterministic)
- [ ] T017 [P] [US1] Unit tests diff ใน `tests/unit/diff.test.ts`:
      first_seen, ปรากฏต่อเนื่องไม่ซ้ำ, missing เมื่อหาย ≥ 2 รอบ, relisted
      หลัง missing, flicker 1 รอบไม่จบการปรากฏ, รายละเอียดเปลี่ยน → ไม่มี
      event แจ้งเตือน (FR-019), burst 25 งานครบทุกตัว (SC-008)
- [ ] T018 [P] [US1] Unit tests formatter ใน `tests/unit/notifier.test.ts`:
      template ทั้ง 5 ประเภทตรง contracts/notifications.md, เวลา ISO 8601
      +07:00 (FR-014), COLD_START_SUMMARY กรณี 0/3/25 งาน (truncate 20 +
      "…และอีก 5 งาน")
- [ ] T019 [P] [US1] สร้าง fixtures HTML ใน `tests/fixtures/`: หน้า login,
      หน้ารายการงาน (ว่างมี marker / 3 งาน / 25 งาน / เพิ่มงานใหม่ /
      ไม่มี marker / มีตัวบ่งชี้ pagination / มีแถว malformed ไม่มี title
      ปนแถวปกติ / งานหาย 2 รอบแล้วกลับมา สำหรับ V9) + mock Google Chat
      webhook server (undici MockAgent) ใน `tests/fixtures/mocks.ts`

### Implementation for User Story 1

- [ ] T020 [US1] jobKey ใน `src/detection/jobKey.ts` (pure function ตาม T016)
- [ ] T021 [US1] diff ใน `src/detection/diff.ts` (pure: snapshot + สถานะเดิม
      รวม `consecutive_misses` → รายการ events + สถานะใหม่ — **เจ้าของ
      กติกา transition ทั้งหมด** ตาม data-model; ไม่มี I/O)
- [ ] T022 [US1] Selector registry ใน `src/portal/selectors.ts`: รวมศูนย์
      selector ทั้งหมด (ฟอร์ม login, container รายการงาน = empty marker,
      แถวงาน + ฟิลด์, ตัวบ่งชี้ pagination, ตัวบ่งชี้ CAPTCHA) — R9
- [ ] T023 [US1] Browser lifecycle ใน `src/portal/browser.ts`: Chromium
      headless + persist `storageState` ใต้ STATE_DIR, timeout ทุก operation
      (nav 30s/selector 10s), ไฟล์ session พัง → ถือว่าไม่มี session (FR-002)
- [ ] T024 [US1] Login flow ใน `src/portal/login.ts`: FR-001 ด้วย selectors
      registry, ตรวจ CAPTCHA/2FA → `CaptchaDetectedError` (ห้าม retry),
      login flow timeout 60s ตาม portal-adapter contract
- [ ] T025 [US1] Job list reader ใน `src/portal/jobList.ts`: refresh 1 ครั้ง/
      รอบ, parse แถว → RawJob ผ่าน zod (title บังคับ, deadline_raw เมื่อ
      parse ไม่ได้), `emptyListConfirmed` ด้วย marker (FR-016), แถว
      malformed → quarantine, ตัวบ่งชี้ pagination → ส่งสัญญาณ alert
      (FR-009), เก็บ evidence งานจริงตัวแรก + sanitize ตาม contract
- [ ] T026 [US1] Formatter ใน `src/reporting/notifier.ts`: interface
      Notifier + render template 5 ประเภท (ตาม T018)
- [ ] T027 [P] [US1] Google Chat adapter ใน `src/reporting/googleChat.ts`:
      POST `{text}` UTF-8, จำแนกผลตอบ 429/5xx/network = ชั่วคราว vs
      401/403/404 = ถาวร (ตารางใน notifications contract)
- [ ] T028 [US1] Dispatcher ใน `src/reporting/dispatcher.ts`: flush outbox
      ทุก 5 วิ, backoff ต่อรายการ, dead → สร้าง system event, ส่งงานละ
      1 ข้อความเสมอ (ไม่มี batch — SC-008), mark sent ทันทีหลังได้ 2xx
      (จำกัดหน้าต่าง at-least-once ตาม data-model), ความล้มเหลวไม่บล็อก
      detection (Constitution IV)
- [ ] T029 [US1] Poll cycle + loop ใน `src/runtime/pollLoop.ts`: 1 รอบ =
      ensureLoggedIn → fetchJobSnapshot → diff → persist+enqueue ใน txn เดียว
      → heartbeat hook + อัปเดต meta.last_successful_poll_at; interval แบบ
      fixed-rate **start-to-start** 25s ± jitter clamp [20s,30s] (หักเวลา
      ทำงานของรอบออกจากการรอ — SC-001ข/FR-003/FR-011); ตัวนับคำขอ/ชม.
      (1 คำขอ = 1 navigation รวม login/retry) เมื่อใกล้/ชนเพดาน 180 →
      ยืดรอบถัดไปพ้นหน้าต่างชั่วโมง + log warn พร้อม unit test ตัวนับใน
      `tests/unit/rateLimit.test.ts`
- [ ] T030 [US1] Cold start ใน `src/runtime/pollLoop.ts` (จุดทำ baseline):
      baseline ครั้งแรก → system event `cold_start_summary` 1 รายการ (รวม
      กรณี 0 งาน — FR-015), ตรวจ cold start ซ้ำใน 7 วันจากไฟล์ประวัติ
      `<LOG_DIR>/cold-start-history.json` (นอก STATE_DIR — deterministic)
      → alert warn
- [ ] T031 [US1] Entrypoints: `src/runtime/once.ts` (รอบเดียวจบ สำหรับ
      `poll:once`) + `src/runtime/main.ts` (loop ถาวร + graceful shutdown
      ปิด browser/db สะอาด)
- [ ] T032 [US1] Integration tests ใน `tests/integration/detect.test.ts`:
      เล่น fixtures ตาม V1 (งานใหม่ → mock Chat ได้รับครบฟิลด์), V2 (รันซ้ำ
      ไม่ซ้ำ), V3 (25 งานครบ), V9 (งานหาย 2 รอบแล้วกลับมา → ข้อความ 🔁
      พร้อม firstSeenAt), V11 (cold start 0/3/25 + ไม่ซ้ำรอบถัดไป), แถว
      malformed ปนแถวปกติ → quarantine + system alert + แถวปกติครบ
      (Constitution II) — พร้อม assertion เวลา: fixture เปลี่ยน → บันทึก
      event ≤ 30s และ mock Chat ได้รับ ≤ 60s นับจากตรวจพบ (SC-001ก/SC-002)

**Checkpoint**: US1 จบ — บอทตรวจจับ+แจ้งเตือนได้จริงกับ fixtures (MVP)

---

## Phase 4: User Story 2 - ระบบทำงานต่อเนื่อง 24/7 และฟื้นตัวได้เอง (Priority: P2)

**Goal**: session ขาด → ต่อเอง, restart → ไม่ซ้ำ/ฟื้นใน 2 นาที, heartbeat
ครบรอบ, error → backoff

**Independent Test**: ฆ่า process/ลบ session/ตัด mock portal ระหว่างรัน —
ระบบกลับมาเองโดยไม่แจ้งซ้ำ + V4, V5, V10 ผ่าน

### Tests for User Story 2 (MANDATORY — เขียนก่อน ต้อง FAIL)

- [ ] T033 [P] [US2] Failure-mode tests ใน `tests/integration/recovery.test.ts`:
      session หมดอายุกลางคัน → re-login + รอบถัดไปปกติ (FR-002),
      storageState หาย/JSON พัง → re-login ไม่ crash loop, restart ระหว่าง
      มีงานค้างแสดง → 0 แจ้งซ้ำ (SC-003), portal timeout ติดกัน → backoff
      40s→80s→cap 5 นาที, ช่องแจ้งเตือนตอบ 503 → คิวค้างแล้ว flush ครบ
      เมื่อกลับมา (V10/FR-013), HTTP 429 → จำแนกเป็นชั่วคราว + backoff,
      restart ระหว่าง dispatch (หลัง POST สำเร็จ ก่อน mark sent) → ซ้ำได้
      ไม่เกิน 1 ข้อความตามหน้าต่าง at-least-once ใน data-model และระบบ
      ไม่ crash

### Implementation for User Story 2

- [ ] T034 [US2] Session expiry detection ใน `src/portal/jobList.ts` +
      `login.ts`: เด้งหน้า login กลางคัน → `SessionExpiredError` →
      ensureLoggedIn แล้ว retry 1 ครั้งในรอบเดิม (portal-adapter contract)
- [ ] T035 [US2] Error backoff ใน `src/runtime/pollLoop.ts`: exponential +
      jitter เมื่อ error ติดกัน (R10), นับ portal ล่มต่อเนื่อง > 10 นาที →
      raise สัญญาณภายใน (**เจ้าของ logic การนับ** — T043 เป็นผู้ wiring
      alert/dedup เท่านั้น ห้ามนับซ้ำ), ฟื้นแล้วกลับ interval ปกติ
- [ ] T036 [US2] Heartbeat ใน `src/monitoring/heartbeat.ts`: ping
      HEALTHCHECKS_PING_URL หลังรอบสำเร็จ (≤ 5 นาที/ครั้ง — FR-010) +
      สร้าง **function กลาง `pingFail()`** สำหรับสถานะมีชีวิตแต่ล้มเหลว
      (ใช้โดย lockout/backoff ยาว — ส่วนกรณี outbox dead ให้ T043 เป็น
      ผู้เรียกใช้ function นี้), ping ห้าม throw กลับเข้า loop
- [ ] T037 [US2] Browser recycle ใน `src/portal/browser.ts` + pollLoop:
      ทุก BROWSER_RECYCLE_HOURS เปิดใหม่ก่อนปิดเก่า — เสร็จใน 1 รอบ poll
      ไม่ทำ heartbeat ขาด (SC-004)
- [ ] T038 [US2] Restart recovery test ใน `tests/integration/restart.test.ts`:
      จำลอง start ใหม่จาก state เดิม → log วัด process start → poll แรก
      สำเร็จ ≤ 2 นาที (SC-006) + ไม่เกิด cold start ซ้ำเมื่อฐานอยู่ครบ

**Checkpoint**: US1+US2 — รันยาวได้จริง ฟื้นตัวเองครบทุก failure ชั่วคราว

---

## Phase 5: User Story 3 - ผู้ดูแลรับรู้ปัญหาทันทีเมื่อระบบติดขัด (Priority: P3)

**Goal**: ทุกความล้มเหลวที่ระบบแก้เองไม่ได้ → SYSTEM_ALERT ใน 5 นาที พร้อม
"ต้องทำ" ต่อกรณี; แก้แล้ว → SYSTEM_RECOVERED; ห้ามล้มเหลวเงียบ

**Independent Test**: จำลองเหตุทีละแบบ (รหัสผิด, CAPTCHA, layout พัง,
webhook 403, db corrupt) — ได้ alert ถูกประเภท ถูกข้อความ ครั้งเดียว +
V7, V8, V12, V13 ผ่าน

### Tests for User Story 3 (MANDATORY — เขียนก่อน ต้อง FAIL)

- [ ] T039 [P] [US3] Failure-mode tests ใน `tests/integration/failures.test.ts`:
      login ผิด 3 ครั้ง → lockout 15 นาที + alert เดียว ไม่ retry รัว (V7),
      CAPTCHA → alert + หยุด ไม่วน (FR-009), layout/marker หาย → evidence
      ถูกสร้าง (sanitized) + alert ไม่เดา parse (V8), webhook 403 ถาวร →
      จำแนกถูก + retry ห่าง + `/fail` ping (V13), db corrupt → ไฟล์
      `.corrupt-*` + alert + cold start ต่อ (V12), alert เรื่องเดิมยัง active
      ไม่ส่งซ้ำ + recovered ปลดล็อก

### Implementation for User Story 3

- [ ] T040 [US3] Login lockout ใน `src/portal/login.ts` + jobStore meta:
      นับ failure → ครบ LOGIN_MAX_RETRY → lockout LOGIN_LOCKOUT_MINUTES +
      system alert (FR-009) — ระหว่าง lockout ไม่แตะ portal
- [ ] T041 [US3] Layout/locale/pagination guards ใน `src/portal/jobList.ts`:
      `LayoutChangedError` พร้อม evidence sanitize (FR-012), locale เปลี่ยน
      นับเป็น layout case, pagination indicator → alert WARN (FR-009)
- [ ] T042 [US3] System alert flow ใน `src/reporting/notifier.ts` +
      dispatcher: เติม mapping ตาราง action 8 trigger → payload ของ
      SYSTEM_ALERT + วงจร resolve/SYSTEM_RECOVERED ตามคอลัมน์ Recovered
      ใน notifications contract (โครง template พื้นฐานทำแล้วใน T026 —
      ห้าม render ซ้ำซ้อน) — ส่งผ่าน outbox เดียวกัน (ห้ามส่งตรง)
- [ ] T043 [US3] Wiring ครบทุก trigger ใน `src/runtime/pollLoop.ts` +
      dispatcher: portal ล่ม > 10 นาที (รับสัญญาณจาก T035 — ไม่นับเอง),
      outbox dead → alert + เรียก `pingFail()` จาก T036, cold start ซ้ำ,
      db corrupt (จาก T012) — แต่ละ trigger จับคู่ dedup_key + เงื่อนไข
      recovered ตามคอลัมน์ Recovered ใน notifications contract

**Checkpoint**: ทุก story อิสระครบ — ไม่มีเส้นทางล้มเหลวเงียบเหลืออยู่

---

## Phase 6: Polish & Cross-Cutting Concerns

- [ ] T044 [P] Secret-scan test ใน `tests/integration/redaction.test.ts`:
      รันทุก flow แล้วสแกน log + alert payload + evidence ทั้งหมด เทียบ
      string กับค่า config จริง — ต้องไม่พบเลย (เกณฑ์ตรวจรับ FR-012)
- [ ] T045 [P] Data retention ใน `src/state/retention.ts` + unit test:
      prune outbox sent > 90 วัน, evidence > 90 วัน (รันวันละครั้งใน loop)
      ตาม data-model Data Retention
- [ ] T046 Ops script requeue ใน `src/runtime/requeue.ts`: `npm run
      outbox:requeue` คืนรายการ dead → pending (ใช้ตามตาราง action)
- [ ] T047 Live smoke กับ portal จริง (รันมือ): `LIVE_PORTAL=1 npm run
      poll:once` — login จริงสำเร็จ, cold start summary "0 งาน" เข้า Chat
      จริง, heartbeat ping ขึ้น Healthchecks dashboard; ทดสอบ alert จริง:
      หยุดระบบ > 10 นาที → Healthchecks แจ้งเข้า Chat (บันทึกผลใน
      research.md R5 + ติ๊ก CHK005)
- [ ] T048 Final gates: `npm run lint` + `npm run typecheck` +
      `npm run test:coverage` (≥ 80% บน core) ผ่านครบ + ไล่ V1–V13 ตาม
      quickstart บันทึกผล + ตรวจ memory < 1 GB ระหว่างรันต่อเนื่อง
      ≥ 24 ชั่วโมงภายใต้ PM2 (ผ่าน browser recycle ≥ 4 รอบ)
- [ ] T049 [P] เขียน `README.md`: สรุป setup/รัน/ops ชี้ไปที่ quickstart +
      ตาราง SC responsibility
- [ ] T051 [P] Script สรุป latency ใน `src/runtime/latencyReport.ts` +
      npm script `report:latency`: อ่าน log JSON สรุป p95 ของ detection
      (ช่วงห่างรอบ ตามนิยาม SC-001ข) และ notify latency (SC-002) ต่อช่วง
      เวลา — ใช้ตรวจรับและบันทึกลง docs/acceptance/001.md (ID ต่อท้าย
      เพราะเพิ่มจากผล /speckit-analyze)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: เริ่มได้ทันที
- **Foundational (Phase 2)**: ต้องรอ Setup — **บล็อกทุก user story**
- **US1 (Phase 3)**: รอ Foundational — ไม่พึ่ง story อื่น (MVP)
- **US2 (Phase 4)**: รอ Foundational; ต่อยอดไฟล์ของ US1 (pollLoop, login,
  browser) — เริ่มหลัง US1 เสร็จจะราบรื่นที่สุด
- **US3 (Phase 5)**: รอ Foundational; ใช้ dispatcher/notifier ของ US1 และ
  heartbeat ของ US2 (สำหรับ `/fail`) — แนะนำทำหลัง US2
- **Polish (Phase 6)**: รอทุก story ที่ต้องการ ship

### Within Each Story

- Tests เขียนก่อนและต้อง FAIL ก่อน implement (Constitution II)
- detection (pure) → portal → reporting → runtime
- T047 (live smoke) ต้องทำหลัง T036 (heartbeat) และก่อนรัน 24/7 จริง

### Parallel Opportunities

- Setup: T002, T003, T004, T006 ขนานกันได้หลัง T001
- Foundational: T008 ∥ T011 (เขียน test ก่อน) จากนั้น T014 ∥ T015 หลัง T012
- US1: T016, T017, T018, T019 ขนานทั้งหมด; T027 ขนานกับ T026
- ข้าม story: หลัง Foundational ทีมหลายคนแยก US1/US2/US3 ได้ แต่ไฟล์
  pollLoop/login ทับกัน — ถ้าทำคนเดียวให้เรียงตาม priority

---

## Parallel Example: User Story 1

```bash
# เขียน tests + fixtures พร้อมกัน (ต่างไฟล์ทั้งหมด):
Task: "Unit tests jobKey ใน tests/unit/jobKey.test.ts"
Task: "Unit tests diff ใน tests/unit/diff.test.ts"
Task: "Unit tests formatter ใน tests/unit/notifier.test.ts"
Task: "สร้าง fixtures HTML + mock webhook ใน tests/fixtures/"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup → Phase 2 Foundational
2. Phase 3 US1 ทั้งหมด → **หยุดตรวจรับ**: V1, V2, V3, V11 ผ่านกับ fixtures
3. รัน `LIVE_PORTAL=1 npm run poll:once` ดู cold start จริงเข้า Chat
   → ได้ MVP ที่เฝ้างานและแจ้งเตือนได้แล้ว (ยังไม่ทน restart/ไม่มี alert ครบ)

### Incremental Delivery

1. US1 → ทดสอบอิสระ → ใช้งานจริงแบบเฝ้าดูใกล้ชิดได้
2. US2 → restart/heartbeat/recycle → ปล่อยรัน 24/7 ใต้ PM2 ได้จริง
3. US3 → alert ครบทุก trigger → เลิกเฝ้าหน้าจอได้อย่างมั่นใจ
4. Polish → secret-scan + retention + live validation → ปิดฟีเจอร์

---

## Notes

- ทุก task ระบุไฟล์ชัดเจน — [P] = ต่างไฟล์และไม่พึ่ง task ค้าง
- Commit หลังจบ task หรือกลุ่ม logical เดียวกัน
- เกณฑ์ตรวจรับสุดท้ายอยู่ที่ quickstart.md (V1–V14 + ตาราง SC)
- V14 (30 วัน) เริ่มนับหลัง deploy จริง — ไม่บล็อกการปิด tasks เช่นเดียวกับ
  การรันต่อเนื่อง 7 วันของ SC-003 (restart ≥ 3 ครั้ง) ซึ่งเริ่มนับหลัง deploy
  และบันทึกผลใน docs/acceptance/001.md ตามตาราง SC ใน quickstart
