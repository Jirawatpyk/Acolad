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
