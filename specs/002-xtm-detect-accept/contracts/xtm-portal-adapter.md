# Contract: XTM Portal Adapter (`src/portal/`)

ขอบเขต: interface เดียวที่ระบบใช้คุยกับ XTM Cloud — `detection/` ห้ามรู้จัก
Playwright โดยตรง (Constitution I). ต่อยอด `PortalClient` ของ 001 โดยเพิ่ม
ความสามารถ "กดรับงาน"

## Interface

```ts
interface XtmPortalClient extends PortalClient {
  /** login ถ้ายังไม่มี session ที่ใช้ได้; idempotent — เรียกซ้ำได้ */
  ensureLoggedIn(): Promise<void>;

  /** อ่านรายการงานใน Active ปัจจุบัน 1 ครั้ง */
  fetchJobSnapshot(): Promise<JobSnapshot>;

  /**
   * กดรับงานที่เข้าเกณฑ์ (มาเลย์) แบบ bulk ครั้งเดียว
   * - ต้องยืนยัน "สัญญาณสำเร็จ" ก่อน return accepted (ไม่เดา — FR-011)
   * - คืนผลต่อ jobKey ที่พยายามกด เพื่อให้ orchestration บันทึก lifecycle
   */
  acceptEligibleTasks(targets: AcceptTarget[]): Promise<AcceptResult[]>;

  dispose(): Promise<void>;
}

interface JobSnapshot {
  jobs: RawJob[];            // แถว Active ที่ parse สำเร็จ (ผ่าน zod)
  malformed: unknown[];      // แถวที่ parse ไม่ผ่าน → quarantine
  capturedAt: string;        // ISO +07:00
  pollCycleId: string;       // UUID ของรอบ
  emptyListConfirmed: boolean; // true เมื่อเห็น marker ตาราง + ไม่มีแถว
}

interface RawJob {
  xtmTaskId: string | null;
  projectName: string;       // ไม่ว่าง (zod enforce)
  fileName: string;          // ไม่ว่าง
  sourceLang: string | null;
  targetLang: string | null; // ใช้ตัดสิน eligibility
  dueDate: string | null;    // ISO +07:00 หรือ null
  dueRaw: string | null;
  words: number | null;
  step: string | null;
  role: string | null;
  acceptAvailable: boolean;  // ปุ่ม/เมนู Accept ยังกดได้ไหม (แยก "ยังว่าง" จาก "รับแล้ว")
}

interface AcceptTarget { jobKey: string; targetLang: string; }  // กลุ่มที่จะ bulk-accept

type AcceptResult =
  | { jobKey: string; outcome: 'accepted'; at: string }
  | { jobKey: string; outcome: 'missing' }       // โดนแย่ง/ไม่มีให้กดแล้ว
  | { jobKey: string; outcome: 'failed'; reason: string }; // ยืนยันสำเร็จไม่ได้
```

## พฤติกรรม acceptEligibleTasks (R4)

- กดผ่านเมนู `⋮` → Accept task → **"Accept all tasks for this language (Malay)
  in this group"** = 1 action ครอบ target มาเลย์ทั้งหมดที่ค้าง
- หลังกด (+ confirm dialog ถ้ามี) **ต้องตรวจสัญญาณสำเร็จที่อ่านได้** (เช่น แถว
  เปลี่ยนสถานะ/ปุ่ม Accept หาย — ยืนยันชนิดสัญญาณตอน recon D4) ภายใน timeout
  - เห็นสัญญาณ → `accepted` (+ `at`)
  - เป้าหมายหายไปก่อน/ระหว่างกด → `missing`
  - กดแล้วไม่เห็นสัญญาณ/timeout/error → `failed` (ห้าม return accepted)
- ต้อง map ผลกลับเป็นราย `jobKey` (bulk action → หลายผล) เพื่อ lifecycle ราย
  แถว; jobKey ที่อยู่ใน Active หลังกดแล้วยัง acceptAvailable=true → `failed`

## Error Taxonomy (extends `PortalError`)

| Error | เงื่อนไข | ผู้เรียกต้องทำ |
|-------|----------|----------------|
| `LoginFailedError` | company/user/pass ถูกปฏิเสธ | นับ failure → ครบ cap: lockout + system alert (FR-021) |
| `CaptchaDetectedError` | พบ CAPTCHA/2FA | หยุด + system alert — ห้าม retry อัตโนมัติ |
| `SessionExpiredError` | ถูกเด้งไป login ระหว่างทำงาน | `ensureLoggedIn()` + retry 1 ครั้งในรอบ — **re-login สำเร็จ = เงียบ ไม่ alert** (FR-021) |
| `LayoutChangedError` | marker/selector ที่คาดหาย | เก็บ evidence (อัตโนมัติ) + system alert — ห้ามเดา (Constitution VI) |
| `AcceptUnconfirmedError` | กด Accept แล้วยืนยันสำเร็จไม่ได้ | บันทึก `accept_failed` + system alert (FR-011) — ใช้ภายใน, สะท้อนเป็น AcceptResult.failed |
| `PortalTimeoutError` | operation เกิน timeout | transient → backoff |

## Behavioral Guarantees

- timeout ชัดทุก op: navigation 30s, selector wait 10s, login flow 60s,
  **accept action 15s** (กันค้างเกินหน้าต่างงาน) — ไม่มี unbounded wait
- `LayoutChangedError`, `AcceptUnconfirmedError`, และการเห็นงานจริงครั้งแรก
  (`xtm_evidence_captured_at`) เก็บ screenshot+HTML(+network ถ้าได้) ลง
  `state/evidence/` ก่อน throw/return — **sanitized** (mask ค่าฟอร์ม login,
  ตัด cookie/token/credential)
- ไม่คลิก element นอก `src/portal/selectors.ts` (รวมศูนย์ R9)
- **re-login เท่าที่จำเป็น** ไม่ re-login เชิงรุกทุกรอบ (กันเตะนักแปลหลุด —
  บัญชีแชร์ FR-021), ≤ 1 ครั้ง/รอบ
- **การอ่านทุกครั้งนับในงบ rate เดียว** (FR-027, N2): Active read + re-read หลัง
  accept (FR-024) + Closed-tab check (FR-014) ต้องผ่าน RateLimiter ตัวเดียวกัน —
  รอบที่มี accept จึงไม่ดันความถี่เกินเพดานกันแบน
- log ทุก action: outcome + latencyMs (โดยเฉพาะ accept — Constitution V/VIII);
  ไม่มี credentials/cookie ใน log
