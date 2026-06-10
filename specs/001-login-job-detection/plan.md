# Implementation Plan: ระบบ Login และตรวจจับงานใหม่บน Acolad Partner Portal

**Branch**: `001-login-job-detection` | **Date**: 2026-06-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-login-job-detection/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

บอทเฝ้าดู Acolad Partner Portal ตลอด 24/7: เข้าสู่ระบบอัตโนมัติด้วย Playwright
(persistent session), ตรวจรายการงานแปลทุก ~25 วินาที, เทียบกับฐานสถานะใน SQLite
เพื่อหา "การปรากฏใหม่" ของงาน (รวมกรณีงานกลับมาอีกครั้ง), แล้วส่งแจ้งเตือนเข้า
Google Chat ผ่าน outbox pattern ที่กันการแจ้งซ้ำและทนต่อการรีสตาร์ต พร้อม
heartbeat ไปยัง Healthchecks.io (dead-man switch) และ PM2 ทำหน้าที่
supervisor — การบันทึกลง Google Sheets เกิดตอน "กดรับงาน" จึงอยู่ในฟีเจอร์
ถัดไป (per Clarifications 2026-06-10)

## Technical Context

**Language/Version**: Node.js 22 LTS + TypeScript 5.x (`strict: true`)

**Primary Dependencies**: Playwright (Chromium, headless), better-sqlite3,
pino + pino-roll (JSON logs), zod (config/input validation), dotenv
(googleapis สงวนไว้สำหรับฟีเจอร์กดรับงาน — ฟีเจอร์นี้ไม่ติดตั้ง)

**Storage**: SQLite (WAL mode) ที่ `state/acolad.db` — jobs, appearance events,
notification outbox (Google Sheets ไม่อยู่ในขอบเขตฟีเจอร์นี้)

**Testing**: Vitest (unit + integration, coverage ≥ 80% บน core modules),
portal HTML fixtures + Playwright route mocking, mock webhook server

**Target Platform**: Windows 11 (เครื่อง always-on ของทีม), รันภายใต้ PM2 +
pm2-windows-startup

**Project Type**: Single project (long-running service/bot)

**Performance Goals**: ตรวจพบงานใหม่ ≤ 30 วินาที (polling 25s ± 5s jitter),
แจ้งเตือนถึง Chat ≤ 60 วินาทีหลังตรวจพบ, ฟื้นจากรีสตาร์ต ≤ 2 นาที

**Constraints**: memory steady-state < 1 GB (recycle browser ทุก 6 ชม.),
อัตราเรียก portal สุภาพ (1 refresh/รอบ + jitter + backoff เมื่อ error),
ไม่มี secrets ใน repo/logs/screenshots, เวลาแสดงผล Asia/Bangkok

**Scale/Scope**: บัญชีเดียว, งานคาดการณ์ < 100 งาน/วัน, ฐานข้อมูลโตช้า
(< 100 MB/ปี), ผู้รับแจ้งเตือน = ทีมเดียวผ่าน 1 ช่อง Chat

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| หลักการ | การปฏิบัติตามในแผนนี้ | ผล |
|---------|------------------------|-----|
| I. Code Quality | แยกโมดูล portal / detection / state / reporting / monitoring / runtime ตามโครงสร้างด้านล่าง; ESLint + Prettier + TS strict บังคับใน CI/pre-commit; reporting ใช้ interface `Notifier` ร่วมกัน | ✅ PASS |
| II. Testing Standards | TDD สำหรับ detection diff/dedup, state store, outbox; failure-mode suite ครอบคลุม login fail, session expiry, timeout, malformed jobs, quota/auth error, restart กลางรอบ; coverage gate ≥ 80%; live-portal tests อยู่หลัง flag `LIVE_PORTAL=1` ไม่รันใน CI | ✅ PASS |
| III. UX Consistency | message schema คงที่ต่อประเภทเหตุการณ์ (ดู contracts/notifications.md); เวลา ISO 8601 Asia/Bangkok ทุกจุด; Sheets schema จะกำหนดในฟีเจอร์กดรับงานซึ่งเป็นผู้เขียน Sheets | ✅ PASS |
| IV. Reliability & Recovery | PM2 auto-restart; retry + exponential backoff + jitter ทุก external call; outbox flush ตามหลังเมื่อช่องทางล่ม; heartbeat → Healthchecks.io (period 5 นาที + grace 5 นาที — เงียบเกิน 10 นาทีจึงแจ้ง Chat ตาม FR-010); state ฟื้นจาก SQLite | ✅ PASS |
| V. Observability | pino JSON logs (rotate, เก็บ 14 วัน); ทุก poll cycle / detection / dispatch log พร้อม outcome + latency; เก็บ screenshot + HTML เมื่อเจอสภาพหน้าผิดคาด; **daily summary เลื่อนไปฟีเจอร์ถัดไป** (ดู Complexity Tracking) | ⚠ PASS (มี deferral 1 จุด) |
| VI. Robustness | zod validate ทุก config/ข้อมูลงานที่ parse ได้; selector guard — ไม่พบโครงสร้างที่คาด → หยุด+เก็บหลักฐาน+แจ้ง; timeout ชัดเจนทุก operation; ตรวจ session expiry แล้ว re-login อัตโนมัติ; แยก "รายการว่างจริง" กับ "อ่านหน้าไม่สำเร็จ" ด้วย marker ของหน้า | ✅ PASS |
| VII. Idempotency & State | job key = portal job ID (ถ้ามี) หรือ composite hash; appearance-event model (first_seen/missing/relisted); เขียน state + outbox ใน transaction เดียวก่อน dispatch; ทุก dispatch ทำซ้ำได้ปลอดภัย (dedup ด้วย event id) | ✅ PASS |
| VIII. Performance | polling 25s ± 5s; dispatcher flush ทุก 5s (แจ้งเตือน ≤ 60s); browser recycle ทุก 6 ชม. กัน memory leak | ✅ PASS |

**Post-Design Re-check (หลัง Phase 1)**: ผ่านทุกข้อเช่นเดิม — design artifacts
ไม่เพิ่มการละเมิดใหม่; deferral เดิม 1 จุดคงอยู่ตามที่บันทึกไว้

## Project Structure

### Documentation (this feature)

```text
specs/001-login-job-detection/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── config.md        # env vars contract
│   ├── notifications.md # Chat message schemas (Sheets → ฟีเจอร์กดรับงาน)
│   └── portal-adapter.md# PortalClient interface + error taxonomy
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── config/              # โหลด .env + zod schema validation (fail fast)
│   └── index.ts
├── portal/              # Playwright: login, session, อ่านรายการงาน
│   ├── browser.ts       # lifecycle ของ browser/context + recycle
│   ├── login.ts         # login flow + ตรวจ CAPTCHA/2FA + retry/lockout
│   ├── selectors.ts     # selector registry รวมศูนย์ (R9)
│   └── jobList.ts       # อ่าน+parse รายการงาน + evidence capture
├── detection/           # ตรรกะหลัก (pure logic, ไม่มี I/O)
│   ├── jobKey.ts        # สร้าง stable job key
│   └── diff.ts          # เทียบ snapshot → appearance events
├── state/               # SQLite store (better-sqlite3, WAL)
│   ├── db.ts            # เปิด/migrate ฐานข้อมูล + จัดการฐานพัง (FR-017)
│   ├── jobStore.ts      # jobs + appearance events
│   ├── systemEvents.ts  # system alerts/recovered + dedup (FR-009/FR-018)
│   ├── retention.ts     # prune ตาม Data Retention (data-model)
│   └── outbox.ts        # notification outbox (transactional)
├── reporting/           # Notifier interface + adapters
│   ├── notifier.ts      # interface + message formatter (Thai)
│   ├── googleChat.ts    # webhook adapter (system channel)
│   └── dispatcher.ts    # outbox flush loop + retry/backoff
│                        # (sheets adapter เพิ่มในฟีเจอร์กดรับงาน ผ่าน interface เดิม)
├── monitoring/
│   ├── logger.ts        # pino JSON + rotation 14 วัน
│   └── heartbeat.ts     # ping Healthchecks.io หลัง poll สำเร็จ
└── runtime/
    ├── pollLoop.ts      # วงรอบหลัก: login→fetch→diff→persist→heartbeat
    ├── once.ts          # รันรอบเดียวแล้วจบ (npm run poll:once — smoke test)
    ├── requeue.ts       # ops script: คืน outbox dead → pending
    └── main.ts          # entry point + graceful shutdown

tests/
├── unit/                # detection, jobKey, formatter, outbox logic
├── integration/         # poll cycle กับ portal fixtures + mock webhook
└── fixtures/            # HTML หน้า login/รายการงาน (ว่าง/มีงาน/พัง)

ecosystem.config.cjs     # PM2 config (restart, log paths)
state/                   # SQLite db + evidence captures (gitignored)
logs/                    # JSON logs (gitignored)
```

**Structure Decision**: Single project ตาม Option 1 ของ template — บอทตัวเดียว
ไม่มี frontend/backend แยก; โมดูลแบ่งตามหลักการ Constitution I โดย
`detection/` เป็น pure logic ปลอด I/O เพื่อให้ TDD ทำได้ตรงไปตรงมา และ
`reporting/` ซ่อนปลายทางไว้หลัง interface เดียว (เพิ่ม daily report ภายหลังได้
โดยไม่แตะ detection)

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Daily summary (Constitution V) ยังไม่ implement ในฟีเจอร์นี้ | ผู้ใช้กำหนดให้ daily report ใช้ Google Chat ช่องที่สอง ซึ่งยังไม่มี webhook (placeholder ใน .env) — จะทำเป็นฟีเจอร์ถัดไปเมื่อได้ URL | ส่งรายงานประจำวันเข้าช่องแจ้งเตือนระบบไปก่อน → ถูกปฏิเสธเพราะผู้ใช้ตั้งใจแยก 2 ช่องชัดเจน และการปนช่องทำให้ alert channel รก ผิดหลัก UX Consistency |
