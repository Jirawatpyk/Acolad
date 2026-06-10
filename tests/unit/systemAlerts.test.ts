import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';
import { raiseAlert, resolveAlert } from '../../src/reporting/systemAlerts.js';

const NOW = '2026-06-10T10:00:00.000Z';
let dir: string;
let db: DB;
let outbox: Outbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acolad-sa-'));
  db = openDatabase(dir, NOW).db;
  outbox = new Outbox(db, 10, 6);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('raiseAlert', () => {
  it('enqueues an alert and renders the action text for the trigger', () => {
    expect(raiseAlert(db, outbox, 'login_failed', NOW, 'rejected 3x')).toBe(true);
    const due = outbox.due(NOW);
    expect(due).toHaveLength(1);
    const text = (JSON.parse(due[0]!.payload_json) as { text: string }).text;
    expect(text).toContain('🚨 [CRITICAL]');
    expect(text).toContain('ต้องทำ:');
    expect(text).toContain('ACOLAD_PASSWORD');
  });

  it('dedupes a second active alert of the same kind', () => {
    expect(raiseAlert(db, outbox, 'portal_down', NOW, 'down')).toBe(true);
    expect(raiseAlert(db, outbox, 'portal_down', NOW, 'still down')).toBe(false);
    expect(outbox.due(NOW)).toHaveLength(1);
  });
});

describe('resolveAlert', () => {
  it('emits SYSTEM_RECOVERED for a trigger that supports it', () => {
    raiseAlert(db, outbox, 'portal_down', NOW, 'down');
    const later = '2026-06-10T10:20:00.000Z';
    expect(resolveAlert(db, outbox, 'portal_down', later, '20 นาที')).toBe(true);
    const texts = outbox
      .due(later)
      .map((r) => (JSON.parse(r.payload_json) as { text: string }).text);
    expect(texts.some((t) => t.includes('✅ ระบบกลับมาทำงานปกติ'))).toBe(true);
  });

  it('does not emit recovered for a one-shot trigger (db_corrupt)', () => {
    raiseAlert(db, outbox, 'db_corrupt', NOW, 'corrupt');
    expect(resolveAlert(db, outbox, 'db_corrupt', NOW, '0')).toBe(false);
  });

  it('returns false when there is no active alert to resolve', () => {
    expect(resolveAlert(db, outbox, 'login_failed', NOW, 'n/a')).toBe(false);
  });

  it('re-arms an alert kind after it is resolved', () => {
    raiseAlert(db, outbox, 'login_failed', NOW, 'first');
    resolveAlert(db, outbox, 'login_failed', NOW, 'ok');
    expect(raiseAlert(db, outbox, 'login_failed', NOW, 'again')).toBe(true);
  });
});
