# Phase 0 Research: ระบบ Login และตรวจจับงานใหม่

**Feature**: 001-login-job-detection | **Date**: 2026-06-10

ทุกหัวข้อ NEEDS CLARIFICATION ใน Technical Context ถูก resolve แล้ว
ด้วยการตัดสินใจด้านล่าง

## R1: Runtime & ภาษา

- **Decision**: Node.js 22 LTS + TypeScript 5.x (`strict: true`)
- **Rationale**: Playwright เป็น first-class บน Node; ได้ static typing ตาม
  Constitution I; ภาษาเดียวครบทุกโมดูล (browser, SQLite, webhook — รวมถึง
  Sheets เมื่อถึงฟีเจอร์กดรับงาน); ecosystem บน Windows เสถียร
- **Alternatives considered**: Python + Playwright (ใช้ได้ แต่ type checking
  อ่อนกว่าและทีมต้องดูแล venv บน Windows); C#/.NET (เกินจำเป็นสำหรับบอท
  ขนาดนี้)

## R2: Browser Automation

- **Decision**: Playwright + Chromium headless, ใช้ `storageState` persist
  session cookies ลงไฟล์ (gitignored) เพื่อให้รีสตาร์ตแล้วไม่ต้อง login ใหม่
  ถ้า session ยังไม่หมดอายุ
- **Rationale**: auto-waiting ลด flaky, มี trace/screenshot ในตัว (ตอบ
  Constitution V/VI), route mocking ใช้ทำ integration test กับ fixtures ได้ตรง,
  รองรับการตรวจ selector หายเพื่อ fail-safe
- **Alternatives considered**: Puppeteer (ไม่มี auto-wait ดีเท่า, ไม่มี route
  fixtures สะดวกเท่า); Selenium (ช้า, API เก่า); HTTP client ล้วน (เร็วสุด
  แต่เสี่ยงสูงมาก — portal เป็นเว็บ login-protected ที่เราไม่รู้โครงสร้าง API
  ภายใน และยังไม่มีงานตัวอย่างให้ reverse-engineer; อาจ revisit ภายหลังเป็น
  optimization เมื่อเห็นโครงสร้างจริง)

## R3: State Store

- **Decision**: SQLite ผ่าน better-sqlite3, เปิด WAL mode, ไฟล์ `state/acolad.db`
- **Rationale**: durable + transactional ตาม Constitution VII (เขียน job state
  กับ outbox ใน transaction เดียว), API แบบ synchronous เรียบง่ายไม่มี race,
  ไม่ต้องติดตั้ง service เพิ่ม, ฟื้นหลัง crash ได้ทันที
- **Alternatives considered**: ไฟล์ JSON (ไม่ transactional — crash กลางเขียน
  = state พัง); Google Sheets เป็น state (latency สูง, quota จำกัด, ผิดหลัก
  "ทะเบียนฝั่งทีมไม่ใช่ source of truth")

## R4: การจัดการแจ้งเตือน — Outbox Pattern

- **Decision**: ทุก appearance event ถูกเขียนลงตาราง `outbox` ใน transaction
  เดียวกับ state change; dispatcher แยกต่างหาก flush ทุก 5 วินาที ส่งไป
  Google Chat พร้อม retry + exponential backoff; แต่ละแถว outbox มี event id
  ใช้ dedup ฝั่งผู้ส่ง (ออกแบบ channel เป็น enum ขยายได้ — ฟีเจอร์กดรับงาน
  จะเพิ่มช่องทาง Sheets ผ่านกลไกเดิม)
- **Rationale**: ตอบ FR-013 (ช่องทางล่มต้องไม่เสียเหตุการณ์), FR-005 (ไม่ส่งซ้ำ),
  Constitution IV (reporting failure ไม่บล็อก detection) และ VII (retry ปลอดภัย)
  ในกลไกเดียว
- **Alternatives considered**: ส่งตรงใน poll loop (ง่ายกว่า แต่ Chat ล่ม =
  บล็อกหรือเสียเหตุการณ์); message queue ภายนอก (RabbitMQ ฯลฯ — เกินขนาด
  งานมาก)

## R5: Heartbeat / Dead-man Switch

- **Decision**: Healthchecks.io (free tier) — บอท ping URL หลังจบ poll cycle
  ที่สำเร็จ; ตั้ง period 5 นาที + grace ให้ครบเกณฑ์ "เงียบเกิน 10 นาทีต้องแจ้ง";
  ตั้ง integration ของ Healthchecks ให้ยิงเข้า Google Chat webhook ช่องแจ้งเตือน
  ระบบ
- **Rationale**: ตามผล clarify Q3 — ครอบคลุมเครื่องดับ/เน็ตหลุดทั้งเครื่อง
  ซึ่ง watchdog ในเครื่องเดียวกันตรวจไม่ได้; ฟรี; setup เป็น URL เดียว
- **Alternatives considered**: watchdog ตัวที่สองในเครื่อง (ไม่ครอบคลุม
  เครื่องดับ); ข้อความ heartbeat ในแชทให้คนดู (spam + พึ่งคน); UptimeRobot
  (เน้น uptime เว็บ ไม่ใช่ dead-man switch โดยตรง)
- **แผนสำรอง**: หาก Healthchecks.io เปลี่ยนเงื่อนไข free tier หรือบริการ
  ล่มเอง → สลับไป UptimeRobot heartbeat monitor หรือ self-host Healthchecks
  ได้ภายใน 1 วันทำการ — จุดเปลี่ยนในระบบมีจุดเดียวคือค่า
  `HEALTHCHECKS_PING_URL`
- **ผลการตรวจสอบจริง (2026-06-10)**: ✅ ดำเนินการแล้ว — สร้าง check
  (period 5 นาที, grace 5 นาที), ผูก Google Chat integration เข้าช่อง
  แจ้งเตือนระบบ, ping URL เก็บใน `.env` (`HEALTHCHECKS_PING_URL`) และ
  ping ทดสอบได้ผล `OK` (ยืนยัน URL ใช้งานได้); ผู้ใช้ยืนยันการตั้งค่าและ
  ทดสอบตามขั้นตอนแล้ว — การทดสอบ dead-man alert ซ้ำแบบ end-to-end
  จะเกิดอีกครั้งใน T047 (live smoke ก่อนรัน 24/7)

## R6: Supervisor บน Windows

- **Decision**: PM2 (`ecosystem.config.cjs`) + `pm2-windows-startup` ให้ฟื้น
  อัตโนมัติหลังเครื่องรีบูต; `max_memory_restart: 900M` เป็น safety net
  ตาม Constitution VIII
- **Rationale**: restart-on-crash + log management + uptime วัดได้ในคำสั่งเดียว;
  ทีมตรวจสถานะด้วย `pm2 status` ได้ง่าย
- **ข้อจำกัดที่ต้องจัดการ**: `pm2-windows-startup` ทำงานผ่าน registry Run
  key ซึ่งรันหลัง user logon เท่านั้น — การรีบูตอัตโนมัติ (เช่น Windows
  Update) ที่ไม่มีคน login จะทำให้บอทไม่กลับมา ต้องเลือกหนึ่งทางตอน deploy:
  (ก) ตั้ง Windows auto-logon + ล็อกหน้าจอทันที (ง่าย, แนะนำ) หรือ
  (ข) รันเป็น Windows Service ผ่าน NSSM (ไม่พึ่ง logon) — ดูขั้นตอนใน
  quickstart
- **Alternatives considered**: NSSM (ติดตั้งเป็น Windows service ได้ดี แต่
  จัดการ log/restart policy เองมากกว่า — เก็บเป็น fallback ใน quickstart);
  Task Scheduler เปล่าๆ (ไม่มี crash-restart ที่ไว)

## R7: Logging

- **Decision**: pino (JSON) + pino-roll หมุนไฟล์รายวัน เก็บ 14 วันใน `logs/`;
  ฟิลด์บังคับ: `time, level, module, jobKey?, action, outcome, latencyMs?`;
  มี redaction list กัน secrets หลุดลง log
- **Rationale**: ตรง Constitution V แบบไม่ต้องตั้ง infrastructure เพิ่ม;
  pino เร็วและ structured โดย default
- **Alternatives considered**: winston (ช้ากว่า, config เยอะ); console.log
  (ไม่ structured, ผิด constitution)

## R8: Google Sheets Adapter — เลื่อนไปฟีเจอร์กดรับงาน

- **Decision**: **ไม่ทำในฟีเจอร์นี้** — ผู้ใช้ยืนยัน (Clarifications
  2026-06-10) ว่าการบันทึก Sheets เกิดตอน "กดรับงาน" เป็นรายละเอียดของ
  task ที่รับ จึงเป็นขอบเขตของฟีเจอร์กดรับงาน
- **Rationale**: ฟีเจอร์ตรวจจับเหลือปลายทางเดียว (Google Chat) ลด dependency
  (googleapis, service account) และลดงาน setup ฝั่งผู้ใช้; แนวทางเทคนิคที่
  ศึกษาไว้ (googleapis + service account scope `spreadsheets` + batch append
  + dedup ด้วย event_id) ยังใช้ได้ตอนทำฟีเจอร์กดรับงาน
- **Alternatives considered**: เขียน Sheets ตั้งแต่ฟีเจอร์นี้ทุกงานที่ตรวจพบ
  (ถูกปฏิเสธโดยผู้ใช้ — ทะเบียน Sheets มีไว้บันทึกงานที่ "รับแล้ว" เท่านั้น)

## R9: กลยุทธ์ Parser เมื่อยังไม่มีงานตัวอย่างจริง

- **Decision**: สร้าง parser จาก fixtures สมมุติ (โครงสร้างทั่วไปของตาราง
  รายการงาน) + "evidence-first mode": เมื่อพบงานจริงครั้งแรก ระบบเก็บ HTML +
  screenshot ของหน้ารายการงานไว้ที่ `state/evidence/` แล้วแจ้งผู้ดูแลให้ยืนยัน
  ว่า parser อ่านถูกต้อง; selector ทั้งหมดรวมศูนย์ในไฟล์เดียว ปรับได้โดยไม่แตะ
  ตรรกะ
- **Rationale**: ตามข้อจำกัดจริงที่ portal ยังว่าง (บันทึกใน Clarifications);
  ลดความเสี่ยง parser เดาผิดเงียบๆ ตาม Constitution VI
- **Alternatives considered**: รอให้มีงานจริงก่อนค่อยพัฒนา (เสียเวลารอ และ
  เสี่ยงพลาดงานแรกๆ); hardcode selector จากหน้า login เท่าที่เห็น (ครอบคลุม
  ไม่พอ)

## R10: จังหวะ Polling และความสุภาพต่อ Portal

- **Decision**: รอบปกติ 25s ± 5s jitter (ครบ "ตรวจพบ ≤ 30s" ของ FR-003);
  เมื่อเกิด error ติดต่อกัน ใช้ exponential backoff (40s → 80s → … cap 5 นาที)
  พร้อมแจ้งผู้ดูแลเมื่อเกินเกณฑ์; login ใหม่เฉพาะเมื่อ session หมดอายุ ไม่ login
  ทุกรอบ; ใช้การ refresh เฉพาะหน้ารายการงาน 1 ครั้งต่อรอบ
- **Rationale**: สมดุลระหว่าง FR-003 (เร็ว) กับ FR-011/SC-007 (ไม่โดนระงับ
  บัญชี) — ปริมาณ ~3,000 requests/วัน ต่อ 1 หน้า เทียบเท่าผู้ใช้เปิดหน้าค้างไว้
  ซึ่งเป็นพฤติกรรมปกติของ freelancer ที่เฝ้างาน
- **Alternatives considered**: ผ่อนตอนกลางคืน (ลด request แต่เสี่ยงพลาดงาน
  ที่ลูกค้ายุโรปโพสต์ช่วงกลางคืนไทย — ขัดเป้าหมายหลักของผู้ใช้ "รัน 24/7");
  WebSocket/notification ของ portal (ยังไม่รู้ว่ามี — revisit เมื่อเห็นโครงสร้างจริง)

## R11: Testing Stack

- **Decision**: Vitest + @vitest/coverage-v8 (gate 80% บน `detection/`,
  `state/`, `reporting/`); integration ใช้ Playwright เปิด fixtures HTML ผ่าน
  `page.route()`; mock Google Chat webhook ด้วย local HTTP server (undici
  MockAgent — mock ของ Sheets จะเพิ่มตอนฟีเจอร์กดรับงาน); ชุด failure-mode
  ตาม Constitution II ครบทุกข้อ; live-portal
  smoke test อยู่หลัง env flag `LIVE_PORTAL=1` รันด้วยมือเท่านั้น
- **Rationale**: Vitest เร็วและรองรับ TS ตรงๆ; fixtures ทำให้ทดสอบ "หน้าว่าง /
  มีงาน / โครงสร้างพัง / session หมดอายุ" ได้ deterministic
- **Alternatives considered**: Jest (ช้ากว่า, ESM/TS ต้อง config เพิ่ม);
  ทดสอบกับ portal จริงใน CI (ผิด Constitution II ข้อ live-portal isolation)
