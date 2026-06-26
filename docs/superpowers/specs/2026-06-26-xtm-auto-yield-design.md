# XTM Auto-Yield — แก้ปัญหา session ชนกัน (บอท vs คน) บนบัญชี XTM ร่วม

วันที่: 2026-06-26
สถานะ: Design (รออนุมัติ → writing-plans)
ขอบเขต: feature เดี่ยว, reuse แกน 002 เดิม

---

## 1. ปัญหา (Problem)

บอท poll XTM Cloud ทุก ~20 วิ (navigate Active → silent re-login เมื่อ session หมด →
อ่าน grid → auto-accept มาเลย์). ทีมงานใช้ **XTM account เดียวกันเป๊ะ** กับบอท.

XTM instance นี้ยอมให้ **1 concurrent session ต่อ account** เท่านั้น → เกิด
**ping-pong login**:

1. คน login → บอทถูกเด้งออก
2. บอท poll รอบถัดไป (ภายใน 20 วิ) → silent re-login กลับ → คนถูกเด้ง
3. วนไม่จบ — ทั้งคู่ทำงานไม่ได้, heartbeat แดง, alert เด้ง

ต้นเหตุในโค้ด: `src/portal/xtmClient.ts` — silent re-login ที่บรรทัด 93–96 (เริ่มรอบ)
และ 115–119 (session ตายกลางการอ่าน). มันเด้งกลับเข้า session ทันทีโดยไม่สนว่ามีคนใช้อยู่.

### ข้อจำกัดที่แก้ไม่ได้ด้วยโค้ดฝั่ง client
XTM บังคับ single-session ฝั่ง server — เขียน client เก่งแค่ไหนก็ทำให้ 1 account อยู่
2 ที่พร้อมกันไม่ได้. ทางออกจึงต้องเป็น **"ไม่ใช้ชนกัน"** ไม่ใช่ bypass.

---

## 2. ทางเลือกที่พิจารณา (Alternatives)

| ทาง | สาระ | ผล |
|---|---|---|
| **A. แยกบัญชีให้บอท** | ขอ Acolad เปิด XTM user ที่ 2 | สะอาดสุด *ถ้าทำได้* แต่พึ่งคนนอก + เสี่ยง user ใหม่มองไม่เห็น job offer เดียวกัน (assignment ผูกกับ user) |
| **B. Auto-yield (เลือก)** | บอทตรวจจับว่ามีคน login แล้วถอยให้เอง | คุมเองได้ทันที แก้ ping-pong จริง แลกกับช่วงบอท "ตาบอด" สั้นๆ ตอนคนทำงาน |
| C. ช่วงเวลาตายตัว | บอทพักตามตาราง | แข็งทื่อ งานมาไม่เป็นเวลา อาจพลาด — แพ้ B |

**ตัดสินใจ:** ทำ **B ตอนนี้** (ไม่ต้องรอใคร) + ผลัก **A คู่ขนาน** เป็นทางออกถาวร.
ออกแบบ B ให้ปิดได้ด้วย flag เดียวเมื่อ A พร้อม (ดู §8).

---

## 3. แก่นการออกแบบ (Core mechanism)

State machine 2 สถานะ คุมที่ orchestration layer (`XtmPollLoop`):

```
        ┌─────────── อ่านสำเร็จ ──────────┐
        ▼                                  │
   ┌─────────┐  เพิ่งสำเร็จ < window      ┌──────────┐
   │ ACTIVE  │  แล้วจู่ๆ logged-out  →   │ YIELDING │
   │ เฝ้าปกติ │ ─────────────────────────▶│  (พัก)   │
   └─────────┘                            └──────────┘
        ▲                                   │   │
        │ probe หลัง cooldown สำเร็จ          │   │ ยังไม่ครบ cooldown
        │ (คนออกแล้ว)                        │   ▼ skip รอบนี้ (ไม่เรียก client เลย)
        └───────────────────────────────────┘     heartbeat = ok
            probe ล้มเหลว (คนยังอยู่) → YIELDING ต่อ
```

### เกณฑ์ตัดสิน (heuristic เดียว)
> "ถ้าบอท**เพิ่งอ่านสำเร็จเมื่อ < `window` ที่แล้ว** แล้วจู่ๆ ถูก logged-out →
> แปลว่ามีคน login (เพราะ XTM session จริงอยู่ได้เป็นชั่วโมง ไม่หมดใน 10 นาที)
> → **พัก** แทนการ login ซ้ำ"

- ช่วง **cooldown**: loop เช็คแค่นาฬิกา **ไม่เรียก client เลย** → ไม่มี portal request
  (ปลอด FR-011), ไม่แตะ session คน → คนทำงานไม่ถูกรบกวน
- **probe** (ครบ cooldown): ลอง login 1 ครั้ง
  - ติด + อ่านได้ = คนออกแล้ว → กลับ ACTIVE
  - โดนเด้งซ้ำเร็ว = คนยังอยู่ → YIELDING ต่อ (รบกวนคน ~1 ครั้ง/cooldown)

---

## 4. ฟังก์ชันบริสุทธิ์ (TDD-first)

ไฟล์ใหม่ `src/runtime/yieldPolicy.ts` — pure, ทดสอบเหมือน `acceptDecision.ts`/`eligibility.ts`:

```ts
/** ยอม login ตอนนี้ไหม — ห้าม ถ้าเพิ่งสำเร็จภายใน window (สงสัยว่ามีคนเข้า). */
export function allowReloginNow(
  lastAuthSuccessMs: number,
  nowMs: number,
  windowMs: number,
): boolean {
  return !(lastAuthSuccessMs > 0 && nowMs - lastAuthSuccessMs < windowMs);
}

/** ยังอยู่ใน cooldown ไหม — ถ้าใช่ ให้ skip รอบนี้. */
export function inCooldown(yieldUntilMs: number, nowMs: number): boolean {
  return yieldUntilMs > nowMs;
}
```

> `lastAuthSuccessMs === 0` (cold start / ไม่เคยสำเร็จ) → `allowReloginNow = true`
> → login ปกติ ไม่หลบมั่ว.

---

## 5. จุดแก้ในโค้ด (touch points)

| ไฟล์ | การเปลี่ยนแปลง |
|---|---|
| `src/portal/errors.ts` | + `SessionYieldError` — "ตรวจพบ logged-out ระหว่างห้าม relogin" (ไม่ใช่ failure) |
| `src/portal/xtmClient.ts` | `fetchJobSnapshot(id, opts?: { allowRelogin?: boolean })` (default `true` = พฤติกรรมเดิม). จุด re-login (บรรทัด 93–96 และ 115–119): ถ้า `allowRelogin === false` แล้วเจอ logged-out → **throw `SessionYieldError`** แทน `login()` |
| `src/runtime/yieldPolicy.ts` | **ใหม่** — 2 ฟังก์ชันบริสุทธิ์ (§4) |
| `src/state/meta.ts` | + typed accessor: `lastAuthSuccessMs`/`setLastAuthSuccessMs`, `yieldUntilMs`/`setYieldUntilMs` (ใช้ `getNumber`/`set` ที่มีอยู่). persist เพื่อให้ **restart ระหว่างคนทำงานไม่เด้งคน** |
| `src/runtime/xtmPollLoop.ts` | yield gate ต้นรอบ + handle `SessionYieldError` (ดู §6) |
| `src/config/index.ts` + `.env.example` | + `XTM_YIELD_ENABLED` (default `1`), `XTM_YIELD_WINDOW_MS` (default `600000`) |

### หลักการที่รักษาไว้
- **client ยังเป็น I/O surface บางๆ** — มันแค่ "รายงาน" ว่า logged-out (โยน error) เมื่อถูกห้าม
  relogin; **นโยบาย yield ทั้งหมดอยู่ที่ loop** (เจ้าของ timing/heartbeat)
- relogin policy คำนวณจาก **เวลา** ล้วน → ไม่ต้องเพิ่ม round-trip เช็ค auth

---

## 6. Flow ใน `XtmPollLoop.runOnce()` (เพิ่มจากของเดิม)

```
nowMs = clock.now
# (0) flag ปิด → ข้าม yield ทั้งหมด พฤติกรรมเดิมเป๊ะ
if !cfg.XTM_YIELD_ENABLED: <เดินทางเดิม>

# (1) ยังอยู่ใน cooldown → พักรอบนี้ ไม่แตะ portal
if inCooldown(meta.yieldUntilMs, nowMs):
    log { action:'yield', outcome:'cooldown' }
    await heartbeat.ok()         # จงใจหลบ = สุขภาพดี ไม่ page
    return true

# (2) คำนวณนโยบาย relogin จากเวลา
allowRelogin = allowReloginNow(meta.lastAuthSuccessMs, nowMs, cfg.XTM_YIELD_WINDOW_MS)

try:
    snapshot = await client.fetchJobSnapshot(id, { allowRelogin })
    # (3) สำเร็จ → บันทึกเวลา + ถ้าเพิ่งกลับจาก yield ให้แจ้ง resumed
    meta.setLastAuthSuccessMs(nowMs)
    if meta.yieldUntilMs > 0:
        meta.setYieldUntilMs(0)
        enqueue outbox 'yield_resumed' → SYSTEM channel  # 🤖 Bot resumed
    <เดินวงจรเดิม: cycle.run → diag → daily → flush → heartbeat>
catch SessionYieldError:
    # (4) ตรวจพบคน login → เข้า/คง YIELDING
    firstEntry = meta.yieldUntilMs === 0
    meta.setYieldUntilMs(nowMs + cfg.XTM_YIELD_WINDOW_MS)
    if firstEntry:
        enqueue outbox 'yield_paused' → SYSTEM channel    # 🧑 Human detected, paused
        await dispatcher.flush(...)
    await heartbeat.ok()         # ไม่ใช่ failure → ห้าม page
    return true
```

> `SessionYieldError` ต้องถูก catch **แยกก่อน** `handleError()` — มันไม่ใช่ portal failure
> จึงต้องไม่เข้า portal_down window / ไม่ heartbeat.fail().

---

## 7. แจ้งเตือน + heartbeat

- **เข้า YIELDING** (ครั้งแรกของช่วง): outbox event `yield_paused` →
  `🧑 Human activity detected on XTM — bot paused monitoring (retry in ~10 min)` →
  **SYSTEM channel** ผ่าน outbox (ตาม Outbox pattern, constitution). ส่ง**ครั้งเดียว**
  ตอนเปลี่ยนสถานะ — ไม่สแปมทุก cooldown cycle.
- **กลับ ACTIVE**: outbox event `yield_resumed` → `🤖 Bot resumed XTM monitoring`.
- **heartbeat = ok ตลอด yield** — process ยังเป็นปกติ แค่จงใจหลบ ไม่ใช่ "ล่ม"
  จึงต้องไม่ trigger Healthchecks `/fail` (ไม่ page on-call).
- การ์ดใช้ EN cards แนวเดียวกับ `systemAlerts.ts`.

---

## 8. Kill switch — เผื่อทาง A (บัญชีแยก)

- `XTM_YIELD_ENABLED=0` → loop ข้าม yield ทั้งหมด, `fetchJobSnapshot` ใช้ default
  `allowRelogin=true` → **พฤติกรรมเดิมทุกประการ** (login ตรง). ไม่ต้องแก้โค้ด.
- เมื่อ Acolad เปิด user ที่ 2 และยืนยันว่าเห็น offer เดียวกัน → สลับบอทไปบัญชีนั้น
  (`XTM_ACOLAD_Username/Password`) + ตั้ง `XTM_YIELD_ENABLED=0`.

**Action item (นอกโค้ด):** ติดต่อ Acolad ขอ XTM user ที่ 2 + **ทดสอบว่า user ใหม่เห็น
job offer มาเลย์เดียวกัน** ก่อนตัดสินใจสลับ.

---

## 9. Edge cases (ครอบในดีไซน์แล้ว)

| กรณี | พฤติกรรม |
|---|---|
| Cold start (deploy แรก, meta ว่าง) | `lastAuth=0` → `allowRelogin=true` → login ปกติ |
| Restart ระหว่างคนทำงาน | meta โหลด `lastAuth` recent + cookie ตาย → `allowRelogin=false` → yield, **ไม่เด้งคน** |
| คนทำงานยาว 1 ชม. | probe ทุก ~10 นาที โดนเด้งซ้ำ → yield ต่อ; คนถูกรบกวน ~6 ครั้งสั้นๆ/ชม. |
| session หมดจริง (ไม่มีคน) | `lastAuth` เก่ากว่า window → `allowRelogin=true` → re-login ปกติ (ไม่ yield ผิด) |
| job มาเลย์มาตอน yield | บอทไม่รับใน 1 นาที **แต่**คนอยู่ใน XTM เห็น/กดเองได้; บอทกลับมาแล้วรับต่อถ้ายังว่าง (`acceptAvailable` กัน double-accept เดิม) |

---

## 10. ค่า default ที่เสนอ

- `XTM_YIELD_ENABLED = 1` (เปิด — แก้ปัญหา live)
- `XTM_YIELD_WINDOW_MS = 600000` (10 นาที) — ใช้เป็นทั้ง "เกณฑ์เพิ่งสำเร็จ" และ "cooldown"
  - สั้นกว่า = บอทกลับมาไวหลังคนออก แต่เด้งคนถี่ตอนทำงานยาว
  - ยาวกว่า = เด้งคนน้อย แต่บอทกลับช้า
  - 10 นาที = สมดุล (สั้นกว่า XTM session จริงมาก จึงแยก "คน login" ออกจาก "expiry" ได้ชัด)

**ตัด YAGNI:** v1 ใช้ **auto-yield อย่างเดียว** — ยังไม่ทำปุ่ม manual pause (เช่น Google Chat
command) เพราะ webhook เป็น one-way ต้องต่อ Chat app inbound เพิ่ม. เพิ่มทีหลังได้ถ้าจำเป็น.

---

## 11. แผนทดสอบ (TDD — test ก่อน implement)

1. **`tests/unit/yieldPolicy.test.ts`** (pure): `allowReloginNow` (recent→false, stale→true,
   zero→true, boundary), `inCooldown` (before/after/equal)
2. **`tests/unit/meta.test.ts`**: typed accessor ใหม่ round-trip + default 0
3. **`tests/integration/xtmPollLoop.test.ts`** (stub client): จำลองวงจร
   - กด logged-out หลัง success < window → คาด `SessionYieldError` → yield + heartbeat.ok + ส่ง paused ครั้งเดียว
   - cooldown cycle ถัดไป → skip (ไม่เรียก client) + heartbeat.ok
   - หลัง window → probe → success → resumed + ACTIVE
   - flag ปิด → พฤติกรรมเดิม (login ตรง, ไม่มี yield)
4. **`tests/integration/failureModes.xtm.test.ts`**: `SessionYieldError` ไม่ถูกนับเป็น
   portal_down / ไม่ heartbeat.fail
5. coverage gate `state/` ยังต้อง ≥ 80% (เพิ่ม accessor + test)

---

## 12. สรุปผลกระทบ

- **เพิ่ม:** 1 ไฟล์ pure (`yieldPolicy.ts`) + 1 error + 2 env + meta accessor + loop gate + test
- **reuse:** outbox/dispatcher (แจ้งเตือน), meta (persist), heartbeat, pure-decision pattern เดิม
- **ไม่แตะ:** detection diff engine, accept state machine, sheets, daily report
- **ความเสี่ยงต่ำ:** ปิดด้วย flag กลับพฤติกรรมเดิมได้ทันที
