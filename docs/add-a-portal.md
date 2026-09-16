# Runbook — เพิ่มพอร์ทัลที่สาม

> **นี่คืออะไร**: checklist ที่ ADR-001 / FR-031 ส่งมอบ **แทน** portal abstraction
> (ไม่มี plug-in registry, ไม่มี shared portal interface). เหตุผล: สองพอร์ทัลยังไม่พอ
> จะรู้ว่า seam ที่ถูกอยู่ตรงไหน และ abstraction ที่ผิดแพงกว่าไฟล์ที่ซ้ำกัน
>
> **นี่ไม่ใช่**: เอกสารสถาปัตยกรรม. อ่านแล้วต้องลงมือได้เลย — ถ้าตรงไหนอ่านแล้ว
> ยังไม่รู้จะพิมพ์อะไร ตรงนั้นคือ bug ของเอกสาร
>
> **เขียนจากของจริง**: ทุกข้อในเอกสารนี้มาจากสิ่งที่การสร้าง Straker (feature 003)
> เสียไปจริง — ไม่ใช่จากสิ่งที่ควรจะเป็น. ดู `git log main..` ของ branch
> `feat/003-straker-phase0-probe` ถ้าอยากเห็นต้นเรื่องแต่ละข้อ

---

## 0. ทะเบียนที่ต้องจองก่อนพิมพ์โค้ดบรรทัดแรก

พอร์ทัลใหม่ชนกับของเดิม **ในวันแรก** อยู่ 2 เรื่อง คือ **port** กับ **state directory**
เพราะ config loader ปฏิเสธค่าที่ชนโดยระบุชื่อตัวแปรตรงๆ (`src/straker/config.ts`
`superRefine`) — ไม่ใช่ปล่อยไปพังตอน runtime. ค่าที่ถูกจองไปแล้ว:

| | XTM (`acolad-bot`) | Straker (`jobcatch-straker`) | พอร์ทัลถัดไป |
|---|---|---|---|
| single-instance port | **47811** | **47812** | **47813** (ค่าถัดไปของทะเบียนนี้) |
| state directory | `state/` | `state/straker/` | `state/<ชื่อ>/` |
| PM2 app name | `acolad-bot` | `jobcatch-straker` | `jobcatch-<ชื่อ>` |
| PM2 config file | `ecosystem.config.cjs` | `straker.config.cjs` | `<ชื่อ>.config.cjs` (ต้องลงท้าย `.config.cjs`) |
| log base name | `acolad` (`src/monitoring/logger.ts`) | `STRAKER_LOG_NAME` (`src/straker/logger.ts`) | ของตัวเอง |
| log glob ที่ deploy ใช้ verify | `logs/acolad.*.log` | `logs/jobcatch-straker.*.log` | ของตัวเอง |
| deploy target | `npm run deploy` | `npm run deploy -- -Target straker` | เพิ่มใน `$Bots` ของ `scripts/deploy.ps1` |
| entry guard env | (import ไม่ได้เลย) | `STRAKER_BOT_ENTRY=1` | ของตัวเอง |

**หนึ่ง port ต้องแก้ 3 ที่ และไม่มีอันไหนอ่านจากอีกอันได้:**

1. `default` ใน zod schema ของ config พอร์ทัลใหม่
2. `.env` (ถ้าจะ override) + `.env.example` (ค่า placeholder)
3. ตาราง `$Bots` ใน `scripts/deploy.ps1` — **สคริปต์นี้ไม่อ่าน `.env` โดยตั้งใจ**
   (เขียนไว้ในหัวไฟล์) ค่าจึงถูก keep in sync ด้วยมือ

### ⚠️ กับดักที่คุณจะเจอถ้า copy `config.ts` มาตรงๆ

`src/straker/config.ts` กันการชนด้วยค่าคงที่ **สองตัว** ที่รู้จักแค่ XTM:

```ts
const XTM_SINGLE_INSTANCE_PORT = 47811;
const XTM_STATE_DIR = 'state';
```

copy ไฟล์นี้ไปเป็นพอร์ทัลที่สาม แล้ว guard ของคุณจะ **ตาบอดต่อ 47812 และ
`state/straker`** — คือกันพอร์ทัลที่คุณไม่ได้จะชนอยู่แล้ว และไม่กันอันที่จะชนจริง

และต้องรู้ด้วยว่า **`src/config/index.ts` (XTM) ไม่มี guard นี้เลย** —
`SINGLE_INSTANCE_PORT` กับ `STATE_DIR` เป็น default เฉยๆ ไม่มีการตรวจการชน. ทะเบียน
ถูกบังคับจากฝั่งบอทใหม่ฝั่งเดียวเสมอ ซึ่งแปลว่า **พอร์ทัลที่สามเป็นคนเดียวที่ต้องรู้จัก
อีกสองตัว** และถ้า Straker แก้ค่าตัวเองในอนาคต ไม่มีอะไรมาเตือน

ตอนเพิ่มพอร์ทัลที่สาม ให้เปลี่ยนสองค่านี้เป็น **ลิสต์ของทุกพอร์ทัลที่มีอยู่** และไป
เพิ่ม 47813 / `state/<ชื่อ>` เข้า guard ของ Straker ด้วย (สองไฟล์ ไม่ใช่ไฟล์เดียว).
นี่คือจุดแรกที่ "ทะเบียนที่เป็นเอกสาร" ไม่พออีกต่อไป และควรกลายเป็น constant ร่วม
จริงๆ — ดูข้อ 7

**อีกเรื่อง**: `.gitignore` กัน `/state/` แบบ root-anchored อยู่แล้ว ดังนั้น
`state/<ชื่อ>/` ปลอดภัยโดยอัตโนมัติ. ถ้าคุณเลือก state dir **นอก** `state/`
คุณต้องเพิ่ม `.gitignore` เอง ไม่งั้น database จะขึ้น git

---

## 1. ลำดับงาน

ลำดับนี้ไม่ใช่รสนิยม — มันเรียงตาม "อะไรที่พังแล้วเจ็บที่สุด" และตรงกับลำดับที่ 003
เดินจริง (Phase 1→6)

1. **Isolation ก่อนอย่างอื่นทั้งหมด.** PM2 app ของตัวเอง, port ของตัวเอง, state dir
   ของตัวเอง, logger ของตัวเอง, heartbeat/liveness ของตัวเอง, `-Target` ใน
   `deploy.ps1`. ยังไม่ต้องมีโค้ดที่ทำอะไรได้เลยก็ทำข้อนี้ได้ และต้องทำก่อน
   เพราะมันคือสิ่งเดียวที่รับประกันว่าบอทตัวใหม่พังแล้วตัวเก่าไม่ล้ม
2. **Config loader แยกไฟล์** — **ห้าม** เพิ่ม required var เข้า `src/config/index.ts`
   เด็ดขาด: schema นั้น fail-fast ให้บอท XTM ที่ live อยู่ วินาทีที่คุณ merge
   บอทที่รันอยู่จะตายทันที
3. **Store ของตัวเอง** — database file คนละไฟล์ ไม่มีตารางชื่อซ้ำ ไม่มี transaction ร่วม
4. **Transport ไฟล์เดียว** (DC-4) — connection, cookie, header, timeout, backoff,
   budget pacing อยู่ในไฟล์นั้นไฟล์เดียว
5. **Read path + shape guard** — อ่าน list งานที่เปิดอยู่ แล้ว **fail loud** ถ้า payload
   เปลี่ยนรูป (ดูข้อ 4.5 "ศูนย์ที่เงียบ")
6. **Parse + eligibility** — จาก fixture ของจริงเท่านั้น ไม่ใช่จากรายชื่อ field ใน
   recon note
7. **Decision + scheduling gate** — เรียก `evaluateAcceptSchedule` ของเดิม **ไม่แก้**
   ให้เพดาน/throughput เป็นของพอร์ทัลใหม่เอง
8. **Claim/accept path** — irreversible; อ่านข้อ 4.6 ก่อนเขียนบรรทัดแรก
9. **Reporting + reconciliation + combined view** — outbox → dispatcher → sender,
   แล้วค่อยเทียบ record ของเรากับ portal

> ระหว่างทาง: ทุกครั้งที่สร้าง capability ใหม่ ให้ทำข้อ 4.1 **ในคอมมิตเดียวกัน**

---

## 2. คัดลอก / reuse / เขียนใหม่

หลังสองพอร์ทัล นี่คือคำตอบที่มีหลักฐาน — **ข้อเท็จจริงที่มีประโยชน์ที่สุดในเอกสารนี้
คือ `src/shared/` เล็กแค่ไหน**: หลังจากสร้างบอทเต็มตัวที่สอง มีของที่พิสูจน์แล้วว่า
generic จริงอยู่ **3 ไฟล์** เท่านั้น

### reuse ตรงๆ (import ได้เลย ห้าม copy)

| โมดูล | ให้อะไร |
|---|---|
| `src/shared/outboxRetry.ts` | ตารางเวลา retry ของ outbox + เมื่อไหร่เลิกลอง (pure, ไม่รู้จัก SQLite) |
| `src/shared/sqliteOpen.ts` | ลำดับ open → WAL → migrate → quarantine (ลำดับคือความปลอดภัย) |
| `src/shared/rollingLogger.ts` | rotation 14 วัน + censor key + flush cap ตอน shutdown |
| `src/schedule/**` | gate ทั้งหมด: `evaluateAcceptSchedule`, `workingMinutesBetween`, `bangkokCalendar`, `deadlineDay`, `thaiHolidays*`, `resolveThroughput`, `effort.ts` (`WORDS_UNIT`/`WWC_UNIT`/`unitOf`) |
| `src/monitoring/heartbeat.ts`, `src/monitoring/logger.ts` (`Logger` type) | liveness ping + logger interface |
| `src/runtime/singleInstance.ts` | port lock |
| `src/reporting/googleChat.ts`, `chatCard.ts`, `cardText.ts`, `dateFormat.ts` | cardsV2 builder + วันที่แบบ Bangkok |

### copy แล้วแก้ (โครงเหมือน เนื้อในต่าง)

| ไฟล์ Straker | คู่ของ XTM | หมายเหตุ |
|---|---|---|
| `src/straker/config.ts` | `src/config/index.ts` | copy โครง — แต่ดูกับดักในข้อ 0 |
| `src/straker/main.ts` | `src/runtime/main.ts` + `bootstrap.ts` | copy **แบบ Straker** ไม่ใช่แบบ XTM (ดูข้อ 4.2) |
| `src/straker/pollCycle.ts` | `src/runtime/xtmPollCycle.ts` | ชื่อ step ต้องเหมือนกัน (DC-3) |
| `src/straker/strakerStore.ts` | `src/state/xtmJobStore.ts` + `db.ts` | schema เป็นของตัวเอง, ใช้ `sqliteOpen` ร่วม |
| `src/straker/outbox.ts` | `src/state/outbox.ts` | policy มาจาก `shared/outboxRetry.ts` |
| `src/straker/dispatcher.ts` | `src/reporting/dispatcher.ts` | channel → sender |
| `src/straker/notifier.ts` | `src/reporting/xtmNotifier.ts` + `systemAlerts.ts` | การ์ด EN |
| `src/straker/trackingSink.ts` | `src/reporting/sheets.ts` | sheet คนละไฟล์, ตรวจ layout ก่อน**ทุก**การเขียน |
| `src/straker/ledger.ts` | `src/schedule/acceptCapacity.ts` + held list | เพดานได้มาจาก held work ไม่ใช่ counter |
| `src/straker/logger.ts` | `src/monitoring/logger.ts` | redact ค่า secret ของตัวเอง |
| `src/straker/offerTracker.ts` | `src/detection/diff.ts` (`diffGeneric`) | pure transition owner |

### เขียนใหม่ทั้งหมด (ของพอร์ทัลนั้นจริงๆ)

`httpClient.ts` (หรือ Playwright client), `session.ts`, `offersApi.ts`,
`offerParse.ts`, `eligibility.ts`, `claim.ts`, `claimOutcome.ts`, `reconcile.ts`

### ไม่มีอะไรร่วมกันเลย

state, transaction, ledger, outbox row, database file, port, heartbeat URL —
**bulkhead คือจุดขายของโครงนี้** ห้ามทำ shared ledger แม้จะเห็นว่าสองเพดานบวกกัน
เกินกำลังทีมจริง (ทางออกคือ combined **view** ไม่ใช่ shared **state** — ดู
`src/straker/combinedSummary.ts`)

---

## 3. กฎ 4 ข้อที่ต้องรักษา (DC-1..DC-4 / FR-027..FR-030)

กฎพวกนี้มีไว้เพื่อให้วันที่ตัดสินใจทำ abstraction จริง มันเป็นงาน **เชิงกล**
ไม่ใช่ redesign. พอร์ทัลที่สามคือวันที่กฎพวกนี้ถูกทดสอบจริง

| | กฎ | แปลเป็นโค้ด |
|---|---|---|
| **DC-1** | แปลศัพท์ของพอร์ทัลที่ขอบ | ห้ามมี HTTP status / result code ของพอร์ทัลหลุดเข้า decision หรือ orchestration. ตัวอย่างที่เคยหลุดจริง: `pollCycle` เคยอ่าน `err.status === 401` เอง → ย้ายไปเป็น `isSessionExpired()` ใน transport |
| **DC-2** | คำเดียวกัน ความหมายเดียวกัน ทุกพอร์ทัล | offer sighting / claim outcome / unit of effort / gate decision. Straker บังคับด้วย **type** ไม่ใช่ comment: `XTM_ACCEPT_OUTCOME_OF` ใน `src/straker/outcomePolicy.ts` ทำให้ `npm run typecheck` **พัง** ถ้า XTM เพิ่ม outcome ใหม่แล้วไม่มีใครมาแก้ตาราง — copy กลไกนี้ |
| **DC-3** | loop ใช้ชื่อ step ชุดเดียวกัน | **fetch → diff → gate → act → persist → notify**. และ log line ที่บอกว่ารอบจบคือ `"action":"cycle","outcome":"ok"` เหมือนกันทั้งสองบอท — `deploy.ps1` ใช้บรรทัดนี้เป็นหลักฐานว่า deploy สำเร็จ |
| **DC-4** | ทุกอย่างที่ยิง request หรือกำหนดจังหวะ อยู่ไฟล์เดียว | connection + reuse, cookie, header, timeout, backoff, budget pacing. **rate limiter ห้ามแยกไฟล์** — 003 เคยวางแผนแยกแล้วถูกตีกลับในรอบ analyze. policy ตัวเลขอยู่ใน config ได้ แต่ code ที่ยิงหรือหน่วงต้องอยู่ในไฟล์ transport |

---

## 4. ของแพงที่ 003 จ่ายไปแล้ว — อย่าจ่ายซ้ำ

### 4.1 capability ที่สร้างเสร็จแล้ว "ไม่มีใครเรียก" — เกิด **4 ครั้ง** ใน feature เดียว

ทั้ง 4 ครั้งผ่าน test ผ่าน typecheck และถูกประกาศว่าพร้อม production ทั้งที่
โค้ดนั้นไปไม่ถึง runtime:

1. **FR-019b backoff** — `getJsonWithBackoff` มีอยู่ แต่ `listOpenOffers` อ่านผ่าน
   `getJson` (ยิงครั้งเดียว) → พอร์ทัลล่มก็อ่านซ้ำที่จังหวะปกติ, alert
   `read_retries_exhausted` ยิงไม่ได้เลย
2. **request timeout (Constitution VI)** — เกือบซ้ำรอยเดิมเป๊ะๆ: มี `timeoutMs`
   ที่ `attempt()` แต่ composition root ไม่ส่งลงไป
3. **`main()` ไม่ถูก assert โดยอะไรเลย** — reviewer พิสูจน์ว่าเปลี่ยน
   `extractOffers` เป็น `() => []` และเปลี่ยนเพดาน ledger เป็น `999_999` แล้ว
   suite ยังเขียว tsc ยังสะอาด
4. **outbox ไม่มีใคร drain** — sender กับ card builder ครบหมด แต่ไม่มี dispatcher
   เส้นทางส่งทั้งเส้นเกือบ ship แบบส่งอะไรไม่ได้เลย

**สาเหตุร่วม**: เวลาแบ่งงานเป็น "ไฟล์ละคน" **call site ระหว่างสองไฟล์ไม่มีเจ้าของ**
ทุกคนทำไฟล์ตัวเองครบ และไม่มีใครเป็นคนต่อสาย

**ทำอย่างนี้แทน**: (ก) มอบหมาย call site เป็นงานชิ้นหนึ่งโดยตรง ไม่ใช่ผลพลอยได้;
(ข) เขียน test ที่ assert **สายไฟ** ไม่ใช่ capability — แบบ
`tests/integration/straker/botWiring.test.ts` ที่ถามว่า "read วิ่งผ่านประตูไหน" และ
"composition root ส่ง `AbortSignal` จริงถึง `fetch` ไหม"; (ค) ใช้ mutation test:
ลบสายไฟออกแล้วต้องมี test แดง ถ้าไม่แดง แปลว่ายังไม่มีใคร assert มัน

### 4.2 composition root ต้องเป็น "ฟังก์ชันที่ return ค่า" ไม่งั้นทดสอบอะไรไม่ได้เลย

`src/runtime/main.ts` (XTM) ทำงาน **ตอน import** → ไม่มี test แตะได้เลย นั่นคือเหตุผล
ที่ข้อ 4.1(3) เกิดขึ้นได้

แบบที่ถูกอยู่ใน `src/straker/main.ts`:

- `assembleStrakerBot(cfg, logger, deps): StrakerAssembly` — การประกอบทั้งหมดเป็น
  **ค่า** ที่ return ออกมา รับ dependency แบบ inject ได้ (production ไม่ส่งอะไรเลย)
- `startStrakerBot(deps): StrakerBotHandle` — `runOnce()` / `run()` / `stop()`
- entry ระดับโมดูลถูกล้อมด้วย `if (process.env.STRAKER_BOT_ENTRY === '1')` และ
  PM2 config เป็นที่เดียวที่ตั้ง flag นี้ → test import ไฟล์ได้โดยไม่มีบอทโผล่ขึ้นมา

ถ้าทำแบบนี้ตั้งแต่แรก ข้อ 4.1(3) จะไม่มีทางเกิด

### 4.3 คำศัพท์ = DB CHECK constraint การเพิ่มคำหนึ่งคำคือการเปลี่ยน schema

`SKIP_REASONS`, `CLAIM_OUTCOMES`, `OFFER_EVENT_TYPES`, outbox `channel`/`status`
อยู่ใน `src/straker/outcomePolicy.ts` / `outbox.ts` และถูก **render เป็น SQL CHECK**
โดย `VOCABULARY_CHECKS` + `ddl()` ใน `strakerStore.ts`

SQLite **แก้ CHECK ในที่เดิมไม่ได้** และ `CREATE TABLE IF NOT EXISTS` ปล่อยตารางเก่าไว้
ตามเดิม แปลว่า:

> เพิ่ม skip reason ใหม่ → fresh database ผ่านหมด, test เขียวหมด, แล้วไปพังที่
> **database เครื่อง production เครื่องเดียวที่สำคัญ** ตอน INSERT แรก — พังอยู่ข้างใน
> transaction ที่แชร์กับการบันทึก state จึง rollback การบันทึกนั้นไปด้วย

ตัวกันคือ `assertVocabularyCovered()` ที่รันตอน migrate: อ่าน `sqlite_master` จริง แล้ว
throw `StrakerSchemaError` พร้อมชื่อค่าที่ขาด. **พอร์ทัลใหม่ต้อง copy กลไกนี้** และ
ตารางใหม่ที่มี vocabulary CHECK ต้องเพิ่มเข้า `VOCABULARY_CHECKS` ด้วย —
ตารางที่ไม่อยู่ในนั้น ตัวตรวจไม่มีอะไรจะพูดถึงมันเลย

เวลาจะเพิ่มคำใหม่: เพิ่มในลิสต์ → เตรียม rebuild ตาราง (SQLite alter CHECK ไม่ได้) →
และเช็คด้วยว่าปลายทางรู้จักคำนั้นไหม — 003 เคยเพิ่ม alert condition `reconcile_failing`
แล้ว `notifier.ts` ไม่มีการ์ดให้ ผลคือ alert ถูก enqueue → ถูกปฏิเสธ → retry →
dead-letter คือ **สองฝั่งเขียว แต่ตรงรอยต่อพัง**

### 4.4 หน่วยวัด effort ต้องตรงกันทุกพอร์ทัล ไม่งั้นยอดรวมคือตัวเลขผิดที่ดูน่าเชื่อ

XTM สลับ metric ได้ (`ACCEPT_EFFORT_METRIC` = `wwc` | `words`) ส่วน Straker เป็น raw
words เสมอ (`STRAKER_EFFORT_UNIT = WORDS_UNIT`). `combinedSummary.ts` จึง **ปฏิเสธที่จะ
บวก** เมื่อหน่วยไม่ตรง — คืน `withheld: 'unlike_units'` พร้อมเหตุผล ไม่ใช่คืนตัวเลข
nullable ที่ caller อาจเผลอพิมพ์ออกไป

พอร์ทัลใหม่ต้องประกาศหน่วยของตัวเองผ่าน `EffortUnit` จาก `src/schedule/effort.ts`
(`WORDS_UNIT` / `WWC_UNIT` / `unitOf(metric)`) — **ห้ามประกาศ `{ adj, noun }` เอง**
และต้องเข้ากฎเดียวกัน: ทุกพอร์ทัลอ่านได้ครบ **และ** หน่วยตรงกัน จึงจะแสดงยอดรวมได้
อย่างอื่นทั้งหมด = แสดงเป็นรายพอร์ทัล + บอกตรงๆ ว่าทำไมไม่มียอดรวม

เหตุผลที่เข้มขนาดนี้: combined view คือ **ข้อแลกเปลี่ยน** ที่ทำให้ยอมรับได้ว่าสอง
ledger แยกกันบวกเกินกำลังทีม — ตัวเลขรวมที่ผิดจึงแย่กว่าการไม่มีตัวเลขรวม

### 4.5 "ศูนย์ที่เงียบ" — read ที่ล้มเหลวต้องไม่มีทางดูเหมือนลิสต์ว่าง

XTM เคยรายงานว่าไม่มีงาน 38 นาที / 114 รอบ ทั้งที่มีงานจริงรออยู่ (กลไกคือ DOM race
ใน grid ไม่ใช่ error) — บทเรียนที่ยกมาใช้ได้กับทุกพอร์ทัลคือ **ศูนย์เป็นคำตอบเดียวที่
หน้าตาเหมือนกันเป๊ะ ไม่ว่ามันจะจริงหรือแปลว่ามองไม่เห็น**: ไม่มี exception ไม่มี log
ไม่มี heartbeat แดง

ที่ Straker ทำ (copy ได้): `offersApi.ts` ตรวจว่า reply ยังเป็น bare array จริงไหม และ
ทุก entry มี `obj_id` — ถ้าไม่ **throw** พร้อมข้อความว่า "refusing to read it as zero
offers"; `getJsonWithBackoff` ไม่ resolve เป็นลิสต์ว่างตอนล้มเหลวเด็ดขาด; และ read ที่
ล้มเหลว **ห้าม** ทำให้ offer ที่ยังอยู่ถูก mark ว่าหายไป

### 4.6 การกดรับเป็นสิ่งที่ย้อนกลับไม่ได้ — ออกแบบจากข้อนี้ข้อเดียว

- **หนึ่ง request เท่านั้น ตลอดกาล** ไม่มี retry ไม่มี "ลองใหม่รอบหน้า" — ที่ Straker
  บังคับด้วย type: `ClaimDoor` มีเมธอดเดียวคือ `postJson` และ retry loop เป็นคนละ
  ประตู. `poll interval` ก็นับเป็น "interval" ด้วย: ต้องอ่าน claim event เก่าจาก store
  แล้วข้าม offer ที่เคยยิงไปแล้ว ไม่งั้นผลลัพธ์ `unknown` จะถูกยิงซ้ำทุก 10 วินาที
- **ผลลัพธ์ที่ไม่รู้ ปล่อยให้ไม่รู้** แล้วให้ reconciliation เทียบกับพอร์ทัลเป็นคน
  ปิดบัญชี — อย่าถามพอร์ทัลซ้ำ
- **ห้าม enquire ก่อน claim** (FR-002): narrow type ของ dependency ให้ทำอย่างอื่นไม่ได้
  แทนที่จะเขียน comment ห้ามไว้
- **แยก "session หมดอายุ" ออกจาก "บัญชีถูกแบน"** — มาถึงหน้าตาเหมือนกัน แต่ถ้าเหมารวม
  จะกลายเป็น sign-in storm ใส่พอร์ทัลที่บอกว่าไม่แล้ว
- **offer ที่รอบนั้นหยุดกลางคัน ต้องมี row** ไม่งั้นมันหายเงียบทุกรอบตลอดที่บล็อกอยู่
  (`claiming_halted`)
- **claim ครั้งแรกของจริง ทำครั้งเดียว มีคนดู** (RP-4) — จนกว่าจะถึงตอนนั้น
  "สัญญาณว่าแพ้การแข่ง" ต้องเป็นลิสต์ว่าง แล้วให้ทุก rejection นับเป็น fault: outcome
  ที่ **ไม่เคย alert** คือ outcome ที่เดาผิดแล้วเจ็บที่สุด

### 4.7 เรื่องเล็กที่กัดจริง

- **`.env` บรรทัดว่าง ≠ ไม่ได้ตั้งค่า**: dotenv แปลง `KEY=` เป็น `''` ซึ่ง zod
  `.optional()` / `.default()` ไม่ถือว่า absent และ `z.coerce.number()` แปลงเป็น `0`
  → แก้ครั้งเดียวที่ขอบ parse (`stripBlanks` ใน `src/straker/config.ts`) ไม่ใช่ไล่
  wrap ทีละ field
- **ค่าที่เป็นข้อผูกพัน ห้ามมี default**: เพดานงานต่อวันเป็น required ไม่มี default —
  บอทจึงสตาร์ทไม่ได้จนกว่าจะมีคนเลือกตัวเลข เพดานที่โค้ดเดาให้คือข้อผูกพันที่ไม่มีใคร
  ตกลงด้วย
- **coverage gate**: เพิ่มชื่อโฟลเดอร์ใหม่เข้า `GATED_AREAS` ใน `vitest.config.ts` —
  ถ้าไม่เพิ่ม โค้ด decision/state ของบอทใหม่จะไม่ถูก gate เลยโดยเงียบๆ. และระวัง
  **glob บน Windows**: `src/<dir>/**` เดี่ยวๆ match ไม่ติดบนเครื่อง Windows (vitest
  เทียบกับ `path.relative` ที่ให้ backslash) และ threshold group ที่ match ไม่ติด
  **รายงาน 100% แล้วผ่าน** — ดูฟังก์ชัน `areaGlob()` ที่เขียน backslash ไว้ทั้งสองแบบ
- **ห้ามมี global threshold**: ตัวเลขรวมทำให้ area ที่ coverage ต่ำถูกอุ้มโดย area อื่น
  (Straker เคยอยู่ 79.93% ขณะที่ตัวเลขรวม 89.45% และไม่มีอะไรแดง) และยังผูกให้บอท
  ใหม่ทำ gate ของบอทเก่าพังได้ด้วย — กลุ่มละ area ต่อหนึ่ง threshold เท่านั้น
- **PM2 บน Windows ไม่ส่งสัญญาณหยุด**: SIGINT/SIGTERM ไปไม่ถึง process และ
  `--shutdown-with-message` ไม่มีใน PM2 7 → `stop()` ไม่ถูกเรียก. หลักฐานว่า instance
  เดียวจริงคือ **port lock** ไม่ใช่ shutdown handler; และอย่าพึ่ง log บรรทัดสุดท้าย
- **`deploy.ps1` ต้องเป็น ASCII ล้วน** (PowerShell 5.1 อ่านเป็น ANSI codepage —
  em-dash ตัวเดียวทำ parse พัง)
- **bulkhead guard เป็นการอ่าน source text รายไฟล์** ไม่ใช่กฎระดับโฟลเดอร์: ตอนนี้มีที่
  `strakerStore.ts`, `ledger.ts`, `outbox.ts`, `combinedSummary.ts` เท่านั้น. ถ้าเขียน
  guard เอง ให้ match specifier ทุกการสะกด (`../state/db.js` กับ
  `../../src/state/db.js` คืออันเดียวกัน) — guard ที่รู้จักแบบเดียวรายงานเขียวโดย
  ไม่ได้ตรวจอะไรเลย

---

## 5. ความลับ

- ค่าจริงอยู่ใน **`.env` เท่านั้น** (gitignored) และ `google-credentials.json`
  (gitignored) — `.env.example` ใส่ได้แค่ placeholder/รูปแบบ ห้ามใส่ค่าจริง
  เพราะไฟล์นั้น **ไม่ได้** ถูก gitignore
- credential, webhook URL, heartbeat ping URL, session cookie / storage state ทั้งหมด
  เป็นความลับระดับเดียวกับรหัสผ่าน — ต้องเข้า redaction list ของ logger ตั้งแต่วันแรก
  (Straker ประกาศไว้ที่ `strakerSecretValues()` และ wrap ที่ call site)
- ห้ามให้ repo อยู่ใต้ Google Drive / OneDrive sync — `.gitignore` ไม่กัน cloud sync
- **สอง bot ใช้ webhook แจ้งเตือน (`GOOGLE_CHAT_WEBHOOK_SYSTEM`) และ service-account key
  ตัวเดียวกันโดยตั้งใจ** — on-call ดูที่เดียว และเครื่องเดียวมี key เดียว. สิ่งที่ต้อง
  **แยก** คือ: channel ประกาศงาน, sheet/tracking file, liveness ping URL, credential
  ของพอร์ทัลเอง

---

## 6. ก่อนบอกว่าเสร็จ

```powershell
npm run lint            # 0 error
npm run typecheck       # strict
npm test                # fixtures เท่านั้น
npm run test:coverage   # ทุก area group เขียว รวม area ใหม่ของคุณ
```

แล้วเช็คด้วยตา:

- [ ] `npm run deploy` เปล่าๆ ยังคง release แค่ XTM และ **ไม่แตะ** บอทอื่นเลย
- [ ] restart บอทใหม่ แล้ว uptime / restart count ของอีกสองตัวไม่ขยับ
- [ ] ฆ่าบอทใหม่ → alert ระบุชื่อพอร์ทัล และบอทอื่นยังวิ่ง
- [ ] ปิด sign-in ของบอทใหม่ → ไม่มีอะไรกระเทือนบอทอื่น
- [ ] test ทุกตัวที่เคยมี ยังอยู่ครบและยังเขียว (จำนวนที่ *เพิ่ม* คืองานใหม่
      จำนวนที่ *หาย* คือ regression)
- [ ] live-portal test อยู่หลัง `LIVE_PORTAL=1` และไม่รันใน CI
      (`.github/workflows/ci.yml` ไม่เคยตั้งตัวแปรนี้ — อย่าไปตั้ง)
- [ ] failure-mode suite ครบ: login fail, session expiry, timeout, payload พัง,
      ปลายทางรายงานล่ม, restart กลางรอบ
- [ ] ก่อนกดรับของจริงครั้งแรก: หมุนรหัสผ่าน, อ่านเงื่อนไขการใช้บอทของพอร์ทัล
      **แล้วเขียนข้อสรุปลงไฟล์** (ชื่อคน + วันที่ + ข้อสรุป), เก็บ baseline ของบอทเดิม
      ไว้เทียบ, และกดรับครั้งแรกโดยมีคนดูอยู่

---

## 7. เมื่อไหร่ควรเลิกใช้ runbook นี้แล้วทำ abstraction จริง

ADR-001 เลื่อนการสกัด `packages/core` ไว้ พร้อม trigger ที่เขียนไว้ชัด — เลื่อนที่ไม่มี
trigger จะกลายเป็นการตัดสินใจถาวรที่ไม่มีใครเคยตัดสิน. **เปิดเรื่องใหม่เมื่อ:**

- มีพอร์ทัลที่สามถูกเสนอ (— คุณอยู่ตรงนี้แล้วถ้ากำลังอ่านบรรทัดนี้)
- ความซ้ำระหว่างบอทโตเกินกว่าที่ DC-3 จะทำให้อ่านเทียบกันรู้เรื่องในพริบตา
- feature 004 เริ่ม

สัญญาณเชิงรูปธรรมที่สุดว่าถึงเวลาแล้ว คือ **ทะเบียนในข้อ 0**: วินาทีที่ port กับ state
directory ต้องถูกกันการชนจาก **สาม** ที่ (และ `config.ts` ของแต่ละบอทต้องรู้จักอีกสอง
ตัว) ทะเบียนที่เป็นเอกสารไม่พออีกต่อไป — มันควรเป็น constant ร่วมหนึ่งชุดที่ทุก config
อ่านจากที่เดียว. นั่นคือ abstraction ชิ้นแรกที่มีหลักฐานรองรับจริง และเป็นชิ้นที่ควร
ทำก่อนเพื่อนๆ ของมัน

---

**อ้างอิง**: `specs/003-straker-offer-race/` (spec FR-024..FR-031, plan §Scope decision
+ Complexity Tracking, quickstart V1–V33), `.specify/memory/constitution.md`, `CLAUDE.md`
