# Quickstart & Validation: 002-xtm-detect-accept

**Feature**: 002-xtm-detect-accept | **Date**: 2026-06-19

คู่มือรัน + เกณฑ์ตรวจรับ (SC เป็น authoritative). รายละเอียด interface/schema ดูที่
`contracts/` และ `data-model.md` — ที่นี่เน้น "รันยังไง + คาดหวังอะไร"

## Prerequisites

- Node.js 22, `npm ci` แล้ว
- `.env` มี `XTM_ACOLAD_*`, `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`,
  `SHEETS_TAB_NAME`, `GOOGLE_CHAT_WEBHOOK_SYSTEM`, `HEALTHCHECKS_PING_URL`,
  `ACCEPT_ENABLED`, `ACCEPT_LANGUAGES`
- Google Sheet แชร์ให้ service account (Editor); `google-credentials.json` อยู่ในเครื่อง (gitignored)

## คำสั่ง

```powershell
npm run lint ; npm run typecheck          # 0 error
npm test                                  # unit + integration (fixtures เท่านั้น)
npm run test:coverage                     # gate ≥ 80% บน detection/state/reporting
npm run xtm:recon                         # ★ ใหม่ — เก็บ evidence XTM จริง (ต้อง $env:LIVE_PORTAL='1')
npm run poll:once                         # รันรอบเดียว (smoke); + $env:LIVE_PORTAL='1' สำหรับ XTM จริง
npm run build ; pm2 start ecosystem.config.cjs   # รัน 24/7 (single instance)
```

## งานแรกเสมอ: Recon (ปิด D1–D6 ก่อน finalize selector)

`npm run xtm:recon` (LIVE) → login XTM, เปิด Active, เปิดเมนู Accept (ไม่กดจริงถ้า
ไม่ตั้ง flag กดจริง), บันทึก `state/evidence/xtm-recon-<ts>/` (HTML+screenshot+
network, sanitized). ใช้ยืนยัน: URL Active, selector login/ตาราง/เมนู, stable job
key, ค่าคอลัมน์ Malay, สัญญาณ Accept สำเร็จ → อัปเดต `selectors.ts` + `eligibility`
config + `XTM_ACOLAD_OFFERS_URL`

## เกณฑ์ตรวจรับ (Validation Matrix)

| ID | สถานการณ์ | วิธี | คาดหวัง | อ้างอิง |
|----|-----------|------|---------|---------|
| V1 | Recon เก็บ evidence ได้ | `xtm:recon` (LIVE) | มีไฟล์ evidence + ยืนยัน D1–D6; ไม่มี secret ในไฟล์ | research D1–D6 |
| V2 | ตรวจพบงานใหม่ ≤ 30 วิ | fixture Active มี 1 งานใหม่ | emit first_seen → Chat "🆕 งานใหม่" + Sheets append `New` | SC-002, FR-001/3 |
| V3 | กรองมาเลย์ถูก | fixture: 1 มาเลย์ + 1 ไม่ใช่ | มาเลย์ eligible=1; อีกงาน `Skipped` (ไม่กด) | FR-006/7, R8 |
| V4 | กดรับมาเลย์สำเร็จ (bulk) | fixture หลายแถวมาเลย์ + mock accept success | acceptEligibleTasks → ทุก jobKey `accepted`; Chat "✅ รับงานแล้ว" (1/แถว); Sheets `Accepted`+Accepted at | SC-001, FR-006/9 |
| V5 | โดนแย่งก่อนกด | mock: เป้าหมายหายตอนกด | ผล `missing`; Sheets `Missing`; Chat ⚠️ (info) | FR-010, R9 |
| V6 | กดแล้วยืนยันไม่ได้ | mock: ไม่เห็นสัญญาณสำเร็จ | ผล `failed`; Sheets `Accept failed`; **system alert** + evidence; ไม่ mark accepted | FR-011, SC-007 |
| V7 | กดรับครั้งเดียว (idempotent) | งานเดิมปรากฏหลายรอบ + restart กลาง accept | accept ครั้งเดียวเท่านั้น; ไม่มีกดซ้ำหลัง restart | SC-005/8, FR-008 |
| V8 | Cold start เจองานค้าง | fixture start: Active มีมาเลย์ค้าง (ยังกดได้) + 1 รับแล้ว | กดรับอันที่ยังกดได้; รับแล้ว=ไม่แตะ; 1 ข้อความสรุปงานค้าง; baseline_done=1 | FR-005, R9 |
| V9 | ทุกงานเข้าชีต | fixture หลายภาษา | ทุกงาน = 1 แถว (upsert by job_key) ไม่มีซ้ำ | SC-004, FR-016/17 |
| V10 | สถานะไหลถึง Closed | accepted หายจาก Active ≥ 2 รอบ + **เจอใน Closed tab** | Sheets `Closed` (ไม่ใช่ Missing) | FR-014, R9 |
| V10b | งาน accepted ถูกยกเลิก → Removed | accepted หายจาก Active + **ไม่เจอใน Closed tab** | Sheets `Removed` (ไม่ติดป้าย Closed ผิด) | FR-014, Q4 |
| V11 | งานไม่เคยรับแล้วหาย → Missing | งาน Skipped/New หายจาก Active ≥ 2 รอบ | Sheets `Missing` | FR-014 |
| V12 | Sheets ล่มไม่บล็อก accept | mock Sheets 5xx | accept ยังทำงาน; outbox `sheets` retry; ฟื้นแล้วเขียนครบ ไม่ซ้ำ | FR-018, Constitution IV |
| V13 | session หลุดกลางรอบ (บัญชีแชร์) | mock logged-out กลางอ่าน | re-login เงียบ + retry; **ไม่มี alert**; ไม่ re-login วน | FR-021, R2 |
| V14 | kill-switch | `ACCEPT_ENABLED=0` + มีงานมาเลย์ | ตรวจจับ+log+แจ้งครบ แต่ **ไม่กดรับ**; Sheets คงสถานะ `New` | FR-012 |
| V15 | layout เปลี่ยน → fail loud | fixture Active ที่ marker หาย | LayoutChangedError + evidence + system alert; ไม่เดา parse | FR-022, SC-007 |
| V16 | accept **click** latency p95 ≤ 5 วิ | วัดจาก log (LIVE) | **click latency** detection→คลิกยืนยัน p95 ≤ 5 วิ (เกณฑ์ Constitution VIII; หรือบันทึก deviation) | Constitution VIII, N1 |
| V16b | outcome-confirmed latency (แยก) | วัดจาก log (LIVE) | latency detection→ผลยืนยัน (รวม FR-024 re-read) วัดแยก ไม่นับใน 5 วิ — ต้อง ≤ 60 วิ end-to-end (SC-003) | SC-003, N1 |

## รัน 24/7

reuse 001: PM2 single instance (`ecosystem.config.cjs`), pm2-windows-startup,
heartbeat → Healthchecks (เงียบเกิน 10 นาที → alert). ห้ามรันซ้อนด้วย `npm start`
มือ ([[acolad-run-via-pm2-single-instance]])
