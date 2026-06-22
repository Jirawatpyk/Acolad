# Implementation Plan: ตรวจจับ + กดรับงานบน XTM + บันทึก Google Sheets

**Branch**: `002-xtm-detect-accept` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-xtm-detect-accept/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

ย้ายเป้าหมายการเฝ้าจาก Acolad Partner Portal (ฟีเจอร์ 001 — ว่างเปล่า เพราะงาน
จริงไม่ได้อยู่ที่นั่น) ไปที่ **XTM Cloud** (`xtm.acolad.com` → Tasks → **Active**)
แล้วเพิ่ม 2 ความสามารถที่ constitution วางไว้แต่ต้น: **กดรับงานอัตโนมัติ** (เฉพาะ
มาเลย์ MS, แบบ bulk "accept all for this language in this group") และ **บันทึกทุก
งานที่เจอลง Google Sheets** พร้อมสถานะตลอดวงจร (New→Accepted/Missing/Skipped/
Accept failed→Closed/Removed)

**กลยุทธ์หลัก = "เปลี่ยนปลาย ไม่รื้อแกน":** แกน domain ของ 001 (detection diff
แบบ appearance-event, SQLite state store, outbox at-least-once, dispatcher,
heartbeat, PM2 supervisor) reuse ทั้งหมด — เปลี่ยนเฉพาะ **portal adapter** ให้
คุยกับ XTM (login company/user/pass, อ่าน Active, กดรับ) และ **เพิ่ม reporting
target ใหม่ (Google Sheets)** ผ่าน interface `Notifier`/outbox เดิม

**งานแรกของการ implement = recon XTM จริง (evidence-first)** เพราะ selector,
stable job key, และ "สัญญาณ Accept สำเร็จ" ยังต้องเห็น DOM จริงก่อน finalize
(ดู research.md) — สอดคล้องหลัก fail-loud/evidence ของโปรเจกต์ (Constitution VI)

## Technical Context

**Language/Version**: Node.js 22 LTS + TypeScript 5.x (`strict: true`) — เดิม

**Primary Dependencies**: Playwright (Chromium new-headless), better-sqlite3,
pino + pino-roll, zod, dotenv — **เพิ่ม `googleapis`** (Google Sheets API v4 ผ่าน
service account `google-credentials.json`) ซึ่ง 001 สงวนไว้แล้วสำหรับฟีเจอร์นี้

**Storage**: SQLite (WAL) `state/acolad.db` — ขยายตาราง `jobs` (target_lang,
accept_status, accepted_at, sheet ref) + outbox channel ใหม่ `'sheets'`;
**Google Sheets** เป็น system-of-record ภายนอก (sheet ID ใน `.env`)

**Testing**: Vitest (unit + integration, coverage ≥ 80% บน detection/state/
reporting), **XTM HTML fixtures** (Active list ว่าง/มีงาน/หลายแถว/พัง) +
Playwright route mocking, mock Sheets API + mock Chat webhook; live-XTM ทดสอบหลัง
flag `LIVE_PORTAL=1` เท่านั้น (ห้ามใน CI)

**Target Platform**: Windows 11 always-on, รันใต้ PM2 (single instance) — เดิม

**Project Type**: Single project (long-running service/bot)

**Performance Goals**: ตรวจพบงานใหม่ ≤ 30 วิ (poll 20 วิ — ปลายเร็วสุดของ
20–25s ± jitter); **accept action ลงภายใน ≤ 60 วิหลังงานโผล่ (เป้า < 40 วิ)** เพราะ
หน้าต่างกดรับ < 1 นาที; แจ้ง Chat/เขียน Sheets ≤ 60 วิหลัง event

**Constraints**: อัตราเรียก XTM สุภาพ — **ห้าม poll ถี่กว่า 20 วิ** (กันบัญชีถูก
ระงับ, FR-003); **การอ่านทุกครั้งในรอบนับรวมในงบเดียว** — Active read + FR-024
re-read หลังกด + FR-014 Closed-tab check ต้องไม่ดันความถี่เกินเพดาน (FR-027, N2);
**บัญชี XTM ใช้ร่วมกับคน → re-login บ่อยเป็นปกติ** ต้องเงียบ (ไม่ alert) และ
re-login เท่าที่จำเป็น ≤ 1 ครั้ง/รอบ (กันเตะนักแปลหลุด, FR-021); memory < 1 GB
(recycle browser); secrets ไม่โผล่ใน repo/log/evidence; เวลา Asia/Bangkok ISO 8601

**Scale/Scope**: **บัญชีเดียว (แชร์)**, งาน ~4–5 งาน/วัน, **กดรับเฉพาะมาเลย์
(Malay (Malaysia))**, ผู้รับแจ้งเตือน = 1 ช่อง Chat + 1 Google Sheet

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| หลักการ | การปฏิบัติตามในแผนนี้ | ผล |
|---------|------------------------|-----|
| I. Code Quality | reuse โมดูล detection/state/reporting/monitoring/runtime เดิม; **portal adapter re-target ไป XTM** (xtmLogin/xtmInbox/xtmAccept, selectors รวมศูนย์) แทนโค้ด partner-portal ที่เลิกใช้ → ไม่เหลือ dead code; Sheets เป็น adapter ใหม่หลัง `Notifier` interface เดิม | ✅ PASS |
| II. Testing Standards | TDD บน accept-eligibility + status state machine + sheets upsert + diff (reuse); failure-mode suite: login fail (shared-account), session expiry กลางรอบ, accept timeout/snatched, malformed row, Sheets quota/auth, restart กลาง accept; coverage ≥ 80%; live หลัง `LIVE_PORTAL=1` | ✅ PASS |
| III. UX Consistency | **Sheets schema คงที่ + เวอร์ชัน** (contracts/sheets.md — ต่อยอด 8 คอลัมน์เดิม + Step/Role/Accepted at/Note), เขียนแบบ upsert by job key ไม่สร้างแถวซ้ำ; Chat messages เพิ่ม `✅ รับงานแล้ว`/`⚠️ กดรับไม่สำเร็จ` ตาม schema คงที่; ISO 8601 Asia/Bangkok | ✅ PASS |
| IV. Reliability & Recovery | PM2 auto-restart; retry+backoff+jitter ทุก external call (XTM, Sheets, Chat); outbox flush ตามหลังเมื่อช่องล่ม — **Sheets ล่มไม่บล็อกการกดรับ**; heartbeat→Healthchecks; ฟื้น accept_status จาก SQLite (ไม่กดซ้ำหลัง restart) | ✅ PASS |
| V. Observability | pino JSON (เก็บ 14 วัน); log ทุก poll/detection/**accept attempt พร้อม latency + outcome** (Constitution V บังคับ); เก็บ evidence เมื่อ layout ผิดคาด/accept ยืนยันไม่ได้; **daily summary ยังเลื่อน** (Complexity Tracking) | ⚠ PASS (deferral 1 จุด — ยกมาจาก 001) |
| VI. Robustness | zod validate ทุก config/row ที่ parse; selector guard — ไม่พบ marker → หยุด+evidence+alert; timeout ชัดทุก op; session expiry → re-login อัตโนมัติ; **ไม่กดปุ่ม Accept ที่ไม่ยืนยันว่าคือปุ่มถูก** (evidence-first ก่อน finalize) | ✅ PASS |
| VII. Idempotency & State | job key เสถียร (คาด fileID+step+role — ยืนยัน recon); **accept at-most-once** ผ่าน `accept_status` state machine + เช็ค state ก่อนกด (รวมข้าม restart); Sheets upsert by (job_key); ทุก op ปลอดภัยต่อ retry; at-least-once exception (เดิม) คงอยู่ | ✅ PASS |
| VIII. Performance | poll 20 วิ → detect ≤ 30 วิ; **วัด 2 เมตริกแยกกัน (N1):** (a) **click latency** detection→คลิกยืนยัน ≤ 5 วิ p95 = เกณฑ์ Constitution VIII; (b) **outcome-confirmed latency** ที่รวม FR-024 re-read (วัดแยก ไม่นับใน 5 วิ); ขึ้นกับความเร็ว UI → วัดจริงตอน recon, UI ช้าเกินพิจารณา XTM API (research.md); dispatcher flush 5 วิ; recycle browser กัน leak | ⚠ PASS (accept p95 ยืนยันหลัง recon) |

**Post-Design Re-check (หลัง Phase 1)**: artifacts Phase 1 ไม่เพิ่มการละเมิดใหม่ —
deferral เดิม (daily summary, at-least-once window) คงอยู่; เพิ่มรายการเฝ้าระวัง 2
จุดใน Complexity Tracking (accept p95 ผูกกับ UI จริง, auto-accept บนบัญชีแชร์)

## Project Structure

### Documentation (this feature)

```text
specs/002-xtm-detect-accept/
├── plan.md              # ไฟล์นี้ (/speckit-plan)
├── research.md          # Phase 0 — resolve discovery items (recon-driven)
├── data-model.md        # Phase 1 — ส่วนขยาย schema + status lifecycle + Sheets
├── quickstart.md        # Phase 1 — สถานการณ์ตรวจรับ end-to-end
├── contracts/           # Phase 1
│   ├── xtm-portal-adapter.md  # XtmPortalClient interface + accept + error taxonomy
│   ├── sheets.md              # SheetSink contract + column schema (versioned)
│   ├── config.md              # env vars ส่วนเพิ่ม (XTM_*, Sheets creds, ACCEPT_ENABLED)
│   └── notifications.md       # Chat message schemas ส่วนเพิ่ม (accepted/failed)
└── tasks.md             # Phase 2 (/speckit-tasks — ยังไม่สร้างที่นี่)
```

### Source Code (repository root)

```text
src/
├── config/
│   └── index.ts          # + XTM_* , GOOGLE_SERVICE_ACCOUNT_KEY_PATH, SHEET tab, ACCEPT_ENABLED, POLL=20s
├── portal/               # ★ re-target ไป XTM (แทน partner-portal)
│   ├── browser.ts        # reuse — Chromium lifecycle + recycle (ไม่ผูก portal)
│   ├── xtmLogin.ts       # login .jsp (company/user/pass) + detect logged-out + retry/lockout
│   ├── xtmInbox.ts       # อ่าน Active list → JobSnapshot (+ evidence capture)
│   ├── xtmAccept.ts      # bulk accept "all Malay in group" + ยืนยันผลสำเร็จ
│   ├── xtmClient.ts      # ประกอบเป็น XtmPortalClient (implements PortalClient + accept)
│   └── selectors.ts      # selector registry ของ XTM (รวมศูนย์ R9)
├── detection/            # reuse (pure) — + รองรับ target_lang ใน RawJob/diff input
│   ├── jobKey.ts         # + composite key fileID|step|role (ยืนยัน recon)
│   ├── eligibility.ts    # ★ ใหม่ pure: ตัดสิน "มาเลย์ → eligible" (config-driven)
│   └── diff.ts           # reuse — appearance events; semantics "หายจาก Active"
├── state/
│   ├── jobStore.ts       # + คอลัมน์ target_lang/accept_status/accepted_at/sheet ref
│   ├── outbox.ts         # + channel 'sheets'
│   └── ... (db/meta/systemEvents/appearanceEvents reuse)
├── reporting/
│   ├── notifier.ts       # + ข้อความ accepted/accept_failed
│   ├── googleChat.ts     # reuse
│   ├── sheets.ts         # ★ ใหม่ — SheetSink (append/upsert by job key) ผ่าน googleapis
│   └── dispatcher.ts     # + route channel 'sheets' → SheetSink
├── monitoring/ (reuse: logger, heartbeat)
└── runtime/
    ├── pollLoop.ts       # + ขั้นตอน accept: detect→[malay&new]→acceptEligibleTasks()→record→log/sheet
    ├── once.ts / requeue.ts / main.ts  # reuse
    └── ...

tests/
├── unit/                 # eligibility, jobKey(xtm), status machine, sheets upsert, formatter
├── integration/          # poll+accept cycle กับ XTM fixtures + mock Sheets/webhook
└── fixtures/             # XTM Active HTML (ว่าง/1 งาน/หลายแถว/มาเลย์/ไม่ใช่มาเลย์/พัง) + accept dialog
```

**Structure Decision**: Single project (เดิม) — re-target `src/portal/` ทั้งชั้นไป
XTM แทนที่จะเพิ่ม flag เลือก portal (YAGNI: เราต้องการ XTM อย่างเดียว, partner
portal เป็นเป้าผิด) จึงไม่เหลือ dead code (Constitution I); `detection/` ยังเป็น
pure logic ปลอด I/O เพิ่มแค่ `eligibility.ts`; `reporting/` เพิ่ม `sheets.ts`
หลัง interface เดิมโดยไม่แตะ detection (Constitution I)

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Daily summary (Constitution V) ยังไม่ implement | ยกมาจาก 001 — daily report ใช้ Chat ช่องที่สองซึ่งยังไม่มี webhook (placeholder ใน `.env`) | ส่งเข้าช่อง alert ไปก่อน → ปฏิเสธ เพราะตั้งใจแยกช่อง + กัน alert channel รก (UX Consistency) |
| การส่งแจ้งเตือน/เขียน Sheets เป็น at-least-once (Constitution VII ห้ามซ้ำ) | หน้าต่าง crash สั้นระหว่าง POST/append สำเร็จ กับ mark sent → ซ้ำได้ ≤ 1 ครั้งหลัง restart; Chat webhook และ Sheets append ไม่มี dedup ฝั่งรับ ส่วน Sheets ลดซ้ำได้ด้วย upsert by job key | Exactly-once ต้อง transaction ข้ามระบบ/ dedup ฝั่งรับ ซึ่งทำไม่ได้กับ webhook; ยอมรับ window สั้นสุด (mark sent หลัง 2xx) + Sheets ใช้ upsert ลดผลกระทบ + test ครอบ |
| accept p95 ≤ 5 วิ (Constitution VIII) ผูกกับความเร็ว UI ของ XTM | กดรับผ่าน UI (เปิดเมนู ⋮ → Accept all for language → ยืนยัน) อาจเกิน 5 วิถ้า XTM อืด — วัดจริงไม่ได้จนกว่าจะ recon | กดผ่าน XTM REST API จะเร็ว/นิ่งกว่า แต่ creds ที่มีคือ UI login (company/user/pass) ไม่ใช่ API token → ประเมินที่ recon (research.md), ถ้าจำเป็นค่อยขอ API token |
| auto-accept บนบัญชีที่ใช้ร่วมกับคน (operational risk) | บัญชี XTM มีบัญชีเดียวแชร์ (FR-021) — บอทกดรับ/re-login อาจชนกับนักแปล | ใช้บัญชีบอทแยก = ทางที่ดีกว่าแต่ผู้ใช้ยืนยันว่ามีบัญชีเดียว → มิติงาน: re-login เท่าที่จำเป็น + เงียบ + แนะนำบัญชีแยกเป็น improvement อนาคต |
| ไม่ batch การเขียน Google Sheets (Constitution VIII แนะ batch เมื่อ event มาใกล้กัน) (N4) | bulk accept อาจสร้างหลาย sheet write ใกล้กัน แต่ปริมาณงานต่ำมาก (4–5/วัน, ครั้งละไม่กี่แถว) — เขียนทีละแถวเข้าใจง่าย + upsert by key ปลอดภัยกว่า | batch ภายในรอบ → เลื่อน เพราะ overhead/complexity ไม่คุมเมื่อ volume ต่ำ; เปิด batch ได้ทันทีถ้า volume โตขึ้น |
