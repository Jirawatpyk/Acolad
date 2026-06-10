# Data Model: ระบบ Login และตรวจจับงานใหม่

**Feature**: 001-login-job-detection | **Date**: 2026-06-10
**Storage**: SQLite (better-sqlite3, WAL mode) — `state/acolad.db`

## ภาพรวมความสัมพันธ์

```text
Job 1 ──── * AppearanceEvent ─┐
                              ├──── * OutboxEntry (1 event → 1 แถวต่อ channel)
SystemEvent ──────────────────┘
Meta (key-value): baseline_done, last_successful_poll_at, login_lockout_until, ...
```

เหตุการณ์ที่ "ต้องแจ้ง" มี 2 ตระกูล — เหตุการณ์งาน (AppearanceEvent) และ
เหตุการณ์ระบบ (SystemEvent) — ทั้งคู่ไหลผ่าน outbox เดียวกันด้วย event_id
เป็น key กลาง เพื่อให้ FR-009/FR-013 (ห้ามสูญหาย, retry, dedup) คุ้มครอง
ข้อความทุกประเภทเท่ากัน

## Entity: Job (ตาราง `jobs`)

| Field | Type | Constraint | ที่มา |
|-------|------|-----------|-------|
| job_key | TEXT | PRIMARY KEY | FR-005 — portal job ID ถ้ามี, ไม่งั้น `h:` + SHA-256(title\|lang\|deadline\|url) ตัด 16 hex — กติกา serialize: ฟิลด์ null แทนด้วยสตริงว่าง คั่นด้วย `\|` เสมอ, trim ช่องว่างซ้ำและแปลงเป็น lowercase ก่อน hash (deterministic, เขียน unit test ได้โดยไม่ตีความ) |
| portal_job_id | TEXT | NULLABLE | รหัสงานจาก portal (ถ้าแสดง) |
| title | TEXT | NOT NULL | FR-004 — งานที่ไม่มี title = malformed → quarantine |
| language_pair | TEXT | NULLABLE | FR-004 |
| deadline | TEXT (ISO 8601) | NULLABLE | FR-004 — normalize เป็น +07:00 |
| deadline_raw | TEXT | NULLABLE | ค่าดิบจาก portal เมื่อ parse ไม่ได้ (deadline = NULL + deadline_raw ≠ NULL ⇒ unparsed) — ปลายทาง persist ของ RawJob.deadlineRaw |
| fee | TEXT | NULLABLE | FR-004 — เก็บตามที่ portal แสดง ไม่แปลงสกุล |
| url | TEXT | NULLABLE | FR-004 |
| status | TEXT | CHECK IN ('visible','missing') | สถานะการปรากฏปัจจุบัน |
| first_seen_at | TEXT (ISO) | NOT NULL | เวลาพบครั้งแรก |
| last_seen_at | TEXT (ISO) | NOT NULL | อัปเดตทุกรอบที่ยังเห็น |
| snapshot_hash | TEXT | NOT NULL | hash ของฟิลด์ทั้งหมด ใช้ตรวจการเปลี่ยนแปลงรายละเอียด |

## Entity: AppearanceEvent (ตาราง `appearance_events`)

| Field | Type | Constraint |
|-------|------|-----------|
| event_id | TEXT (UUID v4) | PRIMARY KEY |
| job_key | TEXT | NOT NULL, FK → jobs.job_key |
| event_type | TEXT | CHECK IN ('first_seen','relisted','missing','cold_start') |
| occurred_at | TEXT (ISO +07:00) | NOT NULL |
| poll_cycle_id | TEXT | NOT NULL — ผูกเหตุการณ์กับรอบตรวจ ใช้ไล่ย้อน (Constitution V) |

UNIQUE INDEX: `(job_key, event_type, poll_cycle_id)` — backstop กันเขียนซ้ำ
จาก retry ภายในรอบเดียวกัน (poll_cycle_id คงที่ต่อรอบ ต่างจาก occurred_at
ที่เปลี่ยนทุกครั้ง จึงกันซ้ำได้จริง; เหตุการณ์ relisted ข้ามรอบยังเกิดได้ตาม
ต้องการ)

หมายเหตุ cold start: เหตุการณ์ `cold_start` รายงานถูกบันทึกที่นี่เพื่อการ
ไล่ย้อนตาม FR-007 แต่**ไม่สร้างแถว outbox รายงาน** — ข้อความสรุป 1 ข้อความ
ตาม FR-015 มาจาก SystemEvent ประเภท `cold_start_summary` (ดูด้านล่าง)
รวมถึงกรณีรายการว่าง (0 งาน) ซึ่งไม่มี appearance event เลย

## Entity: SystemEvent (ตาราง `system_events`)

เหตุการณ์ระดับระบบที่ต้องแจ้งผู้ดูแล/ทีม ซึ่งไม่ผูกกับงานใดงานหนึ่ง
(รองรับ SYSTEM_ALERT, SYSTEM_RECOVERED, COLD_START_SUMMARY ใน
contracts/notifications.md)

| Field | Type | Constraint |
|-------|------|-----------|
| event_id | TEXT (UUID v4) | PRIMARY KEY |
| event_type | TEXT | CHECK IN ('system_alert','system_recovered','cold_start_summary') |
| severity | TEXT | CHECK IN ('info','warn','critical') |
| dedup_key | TEXT | NOT NULL — เช่น 'login_failed', 'layout_changed' (alert ประเภทเดียวกันที่ยัง active ส่งครั้งเดียว; recovered จึงจะเปิดให้ส่งใหม่ได้) |
| payload_json | TEXT | NOT NULL — รายละเอียดที่ formatter ใช้ render |
| occurred_at | TEXT (ISO +07:00) | NOT NULL |
| resolved_at | TEXT (ISO) | NULLABLE — เวลาที่ปัญหาคลี่คลาย (จับคู่ SYSTEM_RECOVERED) |

UNIQUE INDEX (partial): `dedup_key` WHERE `resolved_at IS NULL` AND
`event_type = 'system_alert'` — กัน alert เรื่องเดิมซ้อนระหว่างยังไม่คลี่คลาย

## Entity: OutboxEntry (ตาราง `outbox`)

| Field | Type | Constraint |
|-------|------|-----------|
| outbox_id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| event_id | TEXT | NOT NULL — อ้างถึง appearance_events.event_id หรือ system_events.event_id; dedup key ฝั่งผู้ส่ง (FR-005, FR-013) |
| channel | TEXT | CHECK IN ('chat') — enum ขยายในฟีเจอร์กดรับงาน (เช่น 'sheets') |
| payload_json | TEXT | NOT NULL — ข้อความที่ render แล้ว (รูปแบบ payload ของ channel อื่นเพิ่มเมื่อขยาย enum ในฟีเจอร์กดรับงาน) |
| status | TEXT | CHECK IN ('pending','sent','dead') DEFAULT 'pending' |
| attempts | INTEGER | DEFAULT 0 |
| next_attempt_at | TEXT (ISO) | NOT NULL — exponential backoff |
| created_at | TEXT (ISO) | NOT NULL |
| sent_at | TEXT (ISO) | NULLABLE |

UNIQUE INDEX: `(event_id, channel)` — เหตุการณ์หนึ่งส่งได้ครั้งเดียวต่อช่องทาง
`dead` = เกิน retry cap → ยกระดับเป็น system alert (Constitution IV: ห้ามเงียบ)

## Entity: Meta (ตาราง `meta` — key/value)

| Key | ความหมาย |
|-----|----------|
| baseline_done | '1' เมื่อทำ cold-start summary แล้ว (FR-015) |
| last_successful_poll_at | ใช้คำนวณ uptime + วินิจฉัย |
| login_failure_count | นับ login ล้มเหลวต่อเนื่อง (FR-009) |
| login_lockout_until | หยุดพยายาม login ถึงเวลานี้ (กันบัญชีถูกล็อก) |
| first_job_evidence_captured_at | เวลาเก็บหลักฐานงานจริงตัวแรก (evidence-first mode ตาม R9 / portal-adapter) |
| schema_version | เวอร์ชัน migration ของฐานข้อมูล |

## Session State (นอก SQLite)

- `state/storageState.json` — Playwright session cookies (gitignored,
  ไม่มีรหัสผ่าน มีแต่ cookie)
- `state/evidence/<timestamp>-<reason>/` — screenshot + HTML เมื่อพบสภาพ
  หน้าผิดคาดหรือพบงานจริงครั้งแรก (R9)

## State Transitions ของ Job

```text
(ไม่เคยเห็น) ──พบในรายการ──► visible
    │  ครั้งแรกของระบบ (baseline ยังไม่ทำ): รวมใน cold_start summary
    │  หลัง baseline: emit first_seen → notify "งานใหม่"
visible ──หายจากรายการ──► missing   : emit missing (บันทึก ไม่ notify)
missing ──กลับมาในรายการ──► visible : emit relisted → notify "งานกลับมาอีกครั้ง"
```

กติกาสำคัญ (จาก Clarifications 2026-06-10):

- การปรากฏแต่ละรอบ = คนละเหตุการณ์ — dedup ทำที่ระดับ "เหตุการณ์"
  ไม่ใช่ระดับ "งานตลอดชีพ"
- `missing` ต้องเห็นติดต่อกัน ≥ 2 รอบตรวจก่อนบันทึก (กัน flicker จากหน้า
  โหลดไม่ครบ — Constitution VI, ระบุใน FR-007 แล้ว)
- รายละเอียดงานเปลี่ยนโดยงานยังแสดงอยู่ (FR-019): อัปเดตแถว `jobs` +
  `snapshot_hash` และบันทึกการเปลี่ยนแปลง (ฟิลด์เดิม→ใหม่) ลง log เพื่อ
  ไล่ย้อน — **ไม่สร้าง** appearance event และ**ไม่สร้าง**แถว outbox
  (ไม่แจ้งเตือน)

## Data Retention

| ข้อมูล | อายุการเก็บ |
|--------|-------------|
| jobs / appearance_events / system_events | ถาวร ตาม FR-007 (ประมาณการโต < 100 MB/ปี ตาม plan — ยอมรับได้) |
| outbox ที่ status='sent' | ลบอัตโนมัติเมื่อเก็บครบ 90 วัน |
| outbox ที่ status='dead' | เก็บจนผู้ดูแลตรวจสอบและเคลียร์เอง |
| state/evidence/ | เก็บอย่างน้อย 90 วัน หลังจากนั้นลบได้ |
| logs/ (JSON) | 14 วัน ตาม Constitution V |

## Validation Rules (zod, ใช้ตอน parse จาก portal)

- งานต้องมี `title` ไม่ว่าง — ไม่ผ่าน → quarantine + system alert (FR-009/VI)
- `deadline` parse ไม่ได้ → เก็บค่าดิบลงคอลัมน์ `deadline_raw` โดย `deadline`
  เป็น NULL — สถานะ unparsed ตีความจากคู่ค่านี้ ไม่ต้องมี flag แยก
  (ไม่ตัดงานทิ้ง ตาม edge case "ข้อมูลบางช่องขาดหาย")
- ฟิลด์ที่ไม่มีข้อมูล → `null` ชัดเจน ห้าม empty string
- รายการว่าง: ต้องตรวจพบ marker ของหน้า (เช่น container ของตารางงาน)
  ก่อนจึงนับเป็น "ว่างจริง" — container หาย = LayoutChanged ไม่ใช่รายการว่าง
