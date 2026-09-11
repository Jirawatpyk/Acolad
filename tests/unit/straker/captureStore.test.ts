import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCaptureStore } from '../../../src/straker/captureStore.js';
import { emptyTrackerState } from '../../../src/straker/offerTracker.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'straker-probe-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createCaptureStore', () => {
  it('writes a newly seen offer payload verbatim under an id-stamped filename', async () => {
    const store = createCaptureStore(dir);
    const payload = { obj_id: 'off-1', listing_type: 'direct_po', weighted_words: 812 };

    await store.captureOffer('off-1', payload, 1_788_000_000_000);

    const file = readdirSync(join(dir, 'offers')).find((name) => name.includes('off-1'));
    expect(file).toBeDefined();
    expect(JSON.parse(readFileSync(join(dir, 'offers', file as string), 'utf8'))).toEqual(payload);
  });

  it('appends events as one JSON object per line so a long run stays streamable', async () => {
    const store = createCaptureStore(dir);

    await store.recordEvent({ kind: 'appeared', objId: 'off-1', atMs: 1_000, sighting: 1 });
    await store.recordEvent({ kind: 'read_failed', atMs: 2_000, reason: 'Error: boom' });

    const lines = readFileSync(join(dir, 'events.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ kind: 'read_failed', atMs: 2_000 });
  });

  it('round-trips tracker state so a restart does not lose sighting history', async () => {
    const store = createCaptureStore(dir);
    const state = { live: [], sightingsByObjId: [['off-1', 3] as const] };

    await store.saveState(state);

    expect(store.loadState()).toEqual(state);
  });

  it('starts from an empty state when no state file exists yet', () => {
    expect(createCaptureStore(dir).loadState()).toEqual(emptyTrackerState());
  });
});
