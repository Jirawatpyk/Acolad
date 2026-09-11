# Research Note — Straker Vendor Portal (vendr.straker.ai)

**วันที่ recon**: 2026-08-25 · **วิธี**: Playwright MCP บนเครื่อง eqst-jirawat (IP ผู้ใช้จริง)
**บัญชี**: nztc@eqho.com — Shane Thompson / EQHO (`vendor_type: agency`, `vendor_pool: straker_pool`)
**ขอบเขต**: อ่านอย่างเดียว — **ไม่มีการกด accept / decline ใดๆ**

---

## 1. ข้อค้นพบหลัก (เปลี่ยนแผนสถาปัตยกรรม)

> **Straker มี REST JSON API ที่สะอาดและครบ — ไม่ต้อง scrape DOM เลย**

Frontend เป็น Nuxt SPA ที่คุยกับ backend ผ่าน `/api/**` ทั้งหมด. Adapter ของ Straker
จึงเป็น **HTTP client (fetch + cookie jar)** ไม่ใช่ Playwright scraper แบบ XTM

ผลกระทบต่อแผน:

| เดิมคิดว่า | จริง |
|---|---|
| `portal-straker` ต้องมี login/inbox/accept แบบ Playwright ~1,400 LOC | ~300–400 LOC HTTP client |
| ต้อง handle iframe / selector drift / CAPTCHA / browser recycle | **ไม่ต้องเลย** |
| poll ทุก 20s ด้วย browser (หนัก) | poll ด้วย HTTP (เบามาก, เร็วกว่าได้) |
| `PortalAdapter` SPI อาจ assume Playwright | **ห้าม assume** — SPI ต้องเป็น transport-agnostic |

**การแก้แบบสำคัญ**: `portal/browser.ts` (BrowserSession, recycle) และ `evidence.ts`
(HTML/screenshot capture) **ต้องอยู่ใน `packages/portal-xtm` ไม่ใช่ `packages/core`** —
เดิมผมวางไว้ผิด. core ควรรู้จักแค่ `fetchOffers() / accept() / readAssigned()`
ไม่รู้ว่าข้างล่างเป็น browser หรือ HTTP

---

## 2. Authentication

```
POST /api/vendor/auth/login    { login_id, password, totp_code }
GET  /api/vendor/auth/me       → { member_obj_id, name, email, vendor_pool, vendor_type,
                                    impersonated_by, onboarding_complete, terms_accepted }
POST /api/vendor/auth/logout
POST /api/vendor/auth/exchange   ← น่าจะเป็น refresh (ยังไม่ยืนยัน)
GET  /api/vendor/auth/2fa/status
```

- Session เป็น **HttpOnly cookie** (`document.cookie` เห็นแค่ `nuxt-i18n_locale`)
  → Node client ต้องมี cookie jar (`fetch` + `set-cookie` หรือ `undici` CookieAgent)
- ไม่มี CAPTCHA, ไม่มี SSO, ไม่มี iframe
- **มีระบบ 2FA (TOTP)** — ตอนนี้ปิดอยู่. ถ้าวันไหนเปิด บอทต้องมี TOTP secret
  (`login_id/password/totp_code`) → ควรใส่ config field รอไว้ตั้งแต่แรก
- **`vendorId` = `member_obj_id` จาก `/auth/me`** = `4a249411-d3a9-4057-8e95-9a5d59f8e804`
  → อย่า hardcode, อ่านจาก `/auth/me` ทุกครั้งหลัง login (เผื่อ impersonation/เปลี่ยนบัญชี)
- 401 signature error เมื่อ token ไม่ผ่าน → ใช้เป็นสัญญาณ re-login (แทน `isXtmLoggedOut`)

---

## 3. API surface ที่เกี่ยวกับบอท

ดึงจาก bundle `_nuxt/C_TkNJ2w.js` (offers composable) — ครบทั้งไฟล์:

```js
const n = e => `/api/vendors/${e}/job-offers`;
GET  n(v)                                    ?status=open      // list
GET  `${n(v)}/${offerId}`                                      // detail
POST `${n(v)}/${offerId}/accept`             // ← ACCEPT
POST `${n(v)}/${offerId}/decline`
GET  `${n(v)}/${offerId}/source-files`
GET  `${n(v)}/${offerId}/source-files/${fileId}/download`
```

อื่นๆ ที่เห็นตอน dashboard โหลด:

```
GET /api/vendors/{v}/assigned-jobs?limit=&offset=&job_status=
GET /api/vendors/{v}/assigned-jobs/{id}/files | /upload | /time
GET /api/vendors/{v}/assigned-jobs/timer-report/{id}
GET /api/vendors/{v}/language-pairs
GET /api/vendors/{v}                          // vendor profile
GET /api/vendors/{v}/audit-log | /payout-methods | /vat-verifications
GET /api/languages?page=&page_size=100        // language code → display name
```

**หมายเหตุ**: `/api/openapi.json` และ `/api/docs` → 401 (ปิดไว้) — schema ที่ได้มาจาก
bundle + payload จริงเท่านั้น

---

## 4. Data shapes

### 4.1 Job Offer

ตอน recon **มี 0 open offers** (`GET .../job-offers?status=open` → `[]`) → field list
มาจากโค้ด component `_nuxt/CST6Hz5W.js` **ยังไม่เคยเห็น payload จริง**

```ts
interface StrakerOffer {
  obj_id: string;            // ← primary key ของ offer (ใช้เป็น jobKey)
  batch_obj_id: string;
  job_ref: string;
  listing_type: string;      // เห็น "direct_po" ใน UI; ค่าอื่นยังไม่ทราบ (น่าจะ open/pool)
  source_lang: string;       // language CODE เช่น "en-us" ไม่ใช่ display name
  target_lang: string;       // "ms-my", "zh-tw", ...
  due_at: string;            // ISO UTC
  rate_type: string;         // เช่น per_word / per_hour (ใช้ทำ label)
  unit_cost: number | null;
  total_unit: number | null;
  weighted_words: number | null;   // ★ อนาล็อกตรงตัวของ File WWC ใน XTM
  words: number | null;
  budget: string;            // decimal string
  currency: string;
  source_files: File[];      // โหลดแยกจาก /source-files
}
```

### 4.2 Assigned Job (ยืนยันจาก payload จริง)

```json
{
  "obj_id": "d9e9dfbe-...", "batch_obj_id": "4d66c4d8-...",
  "external_job_id": "aj-175",
  "title": "REQ33954_doen_ULTRAFINE RWS MERINO WOOL.xlsx",
  "source_lang": "en-us", "target_lang": "zh-tw",
  "service": "translation", "words": 4,
  "budget": "35.00", "currency": "USD",
  "due_at": "2026-08-21T05:59:59.999000Z",
  "status": "delivered", "active_total_ms": 532000,
  "can_work": false, "notes": null
}
```

Response envelope: `{ items: [], total, limit, offset }` — **มี pagination** (ต่างจาก
`job-offers` ที่คืน bare array ไม่มี envelope — สอง shape ไม่เหมือนกัน ระวัง)

status ที่เห็นในโค้ด: `pending` · `assigned` · `in_progress` · `delivered` · `open`
ฟิลด์อื่นในหน้า assigned: `words_total`, `words_completed`, `po_amount`, `batch_label`,
`can_work`, `is_open`, `auto_confirmed`, `active_ms`, `idle_ms`, `session_count`

### 4.3 Language pairs ของบัญชีนี้ (44 คู่, ทั้งหมด `active`)

- **targets (27)**: ar, bn-in, en-gb, fa-ir, gu-in, hi-in, id-id, ja-jp, km-kh, ko-kr,
  lo-la, mn-mn, mr-in, **ms-my**, my-mm, ne-np, pa-guru-in, si-lk, so-so, ta-in, th-th,
  tl-ph, ur-pk, vi-vn, zh-cn, zh-hk, zh-tw
- **sources (17)**: ar, en-gb, fa-ir, gu-in, hi-in, id-id, km-kh, mr-in, ms-my, my-mm,
  si-lk, ta-in, th-th, tl-ph, ur-pk, vi-vn, zh-cn
- **services**: translation, edit, review, proofread
- คู่มาเลย์: `en-gb → ms-my`, `ar → ms-my`

---

## 5. Accept semantics (อ่านจากโค้ด ยังไม่ได้ทดสอบจริง)

```js
async function accept(offerId) {
  try { await POST(`.../job-offers/${offerId}/accept`); removeFromList(offerId); }
  catch (e) {
    if (e.status === 409) {
      toast("Offer no longer available",
            e.body?.detail ?? "This offer may have been accepted by another vendor.");
      refetchList();
    } else toast("Something went wrong", ...);
  }
}
```

**★ นี่คือ contract ที่บอทต้องการพอดี:**

| ผลลัพธ์ | ความหมาย | mapping ใน core |
|---|---|---|
| `2xx` | รับงานสำเร็จ | `acceptStatus: 'accepted'` |
| **`409`** | **มีคนอื่นรับไปแล้ว / offer หมดอายุ** | `lifecycleStatus: 'missing'` — **ไม่ใช่ error** ไม่ต้อง alert |
| อื่นๆ | error จริง | `acceptStatus: 'failed'` + system alert |

ดีกว่า XTM มาก: XTM ต้อง re-read grid หลังกด (FR-024) เพื่อรู้ว่าได้งานจริงไหม
Straker บอกตรงๆ ผ่าน status code → **ไม่ต้องมี accept-read race fix**

**accept เป็นทีละ offer (ไม่มี bulk)** → `ACCEPT_MAX_PER_CYCLE=0` (all-or-nothing bulk group)
ของ XTM **ไม่ applicable** กับ Straker. ตรงนี้เป็น per-adapter policy ไม่ใช่ค่าคงที่กลาง

---

## 6. Mapping เข้ากับ core ที่มีอยู่

| core (จาก Acolad) | Straker ใช้ยังไง | ต้องแก้ไหม |
|---|---|---|
| `diffGeneric` + `DiffAdapter` | `key = obj_id`, `hash = JSON ของ business fields` | **ใช้ได้เลย** |
| appearance model (first_seen/missing/relisted) | offer ที่หายไป = คนอื่นรับ/หมดอายุ | ใช้ได้เลย |
| `schedule/` (working hours, Thai holidays, capacity) | ใช้ได้ทั้งหมด | ใช้ได้เลย |
| `ACCEPT_EFFORT_METRIC` | `wwc` → `weighted_words`, `words` → `words` | ใช้ได้เลย ★ |
| `eligibility.isEligibleTarget` | เทียบ **language code** (`ms-my`) ไม่ใช่ display name | **แก้: ต้อง normalize ต่อ adapter** |
| outbox + dispatcher + Google Chat cards | ใช้ได้ | เปลี่ยนแค่ field ในการ์ด |
| `sheets.ts` | Sheet tab แยกของ Straker, คอลัมน์ต่างกัน | column map ต่อ adapter |
| `portal/browser.ts`, `evidence.ts`, `xtmLogin` yield policy | **Straker ไม่ใช้** | ย้ายเข้า `portal-xtm` |
| `rateLimiter` | ใช้ได้ (แต่ cap ต่างกัน — API เบากว่า browser) | config ต่อ adapter |

---

## 7. คำถามที่ยังตอบไม่ได้

> **สถานะ 2026-09-11**: ผู้ใช้ยืนยันว่า **เคยมี offer เข้ามาแล้ว** (ท่อรับงานทำงานปกติ)
> แต่จังหวะที่ recon และจังหวะที่ถามซ้ำ **ไม่มี open offer** → ข้อ 1–3 ยังค้าง
> **ข้อ 1–3 + 5 ตอบได้ด้วย Phase 0 capture probe** (ดูรายละเอียดใน
> `003-straker-feature-brief.md` หัวข้อ "Phase 0") — ไม่ต้องรอนั่งเฝ้าหน้าจอ

1. **payload จริงของ offer** — field list ทั้งหมดมาจาก bundle ยังไม่เคยเห็นของจริง
   → **Phase 0 dump ให้เป็น fixture**
2. **offer อยู่ได้นานแค่ไหน / หมดอายุเมื่อไหร่** — `OfferExpiryChip` รับ prop `dueAt`
   แล้วนับถอยหลังจาก `due_at` → แปลว่า "หมดอายุ" = deadline ของงาน? หรือมี
   `expires_at` แยกที่ยังไม่เห็น?
   **★ นี่คือตัวเลขที่สำคัญที่สุดที่ยังไม่มี** — Phase 0 วัดได้จากเวลาที่ offer โผล่
   ครั้งแรกถึงเวลาที่หายไป:
   - หายใน ~30 วินาที → เป็นการแย่งงานจริง ดีไซน์ latency-critical ทั้งชุดคุ้ม
   - อยู่เป็นชั่วโมง → **ดีไซน์ในหัวข้อ 7.5 over-engineer** poll 60s ก็พอ
     ตัด SC เรื่อง latency ออกได้
3. **`listing_type` มีค่าอะไรบ้าง** — เห็นแค่ `direct_po`. ถ้า direct PO = จองให้เราแล้ว
   (ไม่แข่งกับใคร) vs open pool = ต้องแย่ง → **เป็น input ของ eligibility rule**
   → **Phase 0 เก็บค่าจริงทุกค่าที่เจอ**
4. **`/job-offers?status=` รับค่าอะไรได้บ้าง** — `open` ใช้ได้, ค่ามั่ว → **500** (ไม่ใช่ 400)
5. `job-offers` ไม่มี pagination envelope — ถ้าวันไหน offer เยอะจะตัดที่เท่าไหร่?
6. rate limit / IP throttle ของ API — ยังไม่ทดสอบ
7. `POST /api/vendor/auth/exchange` คือ refresh token ใช่ไหม, session อายุเท่าไหร่

---

## 7.5 ★ Race design — "ใครเร็วสุดได้" (เพิ่มหลังยืนยันจากผู้ใช้)

> ⚠️ **ทุกข้อในหัวข้อนี้เป็น design ที่ยัง "รอ Phase 0 ยืนยัน"** — เรารู้ว่าเป็นระบบ
> แย่งงานจากคำยืนยันของผู้ใช้ แต่ **ยังไม่รู้ว่า offer อยู่ได้นานแค่ไหน**
> ถ้า Phase 0 วัดออกมาว่า offer อยู่เป็นชั่วโมง ข้อ 2/3/6/7 ในหัวข้อนี้
> เป็นการ optimize เกินความจำเป็น — **อย่าเขียน spec บนหัวข้อนี้ก่อนได้ตัวเลขจริง**

Job offers เป็นระบบแย่งงาน first-come-first-served → **latency น่าจะเป็น requirement หลัก**
ตัวเลขที่วัดได้จริงตอน recon:

| ตัววัด | ค่าที่วัดได้ | ที่มา |
|---|---|---|
| Rate limit | **300 req/นาที** (reset ที่ต้นนาที) | `x-ratelimit-limit: 300`, `x-ratelimit-reset` = epoch ของนาทีถัดไป |
| RTT จากกรุงเทพ | **~194–256 ms** | 6 ครั้งติดกัน, connection reuse |
| TTFB | ~300 ms | Resource Timing |
| Server | `nginx/1.27.5`, ไม่มี CDN header | response header |
| Push channel | **ไม่มีเลย** — ไม่มี WebSocket / SSE / setInterval ใน bundle | scan ทุก chunk |

### ผลที่ตามมา

**1. Frontend ของ Straker เองไม่ auto-refresh** — ไม่มี polling ไม่มี WS แปลว่า vendor
ที่เป็นมนุษย์เห็น offer ต่อเมื่อกด reload หน้า (หรือได้อีเมลแจ้ง). **บอทที่ poll ทุก 1 วินาที
ชนะมนุษย์เกือบ 100%** — คู่แข่งจริงคือบอทตัวอื่น ไม่ใช่คน

**2. Poll ได้เร็วกว่า XTM ~20 เท่า**

```
budget 300 req/min:
  poll ทุก 1s  = 60 req/min  = 20% ของ budget   ← แนะนำ
  poll ทุก 0.5s = 120 req/min = 40%
เหลือ headroom ให้ accept POST + retry + assigned-jobs sync
```

**3. Latency budget (poll 1s)**

```
offer เกิด → detect (เฉลี่ย poll/2 = 500ms) → fetch RTT 250ms
           → decide (pure function ~0ms) → accept POST RTT 250ms
           ≈ 1.0s เฉลี่ย / 1.5s worst case      (XTM ที่ poll 20s ≈ 10s เฉลี่ย)
```

**4. ★ ทุกอย่างที่ gate ต้องใช้ อยู่ใน list payload แล้ว** — `target_lang`,
`weighted_words`, `budget`, `due_at`, `listing_type` มาครบตั้งแต่ `GET ?status=open`
→ **ห้ามยิง `/{offerId}` หรือ `/source-files` ก่อน accept** (เสีย RTT ฟรี 250ms)
กติกา: **accept จาก list payload อย่างเดียว แล้วค่อย enrich ทีหลัง**

**5. Critical path ต้องสะอาด** — ระหว่าง detect → accept **ห้ามมี** SQLite write,
outbox, Sheets, Chat. persist/notify ทั้งหมดหลังได้ response แล้ว
(`XtmPollCycle` เรียง detect→decide→gate→accept→record ถูกอยู่แล้ว แต่
`claimForAccept` เป็น SQLite txn ก่อน accept — ต้องวัดว่ากินกี่ ms)

**6. Connection warm-up บังคับ** — ใช้ keep-alive agent (undici `Pool`/`Agent`, HTTP/2)
TLS handshake ใหม่ = +2 RTT ≈ +500ms = แพ้แน่นอน. และ **re-login เชิงรุกก่อน session หมด**
ไม่ใช่รอ 401 แล้วค่อย login (401 กลางการแย่งงาน = เสียรอบนั้นทั้งรอบ)

**7. ★ Server location คือ lever ที่ใหญ่ที่สุด** — RTT จากกรุงเทพ ~250ms
Straker เป็นบริษัท NZ. ถ้ารันบอทบน VPS ที่ Sydney/Auckland RTT น่าจะเหลือ ~10–30ms
→ **ประหยัด ~450ms บนเส้นทาง detect+accept (ลดเวลารวมเกือบครึ่ง)**
ในเกมแย่งงานนี่น่าจะเป็นตัวตัดสิน

> นี่คือจุดที่การออกแบบ **bulkhead / process-per-portal คุ้มทันที**:
> Straker bot ย้ายไปรันบน VPS ที่ AU/NZ ได้เลย ส่วน XTM bot ยังอยู่เครื่อง Windows
> ที่ออฟฟิศ — ถ้าเป็น process เดียวกันจะทำแบบนี้ไม่ได้
>
> **ต้องวัดก่อนตัดสินใจ**: เช่า VPS Sydney ถูกๆ แล้ว `curl` วน 20 รอบเทียบกับกรุงเทพ

**8. Rate limiter ตัวเดิมใช้ไม่ได้** — `REQUESTS_PER_HOUR_CAP=180` (= 3/นาที)
ออกแบบมาสำหรับ browser polling. Straker ต้องการ limiter แบบ **per-minute + อ่าน
`x-ratelimit-remaining` จาก response header แล้วปรับตัวเอง** → เป็น capability ใหม่ใน core

**9. 409 จะเยอะเป็นปกติ ไม่ใช่ error** — ต้องมี metric `win rate`
(offers seen / accepted / lost-409) แบบเดียวกับ `report:catch-rate` ของ XTM
เพื่อรู้ว่าปรับ poll interval หรือย้าย region แล้วดีขึ้นจริงไหม

---

## 8. ความเสี่ยง / ข้อสังเกต

- ℹ️ **แก้ข้อสังเกตเดิมเรื่อง "disengaged" (ตรวจซ้ำ 2026-08-25)** — ผมประเมินแรงเกินไป:
  - `record_status` = **`"active"`** (enum ที่ UI ใช้จริง) ส่วน `status_label` =
    `"Active (disengaged)"` มาจาก `status_obj_id` = **สถานะภายใน CRM ของ Straker**
    คนละ field กัน
  - `StatusChip` ใน bundle map `disengaged` → label `"Active (disengaged)"` **tone `teal`
    เหมือน `active` เป๊ะ** (enum ทั้งหมด: `active` `disengaged` `inactive`
    `newly_registered` `blacklisted` — ตัวที่บล็อกจริงคือ `inactive`/`blacklisted`)
  - **หน้าเว็บ vendor แสดงว่า `ACTIVE`** ไม่มีคำว่า disengaged โผล่ที่ไหนเลย
  - `language_pair_count: 0` เป็น **false alarm** — endpoint `/api/vendors/{id}`
    ไม่ hydrate field นี้ Dashboard แสดง "44 LANGUAGE PAIRS" ถูกต้อง
  - `is_blacklisted: false`
- ℹ️ **สมมติฐานเรื่อง VAT ตกไปแล้ว (ผู้ใช้ยืนยัน 2026-09-11)** — ตอน recon ผมเห็น
  Dashboard ขึ้น `Profile complete 80%` + `VAT PENDING` แล้วเดาว่าเป็นสาเหตุที่ไม่มี
  offer เข้า. **ผิด** — ผู้ใช้ยืนยันว่ามี offer เข้ามาแล้วจริง ท่อรับงานทำงานปกติ
  → `VAT PENDING` ไม่ได้บล็อกการรับ offer (แต่ยังควรเคลียร์เพื่อเรื่องจ่ายเงิน)
  → **สาเหตุที่ไม่เห็น offer ตอน recon คือจังหวะเท่านั้น** ไม่ใช่บัญชีมีปัญหา
- ⚠️ **ToS** — ยังไม่ได้อ่านหน้า Terms & conditions ในพอร์ทัล ควรอ่านก่อนเปิด auto-accept
  (ความเสี่ยงคือบัญชีโดนระงับ ไม่ใช่เรื่องเทคนิค)
- ⚠️ **credential rotation** — รหัสผ่านถูกส่งผ่านแชท ควรเปลี่ยนก่อน production
- ℹ️ ~~API ไม่มี rate-limit header ที่เห็นได้~~ **แก้แล้ว** — API **มี**
  `x-ratelimit-limit: 300` / `-remaining` / `-reset` (ดูหัวข้อ 7.5)
  → poll ได้ถึง 300 req/นาที แต่ **เริ่มที่ 10s ใน Phase 0** (6 req/นาที = 2% ของ budget)
  แล้วค่อยตัดสินใจ poll interval จริงจาก offer lifetime ที่วัดได้

---

## 9. สรุปสำหรับ `/speckit-specify`

> ขยาย Acolad เป็น microkernel + adapter: `packages/core` (schedule, diff engine, outbox,
> dispatcher, monitoring) + `packages/portal-xtm` (Playwright, ของเดิม) +
> `packages/portal-straker` (**HTTP client, ไม่ใช่ browser**). Straker adapter ทำ
> login ผ่าน `POST /api/vendor/auth/login` + cookie jar, poll
> `GET /api/vendors/{v}/job-offers?status=open`, กรองด้วย `target_lang` (language code)
> ผ่าน accept-schedule gate เดิม แล้ว `POST .../{offerId}/accept` โดยตีความ **409 =
> offer ถูกคนอื่นรับ (ไม่ใช่ error)**. Effort metric ใช้ `weighted_words`.
> log ลง Sheet tab แยก + Google Chat card แยก. Deploy เป็น PM2 app ที่ 2
> (state dir / lock port / browser profile คนละตัว).
