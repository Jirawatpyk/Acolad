# Research: ตรวจจับ + กดรับงานบน XTM + บันทึก Google Sheets

**Feature**: 002-xtm-detect-accept | **Date**: 2026-06-19

หมายเหตุ: ฟีเจอร์นี้ยึดหลัก **evidence-first** — รายการที่ระบุ "ยืนยันตอน recon"
จะถูกปิดโดย **งานแรกของการ implement** คือ live-XTM evidence capture (หลัง
`LIVE_PORTAL=1`) ก่อน finalize selector/parser ตาม Constitution VI. ค่าที่ลงไว้
ด้านล่างเป็น "ค่าคาดการณ์ที่มีเหตุผล + วิธีพิสูจน์" ไม่ใช่การเดาแล้วใช้เลย

---

## R1. แหล่งและหน้าที่เฝ้า

**Decision**: เฝ้า **XTM Cloud → Tasks → แท็บ Active** ที่
`xtm.acolad.com/project-manager-gui/` (อ่านตารางงาน 1 ครั้งต่อรอบ)

**Rationale**: ผู้ใช้ยืนยันด้วยสกรีนช็อตว่างานจริง (EN→Malay) โผล่ที่นี่ ไม่ใช่
partner portal; งานใหม่เข้า Active โดยตรง, งานเสร็จย้ายไป Closed (spec Context)

**ยืนยันตอน recon**: URL จริงของมุมมอง Active — `.env` ตั้ง
`XTM_ACOLAD_OFFERS_URL=.../my-inbox-pages.action` แต่ภาพคือหน้า "Tasks". ต้อง
ยืนยันว่า my-inbox = Active view หรือไม่ แล้วปรับ env ให้ตรง

**Alternatives**: my-inbox vs Tasks/Active เป็นคนละหน้า — ตัดสินจาก DOM จริง;
แท็บ Planned (ปฏิเสธ: ผู้ใช้ยืนยันงานใหม่เข้า Active ไม่ใช่ Planned)

---

## R2. Login flow + session บนบัญชีที่ใช้ร่วมกัน

**Decision**: login ผ่านฟอร์ม `.jsp` ด้วย **Company `AMPLEXOR` / Username `EQHO`
/ Password** (จาก `.env` `XTM_ACOLAD_*`); เก็บ session ใน `storageState.json`
เดิม; **ตรวจ logged-out ทุกรอบ แล้ว re-login เฉพาะเมื่อจำเป็น**

**Rationale**: บัญชีเดียวใช้ร่วมกับนักแปล (FR-021) → session ถูก invalidate บ่อย
มาก. ถ้า re-login ทุกครั้งที่เจอ logged-out แบบไม่คิด จะ **เตะนักแปลหลุด** แล้ว
นักแปล login กลับมาเตะบอท = thrash loop. นโยบาย: re-login ก็ต่อเมื่อรอบนั้นมีงาน
ต้องทำ/ต้องอ่าน, และ **re-login สำเร็จ = เงียบ (ไม่ alert, ไม่นับ incident)**;
alert เฉพาะ re-login ล้มเหลวเกิน retry cap

**ยืนยันตอน recon**: (a) มี CAPTCHA/2FA ไหม (ถ้ามี → CaptchaDetectedError หยุด+
alert), (b) XTM ยอมให้หลาย session พร้อมกันต่อบัญชีเดียวไหม (ถ้ายอม → ไม่เตะกัน,
ปัญหาเบาลงมาก), (c) selector ของ company/username/password/submit

**Alternatives**: บัญชีบอทแยก (ดีกว่าแต่ผู้ใช้มีบัญชีเดียว → future improvement,
Complexity Tracking); คา session ยาวด้วย token (XTM อาจหมดอายุเร็วบนบัญชีแชร์)

---

## R3. Stable Job Key

**Decision**: job key = composite **`fileId | step | role`** (normalize lower/trim
แล้วต่อด้วย `|` แบบเดียวกับกติกา 001) — ใช้ `fileId` จากรูปแบบ
`4712942-1-21 (ID-1b270f065098)` (ส่วน `ID-xxxx` ที่ดูนิ่งสุด)

**Rationale**: 1 ไฟล์ปรากฏหลายแถว (เช่น captions.json + Proof.html, หลาย step/
role) — key ต้องแยกแต่ละแถวให้ dedup/accept/log อิสระ (spec edge case). `ID-xxxx`
น่าจะเป็น internal id ที่นิ่งกว่าเลขลำดับ

**ยืนยันตอน recon**: (a) `ID-xxxx` นิ่งข้ามรอบจริงไหม (ไม่เปลี่ยนเมื่อ refresh/
สถานะเปลี่ยน), (b) มี data attribute/row id ที่ XTM ใส่ให้ (เช่น `data-task-id`)
ที่นิ่งกว่าและควรใช้แทน, (c) step+role แยกแถวได้จริง

**Alternatives**: ใช้เลข `4712942-1-21` อย่างเดียว (ปฏิเสธ: ไม่ unique ข้าม step);
hash ทั้งแถว (ปฏิเสธ: progress% เปลี่ยน → hash เปลี่ยน → นับงานใหม่ผิด)

---

## R4. Accept flow (bulk) + สัญญาณสำเร็จ

**Decision**: กดรับแบบ **bulk** — เปิดเมนู `⋮` ของแถวมาเลย์ → `Accept task` →
**"Accept all tasks for this language in this group"** (1 action รับมาเลย์ทั้งหมด
ที่ค้าง, ตาม Clarification Q1); หลังกดต้องเห็น **สัญญาณสำเร็จที่อ่านได้** จึงบันทึก
`Accepted` — ไม่เห็น = `Accept failed` (ไม่เดาว่าสำเร็จ, FR-011)

**Rationale**: หน้าต่าง < 1 นาที → กดทีเดียวเร็วสุด; เมนูมีตัวเลือกนี้อยู่แล้ว
(เห็นในสกรีนช็อต); ทีมรับมาเลย์ทุกงาน → bulk ตรงเจตนา

**ยืนยันตอน recon**: (a) มี confirm dialog หลังเลือกไหม + selector ของปุ่มยืนยัน,
(b) "สัญญาณสำเร็จ" คืออะไร — แถวหาย/ปุ่ม Accept หาย/toast/badge เปลี่ยน, (c)
ขอบเขต "in this group" กินงานทีมอื่นไหม (ถ้าเสี่ยง → ถอยมากดทีละแถวเฉพาะมาเลย์),
(d) วัด latency **2 ตัวแยก (N1)**: detect→**click** ยืนยัน ≤ 5 วิ p95 (Constitution
VIII) กับ detect→**ผลยืนยัน** (รวม FR-024 re-read) ≤ 60 วิ end-to-end (SC-003) —
re-read ไม่นับรวมใน 5 วิ

**Alternatives**: กดทีละ task (ปฏิเสธเป็นค่า default: ช้ากว่าเมื่องานมาเป็นชุด แต่
เก็บเป็น fallback ถ้า bulk scope กว้างเกิน); accept ผ่าน XTM REST API (R5)

---

## R5. UI automation vs XTM REST API

**Decision**: เริ่มด้วย **UI automation (Playwright)** สำหรับทั้งอ่าน Active และ
กดรับ — สอดคล้องสถาปัตยกรรม 001 + creds ที่มี (UI login)

**Rationale**: creds ที่ได้คือ company/user/pass สำหรับ UI ไม่ใช่ API token; XTM
Cloud มี REST API จริงแต่ต้องตั้ง API user/token แยก (ยังไม่มี). UI ใช้ได้ทันที

**ยืนยันตอน recon**: ดู network calls ที่หน้า Active ยิงตอนโหลด/ตอนกด Accept —
ถ้าเป็น JSON endpoint ที่เรียกซ้ำได้ด้วย session cookie เดียวกัน อาจ "อ่าน/กด" ผ่าน
HTTP โดยตรง (เร็ว/นิ่งกว่า DOM) โดยไม่ต้องขอ API token แยก → พิจารณาเป็น
optimization หลังเส้นทาง UI ทำงานได้

**Alternatives**: ขอ XTM API token จากผู้ดูแล (ดีสุดเชิงความนิ่ง แต่บล็อกงานเพราะ
ต้องรอ provisioning) → เลื่อนเป็น future improvement ถ้า UI p95 ไม่ผ่าน

---

## R6. Google Sheets integration

**Decision**: ใช้ **`googleapis` (Sheets API v4)** ผ่าน **service account**
(`google-credentials.json`, path ใน `.env`) — เขียนแบบ **append แถวใหม่ + upsert
สถานะ by job key** (อ่านคอลัมน์ key/หาแถว → update in place); ไหลผ่าน **outbox
channel `'sheets'`** (at-least-once เหมือน Chat)

**Rationale**: sheet มีอยู่แล้ว + creds พร้อม; upsert by job key กัน Constitution
VII (ห้ามแถวซ้ำ); ผ่าน outbox = Sheets ล่มไม่บล็อกการกดรับ (Constitution IV) และ
reuse dispatcher/retry เดิม

**ยืนยัน/ตั้งค่า**: (a) แชร์ sheet ให้ service account email (สิทธิ์ Editor),
(b) ชื่อ tab + gid (จาก URL `gid=285987136`), (c) scope = `spreadsheets` เท่านั้น
(least privilege, Constitution Security)

**Alternatives**: เขียน Sheets ตรงไม่ผ่าน outbox (ปฏิเสธ: เสี่ยงสูญหาย + ผิดหลัก
"ทุกอย่างไหลผ่าน outbox"); batch หลายแถว/รอบ (เลื่อน: งานน้อย 4–5/วัน ไม่จำเป็น —
การไม่ batch เป็น deviation จาก Constitution VIII ที่บันทึกใน plan.md Complexity
Tracking แล้ว, N4)

---

## R7. กลยุทธ์ความเร็ว (ชนะหน้าต่าง < 1 นาที)

**Decision**: poll **20 วิ** (ปลายเร็วสุด 20–25s); ลำดับในรอบ = **detect →
[มาเลย์+ใหม่] accept ก่อน → แล้วค่อย log Sheets/แจ้ง Chat**; คา session warm
(ไม่ re-login ใน hot path); accept ใช้ขั้นตอนสั้นสุด

**Rationale**: worst-case detect ~20 วิ + accept ~10–20 วิ ≈ ≤ 40 วิ < 60 วิ
(spec SC-003); accept-first กันเสียวินาทีไปกับ I/O อื่น

**ยืนยันตอน recon**: วัดเวลา accept จริง; ถ้าเกินบ่อย → พิจารณา HTTP endpoint
(R5) หรือ push/email fast-path (spec Assumptions — future)

**Alternatives**: เพิ่มอีเมล/push ทันที (ปฏิเสธ: ผู้ใช้เลือก polling, YAGNI จน
กว่าจะเห็นว่าพลาดบ่อย — `Missing` ในชีตจะบอกอัตราพลาด)

---

## R8. Eligibility (กรองมาเลย์)

**Decision**: eligible เมื่อ **Target == "Malay (Malaysia)"** แบบ exact match
(config-driven ใน `detection/eligibility.ts`, ค่าเทียบอยู่ใน config ไม่ hardcode
กระจาย); ไม่ใช่มาเลย์ → `Skipped` (log+แจ้ง ไม่กด)

**Rationale**: เห็นค่าจริงจากสกรีนช็อต/ชีต = "Malay (Malaysia)"
([[acolad-malay-only-rule]]); exact match กัน false positive ที่จะกดงานผิดภาษา

**ยืนยันตอน recon**: ค่าจริงใน DOM ตรงกับ "Malay (Malaysia)" เป๊ะไหม หรือมี
รูปแบบอื่น (`ms-MY`, `Malay`) — ใส่เป็น list ใน config ให้ปรับได้โดยไม่แก้โค้ด

**Alternatives**: substring "Malay" (ปฏิเสธ: เสี่ยงชนภาษาอื่นที่มีคำว่า Malay);
hardcode (ปฏิเสธ: ผิดบทเรียน 001 — อย่าตรึงรูปแบบก่อนเห็นจริง)

---

## R9. Status lifecycle + ตัวแยก Closed/Missing

**Decision**: status set = **`New → Accepted / Skipped / Missing / Accept failed
→ Closed / Removed`**; **"งานหายจาก Active"** ตัดสินด้วย *บอทเคยรับงานนี้ไหม*:
ไม่เคยรับ → `Missing` (โดนคนอื่นแย่ง); เคยรับ → **เช็คแท็บ Closed แบบเจาะจง**
(เฉพาะตอนหาย) เจอ → `Closed`, ไม่เจอ → `Removed` (ยกเลิก/โอนคืน). `In progress`
**out of scope** (progress% หลอก — มาจาก MT ไม่ใช่คนแปล, FR-015)

**Rationale**: ตรง Clarification Q4 + spec FR-014; ตัวแยก Missing/Closed ใช้
accept_status ที่บอทเก็บเอง (เชื่อถือได้); แยก Closed/Removed กันบันทึก "ยกเลิก"
เป็น "เสร็จ" ผิด — เช็คเฉพาะตอนหายจึง cost ต่ำ

**ยืนยันตอน recon**: (a) URL/marker ของแท็บ **Closed** สำหรับ targeted check,
(b) ใช้เกณฑ์ "หายติดต่อกัน ≥ 2 รอบ" (reuse 001) ก่อนตัดสินเพื่อกัน flicker

**Alternatives**: หายจาก Active = Closed เลย (ปฏิเสธ: ติดป้ายงานยกเลิกผิดเป็นเสร็จ);
poll Closed ทุกรอบ (ปฏิเสธ: เปลือง rate limit — เช็คเฉพาะตอนหายพอ)

---

## R10. Reuse จาก 001 (ยืนยันว่าใช้ได้)

**Decision**: reuse **`detection/diff.ts`** (appearance-event, consecutive_misses,
relisted), **`state/` ทั้งหมด** (jobStore/outbox/systemEvents/db), **`reporting/`
dispatcher + googleChat + notifier**, **`monitoring/`**, **`runtime/pollLoop`
scaffolding**, **`browser.ts`** (Chromium lifecycle ไม่ผูก portal)

**Rationale**: เป็น domain/infra ปลอด portal-specific; interface `PortalClient`
รองรับ XTM impl ได้ทันที (เพิ่มเมธอด accept) — พิสูจน์แล้วด้วย stub ใน
`tests/unit/pollLoop.test.ts`

**Alternatives**: เขียนใหม่หมด (ปฏิเสธ: ทิ้งโค้ดที่ test แล้ว ≥ 80% โดยเปล่า
ประโยชน์ + เพิ่มความเสี่ยง)

---

## สรุป discovery ที่ต้องปิดด้วย recon (งานแรกของ implement)

| # | สิ่งที่ต้องยืนยัน | กระทบ |
|---|------------------|-------|
| D1 | URL จริงของ Active view (my-inbox vs Tasks) | R1, config |
| D2 | selector login + มี CAPTCHA/2FA ไหม + หลาย session ต่อบัญชีได้ไหม | R2 |
| D3 | stable job key (`ID-xxxx` นิ่ง? มี data-id?) + step/role แยกแถว | R3, jobKey |
| D4 | flow Accept: confirm dialog? + **สัญญาณสำเร็จ** + ขอบเขต "in group" + latency (click ≤5s VIII / outcome ≤60s SC-003 — วัดแยก N1) | R4, R7, VIII |
| D5 | network calls ของ Active/Accept (มี JSON endpoint ใช้แทน DOM ได้ไหม) | R5 |
| D6 | ค่าจริงคอลัมน์ภาษา ("Malay (Malaysia)" เป๊ะ?) | R8 |
| D7 | tab name/gid + แชร์ sheet ให้ service account แล้ว | R6 |
| D8 | URL/marker ของแท็บ Closed (สำหรับ targeted check Closed vs Removed) | R9, FR-014 |

D1–D6 ปิดด้วย evidence-capture script (เก็บ HTML+screenshot+network log ของ Active
และ flow Accept, sanitized); D7 เป็น config/ops step
