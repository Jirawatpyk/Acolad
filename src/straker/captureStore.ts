/**
 * Phase 0 evidence on disk: raw offer payloads (the fixtures feature 003 will be built
 * and tested against), an append-only event log, and the tracker state so an unattended
 * 1-2 week run survives a restart without losing sighting history.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProbeEvent, RawOffer } from './probe.js';
import { emptyTrackerState } from './offerTracker.js';
import type { TrackerState } from './offerTracker.js';

export interface CaptureStore {
  captureOffer(objId: string, payload: RawOffer, atMs: number): Promise<void>;
  recordEvent(event: ProbeEvent): Promise<void>;
  saveState(state: TrackerState): Promise<void>;
  loadState(): TrackerState;
}

export function createCaptureStore(dir: string): CaptureStore {
  const offersDir = join(dir, 'offers');
  const eventsFile = join(dir, 'events.ndjson');
  const stateFile = join(dir, 'tracker-state.json');

  return {
    async captureOffer(objId, payload, atMs) {
      mkdirSync(offersDir, { recursive: true });
      const stamp = new Date(atMs).toISOString().replace(/[:.]/g, '-');
      writeFileSync(
        join(offersDir, `offer-${stamp}-${safeName(objId)}.json`),
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );
    },

    async recordEvent(event) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    },

    async saveState(state) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    },

    loadState() {
      if (!existsSync(stateFile)) return emptyTrackerState();
      return JSON.parse(readFileSync(stateFile, 'utf8')) as TrackerState;
    },
  };
}

/** obj_id is a server-supplied uuid, but never let it reach into the filesystem. */
function safeName(objId: string): string {
  return objId.replace(/[^A-Za-z0-9_-]/g, '_');
}
