# Quickstart: ระบบ Login และตรวจจับงานใหม่

คู่มือ setup + ตรวจรับว่าฟีเจอร์ทำงานจริง end-to-end
(รายละเอียด schema/contract ดู [data-model.md](./data-model.md) และ
[contracts/](./contracts/))

## Prerequisites

1. Node.js 22 LTS (`node -v` ≥ 22)
2. ไฟล์ `.env` ที่ root — ครบตาม [contracts/config.md](./contracts/config.md)
   - มีอยู่แล้ว: portal credentials + `GOOGLE_CHAT_WEBHOOK_SYSTEM` (ทดสอบแล้ว)
   - ต้องเพิ่มก่อนรันจริง: `HEALTHCHECKS_PING_URL`
3. Healthchecks.io: สร้าง check (period 5 นาที, grace 5 นาที) + ตั้ง
   integration ยิงเข้า Google Chat ช่องแจ้งเตือนระบบ → คัดลอก ping URL
4. PM2 (ครั้งเดียว สำหรับขั้นรัน 24/7): `npm install -g pm2`
5. ความปลอดภัยของเครื่อง (ครั้งเดียว): ยืนยันว่า `.gitignore` ครอบคลุม
   `state/` และ `.env`, ไม่มีไฟล์ credentials แบบ plaintext ในโปรเจกต์
   (docs/Auth.txt ถูกลบแล้ว 2026-06-10 — ตรวจซ้ำก่อน `git init` ครั้งแรก),
   และเครื่องตั้งค่าล็อกหน้าจออัตโนมัติ + จำกัดบัญชีผู้ใช้เฉพาะทีม

(Google Sheets + service account ไม่ต้องเตรียมสำหรับฟีเจอร์นี้ — ใช้ตอน
ฟีเจอร์กดรับงาน)

## Setup

```powershell
npm install
npx playwright install chromium
npm run lint        # ESLint + Prettier check ต้องผ่าน 0 error
npm run typecheck   # tsc --noEmit ต้องผ่าน
```

## รันชุดทดสอบ (ต้องผ่านก่อนรันจริงเสมอ)

```powershell
npm test                 # unit + integration (fixtures, ไม่แตะ portal จริง)
npm run test:coverage    # gate: ≥ 80% บน detection/, state/, reporting/
```

คาดหวัง: ทุก test ผ่าน รวมถึง failure-mode suite (login fail, session expiry,
timeout, malformed jobs, restart กลางรอบ, ช่องทางแจ้งเตือนล่ม)

## ทดลองรอบเดียว (smoke กับ portal จริง — รันด้วยมือเท่านั้น)

```powershell
$env:LIVE_PORTAL = '1'; npm run poll:once
```

คาดหวัง: log JSON แสดง login สำเร็จ → อ่านรายการงาน → ถ้า run แรกจะส่ง
COLD_START_SUMMARY เข้า Chat (portal ว่างตอนนี้ → ข้อความ "ยังไม่มีงานบน
portal") → ping Healthchecks 1 ครั้ง

## รัน 24/7

```powershell
npm run build
pm2 start ecosystem.config.cjs
pm2 save
npx pm2-windows-startup install   # ครั้งเดียว: ให้ PM2 ฟื้นหลังรีบูตเครื่อง
pm2 status                        # ต้องเห็น acolad-bot online
```

**รองรับรีบูตอัตโนมัติแบบไม่มีคน login** (จำเป็น — Windows Update รีบูต
กลางดึกได้): `pm2-windows-startup` ทำงานหลัง user logon เท่านั้น ต้องเลือก
หนึ่งทาง:

- **(ก) แนะนำ**: ตั้ง Windows auto-logon ของบัญชีที่รันบอท (netplwiz) +
  ตั้งล็อกหน้าจอทันทีหลัง logon — ง่ายและใช้ PM2 ตามเดิม
- **(ข)**: รันเป็น Windows Service ผ่าน NSSM (ไม่พึ่ง logon) ตาม fallback
  ใน research R6

แล้วตั้ง Active Hours ของ Windows Update ให้รีบูตในช่วงที่ยอมรับได้
ทดสอบด้วยการรีบูตเครื่องโดยไม่ login → heartbeat ต้องกลับมาเอง

## Validation Scenarios (ตรวจรับตาม Acceptance Scenarios ใน spec)

| # | สถานการณ์ | วิธีตรวจ | ผลที่คาดหวัง |
|---|-----------|----------|--------------|
| V1 | งานใหม่ถูกตรวจพบ (US1-AS1) | integration test กับ fixture "มีงานเพิ่ม 1 งาน"; ของจริง: รอจนงานแรกเข้า | แจ้ง Chat ภายใน 60s, log แสดง detect ≤ 30s |
| V2 | ไม่แจ้งซ้ำเมื่องานยังแสดงอยู่ (US1-AS2) | รัน poll 3 รอบกับ fixture เดิม | แจ้งครั้งเดียว, outbox ไม่มี entry เพิ่ม |
| V3 | หลายงานพร้อมกัน (US1-AS3) | fixture 20 งานใหม่รอบเดียว | ครบ 20 เหตุการณ์ งานละ 1 ไม่ตกหล่น |
| V4 | session หมดอายุ (US2-AS1) | ลบ storageState ระหว่างรัน / fixture เด้ง login | re-login อัตโนมัติ + รอบถัดไปทำงานปกติ ไม่มี alert |
| V5 | restart ไม่แจ้งซ้ำ (US2-AS2) | `pm2 restart acolad-bot` ระหว่างมีงานค้างแสดง | ไม่มีแจ้งเตือนซ้ำ, กลับมา poll ภายใน 2 นาที |
| V6 | heartbeat ปกติ + dead-man alert (US2-AS3 + US3-AS3) | ขณะรันปกติเปิด Healthchecks dashboard ดู ping; จากนั้น `pm2 stop acolad-bot` ทิ้งไว้ > 10 นาที | เห็น ping สม่ำเสมอ (≤ 5 นาที/ครั้ง) ขณะรัน; หลังหยุด Healthchecks ยิงแจ้งเตือนเข้า Chat |
| V7 | login ล้มเหลว (US3-AS1) | ตั้งรหัสผ่านผิดใน .env ชั่วคราว | alert ภายใน 5 นาที + lockout 15 นาที ไม่ retry รัว |
| V8 | layout เปลี่ยน (US3-AS2) | fixture หน้า login/รายการงานที่ selector หาย | system alert + โฟลเดอร์ evidence ถูกสร้าง ไม่มีการเดา parse |
| V9 | งานกลับมาอีกครั้ง (Clarify Q2) | fixture: งานหาย 2 รอบแล้วกลับมา | แจ้ง 🔁 พร้อมเวลาที่เคยแจ้งครั้งแรก |
| V10 | ช่องแจ้งเตือนล่ม (FR-013) | mock webhook ตอบ 503 ชั่วคราว | outbox ค้าง pending → flush สำเร็จเมื่อ mock กลับมา ไม่หายไม่ซ้ำ |
| V11 | cold start มีงานค้าง (FR-015) | fixture งานค้าง 3 งาน และ 25 งาน รันครั้งแรกแบบไม่มี state เดิม | สรุป 1 ข้อความ จำนวนถูกต้อง; กรณี 25 งาน truncate ที่ 20 รายการ + "…และอีก 5 งาน"; รอบถัดไปไม่แจ้งงานเดิมซ้ำ |
| V12 | ฐานสถานะเสียหาย (FR-017) | corrupt ไฟล์ db ระหว่างระบบหยุด แล้ว start ใหม่ | ไฟล์เดิมถูกเก็บเป็นสำเนา `.corrupt-*`, ได้ SYSTEM_ALERT + cold start summary, การเฝ้างานดำเนินต่อ |
| V13 | webhook ถูก revoke ถาวร (FR-018) | mock webhook ตอบ 403 ตลอด | จำแนกเป็นถาวร → retry ห่างๆ, เหตุการณ์คงอยู่ใน outbox, ping `/fail` ถูกส่ง (ผู้ดูแลรับรู้ผ่าน Healthchecks ภายใน 15 นาที) |
| V14 | บัญชีปลอดภัยระยะยาว (SC-004/SC-007) | รันจริงครบ 30 วัน | uptime ≥ 99% จาก Healthchecks history; อัตราเรียก ≤ 180 คำขอ/ชม. ทุกชั่วโมง (log); ไม่มี alert การระงับบัญชี/CAPTCHA; login ด้วยมือปลายเดือนยืนยันบัญชีปกติ |

## เกณฑ์ผ่านขั้นสุดท้าย (จาก Success Criteria)

- รันต่อเนื่อง 7 วัน: 0 การแจ้งซ้ำ + restart แบบคงฐานสถานะ ≥ 3 ครั้ง (SC-003)
- log ยืนยัน detection p95 ≤ 30s ตามนิยามชั้น (ข) ของ SC-001, notify p95
  ≤ 60s (SC-002)
- รันครบ 30 วัน: uptime ≥ 99% จาก Healthchecks check history (SC-004)
  และบัญชีไม่ถูกระงับ/บังคับยืนยันตัวตนเพิ่ม (SC-007 — ดู V14)
- `pm2 status` memory < 1 GB ตลอด (Constitution VIII)

### ผู้รับผิดชอบและการบันทึกผล Success Criteria

| SC | ช่วงวัด | แหล่งข้อมูล | บันทึกผลที่ |
|----|---------|-------------|--------------|
| SC-001/002 | ต่อเนื่อง | log JSON (สรุป p95 รายสัปดาห์) | docs/acceptance/001.md |
| SC-003 | 7 วัน | ตาราง appearance_events + outbox + เวลา restart | docs/acceptance/001.md |
| SC-004 | 30 วัน | Healthchecks check history (สำรอง: ช่องว่าง last_successful_poll_at ใน log) | docs/acceptance/001.md |
| SC-005 | ทดสอบ V6-V8 | ผลรัน scenario | docs/acceptance/001.md |
| SC-006 | ทุก restart | log เวลา start → poll แรกสำเร็จ | docs/acceptance/001.md |
| SC-007/008 | 30 วัน / V3 | system_events + log อัตราเรียก / fixture 25 งาน | docs/acceptance/001.md |

ผู้รับผิดชอบทุกข้อ: เจ้าของโปรเจกต์ (สร้างไฟล์ `docs/acceptance/001.md`
เมื่อเริ่มช่วงทดสอบ 7/30 วัน)

## การบำรุงรักษา (Maintenance)

การอัปเดต dependencies (Playwright/Chromium, Node ฯลฯ) อยู่นอกขอบเขต
ฟีเจอร์ — ทำตามรอบทบทวนรายไตรมาส (Governance ของ constitution):

1. แก้เวอร์ชันใน branch/สำเนาแยก — เวอร์ชันถูก pin ใน package.json/lockfile
2. `npm test` + `npm run test:coverage` ต้องผ่านครบ
3. `LIVE_PORTAL=1 npm run poll:once` smoke test ผ่าน
4. deploy ด้วย `pm2 restart acolad-bot` ในช่วงที่ยอมรับ downtime สั้นได้
