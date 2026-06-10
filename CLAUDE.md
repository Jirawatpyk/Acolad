# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

บอทเฝ้า Acolad Partner Portal ตลอด 24/7: ตรวจจับงานแปลใหม่ → แจ้งเตือน
Google Chat ภายใน 60 วินาที (ฟีเจอร์ 001) — ฟีเจอร์ถัดไปคือกดรับงานอัตโนมัติ
+ บันทึกรายละเอียด task ลง Google Sheets

**สถานะปัจจุบัน**: spec/plan/tasks ของฟีเจอร์ 001 สมบูรณ์และผ่าน
`/speckit-analyze` แล้ว — **ยังไม่เริ่ม implement** (ไม่มี `src/` จนกว่าจะรัน
`/speckit-implement` ตาม tasks.md)

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:

**Current feature**: 001-login-job-detection
**Current plan**: specs/001-login-job-detection/plan.md
**Spec**: specs/001-login-job-detection/spec.md
**Tasks**: specs/001-login-job-detection/tasks.md (51 tasks — ลำดับการ implement)
**Design artifacts**: specs/001-login-job-detection/ (research.md, data-model.md, quickstart.md, contracts/)
**Constitution**: .specify/memory/constitution.md (v1.0.1 — 8 principles, gate ทุก plan/PR)
**Stack**: Node.js 22 + TypeScript strict, Playwright (Chromium), SQLite (better-sqlite3), pino, zod, PM2 บน Windows 11
<!-- SPECKIT END -->

## Workflow

งานทั้งหมดขับเคลื่อนด้วย Spec Kit: `/speckit-specify` → `/speckit-clarify` →
`/speckit-plan` → `/speckit-tasks` → `/speckit-analyze` → `/speckit-implement`
— feature ที่ active ชี้โดย `.specify/feature.json`

**Constitution เป็นกฎสูงสุด (non-negotiable)** — ข้อที่กระทบงานเขียนโค้ดตรงๆ:

- TDD บังคับสำหรับ core logic (`src/detection/`, `src/state/`,
  `src/reporting/`): เขียน test ก่อน ต้อง FAIL ก่อน implement; coverage gate
  ≥ 80% เฉพาะสามโมดูลนี้
- Failure-mode suite เป็นข้อบังคับ (login fail, session expiry, timeout,
  malformed jobs, quota/auth error, restart กลางรอบ)
- Live-portal tests อยู่หลัง env flag `LIVE_PORTAL=1` เท่านั้น — **ห้ามรันใน CI**
- ทุกการละเมิดหลักการต้องบันทึกใน Complexity Tracking ของ plan.md
  (มี 2 รายการแล้ว: daily summary deferred, at-least-once window)

## Commands

npm scripts ถูกกำหนดใน tasks.md T001 (มีผลเมื่อ Phase 1 ถูก implement):

```powershell
npm run lint           # ESLint + Prettier — ต้อง 0 error
npm run typecheck      # tsc --noEmit (strict)
npm test               # Vitest unit + integration (fixtures เท่านั้น)
npx vitest run tests/unit/diff.test.ts   # รัน test ไฟล์เดียว
npm run test:coverage  # gate ≥ 80% บน detection/state/reporting
npm run poll:once      # รันรอบเดียวจบ (smoke) — เพิ่ม $env:LIVE_PORTAL='1' สำหรับ portal จริง
npm run build; pm2 start ecosystem.config.cjs   # รัน 24/7
npm run outbox:requeue # ops: คืนรายการแจ้งเตือน dead → pending
npm run report:latency # สรุป p95 จาก log สำหรับตรวจรับ SC-001/SC-002
```

เกณฑ์ตรวจรับ = ตาราง V1–V14 ใน `specs/001-login-job-detection/quickstart.md`
(SC เป็น authoritative เหนือ FR ในการวัดผล)

## Architecture

วงจรหลัก (อ่าน plan.md + data-model.md + contracts/ ประกอบ):

```
pollLoop (fixed-rate start-to-start 25s±5 clamp [20,30]s, ≤180 คำขอ/ชม.)
  → PortalClient.ensureLoggedIn() → fetchJobSnapshot()   [src/portal/]
  → diff(snapshot, prevState)                            [src/detection/ — pure]
  → persist state + enqueue outbox ใน SQLite txn เดียว   [src/state/]
  → dispatcher flush ทุก 5s → Google Chat webhook        [src/reporting/]
  → heartbeat ping Healthchecks.io                       [src/monitoring/]
```

หลักออกแบบที่ต้องรักษา (มาจาก clarifications/analyze — ไม่ใช่สไตล์):

- **`detection/diff.ts` เป็นเจ้าของ state transition แต่เพียงผู้เดียว**
  (first_seen / missing เมื่อไม่พบ ≥ 2 รอบติด / relisted) — jobStore แค่
  persist ผลลัพธ์ ห้ามตัดสินซ้ำ; ตัวนับ `consecutive_misses` อยู่ในตาราง jobs
- **Appearance-event model**: งานหนึ่งงานมีได้หลาย "การปรากฏ" — dedup ทำ
  ที่ระดับการปรากฏ ไม่ใช่ตลอดชีพงาน; งานที่หายแล้วกลับมา → แจ้งซ้ำพร้อม
  ป้าย "งานกลับมาอีกครั้ง"
- **Outbox pattern**: เหตุการณ์ทุกประเภท (งาน + system alert) ไหลผ่าน
  ตาราง outbox เดียว — ห้ามส่งแจ้งเตือนตรงโดยไม่ผ่าน outbox; การส่งเป็น
  at-least-once (mark sent ทันทีหลัง 2xx — ข้อยกเว้นบันทึกแล้ว)
- **ส่งงานละ 1 ข้อความเสมอ ไม่มี batch** (ตัดสินใจแล้วใน /speckit-analyze
  — อย่าเพิ่มกลับ); template ข้อความตายตัวใน contracts/notifications.md
  (ภาษาไทย, เวลา ISO 8601 +07:00)
- **Fail loud**: selector/marker หาย, locale เปลี่ยน, เจอ pagination,
  CAPTCHA → เก็บ evidence (sanitized) + system alert — ห้ามเดา parse
  ห้ามทำงานต่อเงียบๆ; selector รวมศูนย์ที่ `src/portal/selectors.ts` ไฟล์เดียว
- **Portal ยังไม่มีงานจริงให้ดู** — parser พัฒนาจาก fixtures ใน
  `tests/fixtures/` และมี evidence-first mode เก็บ HTML/screenshot งานจริง
  ตัวแรกไว้ยืนยัน selector

## ข้อควรระวังเฉพาะโปรเจกต์

- **Secrets อยู่ใน `.env` เท่านั้น** (gitignored): portal credentials,
  Google Chat webhook URLs, Healthchecks ping URL — ทั้งหมดอยู่ใน pino
  redaction list ห้ามโผล่ใน log/alert/evidence; `state/storageState.json`
  (session cookies) เป็นความลับระดับเดียวกับรหัสผ่าน
- เครื่องรันเป็น Windows 11: `pm2-windows-startup` ทำงานหลัง user logon
  เท่านั้น — การรองรับรีบูตอัตโนมัติ (Windows Update) ต้องใช้ auto-logon
  หรือ NSSM ตามหัวข้อ "รัน 24/7" ใน quickstart.md
- PowerShell 5.1 เป็น shell หลักของเครื่องนี้ (ไม่มี `&&` — ใช้ `;`)
- จังหวะเรียก portal มีเพดานเข้มงวด (กันบัญชีถูกระงับ): ห้ามลด interval
  ต่ำกว่า 20s หรือเพิ่มความถี่คำขอโดยไม่แก้ FR-011 ใน spec ก่อน
