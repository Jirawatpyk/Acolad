import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { MetaStore } from '../../src/state/meta.js';

const NOW = '2026-06-26T00:00:00.000Z';

let dir: string;
let db: DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'acolad-meta-'));
  db = openDatabase(dir, NOW).db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MetaStore yield accessors', () => {
  it('defaults all yield fields to 0 when unset', () => {
    const meta = new MetaStore(db);
    expect(meta.lastAuthSuccessMs).toBe(0);
    expect(meta.yieldUntilMs).toBe(0);
    expect(meta.yieldEpisodeStartedMs).toBe(0);
  });

  it('round-trips each yield field', () => {
    const meta = new MetaStore(db);
    meta.setLastAuthSuccessMs(1700000000000);
    meta.setYieldUntilMs(1700000600000);
    meta.setYieldEpisodeStartedMs(1700000000000);
    expect(meta.lastAuthSuccessMs).toBe(1700000000000);
    expect(meta.yieldUntilMs).toBe(1700000600000);
    expect(meta.yieldEpisodeStartedMs).toBe(1700000000000);
  });
});

describe('getNumber guards non-finite stored values (A1 — cap-bypass defense)', () => {
  it('returns the fallback for a stored non-numeric value (Number → NaN)', () => {
    const m = new MetaStore(db);
    m.set('accepted_words_count', 'not-a-number');
    // Use a non-zero fallback so a returned 0 could not masquerade as a pass.
    expect(m.getNumber('accepted_words_count', 7)).toBe(7);
  });
  it("returns the fallback for the self-perpetuating 'NaN' string (String(NaN)='NaN')", () => {
    const m = new MetaStore(db);
    m.set('accepted_words_count', 'NaN'); // the corrupt value a prior un-guarded write left
    expect(m.getNumber('accepted_words_count', 7)).toBe(7);
  });
  it('returns the fallback for a stored Infinity', () => {
    const m = new MetaStore(db);
    m.set('accepted_words_count', 'Infinity');
    expect(m.getNumber('accepted_words_count', 7)).toBe(7);
  });
  it('still returns a valid stored number', () => {
    const m = new MetaStore(db);
    m.set('accepted_words_count', '42');
    expect(m.getNumber('accepted_words_count', 0)).toBe(42);
  });
});

describe('daily word counter', () => {
  it('accumulates within a date', () => {
    const m = new MetaStore(db);
    m.addAcceptedWords('2026-06-22', 300);
    m.addAcceptedWords('2026-06-22', 200);
    expect(m.acceptedWordsToday('2026-06-22')).toBe(500);
  });
  it('resets on a new Bangkok date', () => {
    const m = new MetaStore(db);
    m.addAcceptedWords('2026-06-22', 800);
    expect(m.acceptedWordsToday('2026-06-23')).toBe(0); // read for a new date
    m.addAcceptedWords('2026-06-23', 100);
    expect(m.acceptedWordsToday('2026-06-23')).toBe(100); // reset, not 900
  });
  it('persists across a fresh MetaStore for the same date', () => {
    new MetaStore(db).addAcceptedWords('2026-06-22', 250);
    expect(new MetaStore(db).acceptedWordsToday('2026-06-22')).toBe(250);
  });
});
