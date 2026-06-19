/** Raw job parsed from the partner portal (contracts/portal-adapter.md). */
export interface RawJob {
  portalJobId: string | null;
  title: string;
  languagePair: string | null;
  deadline: string | null;
  deadlineRaw: string | null;
  fee: string | null;
  url: string | null;
}

/**
 * Raw job parsed from an XTM Active row (contracts/xtm-portal-adapter.md). Lives
 * in the detection layer (not portal) so jobKey/eligibility/diff can operate on
 * it without importing Playwright types (Constitution I).
 */
export interface XtmRawJob {
  xtmTaskId: string | null;
  projectName: string;
  fileName: string;
  sourceLang: string | null;
  targetLang: string | null;
  dueDate: string | null;
  dueRaw: string | null;
  words: number | null;
  step: string | null;
  role: string | null;
  /** Whether the Accept menu is still actionable (distinguishes free vs taken). */
  acceptAvailable: boolean;
}

export interface XtmJobSnapshot {
  jobs: XtmRawJob[];
  malformed: unknown[];
  capturedAt: string;
  pollCycleId: string;
  emptyListConfirmed: boolean;
}

export interface JobSnapshot {
  jobs: RawJob[];
  malformed: unknown[];
  capturedAt: string;
  pollCycleId: string;
  emptyListConfirmed: boolean;
}

/** Persisted state of a job between poll cycles. */
export interface JobState {
  jobKey: string;
  portalJobId: string | null;
  title: string;
  languagePair: string | null;
  deadline: string | null;
  deadlineRaw: string | null;
  fee: string | null;
  url: string | null;
  status: 'visible' | 'missing';
  firstSeenAt: string;
  lastSeenAt: string;
  snapshotHash: string;
  consecutiveMisses: number;
}

export type AppearanceEventType = 'first_seen' | 'relisted' | 'missing' | 'cold_start';

export interface AppearanceEvent {
  jobKey: string;
  eventType: AppearanceEventType;
  occurredAt: string;
  pollCycleId: string;
  /** Snapshot of job fields at event time, for rendering notifications. */
  job: JobState;
  /** For relisted events: when this job was originally first seen. */
  firstSeenAt?: string;
}

/** A field-level change on a still-visible job (FR-019: silent, no notification). */
export interface DetailsChange {
  jobKey: string;
  changes: { field: string; from: string | null; to: string | null }[];
}

export interface DiffResult {
  events: AppearanceEvent[];
  nextStates: Map<string, JobState>;
  detailsChanges: DetailsChange[];
}
