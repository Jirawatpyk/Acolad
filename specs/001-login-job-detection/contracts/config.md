# Contract: Configuration (.env)

โหลดผ่าน dotenv + validate ด้วย zod ที่ `src/config/index.ts` —
**ค่าผิด/ขาด = ระบบไม่ start และพิมพ์ข้อความบอกตัวแปรที่มีปัญหา** (fail fast,
Constitution VI) — ห้าม commit `.env` (มีใน `.gitignore` แล้ว)

| ตัวแปร | จำเป็น | Default | ความหมาย |
|--------|--------|---------|----------|
| `ACOLAD_PORTAL_URL` | ✅ | — | URL หน้า login ของ portal |
| `ACOLAD_EMAIL` | ✅ | — | อีเมลบัญชีทีม |
| `ACOLAD_PASSWORD` | ✅ | — | รหัสผ่าน (ห้ามปรากฏใน log/alert — pino redaction) |
| `GOOGLE_CHAT_WEBHOOK_SYSTEM` | ✅ | — | webhook ช่องแจ้งเตือนระบบ (ตั้งค่าแล้ว) |
| `GOOGLE_CHAT_WEBHOOK_DAILY_REPORT` | ❌ | ว่าง | สงวนไว้สำหรับฟีเจอร์รายงานประจำวัน — ฟีเจอร์นี้ไม่ใช้ |
| `GOOGLE_SHEETS_ID` | ❌ | ว่าง | สงวนไว้สำหรับฟีเจอร์กดรับงาน (บันทึก task ที่กดรับ) — ฟีเจอร์นี้ไม่ใช้ |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | ❌ | ว่าง | สงวนไว้สำหรับฟีเจอร์กดรับงาน — ฟีเจอร์นี้ไม่ใช้ |
| `HEALTHCHECKS_PING_URL` | ✅ | — | URL ping ของ Healthchecks.io check — **เป็น secret**: ผู้ที่ได้ URL ไปสามารถส่ง ping ปลอมทำให้ dead-man switch ไม่แจ้งแม้ระบบตายจริง; อยู่ใน redaction list ตาม FR-012 |
| `OUTBOX_RETRY_CAP` | ❌ | `10` | จำนวนครั้ง retry สูงสุดต่อรายการ outbox ก่อนเปลี่ยนเป็น dead (FR-018) |
| `OUTBOX_DEAD_AFTER_HOURS` | ❌ | `6` | อายุสูงสุดของรายการ pending ก่อนเปลี่ยนเป็น dead แล้วแต่อย่างใดถึงก่อน (FR-018) |
| `POLL_INTERVAL_MS` | ❌ | `25000` | รอบตรวจปกติ — ช่วงห่างจริงสุ่มใน [ค่า−5000, ค่า+5000] แล้ว clamp ให้อยู่ใน [20000, 30000] เสมอ; zod บังคับ 20000 ≤ ค่า ≤ 25000 |
| `LOGIN_MAX_RETRY` | ❌ | `3` | จำนวน login ล้มเหลวก่อน lockout + alert |
| `LOGIN_LOCKOUT_MINUTES` | ❌ | `15` | ระยะหยุดพยายาม login |
| `BROWSER_RECYCLE_HOURS` | ❌ | `6` | รอบ recycle browser กัน memory leak |
| `LOG_DIR` | ❌ | `logs` | ที่เก็บ JSON logs (rotate 14 วัน) |
| `STATE_DIR` | ❌ | `state` | ที่เก็บ SQLite + storageState + evidence |
| `TZ_DISPLAY` | ❌ | `Asia/Bangkok` | เขตเวลาแสดงผล (FR-014) |
| `LIVE_PORTAL` | ❌ | ว่าง | `1` = เปิด live smoke test (ห้ามใช้ใน CI) |

หมายเหตุ:

- `.env.example` ต้อง sync กับตารางนี้ทุกครั้งที่เพิ่ม/ลบตัวแปร
- รายการ secret ใน redaction list ตาม FR-012 (ห้ามปรากฏใน log/alert/
  evidence): `ACOLAD_PASSWORD`, `ACOLAD_EMAIL`, `GOOGLE_CHAT_WEBHOOK_SYSTEM`,
  `GOOGLE_CHAT_WEBHOOK_DAILY_REPORT`, `HEALTHCHECKS_PING_URL` รวมถึง
  เนื้อหาไฟล์ session (`state/storageState.json`)
- ค่า interval/retry เปลี่ยนได้โดยไม่แตะโค้ด แต่ทุกค่าต้องผ่านเกณฑ์ spec
  เสมอ — zod บังคับ `20000 ≤ POLL_INTERVAL_MS ≤ 25000` และ runtime ต้อง
  clamp ช่วงห่างจริงหลังบวก jitter (±5000) ให้อยู่ใน [20000, 30000] ทุกรอบ
  จึงไม่ถี่กว่า 20 วินาที (FR-011) และไม่ห่างเกิน 30 วินาที (FR-003)
  ไม่ว่าผู้ใช้ตั้งค่าใดในช่วงที่อนุญาต
- การนับ interval เป็นแบบ **fixed-rate start-to-start**: scheduler กำหนด
  เวลาเริ่มรอบถัดไป = เวลาเริ่มรอบปัจจุบัน + interval (หักเวลาทำงานของรอบ
  ออกจากการรอ) เพื่อให้ "ช่วงห่างระหว่างจุดเริ่มของรอบ" ตรงกับตัวชี้วัด
  SC-001(ข) — โดยยังเคารพช่วงห่างขั้นต่ำ 20 วินาทีระหว่างคำขอจริงตาม
  FR-011 (หากรอบก่อนหน้าใช้เวลานานจนเหลือช่วงรอ < ขั้นต่ำ ให้เลื่อนตาม)
