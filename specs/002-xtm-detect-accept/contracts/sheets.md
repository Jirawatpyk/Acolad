# Contract: Google Sheets Sink (`src/reporting/sheets.ts`)

ปลายทางรายงานใหม่ เพิ่มหลัง `Notifier`/outbox interface เดิม — Sheets ล่ม **ห้าม**
บล็อกการกดรับ (Constitution IV); ทุกการเขียนผ่าน outbox channel `'sheets'`
(at-least-once)

## Column Schema (versioned — `sheet_header_version = 2`)

ต่อยอดจาก 8 คอลัมน์ที่ผู้ใช้มีอยู่ (v1) + 4 คอลัมน์ใหม่ + 1 คอลัมน์ key (ซ่อน):

| # | Column | ที่มา (RawJob/lifecycle) | หมายเหตุ |
|---|--------|--------------------------|----------|
| A | Received date | first_seen_at (ISO +07:00) | เดิม |
| B | Status | lifecycle_status (แสดงผล) | `New/Accepted/Missing/Accept failed/Skipped/Closed/Removed` |
| C | Project name | project_name | เดิม |
| D | File | file_name | เดิม |
| E | Source language | source_lang | เดิม |
| F | Target languages | target_lang | เดิม |
| G | Due date | due_date \|\| due_raw | เดิม |
| H | Words | words | เดิม |
| I | Step | step | **ใหม่** |
| J | Role | role | **ใหม่** |
| K | Accepted at | accepted_at (ISO +07:00) | **ใหม่** — ว่างถ้ายังไม่รับ |
| L | Note | เหตุผล/evidence ref (เช่น "snatched", "layout?") | **ใหม่** |
| M | _job_key | job_key | **ใหม่ (ซ่อน/named)** — ใช้ค้นแถวตอน upsert |

> การเปลี่ยน schema = migration ที่บันทึก (Constitution III). บอทตรวจ header แถว
> แรกตอน start: ถ้าเป็น v1 (8 คอลัมน์) → เติม header คอลัมน์ I–M (ไม่ลบ/ไม่ย้าย
> ของเดิม) แล้วตั้ง `sheet_header_version=2`; ถ้าไม่ตรงรูปแบบที่รู้จัก → system
> alert ไม่เขียนทับ (fail loud)

## Interface

```ts
interface SheetSink {
  /** ตรวจ/อัปเกรด header ให้เป็น v2 (idempotent) — เรียกตอน start */
  ensureHeader(): Promise<void>;

  /** append แถวใหม่สำหรับ job ที่เพิ่งเจอ (status='New') */
  appendRow(record: SheetRow): Promise<void>;

  /** update สถานะ/ฟิลด์ของ job เดิม — ค้นแถวด้วย job_key (upsert) */
  updateRow(jobKey: string, patch: Partial<SheetRow>): Promise<void>;
}

interface SheetRow {
  jobKey: string;
  receivedDate: string;   // ISO +07:00
  status: 'New'|'Accepted'|'Missing'|'Accept failed'|'Skipped'|'Closed'|'Removed';
  projectName: string; fileName: string;
  sourceLang: string|null; targetLang: string|null;
  dueDate: string|null; words: number|null;
  step: string|null; role: string|null;
  acceptedAt: string|null; note: string|null;
}
```

## Behavioral Guarantees

- **Upsert by `job_key`** (คอลัมน์ M): `updateRow` ค้นแถวก่อน — เจอ → update
  in place; ไม่เจอ → append (กันสถานะอัปเดตงานที่ยังไม่มีแถว). **ไม่มีแถวซ้ำต่อ
  job_key** (Constitution VII)
- **แถวเดิมไม่มี job_key = historical** (FR-026): `ensureHeader` เติมคอลัมน์ I–M
  ให้แถวเดิมแบบว่าง แต่บอท **ไม่ claim/ไม่ update/ไม่ลบ** แถวที่ `_job_key` ว่าง —
  จัดการเฉพาะแถวที่ตัวเองสร้าง (มี key); งานที่เคยกรอกมืออาจมีทั้งแถว historical +
  แถวบอท (ยอมรับได้ ดีกว่าเดา match แล้วทับข้อมูลคน)
- การเขียนทุกครั้งมาจาก dispatcher (outbox channel `sheets`) — retry+backoff;
  ล้มเหลวเกิน cap → outbox `dead` → ยกเป็น system alert (ไม่เงียบ)
- auth ผ่าน **service account** (`GOOGLE_SERVICE_ACCOUNT_KEY_PATH`), scope
  `https://www.googleapis.com/auth/spreadsheets` เท่านั้น (least privilege)
- timeout + retry ตาม R10 ของ 001; respect Sheets API rate limit (งานน้อย —
  ไม่ batch ในเฟสนี้)
- ไม่เขียน secret ลงชีต; `Note` ใส่ได้แค่ ref ของ evidence (path) ไม่ใส่เนื้อ HTML
- at-least-once: หน้าต่าง crash สั้นอาจ append ซ้ำ ≤ 1 แถวหลัง restart — ลดด้วย
  upsert (append เฉพาะตอน job_key ยังไม่มีแถว) ดู Complexity Tracking
