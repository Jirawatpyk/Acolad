# Contract: Portal Adapter (`src/portal/`)

ขอบเขต: interface เดียวที่เหลือของระบบใช้คุยกับ Acolad Partner Portal —
ตรรกะ detection ห้ามรู้จัก Playwright โดยตรง (Constitution I)

## Interface

```ts
interface PortalClient {
  /** เข้าสู่ระบบถ้ายังไม่มี session ที่ใช้ได้; idempotent เรียกซ้ำได้ */
  ensureLoggedIn(): Promise<void>;

  /** อ่านรายการงานปัจจุบัน 1 ครั้ง (refresh หน้าเดียว) */
  fetchJobSnapshot(): Promise<JobSnapshot>;

  /** ปิด browser/context อย่างสะอาด (ใช้ตอน recycle/shutdown) */
  dispose(): Promise<void>;
}

interface JobSnapshot {
  jobs: RawJob[];          // งานที่ parse สำเร็จ (ผ่าน zod แล้ว)
  malformed: unknown[];    // แถวที่ parse ไม่ผ่าน → quarantine path
  capturedAt: string;      // ISO +07:00
  pollCycleId: string;     // UUID ของรอบตรวจ
  emptyListConfirmed: boolean; // true เฉพาะเมื่อเห็น marker หน้า + ไม่มีงาน
}

interface RawJob {
  portalJobId: string | null;
  title: string;           // ไม่ว่างเสมอ (zod enforce)
  languagePair: string | null;
  deadline: string | null; // ISO +07:00 หรือ null (raw เก็บแยก)
  deadlineRaw: string | null;
  fee: string | null;
  url: string | null;
}
```

## Error Taxonomy (ทุกตัว extends `PortalError`)

| Error | เงื่อนไข | ผู้เรียกต้องทำ |
|-------|----------|----------------|
| `LoginFailedError` | credentials ถูกปฏิเสธ / ฟอร์ม login ล้มเหลว | นับ failure → ครบ 3 ครั้ง: lockout 15 นาที + system alert (FR-009) |
| `CaptchaDetectedError` | พบ CAPTCHA/2FA element | หยุดทันที + system alert — ห้าม retry อัตโนมัติ |
| `SessionExpiredError` | ถูกเด้งไปหน้า login ระหว่างอ่านงาน | เรียก `ensureLoggedIn()` แล้ว retry 1 ครั้งในรอบเดียวกัน (FR-002) |
| `LayoutChangedError` | marker/selector ที่คาดไว้หาย | เก็บ evidence (อัตโนมัติใน adapter) + system alert — ห้ามเดา (Constitution VI) |
| `PortalTimeoutError` | operation เกิน timeout | นับเป็น transient → backoff ตาม R10 |

## Behavioral Guarantees

- ทุก operation มี timeout ชัดเจน: navigation 30s, selector wait 10s,
  login ทั้ง flow 60s — ไม่มี unbounded wait (Constitution VI)
- `LayoutChangedError` และการพบงานจริงครั้งแรก (meta key
  `first_job_evidence_captured_at` — ดู data-model.md) เก็บ screenshot +
  HTML ลง `state/evidence/` ก่อน throw/return เสมอ
- Evidence ทุกชิ้นต้องถูก sanitize ก่อนบันทึกตาม FR-012: mask ค่าใน input
  ของฟอร์ม login, ตัด cookie/token/inline credential ออกจาก HTML ที่เก็บ,
  และไม่เก็บหลักฐานหน้า login ที่มีค่ากรอกค้างอยู่
- ไม่มี action ใดคลิก element ที่ไม่ได้ระบุใน selector registry
  (`src/portal/selectors.ts` — รวมศูนย์ไฟล์เดียวตาม R9)
- log ทุกครั้ง: action, outcome, latencyMs — ไม่มี credentials/cookie ใน log
  (pino redaction)
