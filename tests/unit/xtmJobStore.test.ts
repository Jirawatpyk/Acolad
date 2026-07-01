import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/state/db.js';
import { XtmJobStore } from '../../src/state/xtmJobStore.js';
import { effortOf } from '../../src/schedule/effort.js';
import type { XtmJobState } from '../../src/detection/types.js';

const NOW = '2026-06-19T10:00:00.000Z';
const DUE = '2026-06-24T18:00:00+07:00';
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
  fileWwc: 42,
  step: 'Post-Editing (PE) 1',
  role: 'Corrector',
  eligible: true,
  lifecycleStatus: 'new',
  acceptStatus: 'none',
  acceptedAt: null,
  rejectReason: null,
  status: 'visible',
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  snapshotHash: 'h',
  consecutiveMisses: 0,
  ...over,
});

// An accepted (held) job — mirrors xstate() with the accepted lifecycle set.
const accepted = (over: Partial<XtmJobState> = {}): XtmJobState =>
  xstate({ lifecycleStatus: 'accepted', acceptStatus: 'accepted', acceptedAt: NOW, ...over });

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
    expect(s?.fileWwc).toBe(42);
    expect(s?.eligible).toBe(true);
    expect(s?.lifecycleStatus).toBe('new');
    expect(s?.acceptStatus).toBe('none');
    expect(s?.status).toBe('visible');
    expect(s?.firstSeenAt).toBe(NOW);
  });

  it('round-trips rejectReason — a non-null reason survives write→read, null clears it', () => {
    const store = freshStore();
    // A non-null reason MUST survive a write→read (catches a missing reject_reason in the
    // hand-written upsertMany SQL — the four-place trap: column list, VALUES, ON CONFLICT, params).
    store.upsertMany([
      xstate({
        jobKey: 'rr',
        fileName: 'rr.docx',
        rejectReason: 'group blocked: holiday_calendar_stale',
      }),
    ]);
    expect(store.loadAll().get('rr')?.rejectReason).toBe('group blocked: holiday_calendar_stale');

    // Clearing it (null) must persist too (the ON CONFLICT … DO UPDATE SET path).
    store.upsertMany([xstate({ jobKey: 'rr', fileName: 'rr.docx', rejectReason: null })]);
    expect(store.loadAll().get('rr')?.rejectReason).toBeNull();
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

  it('round-trips fileWwc including null and 0 (0 is a real value, not blank)', () => {
    const store = freshStore();
    store.upsertMany([
      xstate({ jobKey: 'fw-null', fileName: 'n.docx', fileWwc: null }),
      xstate({ jobKey: 'fw-zero', fileName: 'z.docx', fileWwc: 0 }),
      xstate({ jobKey: 'fw-num', fileName: 'd.docx', fileWwc: 427 }),
    ]);
    const loaded = store.loadAll();
    expect(loaded.get('fw-null')?.fileWwc).toBeNull();
    expect(loaded.get('fw-zero')?.fileWwc).toBe(0);
    expect(loaded.get('fw-num')?.fileWwc).toBe(427);
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

  describe('effortDueByDeadline', () => {
    it('buckets held words by Bangkok deadline date and skips null/unparseable', () => {
      const store = freshStore();
      store.upsertMany([
        accepted({ jobKey: 'a', dueDate: '2026-06-24T18:00:00+07:00', words: 100 }),
        accepted({ jobKey: 'b', dueDate: '2026-06-24T09:00:00+07:00', words: 200 }),
        accepted({ jobKey: 'c', dueDate: '2026-06-25T18:00:00+07:00', words: 50 }),
        accepted({ jobKey: 'd', dueDate: null, words: 999 }), // skipped
        accepted({ jobKey: 'e', dueDate: 'garbage', words: 999 }), // skipped
      ]);
      const m = store.effortDueByDeadline();
      expect(m.get('2026-06-24')).toBe(300);
      expect(m.get('2026-06-25')).toBe(50);
      expect(m.size).toBe(2);
    });

    it('F2: a held job with a real deadline is always bucketed (F1 keeps held deadlines valid)', () => {
      const store = freshStore();
      // After F1, a held (accepted) job always carries a parseable committed deadline, so it
      // must always land in its deadline-day bucket — never silently dropped/under-counted.
      store.upsertMany([
        accepted({ jobKey: 'h', dueDate: '2026-06-24T18:00:00+07:00', words: 600 }),
      ]);
      const m = store.effortDueByDeadline();
      expect(m.get('2026-06-24')).toBe(600);
      expect(m.size).toBe(1);
    });

    it('treats a null-words held job as 0 (no NaN, does not change a co-day sum)', () => {
      const store = freshStore();
      store.upsertMany([
        accepted({ jobKey: 'a', dueDate: '2026-06-24T18:00:00+07:00', words: 100 }),
        accepted({ jobKey: 'n', dueDate: '2026-06-24T09:00:00+07:00', words: null }), // null → 0
        accepted({ jobKey: 'z', dueDate: '2026-06-26T18:00:00+07:00', words: null }), // null → 0
      ]);
      const m = store.effortDueByDeadline();
      expect(m.get('2026-06-24')).toBe(100); // null co-day job adds 0, not NaN
      expect(Number.isNaN(m.get('2026-06-24'))).toBe(false);
      expect(m.get('2026-06-26')).toBe(0); // a day with only a null-words job sums to 0
    });

    it('effortDueByDeadline buckets via the injected mapper (WWC vs words)', () => {
      const store = freshStore();
      store.upsertMany([accepted({ jobKey: 'a', dueDate: DUE, words: 1500, fileWwc: 800 })]);
      const day = (d: string | null) => d && d.slice(0, 10);
      const wwc = store.effortDueByDeadline(day, (s) => effortOf(s, 'wwc') ?? 0);
      const words = store.effortDueByDeadline(day, (s) => effortOf(s, 'words') ?? 0);
      expect(wwc.get(DUE.slice(0, 10))).toBe(800);
      expect(words.get(DUE.slice(0, 10))).toBe(1500);
    });

    it('a both-null (words=null, fileWwc=null) row via the injected mapper sums to 0, not NaN', () => {
      const store = freshStore();
      store.upsertMany([accepted({ jobKey: 'a', dueDate: DUE, words: null, fileWwc: null })]);
      const day = (d: string | null) => d && d.slice(0, 10);
      const m = store.effortDueByDeadline(day, (s) => effortOf(s, 'wwc') ?? 0);
      expect(m.get(DUE.slice(0, 10))).toBe(0);
      expect(Number.isNaN(m.get(DUE.slice(0, 10)))).toBe(false);
    });
  });

  describe('heldJobsMissingEffort (I-1 — null-effort held-job guard)', () => {
    it('returns held jobs whose effortOf is null (wwc mode: both-null → missing)', () => {
      const store = freshStore();
      store.upsertMany([
        accepted({ jobKey: 'ok-wwc', dueDate: DUE, words: 100, fileWwc: 50 }), // effortOf(wwc)=50
        accepted({ jobKey: 'null-both', dueDate: DUE, words: null, fileWwc: null }), // effortOf(wwc)=null
        // wwc falls back to words when fileWwc is null/0, so this one resolves to words=100
        accepted({ jobKey: 'null-wwc', dueDate: DUE, words: 100, fileWwc: null }),
      ]);
      const missing = store.heldJobsMissingEffort((s) => effortOf(s, 'wwc'));
      expect(missing.map((s) => s.jobKey)).toEqual(['null-both']);
    });

    it('words mode: returns held jobs with null words', () => {
      const store = freshStore();
      store.upsertMany([
        accepted({ jobKey: 'ok', dueDate: DUE, words: 100 }),
        accepted({ jobKey: 'null-words', dueDate: DUE, words: null, fileWwc: 50 }),
      ]);
      const missing = store.heldJobsMissingEffort((s) => effortOf(s, 'words'));
      expect(missing.map((s) => s.jobKey)).toEqual(['null-words']);
    });

    it('is empty when every held job has non-null effort', () => {
      const store = freshStore();
      store.upsertMany([accepted({ jobKey: 'a', dueDate: DUE, words: 100, fileWwc: 42 })]);
      expect(store.heldJobsMissingEffort((s) => effortOf(s, 'wwc'))).toEqual([]);
    });

    it('only inspects held (accepted lifecycle) jobs — non-held jobs with null effort are not flagged', () => {
      const store = freshStore();
      store.upsertMany([
        xstate({ jobKey: 'new-no-words', fileName: 'new.docx', words: null }),
        accepted({ jobKey: 'held-no-words', dueDate: DUE, words: null, fileWwc: null }),
      ]);
      const missing = store.heldJobsMissingEffort((s) => effortOf(s, 'wwc'));
      expect(missing.map((s) => s.jobKey)).toEqual(['held-no-words']);
    });
  });

  describe('heldJobsMissingDeadline (I1 — fail-loud over-accept guard)', () => {
    it('returns the keys of held jobs with a null/unparseable deadline (those effortDueByDeadline skips)', () => {
      const store = freshStore();
      store.upsertMany([
        accepted({ jobKey: 'ok', dueDate: '2026-06-24T18:00:00+07:00', words: 100 }), // bucketed
        accepted({ jobKey: 'nul', dueDate: null, words: 999 }), // missing
        accepted({ jobKey: 'bad', dueDate: 'garbage', words: 999 }), // unparseable → missing
      ]);
      expect(store.heldJobsMissingDeadline().sort()).toEqual(['bad', 'nul']);
    });

    it('is empty when every held job has a parseable deadline', () => {
      const store = freshStore();
      store.upsertMany([
        accepted({ jobKey: 'a', dueDate: '2026-06-24T18:00:00+07:00', words: 100 }),
      ]);
      expect(store.heldJobsMissingDeadline()).toEqual([]);
    });

    it('F10: uses the injected dayOf mapper — a job is "missing" iff its bucket key is null (partners effortDueByDeadline)', () => {
      const store = freshStore();
      store.upsertMany([
        accepted({ jobKey: 'ok', dueDate: '2026-06-24T18:00:00+07:00', words: 100 }),
        accepted({ jobKey: 'mapNull', dueDate: '2026-06-25T18:00:00+07:00', words: 200 }),
      ]);
      // A mapper that buckets 'ok' but returns null for 'mapNull's (perfectly parseable) deadline.
      // The SAME mapper must drive BOTH methods, so 'mapNull' is flagged missing AND skipped by the
      // seed — proving heldJobsMissingDeadline keys off dayOf, not a hardcoded raw-date parse.
      const dayOf = (d: string | null): string | null =>
        d === '2026-06-25T18:00:00+07:00' ? null : '2026-06-24';
      expect(store.heldJobsMissingDeadline(dayOf)).toEqual(['mapNull']);
      const m = store.effortDueByDeadline(dayOf);
      expect(m.get('2026-06-24')).toBe(100); // 'ok' bucketed
      expect(m.has('2026-06-25')).toBe(false); // 'mapNull' skipped — exactly the missing one
    });
  });
});
