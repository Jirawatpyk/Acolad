# XTM Auto-Yield — แก้ปัญหา session ชนกัน (บอท vs คน) บนบัญชี XTM ร่วม

วันที่: 2026-06-26
สถานะ: Design v2 (ผ่าน specialist review + live recon → รออนุมัติ → writing-plans)
ขอบเขต: feature เดี่ยว, reuse แกน 002 เดิม

> **v2 เปลี่ยนอะไรจาก v1:** หลัง reliability + playwright review (เจอ Critical 2 +
> Important 4) และ **live recon** (`scripts/recon-logout.ts`, evidence
> `state/evidence/xtm-logout-recon-2026-06-26T02-01-06-316Z/`) — เปลี่ยนจาก
> heuristic เวลาเปราะๆ มาเป็น **สัญญาณ deterministic จาก URL** + เพิ่ม bound/
> escalation กัน failure-masking + แก้ dedup/txn/flush/probe ตาม review.

---

## 1. ปัญหา (Problem)

บอท poll XTM Cloud ทุก ~20 วิ (navigate Active → silent re-login เมื่อ session หมด →
อ่าน grid → auto-accept มาเลย์). ทีมงานใช้ **XTM account เดียวกันเป๊ะ** กับบอท. XTM
ยอมให้ **1 concurrent session ต่อ account** → เกิด **ping-pong login**: คน login →
บอทถูกเด้ง → บอท poll รอบถัดไป silent re-login กลับ → คนถูกเด้ง วนไม่จบ.

ต้นเหตุ: `src/portal/xtmClient.ts` silent re-login บรรทัด 93–96 (เริ่มรอบ) + 115–119
(session ตายกลางการอ่าน) — เด้งกลับเข้า session ทันทีโดยไม่สนว่ามีคนใช้อยู่.

---

## 2. ทางเลือก (Alternatives)

| ทาง | สาระ | ผล |
|---|---|---|
| **A. แยกบัญชีให้บอท** | ขอ Acolad เปิด XTM user ที่ 2 | สะอาดสุด *ถ้าทำได้* แต่พึ่งคนนอก + เสี่ยง user ใหม่มองไม่เห็น job offer เดียวกัน |
| **B. Auto-yield (เลือก)** | บอทตรวจจับว่ามีคน login แล้วถอยให้เอง | คุมเองได้ทันที แก้ ping-pong จริง แลกกับช่วงบอท "ตาบอด" ตอนคนทำงาน |
| C. ช่วงเวลาตายตัว | บอทพักตามตาราง | แข็งทื่อ งานมาไม่เป็นเวลา — แพ้ B |

**ตัดสินใจ:** ทำ **B ตอนนี้** + ผลัก **A คู่ขนาน** เป็นทางออกถาวร (ปิด B ด้วย flag เมื่อ A พร้อม).

---

## 3. หลักฐานจาก Live Recon (load-bearing)

รัน `npm run xtm:recon-logout` (2 context จำลองบอท A + คน B บนบัญชีร่วม). ผลยืนยัน:

| ข้อเท็จจริง | ผล | ใช้ในดีไซน์ |
|---|---|---|
| logout render แบบไหน | **TOP-LEVEL redirect → `logout.jsp`** (outer login shell, ไม่มี iframe) | `isXtmLoggedOut` (อ่าน outer page) จับได้ — **ไม่ต้องเพิ่ม in-iframe guard** |
| เหตุผล logout อยู่ใน URL | **`logout.jsp?type=LOGGED_OFF_BY_ANOTHER_USER`** (ถูกคนเตะ) vs **`?type=SESSION_EXPIRED`** (หมดเอง) | 🎯 **สัญญาณ deterministic** — แยก "คนเข้า" จาก "หมดเอง" ได้แน่นอน ไม่ต้องเดา |
| latest-login-wins | re-login เตะ session อื่นจริง (`probeLoginKicksHuman=true`) | probe = การ "ยึดบัญชีคืน" ที่เตะคน — ต้องจำกัดความถี่ |
| login รัวๆ ทำทั้งคู่หลุดชั่วคราว | Phase 2: ตัว winner เองได้ `SESSION_EXPIRED` ชั่วคราว แต่ login สดถัดมาติดสะอาด | probe อาจล้มเหลวชั่วคราวถ้าชนจังหวะคน login พอดี → retry รอบถัดไป (edge §9) |

> **ค่าที่ยังต้องวัดแยก:** idle/absolute session timeout จริงของ XTM (ปล่อย session
> idle จนตาย) — ใช้ตั้ง upper bound ของ `XTM_YIELD_WINDOW_MS`. แต่ **ความสำคัญลดลงมาก**
> เพราะตอนนี้ตัวตัดสินหลักคือ URL type ไม่ใช่ window.

---

## 4. แก่นการออกแบบ (Core mechanism) — v2

State machine คุมที่ `XtmPollLoop` 2 สถานะ + **bound/escalation**:

```
        ┌──────── อ่านสำเร็จต่อเนื่อง ≥ resumeStableCycles ────────┐
        ▼                                                          │
   ┌─────────┐   logout type = LOGGED_OFF_BY_ANOTHER_USER       ┌──────────┐
   │ ACTIVE  │   (หรือ SESSION_EXPIRED + เพิ่งสำเร็จ < window)  │ YIELDING │
   │ เฝ้าปกติ │ ──────────────────────────────────────────────▶│  (พัก)   │
   └─────────┘                                                   └──────────┘
        ▲          probe (accept-OFF) หลัง cooldown:                │  │  │
        │            ยึดบัญชีคืน → อ่านได้ → tentative ACTIVE        │  │  │ cooldown ยังไม่ครบ
        │            (เปิด accept เมื่อ ACTIVE นิ่งแล้ว)              │  │  ▼ skip read (ยัง flush outbox!)
        └────────────────────────────────────────────────────────┘  │     heartbeat = ok (ถ้า outbox ไม่ dead)
              ถูกเด้งซ้ำ → YIELDING ต่อ                                │
                                                          yield episode ≥ MAX_MINUTES
                                                                       ▼
                                                          ⚠️ ESCALATE: alert 'yield_stuck'
                                                             + heartbeat.fail (page on-call)
```

### ตัวตัดสินหลัก = อ่าน `logout.jsp?type` (deterministic)
- `LOGGED_OFF_BY_ANOTHER_USER` → มีคน/อีก session active แน่นอน → **YIELD**
- `SESSION_EXPIRED` → session หมดเอง → **re-login ปกติ** *เว้นแต่* เพิ่งสำเร็จ < window
  (กำกวม — อาจเป็นเคส login รัวจากคน) → YIELD เป็น safety net
- อื่นๆ/อ่าน type ไม่ได้ → ใช้ heuristic เวลาเป็น fallback (เหมือน v1)

### bound/escalation (กัน failure-masking — review Critical #1)
- เก็บ `yield_episode_started_ms` (เริ่ม episode เมื่อเข้า YIELDING ครั้งแรก, ไม่ reset
  ทุก probe — กัน flap หลอก)
- yield ต่อเนื่อง ≥ `XTM_YIELD_MAX_MINUTES` (default 60) → ยก alert `yield_stuck` (SYSTEM,
  standing alert raise ครั้งเดียว) + **`heartbeat.fail()`** → on-call ได้ page (กัน AFK/flap/
  outage แอบเงียบ). **เลือก escalate+page (ให้คนตัดสิน) ไม่ auto-retake บัญชี** — เพราะงานแปลจริง
  อาจยาว > 1 ชม. การ force re-login จะเตะคนกลางงาน; ปล่อยให้คนเลือก (ทำงานต่อ/ปิดบอท/คืนบัญชี)
- reset episode **เฉพาะเมื่อ resume แล้ว ACTIVE ต่อเนื่อง ≥ `resumeStableCycles`** (เช่น 2 รอบ)
  — ไม่ใช่แค่ probe สำเร็จครั้งเดียว

---

## 5. ฟังก์ชันบริสุทธิ์ (TDD-first) — `src/runtime/yieldPolicy.ts`

```ts
export type LogoutKind = 'kicked_by_other' | 'expired' | 'unknown';

/** อ่านเหตุผล logout จาก logout.jsp?type (จาก recon — deterministic). */
export function classifyLogout(url: string): LogoutKind {
  if (/type=LOGGED_OFF_BY_ANOTHER_USER/i.test(url)) return 'kicked_by_other';
  if (/type=SESSION_EXPIRED/i.test(url)) return 'expired';
  return 'unknown';
}

/** ควร yield ไหมเมื่อพบ logged-out — deterministic ก่อน, heuristic เป็น net. */
export function shouldYieldOnLogout(args: {
  kind: LogoutKind;
  lastAuthSuccessMs: number;
  nowMs: number;
  windowMs: number;
}): boolean {
  if (args.kind === 'kicked_by_other') return true;               // แน่นอน
  // expired/unknown: yield เฉพาะถ้าเพิ่งสำเร็จ (สงสัยคน login รัว)
  return args.lastAuthSuccessMs > 0 && args.nowMs - args.lastAuthSuccessMs < args.windowMs;
}

/** ยังอยู่ใน cooldown ไหม (skip read รอบนี้). */
export function inCooldown(yieldUntilMs: number, nowMs: number): boolean {
  return yieldUntilMs > nowMs;
}

/** yield episode ยาวเกิน hard cap → ต้อง escalate + page. */
export function yieldStuck(episodeStartedMs: number, nowMs: number, maxMinutes: number): boolean {
  return episodeStartedMs > 0 && nowMs - episodeStartedMs >= maxMinutes * 60_000;
}
```

---

## 6. จุดแก้ในโค้ด (touch points) — v2

| ไฟล์ | การเปลี่ยนแปลง |
|---|---|
| `src/portal/errors.ts` | + `SessionYieldError { kind: LogoutKind }` — **ไม่ extend `PortalError`** (review Minor #9: กันหลุดเข้า transient/portal_down branch) |
| `src/portal/xtmClient.ts` | จุด logged-out (93–96, 115–119): **เลิก silent re-login ไม่มีเงื่อนไข** → อ่าน `page.url()` → `classifyLogout` → ถ้า policy บอก yield → throw `SessionYieldError(kind)` (ไม่ login); ถ้า relogin → login + retry (เดิม). policy ส่งจาก loop |
| `src/runtime/yieldPolicy.ts` | **ใหม่** — 4 ฟังก์ชันบริสุทธิ์ (§5) |
| `src/state/meta.ts` | + typed accessor: `lastAuthSuccessMs`, `yieldUntilMs`, `yieldEpisodeStartedMs` (+ setters) ผ่าน `getNumber`/`set` |
| `src/runtime/xtmPollLoop.ts` | yield gate + escalation + txn-wrapped state/notify (ดู §7) |
| `src/config/index.ts` + `.env.example` | + `XTM_YIELD_ENABLED`(1), `XTM_YIELD_WINDOW_MS`(600000), `XTM_YIELD_MAX_MINUTES`(60) + **zod refine: `WINDOW_MS ≥ 3 × POLL_INTERVAL_MS`** fail-fast (review Important #6) |

หลักการที่รักษา: **client เป็น I/O surface** (รายงาน logged-out + kind), **policy/state ทั้งหมดอยู่ที่ loop**.

---

## 7. Flow ใน `XtmPollLoop.runOnce()` — v2

```
nowMs = clock.now
if !cfg.XTM_YIELD_ENABLED: <เดินทางเดิมทุกประการ>

# (1) ESCALATION ก่อน (review Critical #1): yield ยาวเกิน cap → page
if yieldStuck(meta.yieldEpisodeStartedMs, nowMs, cfg.XTM_YIELD_MAX_MINUTES):
    raiseAlert('yield_stuck', "yielded ≥N min — confirm human is active or XTM/session stuck")
    await dispatcher.flush(...); await heartbeat.fail(); return false   # ดังพอให้ on-call เห็น

# (2) cooldown: skip READ แต่ยัง FLUSH (review Important #4 — flush ไม่แตะ XTM)
if inCooldown(meta.yieldUntilMs, nowMs):
    await dispatcher.flush(...)            # ส่ง outbox ที่ค้าง (Chat/Sheets) ตามปกติ
    heartbeat = ok เฉพาะถ้า outbox ไม่มี dead backlog (countDeadExcludingChannel('team')==0) else fail
    log { action:'yield', outcome:'cooldown', episodeMin: ... }
    return true

# (3) อ่าน — relogin policy ตัดสินจาก logout kind (ส่ง closure/policy เข้า client)
try:
    snapshot = await client.fetchJobSnapshot(id, {
        decideRelogin: (kind) => !shouldYieldOnLogout({kind, lastAuthSuccessMs: meta.lastAuthSuccessMs, nowMs, windowMs})
    })
    # สำเร็จ → จับเวลา ณ สำเร็จจริง (review Minor #8)
    meta.setLastAuthSuccessMs(clock.nowMs())
    if meta.yieldEpisodeStartedMs > 0:
        consecutiveActive += 1
        if consecutiveActive >= cfg.resumeStableCycles:   # นิ่งจริงค่อย resume เต็ม
            db.transaction(() => {                          # review Important #3: txn เดียว
                meta.setYieldUntilMs(0); meta.setYieldEpisodeStartedMs(0)
                outbox.enqueue(`yield_resumed:${episodeId}`, ..., 'chat')   # episode-scoped id
            })()
        else: <ยังไม่เปิด accept เต็ม — probe ครั้งนี้ accept-OFF (review Important #5)>
    <เดินวงจรเดิม: cycle.run → daily → flush → heartbeat>   # accept เปิดเฉพาะเมื่อ resume เต็มแล้ว
catch SessionYieldError(kind):                              # ไม่ผ่าน handleError (review Minor #9)
    firstEntry = meta.yieldEpisodeStartedMs === 0
    episodeStart = firstEntry ? nowMs : meta.yieldEpisodeStartedMs
    db.transaction(() => {                                  # txn เดียว: state + notify
        meta.setYieldUntilMs(nowMs + cfg.XTM_YIELD_WINDOW_MS)
        if firstEntry:
            meta.setYieldEpisodeStartedMs(nowMs)
            outbox.enqueue(`yield_paused:${episodeStart}`, ..., 'chat')   # episode-scoped → ส่ง 1 ครั้ง/episode
    })()
    consecutiveActive = 0
    if firstEntry: await dispatcher.flush(...)
    heartbeat = ok เฉพาะถ้า outbox ไม่ dead else fail
    return true
```

> `episodeId` = `yield_episode_started_ms` → ทำให้ `yield_paused:<start>` / `yield_resumed:<start>`
> ผูกกับ episode (review Critical #2: กัน `INSERT OR IGNORE` ทิ้งสัญญาณถาวร).

---

## 8. แจ้งเตือน + heartbeat — v2

- **เข้า YIELDING (ครั้งแรกของ episode):** `yield_paused:<episodeStart>` → SYSTEM channel →
  `🧑 Human/another session on XTM — bot paused (account in use)`. ส่ง 1 ครั้ง/episode.
- **resume เต็ม (ACTIVE นิ่ง ≥ resumeStableCycles):** `yield_resumed:<episodeStart>` →
  `🤖 Bot resumed XTM monitoring`.
- **yield ยาวเกิน cap:** `yield_stuck` (SYSTEM) + **heartbeat.fail** → page on-call.
- **heartbeat ปกติระหว่าง yield = ok** *ก็ต่อเมื่อ* outbox ไม่มี dead backlog — ไม่ short-circuit
  ข้าม dead-gate (review Important #4).

---

## 9. Edge cases — v2

| กรณี | พฤติกรรม |
|---|---|
| Cold start (meta ว่าง) | `lastAuth=0`, ไม่มี logged-out kind ที่ kicked → re-login ปกติ |
| คน login เตะบอท | บอทเห็น `type=LOGGED_OFF_BY_ANOTHER_USER` → yield แน่นอน (deterministic) |
| session หมดเองจริง (ไม่มีคน) | `type=SESSION_EXPIRED` + lastAuth เก่า → re-login ปกติ (ไม่ yield ผิด) |
| Restart ระหว่างคนทำงาน | meta โหลด episode/yieldUntil → คงสถานะ yield, ไม่เด้งคน |
| คน AFK เปิดแท็บค้างข้ามคืน | yield จนชน `MAX_MINUTES` → **escalate + page** (ไม่เงียบหาย — review Critical #1) |
| flap (session ถูกตัดซ้ำจาก non-human) | probe สำเร็จชั่วคราวไม่ reset episode → ชน cap → escalate |
| probe ชนจังหวะคน login พอดี | อาจได้ `SESSION_EXPIRED` ทั้งคู่ชั่วคราว (recon Phase 2) → retry รอบถัดไป |
| job มาเลย์มาตอน yield | บอทไม่รับ — คนอยู่ใน XTM เห็น/กดเอง; resume แล้วบอทรับต่อถ้ายังว่าง (`acceptAvailable` กัน double-accept) |

---

## 10. Kill switch — เผื่อทาง A (บัญชีแยก)

`XTM_YIELD_ENABLED=0` → ข้าม yield ทั้งหมด → **พฤติกรรมเดิมเป๊ะ** (login ตรง). ไม่ต้องแก้โค้ด.
เมื่อ Acolad เปิด user ที่ 2 + ยืนยันเห็น offer เดียวกัน → สลับบัญชี + ตั้ง flag=0.
**Action item (นอกโค้ด):** ติดต่อ Acolad ขอ user ที่ 2 + ทดสอบเห็น offer มาเลย์เดียวกัน.

---

## 11. Config + validation

- `XTM_YIELD_ENABLED` default `1` (เปิด — แต่ ship หลังใส่ bound/escalation ครบ; ตัดสินใจแล้ว)
- `XTM_YIELD_WINDOW_MS` default `600000` (cooldown + เกณฑ์ recent สำหรับ SESSION_EXPIRED)
  — **zod refine: ต้อง ≥ 3 × POLL_INTERVAL_MS** ไม่งั้น fail-fast ตอน start (review Important #6)
- `XTM_YIELD_MAX_MINUTES` default `60` (hard cap → escalate + page)
- `resumeStableCycles` ค่าคงที่ใน loop = 2 (ACTIVE นิ่งกี่รอบถึง resume เต็ม)

YAGNI: ยังไม่ทำ manual pause (Google Chat command) — auto-yield + deterministic signal พอ.

---

## 12. แผนทดสอบ (TDD — test ก่อน implement)

1. **`tests/unit/yieldPolicy.test.ts`** (pure): `classifyLogout` (ทั้ง 3 kind + url แปลก),
   `shouldYieldOnLogout` (kicked→true เสมอ, expired+recent→true, expired+stale→false,
   unknown ตาม window, lastAuth=0), `inCooldown`, `yieldStuck` (boundary + episode=0)
2. **`tests/unit/meta.test.ts`**: accessor 3 ตัวใหม่ round-trip + default 0
3. **`tests/unit/config.test.ts`**: zod refine ปฏิเสธ `WINDOW_MS < 3×interval`
4. **`tests/integration/xtmPollLoop.test.ts`** (stub client):
   - logout kind=kicked → SessionYieldError → yield + paused (ส่ง 1 ครั้ง/episode) + heartbeat ตาม dead-gate
   - cooldown cycle → skip read แต่ **flush ถูกเรียก** + ประเมิน dead-gate
   - resume ต้องนิ่ง ≥ resumeStableCycles ก่อนส่ง resumed + เปิด accept (accept-OFF ระหว่าง probe)
   - yield ≥ MAX_MINUTES → yield_stuck + **heartbeat.fail**
   - episode-scoped id: paused ส่งครั้งเดียวต่อ episode, episode ใหม่ส่งใหม่
   - state+notify อยู่ใน txn เดียว (crash จำลอง: ไม่มีครึ่งๆ)
   - flag ปิด → พฤติกรรมเดิม
5. **`tests/integration/failureModes.xtm.test.ts`**: `SessionYieldError` **ไม่แตะ
   `loginFailures`/`firstPortalErrorMs`**, ไม่นับ portal_down (review Minor #9);
   `SESSION_EXPIRED`+stale → re-login (ไม่ yield)
6. coverage gate `state/` ≥ 80%

---

## 13. สรุปผลกระทบ

- **เพิ่ม:** `yieldPolicy.ts` (pure, 4 fn) + 1 error + 3 env + 3 meta accessor + loop gate/escalation + `recon-logout.ts` (มีแล้ว) + tests
- **reuse:** outbox/dispatcher, meta, heartbeat, pure-decision pattern, `isXtmLoggedOut`
- **ไม่แตะ:** detection diff engine, accept state machine, sheets, daily report
- **ความเสี่ยงลดจาก v1:** ตัวตัดสินหลักเป็น deterministic (URL type) ไม่ใช่ heuristic เวลา;
  มี bound/escalation กัน failure-masking; ปิดด้วย flag กลับเดิมได้ทันที
- **ยังค้าง (ไม่บล็อก build):** วัด XTM session timeout จริงเพื่อยืนยัน upper bound ของ window
