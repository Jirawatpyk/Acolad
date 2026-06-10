# Contract: Notifications (Chat Message Schemas)

ขอบเขต: รูปแบบข้อความทุกประเภทที่ออกจากระบบ (Constitution III — เหตุการณ์
ประเภทเดียวกัน render เหมือนกันทุกครั้ง) — formatter อยู่ที่
`src/reporting/notifier.ts` ที่เดียว

## ช่องทาง

| ช่อง | ปลายทาง | env var |
|------|----------|---------|
| แจ้งเตือนระบบ | Google Chat webhook (ทดสอบแล้ว 2026-06-10) | `GOOGLE_CHAT_WEBHOOK_SYSTEM` |
| รายงานประจำวัน | Google Chat webhook ช่องที่ 2 | `GOOGLE_CHAT_WEBHOOK_DAILY_REPORT` (สงวนไว้ — ฟีเจอร์ถัดไป) |
| ทะเบียนงานที่รับ | Google Sheets — **สงวนไว้สำหรับฟีเจอร์กดรับงาน** (บันทึกรายละเอียด task ตอนกดรับ ไม่ใช่ตอนตรวจพบ) | `GOOGLE_SHEETS_ID` (ยังไม่ใช้) |

Payload Google Chat: `{ "text": "<ข้อความตาม template>" }` (POST JSON,
UTF-8) — เริ่มด้วย simple text; ย้ายไป cardsV2 ได้ภายหลังโดยแก้ formatter
ที่เดียว

## Message Templates (ภาษาไทย, เวลา = ISO 8601 `YYYY-MM-DDTHH:mm+07:00`
ตาม Constitution III และ FR-014)

### 1. NEW_JOB — งานใหม่ (event_type: first_seen)

```text
🆕 งานใหม่บน Acolad
งาน: {title}
รหัส: {portalJobId | job_key}
คู่ภาษา: {languagePair | "—"}
กำหนดส่ง: {deadline | "—"}
ค่าตอบแทน: {fee | "—"}
ลิงก์: {url | "—"}
พบเมื่อ: {occurredAt}
```

### 2. RELISTED_JOB — งานกลับมาอีกครั้ง (event_type: relisted)

โครงเดียวกับ NEW_JOB แต่บรรทัดแรกเป็น:
`🔁 งานกลับมาอีกครั้ง (เคยแจ้งเมื่อ {firstSeenAt})`

### 3. COLD_START_SUMMARY — สรุปงานค้างตอนเริ่มระบบ (FR-015)

```text
📋 เริ่มระบบเฝ้างาน — พบงานค้างอยู่ {count} งาน
{รายการย่อ: "• {title} | {languagePair|—} | ส่ง {deadline|—}" สูงสุด 20 แถว
 เกินนั้นสรุปเป็น "…และอีก {n} งาน"}
(count = 0: "📋 เริ่มระบบเฝ้างาน — ยังไม่มีงานบน portal ระบบเฝ้าต่อ 24/7")
```

ที่มาของข้อความ: SystemEvent ประเภท `cold_start_summary` 1 รายการต่อการทำ
baseline (ไม่ใช่ N ข้อความจาก appearance events — ดู data-model.md) ส่งครั้ง
เดียวรวมกรณี 0 งาน ตาม FR-015

### 4. SYSTEM_ALERT — ปัญหาที่ต้องการคน (FR-009)

```text
🚨 [{severity: WARN|CRITICAL}] {หัวข้อปัญหา}
สาเหตุ: {เหตุที่ตรวจพบ}
ผลกระทบ: {เช่น "หยุดเฝ้างานชั่วคราว"}
ต้องทำ: {action ที่คนต้องทำ}
เวลา: {occurredAt}
```

ตาราง action ต่อทริกเกอร์ (ช่อง "ต้องทำ" ของแต่ละกรณี — FR-009 บังคับให้
ระบุสิ่งที่ผู้ดูแลต้องทำ):

| ทริกเกอร์ | severity | ผลกระทบ | ต้องทำ |
|-----------|----------|----------|--------|
| login ล้มเหลวครบ 3 ครั้ง | CRITICAL | หยุดเฝ้างานชั่วคราว (lockout 15 นาที) | ลอง login ด้วยมือ; ถ้ารหัสผ่านเปลี่ยน แก้ `ACOLAD_PASSWORD` ใน .env แล้ว `pm2 restart acolad-bot` |
| CAPTCHA/2FA | CRITICAL | หยุดเฝ้างานจนกว่าคนจะผ่านขั้นยืนยัน | login ด้วยมือผ่าน CAPTCHA แล้ว restart บอท; ถ้า portal บังคับ 2FA ถาวร ให้หยุดระบบและทบทวน Assumption ใน spec |
| LayoutChanged / locale เปลี่ยน | CRITICAL | หยุดอ่านหน้ารายการงาน | เปิด `state/evidence/<timestamp>-layout_changed` เทียบหน้าใหม่ อัปเดต `src/portal/selectors.ts` รัน `npm test` ผ่าน แล้ว restart |
| พบตัวบ่งชี้ pagination (FR-009) | WARN | ขอบเขตตรวจจับอาจไม่ครบ | ตรวจหน้าจริง ทบทวน Assumption "หน้าเดียว" และขยาย scope การอ่านถ้าจำเป็น |
| portal ล่มต่อเนื่อง > 10 นาที | WARN | การตรวจถูกถ่วงด้วย backoff | ลองเปิด portal จากเครื่องอื่น; ถ้าล่มจริงไม่ต้องทำอะไร ระบบ retry เองและส่ง SYSTEM_RECOVERED เมื่อกลับมา |
| outbox dead (FR-018) | CRITICAL | มีข้อความค้างส่งไม่สำเร็จ | ตรวจ webhook URL/สิทธิ์ Chat space แล้วสั่ง requeue รายการ dead (`npm run outbox:requeue`) |
| cold start ซ้ำใน 7 วัน (FR-015) | WARN | ฐานสถานะอาจสูญหายผิดปกติ | ตรวจดิสก์/สาเหตุที่ไฟล์ db หาย และดูสำเนา `.corrupt-*` ถ้ามี (FR-017) |
| ฐานสถานะเสียหาย (FR-017) | CRITICAL | ฐานถูกรีเซ็ตเป็น cold start | เก็บสำเนา corrupt ไว้วิเคราะห์ ตรวจสุขภาพดิสก์ |

### 5. SYSTEM_RECOVERED — กลับสู่ปกติ

`✅ ระบบกลับมาทำงานปกติ: {เรื่องที่หาย} (หยุดไป {duration})`
ส่งครั้งเดียวเมื่อปัญหาที่เคย alert ถูกแก้ (กัน alert ทิ้งค้างไม่รู้จบ)

## Heartbeat (ไม่ใช่ข้อความแชท)

- HTTP GET/POST ไป `HEALTHCHECKS_PING_URL` หลังจบ poll cycle สำเร็จ
- ตั้งค่าฝั่ง Healthchecks.io: period 5 นาที, grace 5 นาที (รวม = แจ้งภายใน
  ~10 นาทีตาม FR-010), integration → Google Chat ช่องแจ้งเตือนระบบ
- ระหว่าง login lockout, backoff ยาว, หรือเมื่อ outbox มีรายการ dead /
  ช่องแจ้งเตือนล้มเหลวถาวร (FR-018): ระบบ ping endpoint `/fail` ของ check
  เดิมแทน — พิสูจน์ว่า process ยังมีชีวิตแต่กำลังล้มเหลว ช่วยแยก "เครื่องดับ
  จริง" ออกจาก "ล้มเหลวโดยรู้ตัว" ทำให้ผู้ดูแลรับรู้ผ่านบริการภายนอกแม้ Chat
  webhook ใช้ไม่ได้ — ต้องมี failure-mode test คุมเคสเหล่านี้

## การจำแนกความล้มเหลวของช่องทางแจ้งเตือน (FR-018)

| การตอบกลับ | ประเภท | พฤติกรรม |
|------------|--------|-----------|
| HTTP 429, 5xx, network error, timeout | ชั่วคราว | retry + exponential backoff ตามปกติ (FR-013) |
| HTTP 401, 403, 404 (webhook ถูก revoke/ลบ) | ถาวร | ลด retry เหลือตรวจซ้ำห่างๆ (ทุก 30 นาที), คงเหตุการณ์ใน outbox, ping `/fail` ให้บริการเฝ้าระวังแจ้งผู้ดูแลภายใน 15 นาที |

## Google Sheets — เลื่อนไปฟีเจอร์กดรับงาน

ตาม Clarifications 2026-06-10: การบันทึก Sheets เกิดตอน "กดรับงาน" โดยเก็บ
รายละเอียดของ task ที่รับ — column schema จะถูกกำหนดใน contract ของฟีเจอร์
กดรับงาน (คาดว่าประกอบด้วยรายละเอียดงาน + เวลากดรับ + ผลการกดรับ)
ฟีเจอร์ตรวจจับนี้ไม่มีการเขียน Sheets ใดๆ

กติกาที่ส่งต่อไปยังฟีเจอร์นั้น (จาก Constitution III/VII): append-only,
กันแถวซ้ำด้วย event id, การแก้ schema = เพิ่มคอลัมน์ต่อท้าย + bump เวอร์ชัน
เท่านั้น
