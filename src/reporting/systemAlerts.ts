import type { DB } from '../state/db.js';
import { SystemEventStore } from '../state/systemEvents.js';
import { Outbox } from '../state/outbox.js';
import { renderSystemAlert, renderSystemRecovered, type SystemAlertFields } from './notifier.js';

export type TriggerKind =
  | 'login_failed'
  | 'captcha'
  | 'layout_changed'
  | 'pagination'
  | 'portal_down'
  | 'outbox_dead'
  | 'cold_start_repeat'
  | 'db_corrupt'
  | 'accept_failed';

interface TriggerSpec {
  severity: 'warn' | 'critical';
  title: string;
  impact: string;
  action: string;
  /** Whether this trigger emits a SYSTEM_RECOVERED when the condition clears. */
  hasRecovered: boolean;
}

/** Action text per trigger (contracts/notifications.md §4). */
const TRIGGERS: Record<TriggerKind, TriggerSpec> = {
  login_failed: {
    severity: 'critical',
    title: 'เข้าสู่ระบบไม่สำเร็จ',
    impact: 'หยุดเฝ้างานชั่วคราว (lockout)',
    action:
      'ลอง login ด้วยมือ; ถ้ารหัสผ่านเปลี่ยน แก้ XTM_ACOLAD_Password ใน .env แล้ว pm2 restart acolad-bot',
    hasRecovered: true,
  },
  captcha: {
    severity: 'critical',
    title: 'พบ CAPTCHA/การยืนยันตัวตน',
    impact: 'หยุดเฝ้างานจนกว่าคนจะผ่านขั้นยืนยัน',
    action:
      'login ด้วยมือผ่าน CAPTCHA แล้ว restart บอท; ถ้าบังคับ 2FA ถาวร ให้ทบทวน Assumption ใน spec',
    hasRecovered: true,
  },
  layout_changed: {
    severity: 'critical',
    title: 'หน้ารายการงานเปลี่ยนรูปแบบจนอ่านไม่ได้',
    impact: 'หยุดอ่านหน้ารายการงาน',
    action:
      'เปิด state/evidence ล่าสุดเทียบหน้าใหม่ อัปเดต src/portal/selectors.ts รัน npm test ผ่าน แล้ว restart',
    hasRecovered: true,
  },
  pagination: {
    severity: 'warn',
    title: 'พบตัวบ่งชี้หลายหน้า (pagination)',
    impact: 'ขอบเขตการตรวจจับอาจไม่ครบ',
    action: 'ตรวจหน้าจริง ทบทวน Assumption "หน้าเดียว" และขยายการอ่านถ้าจำเป็น',
    hasRecovered: false,
  },
  portal_down: {
    severity: 'warn',
    title: 'portal เข้าถึงไม่ได้ต่อเนื่องเกิน 10 นาที',
    impact: 'การตรวจถูกถ่วงด้วย backoff',
    action:
      'ลองเปิด portal จากเครื่องอื่น; ถ้าล่มจริงไม่ต้องทำอะไร ระบบ retry เองและจะส่ง SYSTEM_RECOVERED เมื่อกลับมา',
    hasRecovered: true,
  },
  outbox_dead: {
    severity: 'critical',
    title: 'มีข้อความแจ้งเตือนค้างส่งไม่สำเร็จ',
    impact: 'การแจ้งเตือนบางรายการไม่ถึงทีม',
    action: 'ตรวจ webhook URL/สิทธิ์ Chat space แล้วสั่ง npm run outbox:requeue',
    hasRecovered: true,
  },
  cold_start_repeat: {
    severity: 'warn',
    title: 'ฐานสถานะอาจสูญหายผิดปกติ (cold start ซ้ำใน 7 วัน)',
    impact: 'อาจมีปัญหาดิสก์/ไฟล์ฐานข้อมูล',
    action: 'ตรวจดิสก์และสาเหตุที่ไฟล์ฐานสถานะหาย ดูสำเนา .corrupt-* ถ้ามี',
    hasRecovered: false,
  },
  db_corrupt: {
    severity: 'critical',
    title: 'ฐานสถานะเสียหาย ถูกรีเซ็ตเป็น cold start',
    impact: 'ประวัติงานเดิมถูกเก็บเป็นสำเนาและเริ่มฐานใหม่',
    action: 'เก็บสำเนา .corrupt-* ไว้วิเคราะห์ และตรวจสุขภาพดิสก์',
    hasRecovered: false,
  },
  // Raised with a per-job dedup key (`accept_failed:<jobKey>`) and never auto-resolved
  // (hasRecovered:false) — so a given job alerts ONCE and a repeat failure of the SAME
  // job is intentionally deduped (avoids per-cycle spam while accept stays unconfirmed).
  // Distinct jobs still each alert. Revisit if per-incident re-alerting is ever needed.
  accept_failed: {
    severity: 'critical',
    title: 'กดรับงานไม่สำเร็จ (ยืนยันไม่ได้)',
    impact: 'งานมาเลย์ที่ควรได้อาจไม่ถูกรับ — ต้องตรวจด้วยคน',
    action:
      'เปิด state/evidence ล่าสุด + เข้า XTM ดูว่างานถูกรับไหม; ถ้าเมนู accept เปลี่ยนรูปแบบ อัปเดต src/portal/selectors.ts',
    hasRecovered: false,
  },
};

/**
 * Raise a system alert through the outbox (never sent directly — Constitution IV).
 * Deduped per trigger via the active-alert index. Returns true if a new alert
 * was enqueued (false if already active).
 */
export function raiseAlert(
  db: DB,
  outbox: Outbox,
  kind: TriggerKind,
  occurredAt: string,
  detail: string,
  extra: Partial<SystemAlertFields> = {},
  /** Override the dedup key (default = kind). Use a per-job key for incidents
   *  that recur per job (e.g. accept_failed) so distinct failures each alert. */
  dedupKey?: string,
): boolean {
  const spec = TRIGGERS[kind];
  const system = new SystemEventStore(db);
  return db.transaction(() => {
    const fields: SystemAlertFields = {
      severity: spec.severity,
      title: spec.title,
      cause: detail,
      impact: extra.impact ?? spec.impact,
      action: extra.action ?? spec.action,
      occurredAt,
    };
    const payload = JSON.stringify({ text: renderSystemAlert(fields) });
    const eventId = system.create({
      eventType: 'system_alert',
      severity: spec.severity,
      dedupKey: dedupKey ?? kind,
      payloadJson: payload,
      occurredAt,
    });
    if (!eventId) return false; // already active
    return outbox.enqueue(eventId, payload, occurredAt);
  })();
}

/** Resolve an active alert and enqueue a SYSTEM_RECOVERED if the trigger supports it. */
export function resolveAlert(
  db: DB,
  outbox: Outbox,
  kind: TriggerKind,
  occurredAt: string,
  downDuration: string,
): boolean {
  const spec = TRIGGERS[kind];
  const system = new SystemEventStore(db);
  return db.transaction(() => {
    const resolvedId = system.resolve(kind, occurredAt);
    if (!resolvedId) return false;
    if (!spec.hasRecovered) return false;
    const text = renderSystemRecovered(spec.title, downDuration, occurredAt);
    const sysId = system.create({
      eventType: 'system_recovered',
      severity: 'info',
      dedupKey: `${kind}:recovered:${occurredAt}`,
      payloadJson: JSON.stringify({ text }),
      occurredAt,
    });
    if (!sysId) return false;
    return outbox.enqueue(sysId, JSON.stringify({ text }), occurredAt);
  })();
}

export { TRIGGERS };
