import type { DB } from '../state/db.js';
import { JobStore } from '../state/jobStore.js';
import { AppearanceEventStore } from '../state/appearanceEvents.js';
import { Outbox } from '../state/outbox.js';
import { SystemEventStore } from '../state/systemEvents.js';
import { MetaStore } from '../state/meta.js';
import { diff } from '../detection/diff.js';
import { renderAppearance, renderColdStartSummary } from '../reporting/notifier.js';
import type { JobSnapshot, JobState } from '../detection/types.js';
import type { Logger } from '../monitoring/logger.js';

export interface PersistResult {
  enqueued: number;
  coldStart: boolean;
  detailsChanged: number;
}

/**
 * Applies a snapshot to persistent state and enqueues notifications — all in a
 * single SQLite transaction (Constitution VII). On the first run with no
 * baseline, emits a single cold_start_summary instead of N first_seen messages
 * (FR-015) and records the baseline jobs without per-job outbox rows.
 */
export class PollCyclePersister {
  private readonly jobs: JobStore;
  private readonly appearances: AppearanceEventStore;
  private readonly outbox: Outbox;
  private readonly system: SystemEventStore;
  private readonly meta: MetaStore;

  constructor(
    private readonly db: DB,
    outbox: Outbox,
    private readonly logger: Logger,
  ) {
    this.jobs = new JobStore(db);
    this.appearances = new AppearanceEventStore(db);
    this.outbox = outbox;
    this.system = new SystemEventStore(db);
    this.meta = new MetaStore(db);
  }

  persist(snapshot: JobSnapshot): PersistResult {
    const prev = this.jobs.loadAll();
    const baseline = !this.meta.baselineDone;
    const result = diff(snapshot, prev, { baseline });

    const tx = this.db.transaction((): PersistResult => {
      this.jobs.upsertMany(result.nextStates.values());

      if (baseline) {
        // Record cold-start appearance events for traceability, but emit ONE summary.
        for (const ev of result.events) this.appearances.insert(ev);
        const visibleJobs: JobState[] = [...result.nextStates.values()].filter(
          (s) => s.status === 'visible',
        );
        const summaryPayload = JSON.stringify({
          text: renderColdStartSummary(visibleJobs, snapshot.capturedAt),
        });
        const summaryId = this.system.create({
          eventType: 'cold_start_summary',
          severity: 'info',
          dedupKey: `cold_start:${snapshot.pollCycleId}`,
          payloadJson: summaryPayload,
          occurredAt: snapshot.capturedAt,
        });
        let enqueued = 0;
        if (summaryId && this.outbox.enqueue(summaryId, summaryPayload, snapshot.capturedAt)) {
          enqueued++;
        }
        this.meta.markBaselineDone();
        this.meta.recordSuccessfulPoll(snapshot.capturedAt);
        return { enqueued, coldStart: true, detailsChanged: result.detailsChanges.length };
      }

      let enqueued = 0;
      for (const ev of result.events) {
        if (ev.eventType === 'missing') {
          // Missing is recorded for traceability but not notified.
          this.appearances.insert(ev);
          continue;
        }
        const eventId = this.appearances.insert(ev);
        if (!eventId) continue; // deduped within cycle
        const payload = JSON.stringify({ text: renderAppearance(ev) });
        if (this.outbox.enqueue(eventId, payload, snapshot.capturedAt)) enqueued++;
      }
      this.meta.recordSuccessfulPoll(snapshot.capturedAt);
      return { enqueued, coldStart: false, detailsChanged: result.detailsChanges.length };
    });

    const out = tx();

    for (const dc of result.detailsChanges) {
      this.logger.info(
        { module: 'detection', action: 'details_changed', jobKey: dc.jobKey, changes: dc.changes },
        'job details changed (silent)',
      );
    }
    return out;
  }
}
