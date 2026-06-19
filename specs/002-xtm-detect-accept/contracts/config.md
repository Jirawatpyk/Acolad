# Contract: Configuration (`src/config/` — ส่วนเพิ่มของ 002)

โหลดจาก `.env` ผ่าน zod (fail-fast ตอน start ถ้าค่าไม่ครบ/ผิดรูปแบบ). ตารางนี้ระบุ
**เฉพาะคีย์ที่ 002 เพิ่ม/เปลี่ยน** — คีย์ของ 001 (Chat webhook, Healthchecks,
tuning) ยังใช้เหมือนเดิม

## XTM (แทน ACOLAD_* ของ partner portal)

| Key | ชนิด/กฎ | Default | หมายเหตุ |
|-----|---------|---------|----------|
| `XTM_ACOLAD_PORTAL_URL` | URL (https) | — required | หน้า login `.jsp` |
| `XTM_ACOLAD_OFFERS_URL` | URL (https) | — required | **มุมมอง Active** — ยืนยัน/ปรับตอน recon (D1) |
| `XTM_ACOLAD_CLOSED_URL` | URL (https) | optional | **มุมมอง Closed** — ใช้ targeted check ตอนงาน accepted หาย (FR-014, Closed vs Removed); ยืนยัน recon (D8) |
| `XTM_ACOLAD_Company` | string ไม่ว่าง | — required | เช่น `AMPLEXOR` — **secret-adjacent** (redact) |
| `XTM_ACOLAD_Username` | string ไม่ว่าง | — required | เช่น `EQHO` — redact |
| `XTM_ACOLAD_Password` | string ไม่ว่าง | — required | **secret** — redact list |

> คีย์ `ACOLAD_*` (partner portal ของ 001) เลิกใช้ — ลบออกจาก schema หรือทำเป็น
> optional/ignored; `.env.example` อัปเดตให้สะท้อน XTM

## Google Sheets

| Key | ชนิด/กฎ | Default | หมายเหตุ |
|-----|---------|---------|----------|
| `GOOGLE_SHEETS_ID` | string | — required | มีอยู่แล้วใน `.env` |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | path มีไฟล์อยู่จริง | `google-credentials.json` | service account key — **gitignored** |
| `SHEETS_TAB_NAME` | string | required | ชื่อ tab เป้าหมาย (จาก gid=285987136 — map ตอน recon D7) |

## Accept control

| Key | ชนิด/กฎ | Default | หมายเหตุ |
|-----|---------|---------|----------|
| `ACCEPT_ENABLED` | bool (`0`/`1`) | `0` | **kill-switch (FR-012)** — `0` = ตรวจจับ+log+แจ้ง แต่ไม่กดรับ. ตั้งต้น OFF เพื่อความปลอดภัยจนกว่า recon ยืนยัน accept flow แล้วเปิด `1` |
| `ACCEPT_LANGUAGES` | csv | `Malay (Malaysia)` | รายการ target ที่ eligible (R8 — config-driven, ปรับได้โดยไม่แก้โค้ด) |
| `ACCEPT_MAX_WORDS` | int ≥ 0 | `0` (= ไม่จำกัด) | เพดานคำต่องาน (FR-025) — เกิน → `Skipped` + แจ้งคน; default ไม่จำกัด |
| `ACCEPT_MAX_PER_CYCLE` | int ≥ 0 | `0` (= ไม่จำกัด) | เพดานจำนวนกดรับต่อรอบ (FR-025) — seam ไว้เติมทีหลัง; default ไม่จำกัด |

## Tuning (override ของ 001 ที่ 002 เปลี่ยนค่าแนะนำ)

| Key | กฎ (zod) | ค่าแนะนำ 002 | หมายเหตุ |
|-----|----------|--------------|----------|
| `POLL_INTERVAL_MS` | 20000–25000 | **20000** | ปลายเร็วสุด — ชนะหน้าต่าง < 1 นาที (R7) |
| `BROWSER_RECYCLE_HOURS` | int > 0 | 6 | เดิม |

## ความปลอดภัย (Constitution Operational Constraints)

- `XTM_ACOLAD_Password`, `XTM_ACOLAD_Username`, `XTM_ACOLAD_Company`,
  service-account key, Chat webhook, Healthchecks URL → อยู่ใน **pino redaction
  list** ทั้งหมด; `state/storageState.json` = ความลับระดับรหัสผ่าน
- `google-credentials.json` ต้อง gitignored (ตรวจ `.gitignore`) — ปัจจุบันเป็น
  untracked, ต้องกันหลุดเข้า repo
