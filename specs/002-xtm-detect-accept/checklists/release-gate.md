# Release-Gate Requirements Checklist: 002-xtm-detect-accept

**Purpose**: "Unit tests for English" — ตรวจ **คุณภาพของ requirements** (ครบ/ชัด/
สอดคล้อง/วัดได้/ครอบคลุม) ก่อนอนุมัติให้ลง implement & merge. แต่ละข้อตรวจ *สิ่งที่
เขียน (หรือไม่ได้เขียน) ใน spec/plan/contracts* — ไม่ใช่ทดสอบพฤติกรรมโค้ด
**Created**: 2026-06-19
**Depth**: Release gate (เข้ม — ทุกข้อควรผ่านก่อน merge)
**Audience**: Reviewer (PR gate)
**Scope**: accept-safety + reliability + observability/data-integrity + recon-deferred assumptions
**Feature**: [spec.md](../spec.md)

## Requirement Completeness

- [x] CHK001 - มี requirement นิยาม "สัญญาณ Accept สำเร็จ" แบบวัดได้ หรือปล่อยให้ recon นิยามทั้งหมดโดยไม่มีเกณฑ์ใน spec? [Completeness, Spec §FR-011 / §Assumptions]
- [x] CHK002 - มี requirement ระบุการจัดการแถวเดิมในชีต (กรอกมือ ไม่มี job_key) ตอนเริ่ม upsert หรือไม่? [Completeness, Gap, contracts/sheets.md]
- [x] CHK003 - heartbeat/dead-man switch ถูกระบุเป็น requirement ของฟีเจอร์นี้ หรือแค่สมมติว่า reuse จาก 001? [Completeness, Gap]
- [x] CHK004 - มี requirement กรณี process ตายหลังกด bulk-accept แต่ก่อนบันทึกผล (รู้ได้ยังไงว่าแถวไหนรับสำเร็จ)? [Completeness, Spec §FR-008, Gap]
- [ ] CHK005 - มี requirement ว่าต้องทำอะไรถ้า bulk "in this group" ดันรับงานทีมอื่น (มากกว่าแค่ "ยืนยันตอน recon")? [Completeness, Spec §FR-006, Gap]

## Requirement Clarity & Measurability

- [ ] CHK006 - องค์ประกอบ stable job key (`fileId|step|role`) ระบุชัดพอจะเขียน test ได้ หรือเป็นแค่ "คาดว่า"? [Clarity, Spec §FR-002]
- [x] CHK007 - "re-login เฉพาะเมื่อจำเป็น" ถูกระบุเงื่อนไขที่เป็นรูปธรรมไหม? [Ambiguity, Spec §FR-021]
- [x] CHK008 - "minimize session churn" มีเกณฑ์วัดได้ไหม (กี่ครั้ง/ช่วงเวลา)? [Measurability, Spec §FR-021]
- [ ] CHK009 - ค่าเทียบภาษา "Malay (Malaysia)" ยืนยันว่าเป็น authoritative แล้ว หรือยังอาจมีรูปแบบอื่นที่ไม่ได้บันทึก? [Clarity, Spec §FR-006 / §Assumptions]
- [ ] CHK010 - เส้นแบ่ง "งานที่โผล่ใหม่ระหว่างระบบทำงาน" กับ baseline ตอน cold start นิยามชัดไหม (first-start vs restart)? [Clarity, Spec §FR-005]

## Requirement Consistency

- [ ] CHK011 - เป้าหมาย latency การกดรับสอดคล้องกันข้ามเอกสารไหม (Spec SC-003 ≤60s กับ plan/Constitution VIII ≤5s p95)? [Consistency, Spec §SC-003]
- [ ] CHK012 - ชุดค่า Status ตรงกันทุกที่ (spec, data-model lifecycle, Sheets schema)? [Consistency, Spec §FR-013, contracts/sheets.md]
- [ ] CHK013 - ขอบเขตการแจ้ง "ทุกงานที่เจอ" สอดคล้องกับกฎ "1 ข้อความ/งาน ไม่ batch" เมื่อ 1 โปรเจกต์มีหลายแถวไหม? [Consistency, Spec §FR-019]
- [ ] CHK014 - คำกล่าวเรื่องจังหวะ poll สอดคล้องกันไหม (SC-002 "≤30s", FR-003 "human-plausible", plan "20s floor")? [Consistency, Spec §SC-002 / §FR-003]

## Acceptance Criteria Quality (SC)

- [x] CHK015 - SC-001 (≥90% กดรับสำเร็จ) วัดได้จริงไหม ในเมื่อไม่มีนิยาม "ตัวหาร" (งานที่พลาดจนไม่เคยเห็น นับยังไง)? [Measurability, Spec §SC-001]
- [ ] CHK016 - SC-003 ระบุจุดเริ่มวัด ("งานโผล่") แบบสังเกตได้ไหม? [Measurability, Spec §SC-003]
- [ ] CHK017 - SC ทุกข้อ technology-agnostic และตรวจรับได้โดยไม่ต้องรู้ implementation? [Acceptance Criteria, Spec §SC-001..008]
- [ ] CHK018 - "zero double-accept" (SC-005) ระบุวิธีสังเกต/พิสูจน์ข้าม restart ไหม? [Measurability, Spec §SC-005]

## Accept Safety & Idempotency

- [ ] CHK019 - requirement ระบุชัดว่า bulk accept ถูกจำกัดด้วยภาษา จึงรับงานไม่ใช่มาเลย์ไม่ได้? [Accept Safety, Spec §FR-006/007]
- [ ] CHK020 - มี requirement กันการรับซ้ำงานที่คน (บนบัญชีแชร์) รับไปแล้ว? [Accept Safety, Spec §Edge Cases / §FR-008]
- [x] CHK021 - การรับประกัน at-most-once ระบุให้ครอบคลุม bulk action (สำเร็จบางส่วน/ตายกลางคัน) ไหม? [Idempotency, Spec §FR-008]
- [ ] CHK022 - ค่า default ที่ปลอดภัยของ kill-switch `ACCEPT_ENABLED` ถูกระบุเป็น requirement (ไม่ใช่แค่ใน config)? [Completeness, Spec §FR-012]
- [x] CHK023 - มี requirement เรื่องเพดานจำนวน/ขนาดงานที่กดรับอัตโนมัติ หรือ "รับมาเลย์ทั้งหมด" ตั้งใจไม่จำกัดจริง? [Coverage, Gap, Spec §FR-006]

## Reliability & Recovery

- [ ] CHK024 - มี requirement กรณี session หลุดกลางการกดรับ (ไม่ใช่แค่กลางการอ่าน)? [Coverage, Spec §Edge Cases / §FR-021]
- [ ] CHK025 - มี requirement จำกัดจำนวน re-login กัน loop เตะกันระหว่างบอท↔คน? [Completeness, Spec §FR-021]
- [ ] CHK026 - requirement ระบุชัดว่า Sheets ล่มไม่บล็อกการกดรับ และฟื้นแล้วไม่สูญ/ไม่ซ้ำ? [Completeness, Spec §FR-018]
- [ ] CHK027 - requirement การฟื้นหลัง restart (ไม่ทำซ้ำ/ไม่กดซ้ำ) ระบุเจาะจง flow XTM/accept ไหม? [Coverage, Spec §SC-008]

## Observability & Data Integrity

- [ ] CHK028 - requirement Sheets upsert ใช้ key ที่ unique จนแถวซ้ำต่อ 1 งานเป็นไปไม่ได้? [Data Integrity, Spec §FR-017]
- [ ] CHK029 - มี requirement ให้ log การกดรับพร้อม outcome + latency (Constitution V) อยู่ใน spec หรือเฉพาะ plan? [Completeness, Gap]
- [ ] CHK030 - requirement เก็บ evidence (sanitized) ระบุครอบคลุม accept-unconfirmed และ layout-changed ไหม? [Completeness, Spec §FR-022]
- [ ] CHK031 - requirement versioning/migration ของ Sheet header (v1→v2) อยู่ใน spec หรือแค่ contract? [Completeness, Gap, Spec §FR-016]

## Scenario & Edge Case Coverage

- [x] CHK032 - มี requirement ผลลัพธ์ bulk-accept แบบบางส่วน (รับได้บาง โดนแย่งบาง)? [Coverage, Gap]
- [x] CHK033 - มี requirement แยก "งาน accepted หายจาก Active เพราะเสร็จ (Closed)" ออกจาก "ถูกยกเลิก/โอนคืน (ไม่เสร็จ)"? [Edge Case, Gap, Spec §FR-014]
- [ ] CHK034 - requirement แยก "Active ว่างจริง" ออกจาก "อ่านหน้าไม่สำเร็จ" ระบุชัดไหม? [Edge Case, Spec §Edge Cases]
- [ ] CHK035 - มี requirement กรณีแถวที่ target-language อ่านไม่ได้/หาย (ตัดสิน eligibility ไม่ได้)? [Coverage, Spec §FR-004 / data-model]

## Dependencies & Assumptions

- [ ] CHK036 - รายการ defer ไป recon (Active URL, job key, accept signal, ค่าภาษา, ขอบเขต bulk) มีเกณฑ์ปิด (closure criteria) ชัดเป็น requirement ไม่ใช่คำถามค้าง? [Assumption, Spec §Assumptions / research D1–D7]
- [x] CHK037 - สมมติฐาน "portal มีสัญญาณ accept-success ที่อ่านได้" ถูก validate พร้อม fallback ถ้าไม่มีไหม? [Assumption, Spec §Assumptions / §FR-011]
- [ ] CHK038 - dependency "ชีตถูกแชร์ให้ service account" ถูกบันทึกเป็น precondition requirement ไหม? [Dependency, Spec §Assumptions]

## Ambiguities & Conflicts

- [ ] CHK039 - เนื้อหาคอลัมน์ "Note" ถูกนิยาม (ใส่อะไรได้บ้าง) ให้บันทึกสม่ำเสมอไหม? [Ambiguity, contracts/sheets.md]
- [ ] CHK040 - มีความขัดแย้งระหว่าง "กดรับงานค้างที่ยังกดได้ตอน cold start" (FR-005) กับความเสี่ยงที่ยังแยก acceptable/accepted ไม่ได้จน recon ยืนยันไหม? [Conflict, Spec §FR-005]

## Notes

- ข้อที่ "ไม่ผ่าน" = requirement ยังไม่ครบ/ไม่ชัด → แก้ spec ก่อน implement (ไม่ใช่แก้โค้ด)
- ข้อที่คาดว่าจะเป็นช่องโหว่จริง (worth attention): **CHK015** (SC-001 วัดไม่ได้), **CHK001/CHK037** (accept-success signal), **CHK004/CHK021/CHK032** (idempotency/partial ของ bulk), **CHK033** (Closed vs ยกเลิก), **CHK002** (แถวเดิมไม่มี key) — หลายข้อแก้ได้โดยปรับ spec เล็กน้อยหรือ `/speckit-clarify` รอบสั้น
- ข้อที่อ้าง [Gap]/[Conflict] ส่วนใหญ่ตั้งใจ defer ไป recon — gate ควรเช็คว่า "defer อย่างมีเกณฑ์ปิด" ไม่ใช่ "ลืม"
