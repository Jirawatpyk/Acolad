# Feature Brief — JobCatch 003: Straker Offer Race

> **วิธีใช้**: วางเนื้อหาตั้งแต่ "## Feature description" ลงไปเป็น input ของ
> `/speckit-specify` ใน Claude Code (รันในโฟลเดอร์รีโป Acolad)
> เอกสารอ้างอิงประกอบ: `straker-recon-note.md` (recon 2026-08-25)
>
> **⚠️ ทำ "Phase 0" ให้เสร็จก่อน** — หัวข้อ Phase 0 ด้านล่างไม่ใช่ spec input
> แต่เป็นงานที่ต้องรันทิ้งไว้ 1–2 สัปดาห์ก่อน เพื่อให้ `/speckit-plan` มีข้อมูลจริง
> ล็อก data model และ poll interval
>
> อัปเดต 2026-09-11: ผู้ใช้ยืนยันว่ามี offer เข้ามาแล้ว (ข้อกังวลเรื่อง VAT /
> disengaged ตกไป) แต่ยังจับ payload จริงไม่ได้ → จึงต้องมี Phase 0

---

## ภาพรวมโปรแกรม (อ่านก่อน ถ้าเพิ่งเข้ามาอ่าน)

### ของที่มีอยู่แล้ววันนี้

บอทตัวหนึ่งเฝ้า XTM Cloud ตลอด 24 ชั่วโมง ทุก 20 วินาทีเปิดดูว่ามีงานแปลใหม่โผล่ไหม
ถ้าเจองานคู่ภาษามาเลย์ **และ** อยู่ในเวลาทำงาน ไม่ใช่วันหยุดไทย ยังไม่เกินโควต้าคำต่อวัน
→ กดรับให้เลย แล้วบันทึกลง Google Sheets + แจ้ง Google Chat
**live มาตั้งแต่ 2026-06-22**

### ของที่จะเพิ่ม

บอทตัวที่สองเฝ้า **Straker** ทำงานหลักการเดียวกัน แต่ต่างสองเรื่องใหญ่:
Straker มี **REST API** ให้เรียกตรง (ไม่ต้องอ่าน DOM) และงานเป็นแบบ
**ใครกดก่อนได้** ต้องเร็ว

### จัดระเบียบยังไง — 3 ชั้น

```
ชั้นกลาง (ใช้ร่วมกัน)      กฎเวลาทำงาน · วันหยุดไทย · โควต้า · ระบบส่งแจ้งเตือน
  @jobcatch/core            · ตรรกะกันแจ้งซ้ำ  —  ไม่รู้จักพอร์ทัลไหนเลย

ชั้นพอร์ทัล (ตัวละชุด)     portal-xtm รู้เรื่อง Playwright/iframe
  @jobcatch/portal-*        portal-straker รู้เรื่อง HTTP/cookie
                            แต่ละตัวรู้แค่พอร์ทัลของตัวเอง

ชั้นรัน                     คนละ process · คนละไฟล์ SQLite · คนละโควต้า
  PM2 app ละตัว             ตัวหนึ่งล่ม อีกตัวไม่รู้เรื่องเลย (bulkhead)
```

**กฎข้อเดียวที่สำคัญที่สุด (Open/Closed)**
เพิ่มพอร์ทัลใหม่ **ต้องไม่ต้องแก้พอร์ทัลเดิมหรือชั้นกลาง** — แค่เพิ่มโฟลเดอร์ใหม่
+ process ใหม่ (ดู `docs/add-a-portal.md` ที่ 003 จะส่งมอบ)

### ลำดับงาน

| | ทำอะไร | เวลา |
|---|---|---|
| **Phase 0** | สคริปต์ read-only ดักเก็บ offer payload จริง + วัด offer lifetime | รันทิ้งไว้ 1–2 สัปดาห์ |
| **003** | ย้ายชั้นกลางออกมา + เขียนบอท Straker | หลัง Phase 0 |
| **004** | ยังไม่ทำ — รอพอร์ทัล*ชนิดเดียวกัน* 2 ตัว (ADR-001) | ตาม trigger |

---

## ADR-002 — ชื่อโปรแกรม: **JobCatch**

**บริบท**: ชื่อ `Acolad` ไม่ตรงกับของจริงแล้ว — เริ่มจาก `partner.acolad.com`
(ถอดออกแล้วใน 002) → ย้ายไป XTM Cloud → กำลังเพิ่ม Straker ซึ่งเป็นบริษัทคนละราย
และจะมีพอร์ทัลอื่นตามมาอีก. ชื่อปัจจุบันบอกชื่อ*ลูกค้ารายหนึ่ง* ไม่ได้บอกว่าระบบทำอะไร

**ตัดสินใจ**: ชื่อโปรแกรมคือ **JobCatch**

- มาจาก **คำที่ทีมใช้อยู่แล้ว** — `CLAUDE.md` เขียน "snatch window" และมี
  `npm run report:catch-rate` อยู่แล้ว
- บอก**พฤติกรรม** ไม่ใช่ชื่อ vendor → ไม่พังเมื่อมีพอร์ทัลที่ 3, 4
- ⚠️ **หลีกเลี่ยง** `vendor-bot` / `vendr-bot` — `vendr` เป็นชื่อผลิตภัณฑ์ของ Straker เอง

**Naming convention**

| สิ่ง | ชื่อ |
|---|---|
| npm package | `@jobcatch/core` · `@jobcatch/portal-xtm` · `@jobcatch/portal-straker` |
| PM2 app | `jobcatch-xtm` · `jobcatch-straker` · `jobcatch-straker-recon` (Phase 0) |
| ไฟล์ SQLite | `jobcatch-xtm.db` · `jobcatch-straker.db` (ของเดิม `acolad.db` คงไว้จนถึงขั้น 3) |

**ยังไม่เปลี่ยนชื่อ GitHub repo ตอนนี้** — จะลาก PM2 app name, `deploy.ps1`,
ชื่อไฟล์ DB, คอมเมนต์เรื่อง port, CI ไปด้วย = churn จริงบนระบบ live เพื่อความสวยงามล้วนๆ
ทำเป็น 3 ขั้นแทน:

1. **ตอนนี้** — ใช้ JobCatch เป็นชื่อเรียกในเอกสารและเวลาคุยกับทีม
2. **ใน 003** — package ใหม่ตั้งชื่อ `@jobcatch/*` ตั้งแต่แรก (ยังไม่มีอะไรอ้างถึง = ฟรี)
3. **ทีหลัง** — เปลี่ยนชื่อ repo + PM2 + ไฟล์ DB เป็นงานเล็กของตัวเอง ตอนไม่มีอะไรค้าง
   (GitHub redirect ให้อัตโนมัติ clone เดิมไม่พัง)

---

## ⚠️ ก่อนอ่านต่อ — ผมขอแก้คำแนะนำเดิม

รอบก่อนผมเสนอให้ extract `packages/core` + ออกแบบ `PortalAdapter` SPI ให้เสร็จก่อน
แล้วค่อยเขียน Straker. **ตอนนี้ผมคิดว่าลำดับนั้นผิด** ด้วยเหตุผล 2 ข้อ:

1. **ห้าม abstract จากตัวอย่างเดียว** — ถ้าออกแบบ SPI จาก XTM อย่างเดียว จะเผลอ
   ฝัง assumption ว่า "พอร์ทัล = browser" เข้าไป **ซึ่งผมทำพลาดไปแล้วจริงๆ**
   (รอบแรกผมวาง `browser.ts` + `evidence.ts` ไว้ใน core ทั้งที่ Straker ไม่ใช้เลย)
2. Straker เป็น HTTP client ล้วน ต่างจาก XTM ที่เป็น Playwright ถึงราก —
   SPI ที่ครอบทั้งสองแบบได้จริง ต้องมีของจริงสองตัวอยู่ในมือก่อน

**ลำดับใหม่ที่เสนอ:**

| Feature | ทำอะไร | ความเสี่ยงต่อ XTM live |
|---|---|---|
| **Phase 0 (ทำก่อนทุกอย่าง)** | capture probe read-only — ดักเก็บ offer payload จริง + วัด offer lifetime | **ศูนย์** — แยกสคริปต์ ไม่แตะโค้ด XTM เลย |
| **003** | ย้าย module ที่ *พิสูจน์แล้วว่า generic* เข้า `packages/core` (`@jobcatch/core`) แบบ mechanical + สร้าง Straker bot ที่ import จาก core นั้น | ต่ำ — XTM แค่เปลี่ยน import path |
| **004** | ~~ออกแบบ `PortalAdapter` SPI~~ → **ไม่มีกำหนด เป็น trigger-based** (ดู ADR-001 ด้านล่าง) | — |

module ที่ย้ายได้ทันทีใน 003 (ตรวจแล้ว **XTM reference = 0** ยกเว้นที่ระบุ):
`schedule/*` (มี 2 ที่ใน `effort.ts` ต้อง clean) · `monitoring/*` ·
`state/outbox.ts|meta.ts|systemEvents.ts` · `reporting/dispatcher|googleChat|chatCard|cardText|dateFormat` ·
`runtime/rateLimiter|scheduler|singleInstance` · `detection/diff.ts` (เฉพาะ `diffGeneric`+`DiffAdapter`) ·
`clock.ts` · `withTimeout.ts`

**ยังไม่ย้ายใน 003**: `portal/*` (ทั้งหมดอยู่กับ XTM), `detection/types.ts`,
`state/xtmJobStore.ts`, `reporting/sheets.ts|xtmNotifier.ts`, `runtime/xtmPoll*`

---

## ADR-001 — ไม่ทำ `PortalAdapter` SPI (microkernel) ใน 003 หรือ 004

**บริบท**: จะมีบอทพอร์ทัลอื่นเพิ่มอีก แต่ **ยังไม่ทราบว่าพอร์ทัลไหน กี่ตัว หรือเมื่อไหร่**
— จะทำเพิ่มตามงานที่เข้ามาจริง (2026-09-11)

**ตัดสินใจ**: ไม่สร้าง SPI กลาง ไม่ทำ plug-in registry ไม่ทำ runtime plug-in loading

**เหตุผล**:
- ตอนนี้มี **HTTP-based 1 ตัว (Straker) + browser-based 1 ตัว (XTM)** —
  ยังไม่มีสองตัวที่เป็น *ชนิดเดียวกัน* ให้ generalize. Rule of Three นับตัวอย่างที่
  เทียบกันได้ ไม่ใช่นับหัว
- SPI ที่ครอบทั้ง Playwright และ HTTP จะเป็น lowest-common-denominator +
  escape hatch → แย่กว่าไม่มี (Speculative Generality, *Refactoring*/Fowler)
- ความไม่สมมาตรของจริง: XTM ต้องมี `readClosedKeys` · `acceptAvailable` ·
  evidence capture · session-collision yield · bulk all-or-nothing;
  Straker ต้องมี rate-limit header adaptive · cookie jar · proactive re-login ·
  409 semantics — **แต่ละฝั่งไม่ต้องการของอีกฝั่งเลยสักอย่าง**

**คาดการณ์**: พอร์ทัลใหม่ส่วนใหญ่มี API → SPI (ถ้าเกิด) จะโตมาจาก**ฝั่ง HTTP**
และ **XTM จะเป็น special case ถาวร** — อย่าพยายามลาก XTM เข้ามา
special case 1 ตัวถูกกว่า universal abstraction ที่ผิด

**Trigger ที่จะกลับมาพิจารณา** (ข้อใดข้อหนึ่ง):
1. มีพอร์ทัล **ชนิดเดียวกัน** ครบ 2 ตัว (เช่น HTTP-based ตัวที่ 2 นอกจาก Straker)
2. ต้องแก้บั๊กตัวเดียวกันซ้ำใน poll loop สองตัว
3. โค้ดที่ duplicate จริง > ~500 บรรทัด

**สิ่งที่ *ไม่* ต้องใช้ SPI แก้** (คนมักสับสน):
- ~~capacity ที่แชร์กันระหว่างพอร์ทัล → shared ledger~~ → **ไม่ต้องทำเลย**
  (ยืนยัน 2026-09-11: **capacity แยกต่อพอร์ทัล ไม่ใช้ร่วม**) → bulkhead สมบูรณ์
- **รายงานรวมทุกพอร์ทัล** → Sheet schema ร่วม + card builder ร่วม (อยู่ใน core หลัง 003)
  เป็น **read-only aggregation ตอนทำรายงาน** ไม่ใช่ shared state ตอน accept

---

## Design Constraints — เตรียมรับพอร์ทัลอนาคต (ราคาเกือบศูนย์)

เนื่องจากจะมีพอร์ทัลเพิ่มแบบทยอยมา **เป้าหมายคือ "เพิ่มพอร์ทัลใหม่ต้องไม่ต้องแก้
พอร์ทัลเดิมหรือ core"** (Open/Closed) — ซึ่งดีไซน์ process-per-portal ให้คุณสมบัตินี้อยู่แล้ว
สิ่งที่เพิ่มคือวินัย 4 ข้อ ให้ Straker เป็น **reference implementation ของตระกูล HTTP**:

| # | กฎ | ทำไม |
|---|---|---|
| **DC-1** | **แปลเป็นภาษาโดเมนที่ขอบของ adapter — ห้ามรั่วขึ้นไป** เช่น orchestration ต้องไม่มี `status === 409` โผล่; adapter แปลเป็น `AcceptOutcome.LostRace` ที่ขอบตัวเอง | ★ ข้อสำคัญที่สุด — ถ้าทำข้อนี้ SPI ทีหลังเหลือแค่ "เขียน interface ที่ทั้งสองทำได้อยู่แล้ว" |
| **DC-2** | **vocabulary เดียวกันทั้งสองบอท** — `OfferSeen` / `AcceptOutcome` / `EffortUnits` / `GateDecision` ชื่อเดียวกัน ความหมายเดียวกัน ถึงจะยังไม่มี interface กลาง | ทำให้ generalize ทีหลังเป็นงานกลไก |
| **DC-3** | **ลำดับขั้นใน poll loop เหมือนกัน** — `fetch → diff → gate → act → persist → notify` ชื่อ function เหมือนกัน | diff ระหว่างสองบอทอ่านออกด้วยตา → เห็น duplication จริงเมื่อไหร่ก็รู้ (trigger #3) |
| **DC-4** | **transport detail อยู่ในไฟล์เดียว** — cookie jar / rate-limit header / retry รวมใน `httpClient.ts` ไฟล์เดียว ไม่กระจาย | พอร์ทัลที่ 3 copy ไฟล์นี้ไปแก้ base URL ก็เกือบเสร็จ |

### Deliverable เพิ่มของ 003: runbook "เพิ่มพอร์ทัลใหม่"

เพราะยังไม่รู้ว่าพอร์ทัลถัดไปคืออะไร **เอกสารมีค่ามากกว่า abstraction**
003 ต้องส่งมอบ `docs/add-a-portal.md` ที่เป็น checklist ใช้ได้จริง:

1. recon ก่อน (มี API ไหม → ถ้ามี copy ตระกูล Straker, ถ้าไม่มี copy ตระกูล XTM)
2. สร้าง `packages/portal-<ชื่อ>` (`@jobcatch/portal-<ชื่อ>`) + config schema ของตัวเอง
3. จอง `SINGLE_INSTANCE_PORT` ใหม่ (ตารางพอร์ตที่ใช้แล้ว: XTM 47811, Straker 47812)
4. `STATE_DIR` ใหม่ (คนละไฟล์ SQLite)
5. Sheet tab ใหม่ + Chat webhook
6. ลงทะเบียนใน `ecosystem.config.cjs` + `deploy.ps1`
7. รัน `ACCEPT_ENABLED=0` อย่างน้อย 1 สัปดาห์ก่อนเปิดกดรับ
8. ตั้งค่า capacity/throughput **ชุดของพอร์ทัลนั้นเอง** (ไม่แชร์กับพอร์ทัลอื่น —
   ดู ADR-001) + เพิ่มเข้า daily report รวมเพื่อให้คนเห็นยอดรวมทุกพอร์ทัล

---

## Phase 0 — Offer capture probe (ทำก่อน `/speckit-specify`)

### ทำไมต้องมี

ผู้ใช้ยืนยัน (2026-09-11) ว่า **เคยมี offer เข้ามาแล้ว** แต่จังหวะที่ recon และจังหวะที่
ถามซ้ำไม่มี open offer เลย → **ยังไม่เคยเห็น offer payload จริงแม้แต่ตัวเดียว**
และที่สำคัญกว่า: **ยังไม่รู้ว่า offer อยู่ได้นานแค่ไหน**

ตัวเลขนั้นตัดสินว่า feature 003 ต้องเป็นดีไซน์ latency-critical จริงหรือไม่:

| ถ้า Phase 0 วัดได้ว่า offer อยู่ | ผลต่อ spec |
|---|---|
| หายใน ~30 วินาที | แย่งงานจริง → poll 1s + keep-alive + SC-001/002 **คุ้ม** |
| อยู่หลายนาที–ชั่วโมง | **ดีไซน์ race ทั้งชุด over-engineer** → poll 30–60s พอ, **ตัด SC-001/002 ออก**, งานลดลงมาก |

ถ้าเขียน spec ตอนนี้ = เขียนบน assumption ไม่ใช่หลักฐาน (ขัดหลัก evidence-first
ใน constitution — แบบเดียวกับที่ 002 บังคับ recon XTM จริงก่อนเขียนโค้ด)

### ขอบเขต (เล็กมาก ~70–80 บรรทัด)

```
login  POST /api/vendor/auth/login  (+ cookie jar)
vendorId ← GET /api/vendor/auth/me   (member_obj_id — ห้าม hardcode)

loop ทุก 10 วินาที:            ← 6 req/นาที = 2% ของ budget 300/นาที
  GET /api/vendors/{v}/job-offers?status=open
  log: timestamp · x-ratelimit-* · RTT · จำนวน offer
  ถ้า array ไม่ว่าง:
    สำหรับ offer ที่ยังไม่เคยเห็น (obj_id ใหม่):
      → เขียน raw JSON ลง fixtures/straker/offer-<ts>-<obj_id>.json
      → GET /{obj_id} + /{obj_id}/source-files เก็บด้วย (ไม่ต้องรีบ — ไม่ได้แย่ง)
      → บันทึก first_seen_at
    สำหรับ offer ที่หายไปจาก list:
      → บันทึก last_seen_at  →  lifetime = last_seen - first_seen
```

**ข้อห้ามเด็ดขาด**: ไม่มีการเรียก `POST .../accept` หรือ `POST .../decline` ในสคริปต์นี้
ต้องไม่มี string `accept` / `decline` ในโค้ด Phase 0 เลย (ตรวจด้วย grep ใน review)

รันบน PM2 เครื่อง Windows เดิม เป็น app ที่สาม (ชั่วคราว) ชื่อ **`jobcatch-straker-recon`**
เรียกด้วย **`npm run straker:recon`** (ให้เข้าคู่กับ `xtm:recon` ที่มีอยู่แล้ว — คนอ่านรีโป
จะรู้ทันทีว่าไม่ใช่ production path) ทิ้งไว้ 1–2 สัปดาห์

### สิ่งที่จะได้ออกมา

1. **fixture ของ offer payload จริง** → ล็อก data model ได้ + เป็น test data ของ
   `/speckit-implement` โดยตรง (ไม่เสียเปล่าแม้ spec เปลี่ยน)
2. **offer lifetime distribution** → ตัดสิน poll interval ด้วยข้อมูล
3. **ค่าจริงของ `listing_type`** ทุกค่าที่เจอ → input ของ eligibility rule
4. **จำนวน eligible offer ต่อวัน** → ตัวหารของ win rate (baseline ของ SC-004)
5. **โค้ด login + cookie jar + poll loop** ≈ 80% ของ plumbing ใน adapter จริง
   เขียนไว้ล่วงหน้าแบบ test-first

### Exit criteria ของ Phase 0

ผ่านเมื่อเก็บได้ **≥ 10 offer distinct** พร้อม lifetime ที่วัดได้ **หรือ** ครบ 14 วัน
(ถ้าได้น้อยกว่า 10 ให้บันทึกเป็นข้อจำกัดใน spec ว่า sample เล็ก)

---

## Feature description

### บริบท

บอท Acolad ปัจจุบัน (002) เฝ้า XTM Cloud 24/7 ด้วย Playwright: detect งานใหม่ →
กรองด้วย accept-schedule gate → กดรับอัตโนมัติ (เฉพาะมาเลย์) → log Google Sheets →
แจ้ง Google Chat. live ตั้งแต่ 2026-06-22

ตอนนี้ต้องรับงานจากพอร์ทัลที่สองด้วย: **Straker Vendor Portal** (`vendr.straker.ai`)
บัญชี `nztc@eqho.com` (EQHO, agency, vendor_pool `straker_pool`)

### สิ่งที่ทำให้ Straker ต่างจาก XTM โดยสิ้นเชิง

1. **มี REST JSON API เต็มรูปแบบ — ไม่ต้อง scrape DOM** adapter เป็น HTTP client
   (fetch + cookie jar) ไม่ใช่ Playwright. ไม่มี iframe / selector / CAPTCHA /
   browser recycle / session-collision yield
2. **เป็นระบบแย่งงาน first-come-first-served** — ใครกดรับก่อนได้ **latency คือ
   requirement หลัก ไม่ใช่ nice-to-have** (XTM ไม่ใช่แบบนี้ — poll 20s ก็พอ)
3. **`HTTP 409` จาก accept = offer ถูก vendor อื่นรับไปแล้ว** เป็น outcome ปกติ
   ไม่ใช่ error → **ไม่ต้องมี accept-read race fix แบบ XTM (FR-024)**
4. accept ทีละ offer ไม่มี bulk → กติกา all-or-nothing bulk group ของ XTM
   (`ACCEPT_MAX_PER_CYCLE=0`) **ไม่ applicable**

### เป้าหมาย

รันบอทตัวที่สองบน **เครื่อง Windows ที่ออฟฟิศเครื่องเดิม** (PM2 app แยก) ที่:

- poll `GET /api/vendors/{v}/job-offers?status=open` ถี่พอจะชนะการแย่งงาน
- กรอง eligibility ด้วย **language code** (`ms-my`) + ผ่าน accept-schedule gate เดิม
  (working hours / Thai holidays / daily capacity / throughput) ที่ใช้ร่วมกับ XTM
- `POST .../{offerId}/accept` ให้เร็วที่สุด แล้วตีความ 2xx / 409 / อื่นๆ ต่างกัน
- log ลง **Google Sheet tab แยก** + แจ้ง **Google Chat** (การ์ดคนละแบบกับ XTM)
- **ไม่กระทบพฤติกรรมของบอท XTM ที่ live อยู่แม้แต่นิดเดียว**

### Non-goals (ชัดเจนว่าไม่ทำใน 003)

- **ไม่ออกแบบ `PortalAdapter` SPI / microkernel / plug-in registry** (ดู ADR-001) —
  แต่ **ต้องทำตาม DC-1..DC-4** เพื่อให้ทำทีหลังได้ถูกเมื่อ trigger ยิง
- ไม่ทำ auto-decline (ปล่อยให้ offer หมดอายุเอง)
- ไม่ทำ upload/deliver ไฟล์งาน ไม่ทำ timer/time-tracking (`/assigned-jobs/{id}/time`)
- ไม่ทำ invoice / PO / rates
- ไม่ย้าย XTM ไปใช้ API (XTM ไม่มี API — ยังคง Playwright ต่อไป)
- ไม่ย้ายที่รันไป cloud/VPS — **ยืนยันว่าอยู่เครื่อง Windows ออฟฟิศ**

---

## ข้อเท็จจริงจาก recon (ยืนยันแล้ว — ใช้เป็น input ของ /speckit-plan ได้)

### Auth
```
POST /api/vendor/auth/login   { login_id, password, totp_code }   → HttpOnly cookie
GET  /api/vendor/auth/me      → { member_obj_id, ... }   ← vendorId มาจากที่นี่ ห้าม hardcode
POST /api/vendor/auth/logout
POST /api/vendor/auth/exchange    ← น่าจะเป็น refresh (ยังไม่ยืนยัน)
GET  /api/vendor/auth/2fa/status  ← ระบบรองรับ TOTP (ตอนนี้ปิด) ต้องเผื่อ config ไว้
```
401 `Invalid authentication token` = สัญญาณ re-login

### Offers
```
GET  /api/vendors/{v}/job-offers?status=open      → bare array (ไม่มี envelope)
POST /api/vendors/{v}/job-offers/{offerId}/accept
POST /api/vendors/{v}/job-offers/{offerId}/decline
GET  /api/vendors/{v}/job-offers/{offerId}        ← ห้ามเรียกใน hot path
GET  /api/vendors/{v}/job-offers/{offerId}/source-files   ← ห้ามเรียกใน hot path
```

Offer fields (จาก bundle — **ยังไม่เคยเห็น payload จริง ตอน recon มี 0 open offers**):
`obj_id` · `batch_obj_id` · `job_ref` · `listing_type` (เห็น `direct_po`) ·
`source_lang` · `target_lang` (language code) · `due_at` (ISO UTC) · `rate_type` ·
`unit_cost` · `total_unit` · `weighted_words` · `words` · `budget` (decimal string) ·
`currency` · `source_files[]`

### Assigned jobs (ยืนยันจาก payload จริง)
```
GET /api/vendors/{v}/assigned-jobs?limit=&offset=&job_status=
→ { items: [...], total, limit, offset }        ← มี pagination (ต่างจาก offers)
```
status ที่พบในโค้ด: `pending` `assigned` `in_progress` `delivered` `open`

### ตัวเลขที่วัดได้จริง
| | ค่า |
|---|---|
| Rate limit | **300 req/นาที**, reset ที่ต้นนาที (`x-ratelimit-limit` / `-remaining` / `-reset`) |
| RTT จากกรุงเทพ | **~194–256 ms** (connection reuse) |
| Push channel | **ไม่มี** — ไม่มี WebSocket / SSE / polling ใน frontend เลย |
| Server | `nginx/1.27.5` ไม่มี CDN |

### Language pairs ของบัญชี (44 คู่ active)
targets 27 ภาษา รวม **`ms-my`** (`en-gb→ms-my`, `ar→ms-my`)
services: `translation` `edit` `review` `proofread`

---

## ข้อกำหนดเชิงเทคนิคที่ต้องบังคับ (มาจากธรรมชาติของการแย่งงาน)

1. **accept จาก list payload อย่างเดียว** — `target_lang`, `weighted_words`, `budget`,
   `due_at`, `listing_type` มาครบตั้งแต่ `?status=open` แล้ว
   **ห้ามยิง `/{offerId}` หรือ `/source-files` ก่อน accept** (เสีย RTT ฟรี ~250ms)
   → enrich ทีหลังหลังรับงานได้แล้ว
2. **critical path สะอาด** — ระหว่าง detect → `POST accept` **ห้ามมี** SQLite write,
   outbox enqueue, Sheets, Chat มาคั่น. persist + notify ทั้งหมด *หลัง* ได้ response
   (ต้องวัดว่า `claimForAccept` txn กินกี่ ms ถ้าเกิน ~5ms ต้องหาทางอื่น)
3. **keep-alive / connection warm-up บังคับ** — undici `Agent`/`Pool` + HTTP keep-alive
   (TLS handshake ใหม่ = +2 RTT ≈ +500ms = แพ้)
4. **re-login เชิงรุก** ก่อน session หมดอายุ ไม่ใช่รอ 401 แล้วค่อย login
   (401 กลางการแย่งงาน = เสียงานนั้นแน่นอน)
5. **rate limiter ตัวใหม่** — ตัวเดิมเป็น `REQUESTS_PER_HOUR_CAP` (180/ชม. = 3/นาที)
   ออกแบบมาสำหรับ browser. ต้องทำแบบ **per-minute + อ่าน `x-ratelimit-remaining`
   จาก response header แล้วปรับตัวเอง** พร้อม hard floor กันยิงทะลุ
6. **poll interval แยก config จาก XTM** — `config/index.ts` ปัจจุบัน clamp
   `POLL_INTERVAL_MS` ไว้ที่ `[20000, 25000]` ซึ่งใช้กับ Straker ไม่ได้
   → เป็นเหตุผลรูปธรรมว่าทำไม config ต้องแยกต่อพอร์ทัล
   เริ่มที่ **1000ms** (= 60 req/นาที = 20% ของ budget) แล้วปรับตาม win-rate ที่วัดได้
   (0.5s = 40% ยังปลอดภัย แต่อย่าเริ่มที่นั่น)
7. **isolation จาก XTM บนเครื่องเดียวกัน** — `SINGLE_INSTANCE_PORT` คนละพอร์ต
   (XTM = 47811), `STATE_DIR` คนละโฟลเดอร์ (คนละไฟล์ SQLite), PM2 app คนละตัว,
   `deploy.ps1` ต้องรองรับสองแอปโดยไม่ไป restart อีกตัว
8. **409 ห้ามยิง system alert** — เป็น outcome ปกติของการแย่งงาน
   ต้องบันทึกเป็น metric ไม่ใช่ error

---

## Success criteria (ตั้งเป็น SC — authoritative เหนือ FR ตามธรรมเนียม 002)

> ⚠️ **SC-001 และ SC-002 เป็น conditional — ยืนยันด้วย Phase 0 ก่อน**
> ถ้า Phase 0 วัดได้ว่า offer อยู่หลายนาทีขึ้นไป **ให้ตัดสองข้อนี้ออก** และเปลี่ยน
> poll interval เป็น 30–60s (ประหยัดงานเรื่อง keep-alive / proactive re-login /
> critical-path tuning ทั้งหมด)

| # | เกณฑ์ | วิธีวัด |
|---|---|---|
| SC-001 *(conditional)* | p95 ของ (เวลาที่ response ของ poll ที่เห็น offer ครั้งแรกมาถึง → เวลาที่ `POST accept` ถูกส่งออก) **≤ 400 ms** | log timestamp สองจุด, สคริปต์ `report:straker-latency` |
| SC-002 *(conditional)* | p95 ของช่องว่างระหว่าง poll สองครั้งที่สำเร็จติดกัน **≤ 1.3 × POLL_INTERVAL_MS** | log |
| SC-000 | Phase 0 ส่งมอบ fixture ของ offer จริง ≥ 10 ตัว + ตัวเลข offer lifetime **ก่อน** `/speckit-plan` ล็อก data model | `fixtures/straker/` + รายงาน lifetime |
| SC-003 | **ไม่เคย** ยิงเกิน 300 req/นาที และ `x-ratelimit-remaining` ไม่เคยต่ำกว่า 60 | log header ทุก response |
| SC-004 | Win rate (accepted / eligible offers seen) — **วัดและรายงาน** ตั้ง target หลังเก็บ baseline 2 สัปดาห์ | `report:straker-win-rate` |
| SC-005 | **พฤติกรรมบอท XTM ไม่เปลี่ยน** — 580+ tests เขียวหมด, coverage gate ≥80% เดิม, และ 7 วันหลัง deploy ตัวเลข detect/accept ของ XTM ไม่ต่างจาก baseline | test suite + `report:catch-rate` เทียบก่อน/หลัง |
| SC-006 | **0 ครั้ง** ที่ accept ผ่านไปโดยไม่ผ่าน schedule gate หรือเกิน daily capacity | audit จาก DB |
| SC-007 | 409 ไม่เคยทำให้เกิด system alert หรือทำให้ loop หยุด | failure-mode test |
| SC-008 | ถ้า Straker bot ตาย/ล็อกอินไม่ได้ ต้องไม่กระทบ XTM bot เลย | bulkhead test |

---

## ประเด็นที่ต้องเคลียร์ใน `/speckit-clarify`

1. ~~**ยังไม่เคยเห็น offer payload จริง**~~ → **Phase 0 ตอบให้** (ดูหัวข้อ Phase 0)
2. ~~**offer หมดอายุเมื่อไหร่**~~ → **Phase 0 ตอบให้ — และเป็นข้อที่ตัดสินว่า
   SC-001/002 อยู่หรือไป** ห้ามล็อก poll interval ก่อนได้ตัวเลขนี้
3. ~~**`listing_type` มีค่าอะไรบ้าง**~~ → **Phase 0 เก็บค่าจริงให้** — แต่ยังต้องถาม
   Straker ว่าแต่ละค่า*หมายความว่าอะไร* (direct PO = จองให้เราแล้วไม่ต้องแย่ง?)
4. **eligibility rule ของ Straker คืออะไร** — มาเลย์อย่างเดียวเหมือน XTM?
   หรือรับทุกคู่ภาษาใน 44 คู่ที่ลงทะเบียนไว้? กรอง `service` (translation เท่านั้น?)
   กรองราคาขั้นต่ำ (`budget` / `unit_cost`)?
5. ~~**capacity ใช้ร่วมกับ XTM หรือแยก**~~ → ✅ **ตอบแล้ว 2026-09-11: แยก ไม่ใช้ร่วม**
   - แต่ละบอทมี **SQLite ไฟล์ของตัวเอง + daily cap ของตัวเอง** — ไม่มี shared ledger
     ไม่มี cross-process transaction → **bulkhead สมบูรณ์ 100%** (ข้อนี้ทำให้ 003 ง่ายลง)
   - Straker ต้องมีค่า capacity/throughput **ชุดของตัวเอง** ใน config ไม่ใช่ใช้ค่าของ XTM
     (ตั้งเท่าไหร่เป็นการตัดสินใจของทีม — Phase 0 จะบอกว่ามี offer เข้าวันละกี่งาน
     จึงจะตั้งค่าได้อย่างมีข้อมูล)
   - ⚠️ **ผลข้างเคียงที่ต้องรู้ตัว**: ทีมแปลเป็นทีมเดียวกัน แต่เพดานแยกกัน →
     ยอดรวมที่รับได้ = XTM cap + Straker cap ซึ่งอาจเกินกำลังจริงของทีม
     **ทางแก้ที่ไม่ต้องแชร์ state**: แยก *การบังคับ* (enforcement) แต่รวม *การมองเห็น*
     (visibility) — ให้ daily report 09:00 แสดงยอดรวมทั้งสองพอร์ทัลในการ์ดเดียว
     (อ่านสอง DB แบบ read-only ตอนทำรายงาน ไม่ใช่ตอน accept) → คนเห็นแล้วปรับ cap เอง
     เริ่มด้วยการตั้ง Straker cap แบบ conservative ไว้ก่อน
6. **effort metric** — ใช้ `weighted_words` (เทียบเท่า File WWC) หรือ `words`?
   throughput ต่อชั่วโมงของทีมสำหรับงาน Straker เท่ากับ XTM ไหม
7. **Sheet layout** — tab ใหม่ในไฟล์เดิม หรือไฟล์ใหม่? คอลัมน์อะไรบ้าง
8. **Chat channel** — ใช้ webhook เดิมหรือช่องใหม่? การ์ดหน้าตายังไง
9. `POST /api/vendor/auth/exchange` คือ refresh token ใช่ไหม session อายุเท่าไหร่

---

## ความเสี่ยงที่ต้องบันทึกใน plan (Complexity Tracking / Risks)

- ℹ️ **ข้อกังวลเรื่องบัญชีตกไปหมดแล้ว** (ยืนยัน 2026-09-11) — ผู้ใช้ยืนยันว่า
  **มี offer เข้ามาแล้วจริง** ท่อรับงานทำงานปกติ. สองข้อที่ผมเคยยกเป็นความเสี่ยงตกไป:
  - `VAT PENDING` / `Profile complete 80%` → **ไม่ได้บล็อกการรับ offer**
    (ยังควรเคลียร์เพื่อเรื่องจ่ายเงิน แต่ไม่ใช่ blocker ของ 003)
  - `status_label: "Active (disengaged)"` → **ไม่ใช่สถานะบล็อก** `record_status` =
    `active`, `is_blacklisted` = false, UI แสดง `ACTIVE`; และ `language_pair_count: 0`
    เป็น false alarm (endpoint นั้นไม่ hydrate field — Dashboard แสดง 44 คู่ถูกต้อง)
- ⚠️ **ความเสี่ยงที่แท้จริงตอนนี้คือ "ไม่มีข้อมูล offer จริงเลย"** — offer เข้ามาแบบ
  ไม่สม่ำเสมอ จับจังหวะด้วยมือไม่ได้ → **Phase 0 คือ mitigation ของข้อนี้**
  ถ้าข้าม Phase 0 ไปเขียน spec เลย data model กับ poll interval จะตั้งบน assumption
  แล้วต้องรื้อทีหลัง
- ⚠️ **ToS ของ Straker เรื่อง automation ยังไม่ได้อ่าน** — ความเสี่ยงคือบัญชีโดนระงับ
  ไม่ใช่เรื่องเทคนิค ต้องอ่านหน้า Terms & conditions ในพอร์ทัลก่อนเปิด auto-accept
- ⚠️ **RTT 250ms จากกรุงเทพเป็นค่าคงที่ที่แก้ไม่ได้** (ตัดสินใจแล้วว่าไม่ย้ายที่รัน)
  → lever ที่เหลือคือ poll interval + connection warm-up เท่านั้น
  ถ้า win rate ออกมาต่ำ ต้องยอมรับว่าเพดานมาจากตรงนี้
- ⚠️ **รหัสผ่านถูกส่งผ่านช่องทางแชท** ต้อง rotate ก่อน production
- ⚠️ constitution ข้อ TDD + coverage ≥80% ใช้กับ `detection/` `state/` `reporting/`
  `schedule/` — โค้ด Straker ที่ตกอยู่ในสี่โมดูลนี้ต้องเขียน test ก่อน
- ⚠️ `/api/openapi.json` และ `/api/docs` ปิด (401) → schema ทั้งหมดเป็น
  **reverse-engineered** ไม่มี contract ที่ vendor รับรอง → ต้อง fail loud
  เมื่อ payload ไม่ตรงคาด (หลักการเดียวกับ selector หายใน XTM)
