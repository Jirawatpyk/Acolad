# Data Model: ตรวจจับ + กดรับงานบน XTM + บันทึก Google Sheets

**Feature**: 002-xtm-detect-accept | **Date**: 2026-06-19
**Storage**: SQLite (better-sqlite3, WAL) `state/acolad.db` + Google Sheets (external)

เอกสารนี้บันทึก **ส่วนต่าง (delta)** จาก 001 เท่านั้น — ตาราง `appearance_events`,
`system_events`, `outbox`, `meta` reuse โครงเดิม (ดู 001/data-model.md) โดยมีจุด
ขยายที่ระบุไว้

## ภาพรวม

```text
Job(XTM row) 1 ── * AppearanceEvent ─┐
                                     ├── * OutboxEntry (channel: chat | sheets)
SystemEvent ─────────────────────────┘
SheetRecord (ภายนอก: 1 แถวต่อ job_key, upsert)  ← reporting/sheets.ts
Meta: baseline_done, accept_enabled_effective, ...
```

## Entity: Job (ตาราง `jobs`) — ขยายฟิลด์

ฟิลด์เดิมที่ยัง reuse: `job_key`(PK), `status`(visible/missing — การปรากฏ),
`consecutive_misses`, `first_seen_at`, `last_seen_at`, `snapshot_hash`

ฟิลด์ของ XTM (แทน title/fee/url ของ partner portal):

| Field | Type | Constraint | ที่มา |
|-------|------|-----------|-------|
| job_key | TEXT | PRIMARY KEY | R3 — **`fileName\|step\|role`** (recon ยืนยัน: XTM ไม่มี stable row-id/`fileId`; token `ID-<hex>` **ไม่ unique**) normalize lower/trim คั่น `\|`; uniqueness ของ composite ยังต้องยืนยันกับงาน relist จริง |
| xtm_task_id | TEXT | NULLABLE | token `ID-<hex>` จากเซลล์ File — **อ้างอิงเท่านั้น ไม่ใช้เป็น key** (ไม่ unique); ถ้า recon เจอ real id ภายหลังค่อยเก็บตัวนั้น |
| project_name | TEXT | NOT NULL | คอลัมน์ Project (malformed ถ้าว่าง → quarantine) |
| file_name | TEXT | NOT NULL | คอลัมน์ File |
| source_lang | TEXT | NULLABLE | คอลัมน์ Source |
| target_lang | TEXT | NULLABLE | คอลัมน์ Target — ใช้ตัดสิน eligibility (R8) |
| due_date | TEXT (ISO +07:00) | NULLABLE | คอลัมน์ Due (normalize) |
| due_raw | TEXT | NULLABLE | ค่าดิบเมื่อ parse ไม่ได้ (คู่กับ due_date=NULL ⇒ unparsed) |
| words | INTEGER | NULLABLE | คอลัมน์ Words |
| step | TEXT | NULLABLE | คอลัมน์ Step (เช่น "Post-Editing (PE) 1") |
| role | TEXT | NULLABLE | คอลัมน์ Role (เช่น "Corrector") |
| eligible | INTEGER (0/1) | NOT NULL DEFAULT 0 | 1 เมื่อ target_lang ผ่านกฎมาเลย์ (R8) |
| lifecycle_status | TEXT | CHECK IN ('new','accepted','skipped','missing','accept_failed','closed','removed') | สถานะธุรกิจที่ sync ลง Sheets |
| accept_status | TEXT | CHECK IN ('none','accepting','accepted','failed') DEFAULT 'none' | state machine กันกดซ้ำ (แยกจาก lifecycle เพื่อกันแข่ง) |
| accepted_at | TEXT (ISO) | NULLABLE | เวลาบอทกดรับสำเร็จ |
| sheet_synced_status | TEXT | NULLABLE | lifecycle_status ล่าสุดที่ยืนยันว่าเขียนลงชีตแล้ว (กัน update ซ้ำเปล่า) |

> หมายเหตุ: `lifecycle_status` (ธุรกิจ) แยกจาก `status` (การปรากฏ visible/missing
> ของ diff เดิม) — diff ยังเป็นเจ้าของ `status`/`consecutive_misses` เหมือนเดิม,
> ส่วน `lifecycle_status` คำนวณต่อยอดจากผล diff + accept (ดู State Transitions)

## Status Lifecycle (ฟิลด์ `lifecycle_status`)

```text
ตรวจพบใหม่หลัง baseline ─► new
   new ─[eligible && accept สำเร็จ]──────────────► accepted
   new ─[eligible && accept ล้มเหลว/ยืนยันไม่ได้]─► accept_failed   (+ system alert)
   new ─[eligible && โดนแย่งก่อน/ระหว่างกด]──────► missing
   new ─[ไม่ eligible (ไม่ใช่มาเลย์)]─────────────► skipped
   accepted ─[หายจาก Active ≥ 2 รอบ]─[เช็ค Closed tab]─► closed (เจอ) | removed (ไม่เจอ)
   {new|skipped|accept_failed} ─[หายจาก Active ≥ 2 รอบ]─► missing  (ไม่เคยรับ = โดนแย่ง/หาย)
```

กติกาตัดสิน "งานหายจาก Active" (reuse เกณฑ์ ≥ 2 รอบของ 001 กัน flicker):
ดู`accept_status` ของบอทเอง — ไม่เคยรับ → **missing**; เคยรับ (`accepted`) →
**เช็คแท็บ Closed แบบเจาะจง** (เฉพาะตอนหาย ไม่ใช่ทุกรอบ): เจอ → **closed**, ไม่เจอ
→ **removed** (ยกเลิก/โอนคืน) (R9, FR-014). ทุกครั้งที่ `lifecycle_status` เปลี่ยน →
enqueue outbox `sheets` (update) + (ถ้าควรแจ้ง) outbox `chat`

**Accept ทำครั้งเดียว (Constitution VII):** ก่อนกด ตรวจ `accept_status` —
ดำเนินต่อเฉพาะเมื่อเป็น `none`; ตั้งเป็น `accepting` ใน txn เดียวกับการอ่าน เพื่อ
กันสองรอบกดชนกัน/กดซ้ำหลัง restart

## Entity: SheetRecord (Google Sheets — ภายนอก)

1 แถวต่อ `job_key` (upsert) ตาม schema ใน **contracts/sheets.md** (8 คอลัมน์เดิม
+ Step/Role/Accepted at/Note). คอลัมน์ `Status` = `lifecycle_status` ในรูปแบบ
แสดงผล (`New/Accepted/Missing/Accept failed/Skipped/Closed/Removed`). upsert ค้นแถวด้วย
คอลัมน์ key ที่ซ่อนไว้ (เก็บ `job_key` ในคอลัมน์ท้าย/named range) — รายละเอียดใน
contract

## OutboxEntry — ขยาย enum channel

`channel` CHECK เพิ่ม `'sheets'`:

| channel | payload_json | ปลายทาง |
|---------|--------------|---------|
| chat | ข้อความ Chat ที่ render แล้ว | googleChat.ts (เดิม) |
| **sheets** | `{op:'append'\|'update', jobKey, row:{...}}` | **sheets.ts (ใหม่)** |

UNIQUE INDEX เดิม `(event_id, channel)` ยังคุม — 1 event ส่งได้ครั้งเดียวต่อช่อง.
สำหรับ Sheets การ `update` สถานะที่เปลี่ยนหลายครั้งใช้ **event_id ใหม่ต่อการ
เปลี่ยนสถานะ** (แต่ละ transition = 1 event) → ไม่ชน unique index และ upsert ฝั่ง
Sheets (by job_key) กันแถวซ้ำอีกชั้น (Constitution VII)

## Meta — keys เพิ่ม

| Key | ความหมาย |
|-----|----------|
| baseline_done | reuse — '1' เมื่อทำ cold-start summary แล้ว |
| accept_enabled_effective | สะท้อนค่า `ACCEPT_ENABLED` ที่ใช้จริงรอบล่าสุด (ไว้ log/วินิจฉัย) |
| sheet_header_version | เวอร์ชัน schema คอลัมน์ของชีต (กัน drift, Constitution III) |
| xtm_evidence_captured_at | เวลาเก็บ evidence งานจริงตัวแรกของ XTM (D1–D6) |

## Validation Rules (zod, ตอน parse แถว Active)

- ต้องมี `project_name` และ `file_name` ไม่ว่าง — ไม่ผ่าน → quarantine + system
  alert (FR-022/Constitution VI)
- `due_date` parse ไม่ได้ → เก็บ `due_raw`, `due_date=NULL` (ไม่ตัดงานทิ้ง)
- `target_lang` ว่าง/อ่านไม่ได้ → `eligible=0` (ไม่กด) + log เพื่อให้ปรับ selector
- รายการว่าง: ต้องเห็น marker ของตาราง Active ก่อนนับ "ว่างจริง" — container หาย =
  LayoutChanged ไม่ใช่ empty (reuse กติกา 001)
- หลายแถวต่อไฟล์ = หลาย Job (คนละ job_key) — accept แบบ bulk แต่ persist/log แยก
  แถว

## State Transitions ownership

- `detection/diff.ts` (reuse, pure): เป็นเจ้าของ `status`(visible/missing) +
  `consecutive_misses` + appearance events เหมือนเดิม
- `detection/eligibility.ts` (ใหม่, pure): map `target_lang` → `eligible`
- การคำนวณ `lifecycle_status` + การตัดสิน accept: อยู่ใน orchestration
  (`runtime/pollLoop.ts`) ที่ประกอบผล diff + eligibility + ผล accept แล้ว persist
  ผ่าน jobStore — **ไม่ใส่ logic นี้ใน diff** (รักษา diff ให้ pure/เทียบ snapshot
  อย่างเดียว)

## Data Retention (delta)

reuse ของ 001; เพิ่ม: outbox channel `sheets` ที่ `sent` ลบเมื่อครบ 90 วันเช่นกัน;
`jobs` เก็บถาวร (โตช้า ~4–5 งาน/วัน)
