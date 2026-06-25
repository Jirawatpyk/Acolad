import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { XtmJobStore } from '../../src/state/xtmJobStore.js';
import type { XtmJobState } from '../../src/detection/types.js';

const NOW = '2026-06-19T10:00:00.000Z';
const dirs: string[] = [];
let db: DB;

function freshStore(): XtmJobStore {
  const d = mkdtempSync(join(tmpdir(), 'acolad-xstore-'));
  dirs.push(d);
  db = openDatabase(d, NOW).db;
  return new XtmJobStore(db);
}

const xstate = (over: Partial<XtmJobState> = {}): XtmJobState => ({
  jobKey: 'chapter-01.docx|post-editing (pe) 1|corrector',
  xtmTaskId: 'ID-1b270f065098',
  projectName: 'Acme Q3',
  fileName: 'chapter-01.docx',
  sourceLang: 'English (USA)',
  targetLang: 'Malay (Malaysia)',
  dueDate: null,
  dueRaw: '18-Jun-2026 19:25',
  words: 100,
  step: 'Post-Editing (PE) 1',
  role: 'Corrector',
  eligible: true,
  lifecycleStatus: 'new',
  acceptStatus: 'none',
  acceptedAt: null,
  status: 'visible',
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  snapshotHash: 'h',
  consecutiveMisses: 0,
  ...over,
});

afterEach(() => {
  db?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('XtmJobStore', () => {
  it('round-trips a job state (all fields, eligible as boolean)', () => {
    const store = freshStore();
    store.upsertMany([xstate()]);
    const loaded = store.loadAll();
    expect(loaded.size).toBe(1);
    const s = loaded.get('chapter-01.docx|post-editing (pe) 1|corrector');
    expect(s?.projectName).toBe('Acme Q3');
    expect(s?.fileName).toBe('chapter-01.docx');
    expect(s?.targetLang).toBe('Malay (Malaysia)');
    expect(s?.words).toBe(100);
    expect(s?.eligible).toBe(true);
    expect(s?.lifecycleStatus).toBe('new');
    expect(s?.acceptStatus).toBe('none');
    expect(s?.status).toBe('visible');
    expect(s?.firstSeenAt).toBe(NOW);
  });

  it('updates in place on conflict (no duplicate row per job_key)', () => {
    const store = freshStore();
    store.upsertMany([xstate()]);
    store.upsertMany([
      xstate({
        lifecycleStatus: 'accepted',
        acceptStatus: 'accepted',
        acceptedAt: NOW,
        words: 250,
      }),
    ]);
    const loaded = store.loadAll();
    expect(loaded.size).toBe(1);
    const s = loaded.get('chapter-01.docx|post-editing (pe) 1|corrector');
    expect(s?.lifecycleStatus).toBe('accepted');
    expect(s?.acceptStatus).toBe('accepted');
    expect(s?.acceptedAt).toBe(NOW);
    expect(s?.words).toBe(250);
  });

  it('persists eligible=false as 0 and loads it back as false', () => {
    const store = freshStore();
    store.upsertMany([xstate({ jobKey: 'k2', fileName: 'b.html', eligible: false })]);
    expect(store.loadAll().get('k2')?.eligible).toBe(false);
  });

  it('loadAll ignores legacy partner rows (empty file_name)', () => {
    const store = freshStore();
    store.upsertMany([xstate()]);
    // A partner-era row: file_name defaults to '' (migration), title set.
    db.prepare(
      'INSERT INTO jobs (job_key, title, status, first_seen_at, last_seen_at, snapshot_hash) VALUES (?,?,?,?,?,?)',
    ).run('legacy', 'old partner job', 'visible', NOW, NOW, 'h');
    const loaded = store.loadAll();
    expect(loaded.size).toBe(1);
    expect(loaded.has('legacy')).toBe(false);
  });

  it('persists multiple distinct jobs', () => {
    const store = freshStore();
    store.upsertMany([
      xstate({ jobKey: 'a', fileName: 'a.docx' }),
      xstate({ jobKey: 'b', fileName: 'b.docx' }),
    ]);
    expect(store.loadAll().size).toBe(2);
  });

  describe('listByLifecycle', () => {
    it('returns only jobs with the requested lifecycle_status, correctly mapped', () => {
      const store = freshStore();
      store.upsertMany([
        xstate({
          jobKey: 'acc-1',
          fileName: 'acc-1.docx',
          projectName: 'Project Alpha',
          targetLang: 'Malay (Malaysia)',
          lifecycleStatus: 'accepted',
          acceptStatus: 'accepted',
          acceptedAt: NOW,
          words: 200,
        }),
        xstate({
          jobKey: 'acc-2',
          fileName: 'acc-2.docx',
          projectName: 'Project Beta',
          lifecycleStatus: 'accepted',
          acceptStatus: 'accepted',
          acceptedAt: NOW,
          words: 300,
        }),
        xstate({
          jobKey: 'miss-1',
          fileName: 'miss-1.docx',
          lifecycleStatus: 'missing',
          status: 'missing',
          words: 50,
        }),
      ]);

      const accepted = store.listByLifecycle('accepted');
      expect(accepted).toHaveLength(2);

      const keys = accepted.map((j) => j.jobKey).sort();
      expect(keys).toEqual(['acc-1', 'acc-2']);

      const a1 = accepted.find((j) => j.jobKey === 'acc-1')!;
      expect(a1.projectName).toBe('Project Alpha');
      expect(a1.targetLang).toBe('Malay (Malaysia)');
      expect(a1.words).toBe(200);
      expect(a1.acceptStatus).toBe('accepted');
      expect(a1.acceptedAt).toBe(NOW);
      expect(a1.lifecycleStatus).toBe('accepted');
    });

    it('excludes rows with empty file_name even if lifecycle_status matches', () => {
      const store = freshStore();
      store.upsertMany([
        xstate({ jobKey: 'real', fileName: 'real.docx', lifecycleStatus: 'accepted' }),
      ]);
      // insert a legacy partner row (empty file_name) with accepted lifecycle
      db.prepare(
        'INSERT INTO jobs (job_key, title, lifecycle_status, status, first_seen_at, last_seen_at, snapshot_hash) VALUES (?,?,?,?,?,?,?)',
      ).run('legacy-acc', 'old job', 'accepted', 'visible', NOW, NOW, 'h');

      const accepted = store.listByLifecycle('accepted');
      expect(accepted).toHaveLength(1);
      expect(accepted[0]?.jobKey).toBe('real');
    });

    it('returns empty array when no jobs match the status', () => {
      const store = freshStore();
      store.upsertMany([xstate({ jobKey: 'n1', fileName: 'n1.docx', lifecycleStatus: 'new' })]);
      expect(store.listByLifecycle('accepted')).toEqual([]);
    });
  });
});
