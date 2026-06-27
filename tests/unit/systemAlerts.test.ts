import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';
import { raiseAlert, resolveAlert, TRIGGERS } from '../../src/reporting/systemAlerts.js';

const NOW = '2026-06-10T10:00:00.000Z';
const THAI_RE = /[฀-๿]/;
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

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function firstPayload(): unknown {
  const due = outbox.due(NOW);
  expect(due.length).toBeGreaterThan(0);
  return JSON.parse(due[0]!.payload_json) as unknown;
}

function assertCard(payload: unknown): { cardsV2: unknown[] } {
  expect(payload).toHaveProperty('cardsV2');
  const card = payload as { cardsV2: unknown[] };
  expect(Array.isArray(card.cardsV2)).toBe(true);
  expect(card.cardsV2.length).toBeGreaterThan(0);
  return card;
}

function cardTitle(payload: unknown): string {
  const card = assertCard(payload);
  const entry = card.cardsV2[0] as { card: { header: { title: string } } };
  return entry.card.header.title;
}

function cardJson(payload: unknown): string {
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// All triggers produce English cardsV2 (no Thai)
// ---------------------------------------------------------------------------

describe('raiseAlert — all triggers produce cardsV2 English cards', () => {
  const allKinds = Object.keys(TRIGGERS) as (keyof typeof TRIGGERS)[];

  for (const kind of allKinds) {
    it(`${kind}: payload is cardsV2 with English title, Impact/Action/Detail rows, NO Thai`, () => {
      raiseAlert(db, outbox, kind, NOW, 'test-detail');
      const payload = firstPayload();

      // Must be cardsV2, NOT {text:...}
      expect(payload).toHaveProperty('cardsV2');
      expect(payload).not.toHaveProperty('text');

      const json = cardJson(payload);
      // No Thai characters anywhere in the serialized payload
      expect(THAI_RE.test(json)).toBe(false);

      // Header title must contain the English trigger title
      const title = cardTitle(payload);
      expect(title.length).toBeGreaterThan(0);

      // Rows must include Impact, Action, Detail labels
      expect(json).toContain('Impact');
      expect(json).toContain('Action');
      expect(json).toContain('Detail');
    });
  }
});

// ---------------------------------------------------------------------------
// Specific trigger assertions
// ---------------------------------------------------------------------------

describe('raiseAlert — login_failed', () => {
  it('header contains "Login failed" and action mentions npm run deploy', () => {
    raiseAlert(db, outbox, 'login_failed', NOW, 'rejected 3x');
    const payload = firstPayload();
    const json = cardJson(payload);
    expect(cardTitle(payload)).toContain('Login failed');
    expect(json).toContain('npm run deploy');
  });
});

describe('raiseAlert — daily_report_dead', () => {
  it('exists in TRIGGERS with severity warn', () => {
    expect(TRIGGERS.daily_report_dead).toBeDefined();
    expect(TRIGGERS.daily_report_dead.severity).toBe('warn');
    expect(TRIGGERS.daily_report_dead.hasRecovered).toBe(false);
  });

  it('raises a card naming the date when detail includes it', () => {
    raiseAlert(db, outbox, 'daily_report_dead', NOW, '2026-06-10');
    const payload = firstPayload();
    const json = cardJson(payload);
    expect(THAI_RE.test(json)).toBe(false);
    expect(cardTitle(payload)).toContain('Daily report delivery failed');
    expect(json).toContain('2026-06-10');
  });
});

describe('raiseAlert — outbox_dead', () => {
  it('header contains "Notifications stuck"', () => {
    raiseAlert(db, outbox, 'outbox_dead', NOW, 'retries exhausted');
    expect(cardTitle(firstPayload())).toContain('Notifications stuck');
  });
});

describe('raiseAlert — accept_failed', () => {
  it('header contains "Job accept failed"', () => {
    raiseAlert(db, outbox, 'accept_failed', NOW, 'proj/file', {}, 'accept_failed:JK1');
    expect(cardTitle(firstPayload())).toContain('Job accept failed');
  });
});

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

describe('raiseAlert — dedup', () => {
  it('dedupes a second active alert of the same kind', () => {
    expect(raiseAlert(db, outbox, 'portal_down', NOW, 'down')).toBe(true);
    expect(raiseAlert(db, outbox, 'portal_down', NOW, 'still down')).toBe(false);
    expect(outbox.due(NOW)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveAlert
// ---------------------------------------------------------------------------

describe('resolveAlert', () => {
  it('emits an English SYSTEM_RECOVERED card for a trigger that supports it', () => {
    raiseAlert(db, outbox, 'portal_down', NOW, 'down');
    const later = '2026-06-10T10:20:00.000Z';
    expect(resolveAlert(db, outbox, 'portal_down', later, '20 min')).toBe(true);

    const due = outbox.due(later);
    // Both the original alert and the recovered event are in the outbox
    const payloads = due.map((r) => JSON.parse(r.payload_json) as unknown);
    const recoveredPayload = payloads.find((p) => {
      const json = JSON.stringify(p);
      return json.includes('Recovered') || json.includes('recovered');
    });
    expect(recoveredPayload).toBeDefined();

    // Must be cardsV2 (not {text})
    expect(recoveredPayload).toHaveProperty('cardsV2');
    const json = cardJson(recoveredPayload);
    // No Thai in recovered payload
    expect(THAI_RE.test(json)).toBe(false);
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

// ---------------------------------------------------------------------------
// yield alert triggers (Task 4)
// ---------------------------------------------------------------------------

describe('yield alert triggers', () => {
  it('raises xtm_yielding once per active episode, then resolves', () => {
    expect(raiseAlert(db, outbox, 'xtm_yielding', '2026-06-26T00:00:00Z', 'account in use')).toBe(
      true,
    );
    expect(raiseAlert(db, outbox, 'xtm_yielding', '2026-06-26T00:00:20Z', 'account in use')).toBe(
      false,
    ); // deduped
    expect(resolveAlert(db, outbox, 'xtm_yielding', '2026-06-26T00:10:00Z', '10 min')).toBe(true);
    // after resolve a new episode can raise again
    expect(raiseAlert(db, outbox, 'xtm_yielding', '2026-06-26T00:11:00Z', 'account in use')).toBe(
      true,
    );
  });

  it('raises yield_stuck as a critical alert', () => {
    expect(raiseAlert(db, outbox, 'yield_stuck', '2026-06-26T01:00:00Z', 'paused 60 min')).toBe(
      true,
    );
  });

  it('raises yield_stuck once per active episode, then resolves and re-arms', () => {
    expect(raiseAlert(db, outbox, 'yield_stuck', '2026-06-26T01:00:00Z', 'paused 60 min')).toBe(
      true,
    );
    expect(raiseAlert(db, outbox, 'yield_stuck', '2026-06-26T01:00:20Z', 'paused 61 min')).toBe(
      false,
    );
    expect(resolveAlert(db, outbox, 'yield_stuck', '2026-06-26T02:00:00Z', '60 min')).toBe(true);
    expect(raiseAlert(db, outbox, 'yield_stuck', '2026-06-26T02:01:00Z', 'paused again')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// I3b: daily_cap_reached trigger
// ---------------------------------------------------------------------------

describe('raiseAlert — daily_cap_reached (I3b)', () => {
  it('is a warn trigger that does not auto-recover', () => {
    const t = TRIGGERS['daily_cap_reached'];
    expect(t.severity).toBe('warn');
    expect(t.hasRecovered).toBe(false);
    expect(t.title.length).toBeGreaterThan(0);
  });

  it('dedups per Bangkok day via the dedup key, re-arming on the next day', () => {
    expect(
      raiseAlert(db, outbox, 'daily_cap_reached', NOW, 'cap', {}, 'daily_cap_reached:2026-06-10'),
    ).toBe(true);
    expect(
      raiseAlert(db, outbox, 'daily_cap_reached', NOW, 'cap', {}, 'daily_cap_reached:2026-06-10'),
    ).toBe(false); // same day → deduped
    expect(
      raiseAlert(db, outbox, 'daily_cap_reached', NOW, 'cap', {}, 'daily_cap_reached:2026-06-11'),
    ).toBe(true); // next Bangkok day re-arms
  });
});

// ---------------------------------------------------------------------------
// Task 10: holiday_calendar_stale trigger
// ---------------------------------------------------------------------------

describe('raiseAlert — holiday_calendar_stale', () => {
  it('holiday_calendar_stale is a CRITICAL trigger that recovers (C1 — current-year outage pages on-call)', () => {
    const t = TRIGGERS['holiday_calendar_stale'];
    expect(t.severity).toBe('critical'); // escalated from warn — a total auto-accept outage
    expect(t.hasRecovered).toBe(true);
    expect(t.title.length).toBeGreaterThan(0);
  });

  it('holiday_calendar_stale action names the fix (curate the current year then npm run deploy)', () => {
    raiseAlert(db, outbox, 'holiday_calendar_stale', NOW, 'year 2099');
    const json = cardJson(firstPayload());
    expect(json).toContain('thaiHolidaysData.ts');
    expect(json).toContain('npm run deploy');
    expect(json).toContain('🔴'); // critical emoji (was ⚠️ when it was warn)
  });

  // F2: behavioral (not just a constant check) — raise → dedup → resolve, mirroring yield_stuck.
  const activeCount = (): number =>
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM system_events WHERE event_type='system_alert' AND dedup_key='holiday_calendar_stale' AND resolved_at IS NULL",
        )
        .get() as { n: number }
    ).n;

  it('raises once (one active row), dedups a second raise, then resolves', () => {
    expect(raiseAlert(db, outbox, 'holiday_calendar_stale', NOW, 'year 2099')).toBe(true);
    expect(activeCount()).toBe(1); // exactly one active alert
    expect(raiseAlert(db, outbox, 'holiday_calendar_stale', NOW, 'year 2099 again')).toBe(false); // deduped
    expect(activeCount()).toBe(1); // still one

    const later = '2026-06-10T11:00:00.000Z';
    expect(resolveAlert(db, outbox, 'holiday_calendar_stale', later, '—')).toBe(true);
    expect(activeCount()).toBe(0); // resolved_at set → no longer active

    const resolved = db
      .prepare(
        "SELECT resolved_at FROM system_events WHERE event_type='system_alert' AND dedup_key='holiday_calendar_stale'",
      )
      .get() as { resolved_at: string | null };
    expect(resolved.resolved_at).toBe(later);

    // After a resolve the kind re-arms for a future uncurated year.
    expect(raiseAlert(db, outbox, 'holiday_calendar_stale', later, 'year 2100')).toBe(true);
  });
});
