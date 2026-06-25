/**
 * Unit tests for Outbox (state/outbox.ts).
 *
 * Fix 4 atomicity: the outbox channel migration (v2→widened) must preserve
 * existing rows and remain transactional — either the whole RENAME→CREATE→
 * INSERT…SELECT→DROP→INDEX block commits or nothing changes.
 *
 * The "crash between steps" scenario is impractical to inject in a unit test
 * (SQLite C calls mid-transaction cannot be interrupted from JS). We instead
 * assert the happy-path guarantee: a pending row with channel='chat' seeded
 * into a v2-shaped outbox (CHECK IN ('chat','sheets') — pre-team) survives
 * migration intact and the new CHECK accepts a 'team' insert. The atomicity
 * property is guaranteed by construction because all 5 exec calls are wrapped
 * in a single db.transaction(() => {...})().
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/state/db.js';
import { Outbox } from '../../src/state/outbox.js';

const NOW = '2026-06-25T03:00:00.000Z';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acolad-outbox-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fix 4: outbox channel migration atomicity
// ---------------------------------------------------------------------------

/**
 * Build a "v2-pre-team" database: outbox CHECK IN ('chat','sheets') but no
 * 'team'. This simulates the state of a production db that was opened with
 * the 002 schema before the 'team' channel was added to ensureOutboxChannel.
 */
function buildPreTeamDb(dir: string): void {
  const db = new Database(join(dir, 'acolad.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      job_key TEXT PRIMARY KEY,
      portal_job_id TEXT,
      title TEXT NOT NULL,
      language_pair TEXT,
      deadline TEXT,
      deadline_raw TEXT,
      fee TEXT,
      url TEXT,
      status TEXT NOT NULL CHECK (status IN ('visible','missing')),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      snapshot_hash TEXT NOT NULL,
      consecutive_misses INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS outbox (
      outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('chat','sheets')),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedup ON outbox (event_id, channel);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Seed a pending row that must survive migration
  db.prepare(
    "INSERT INTO outbox (event_id, channel, payload_json, next_attempt_at, created_at) VALUES ('pending-chat','chat','{\"text\":\"hi\"}',?,?)",
  ).run(NOW, NOW);
  db.prepare(
    'INSERT INTO outbox (event_id, channel, payload_json, next_attempt_at, created_at) VALUES (\'pending-sheets\',\'sheets\',\'{"row":{"jobKey":"k"}}\',?,?)',
  ).run(NOW, NOW);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version','2')").run();
  db.close();
}

describe('outbox channel migration — Fix 4 atomicity', () => {
  it('pre-team pending rows survive migration with channel intact', () => {
    const dir = tmp();
    buildPreTeamDb(dir);

    const { db } = openDatabase(dir, NOW);

    // Both pre-migration rows must be present and unchanged
    const chatRow = db
      .prepare("SELECT channel, status FROM outbox WHERE event_id='pending-chat'")
      .get() as {
      channel: string;
      status: string;
    };
    expect(chatRow.channel).toBe('chat');
    expect(chatRow.status).toBe('pending');

    const sheetsRow = db
      .prepare("SELECT channel, status FROM outbox WHERE event_id='pending-sheets'")
      .get() as { channel: string; status: string };
    expect(sheetsRow.channel).toBe('sheets');
    expect(sheetsRow.status).toBe('pending');

    db.close();
  });

  it('after migration the new CHECK accepts a team insert', () => {
    const dir = tmp();
    buildPreTeamDb(dir);

    const { db } = openDatabase(dir, NOW);

    // 'team' must be accepted after migration
    expect(() =>
      db
        .prepare(
          "INSERT INTO outbox (event_id, channel, payload_json, next_attempt_at, created_at) VALUES ('daily:2026-06-25','team','{\"cardsV2\":[]}',?,?)",
        )
        .run(NOW, NOW),
    ).not.toThrow();

    // 'email' (unknown channel) must still be rejected
    expect(() =>
      db
        .prepare(
          "INSERT INTO outbox (event_id, channel, payload_json, next_attempt_at, created_at) VALUES ('x','email','{}',?,?)",
        )
        .run(NOW, NOW),
    ).toThrow();

    db.close();
  });

  it('migration is idempotent — re-opening a post-migration db does not error', () => {
    const dir = tmp();
    buildPreTeamDb(dir);

    const first = openDatabase(dir, NOW);
    first.db.close();

    // Re-open must not throw and must still see the rows
    const second = openDatabase(dir, NOW);
    const chatRow = second.db
      .prepare("SELECT event_id FROM outbox WHERE event_id='pending-chat'")
      .get();
    expect(chatRow).toBeDefined();
    second.db.close();
  });

  it('Outbox.enqueue on fresh db returns true for chat/sheets/team channels', () => {
    const dir = tmp();
    const { db } = openDatabase(dir, NOW);
    const ob = new Outbox(db, 10, 6);

    expect(ob.enqueue('e-chat', '{"text":"a"}', NOW, 'chat')).toBe(true);
    expect(ob.enqueue('e-sheets', '{"row":{"jobKey":"k"}}', NOW, 'sheets')).toBe(true);
    expect(ob.enqueue('e-team', '{"text":"b"}', NOW, 'team')).toBe(true);

    // Duplicate returns false (idempotent)
    expect(ob.enqueue('e-chat', '{"text":"a"}', NOW, 'chat')).toBe(false);

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Outbox core behaviour
// ---------------------------------------------------------------------------

describe('Outbox — core behaviour', () => {
  it('countDeadExcludingChannel excludes exactly the given channel', () => {
    const dir = tmp();
    const { db } = openDatabase(dir, NOW);
    const ob = new Outbox(db, 10, 6);

    ob.enqueue('d-team', '{"text":"t"}', NOW, 'team');
    ob.enqueue('d-chat', '{"text":"c"}', NOW, 'chat');

    // Force both to dead
    db.prepare("UPDATE outbox SET status='dead'").run();

    expect(ob.countDeadExcludingChannel('team')).toBe(1); // only chat row
    expect(ob.countDeadExcludingChannel('chat')).toBe(1); // only team row
    expect(ob.countDeadExcludingChannel('sheets')).toBe(2); // both

    db.close();
  });

  it('requeueDead resets all dead rows to pending with 0 attempts', () => {
    const dir = tmp();
    const { db } = openDatabase(dir, NOW);
    const ob = new Outbox(db, 1, 6);

    ob.enqueue('r1', '{"text":"x"}', NOW, 'chat');
    ob.recordFailure(
      db.prepare("SELECT * FROM outbox WHERE event_id='r1'").get() as Parameters<
        typeof ob.recordFailure
      >[0],
      Date.parse(NOW),
    ); // exhausts cap=1 → dead

    expect(ob.countByStatus('dead')).toBe(1);
    const requeued = ob.requeueDead(NOW);
    expect(requeued).toBe(1);
    expect(ob.countByStatus('pending')).toBe(1);
    expect(ob.countByStatus('dead')).toBe(0);

    db.close();
  });
});
