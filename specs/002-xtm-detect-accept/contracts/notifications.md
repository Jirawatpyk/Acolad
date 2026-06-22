# Contract: Notifications (Google Chat) — ส่วนเพิ่มของ 002

ยึด message schema คงที่ต่อประเภทเหตุการณ์ (Constitution III); เวลา ISO 8601
Asia/Bangkok (+07:00); ทุกข้อความไหลผ่าน outbox channel `chat` (at-least-once,
1 ข้อความต่อ job — ไม่ batch). ระบุ **เฉพาะข้อความที่ 002 เพิ่ม/ปรับ**

## เหตุการณ์ระดับงาน

### 1) พบงานใหม่ (reuse แนวเดิม "งานใหม่" — ปรับฟิลด์เป็นของ XTM)

ส่งเมื่อ job เปลี่ยนเป็น `lifecycle_status='new'` (หลัง baseline). ทุกภาษา (รวมไม่ใช่
มาเลย์):

```
🆕 งานใหม่บน XTM
โปรเจกต์: {projectName}
ไฟล์: {fileName}
ภาษา: {sourceLang} → {targetLang}
ครบกำหนด: {dueDate|"-"} | คำ: {words|"-"} | ขั้น: {step|"-"} ({role|"-"})
สถานะ: {eligible ? "เข้าเกณฑ์มาเลย์ — กำลังกดรับ" : "ไม่ใช่มาเลย์ — บันทึกไว้เฉย ๆ"}
เวลา: {capturedAt}
```

### 2) รับงานสำเร็จ (ใหม่)

ส่งเมื่อ `accept_status` → `accepted`:

```
✅ รับงานแล้ว (XTM)
โปรเจกต์: {projectName}
ไฟล์: {fileName} | {sourceLang} → {targetLang}
ครบกำหนด: {dueDate|"-"} | คำ: {words|"-"}
รับเมื่อ: {acceptedAt}
```

> bulk accept ที่รับหลายแถวพร้อมกัน → **ส่ง 1 ข้อความต่อ job_key** (ตามกติกา "งาน
> ละ 1 ข้อความ ไม่ batch")

### 3) กดรับไม่สำเร็จ / โดนแย่ง (ใหม่)

ส่งเมื่อผล accept = `failed` หรือ `missing`:

```
⚠️ กดรับไม่สำเร็จ (XTM)
โปรเจกต์: {projectName} | ไฟล์: {fileName}
{sourceLang} → {targetLang}
สาเหตุ: {outcome=='missing' ? "โดนแย่ง/ถูกรับไปแล้วก่อนกดทัน" : "กดแล้วยืนยันไม่สำเร็จ — {reason}"}
ต้องตรวจสอบ: {outcome=='failed' ? "ใช่ — เข้าไปดูใน XTM" : "ไม่จำเป็น (งานหลุดไปแล้ว)"}
เวลา: {at|capturedAt}
```

`outcome=='failed'` → severity เทียบเท่า system alert (มี evidence ref ใน Sheets
Note); `missing` = info

## เหตุการณ์ระดับระบบ (reuse 001 — ปรับ trigger ให้เป็น XTM)

- **Cold-start summary** (reuse): ตอน start ถ้า Active มีงานค้าง → 1 ข้อความสรุป
  `📋 พบงานค้าง {N} รายการตอนเริ่มระบบ` (+ จำนวนมาเลย์ที่ "ยังกดได้/กดให้แล้ว" ตาม
  FR-005)
- **System alert / recovered** (reuse): login fail (cap), layout changed,
  accept ยืนยันไม่ได้, outbox dead, Sheets auth/quota — รูปแบบ `🚨 [CRITICAL/WARN]`
  เดิม. **re-login ปกติบนบัญชีแชร์ = ไม่ส่ง alert** (FR-021)

## สถานะที่เป็น "sheet-only" (ไม่ส่ง Chat — ตั้งใจ, N7)

สถานะปลายวงจรที่เกิดทีหลังและไม่ใช่ "ผลการกดรับ" จะ **อัปเดตเฉพาะใน Sheets ไม่ส่ง
Chat** เพื่อกัน channel รก (SC-006 บังคับเฉพาะ detection + acceptance outcome):
- `Closed` / `Removed` (งานที่รับแล้วจบ/ถูกยกเลิก — FR-014)
- `Missing` ที่มาจาก **งานไม่เคยรับแล้วหายจาก Active** (ต่างจาก `Missing` ตอนกดรับ
  ที่โดนแย่ง ซึ่ง = acceptance outcome → ส่ง ⚠️ ข้อความ 3)

## กติกาที่ไม่เปลี่ยนจาก 001

- 1 เหตุการณ์ = 1 แถว outbox = 1 ข้อความ (dedup ด้วย event_id)
- ไม่มี secret/cookie/credential ในข้อความหรือ payload
- ช่อง: ใช้ `GOOGLE_CHAT_WEBHOOK_SYSTEM` (daily report ช่องสอง ยังเลื่อน)
