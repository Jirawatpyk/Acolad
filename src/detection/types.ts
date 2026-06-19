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

/**
 * The appearance bookkeeping every persisted job state carries (owned by diff).
 * Both the partner JobState and XtmJobState extend this so the diff algorithm is
 * generic over the portal-specific fields.
 */
export interface BaseJobState {
  jobKey: string;
  status: 'visible' | 'missing';
  firstSeenAt: string;
  lastSeenAt: string;
  snapshotHash: string;
  consecutiveMisses: number;
}

/** Persisted state of a partner-portal job between poll cycles. */
export interface JobState extends BaseJobState {
  portalJobId: string | null;
  title: string;
  languagePair: string | null;
  deadline: string | null;
  deadlineRaw: string | null;
  fee: string | null;
  url: string | null;
}

export type XtmLifecycleStatus =
  | 'new'
  | 'accepted'
  | 'skipped'
  | 'missing'
  | 'accept_failed'
  | 'closed'
  | 'removed';

export type XtmAcceptStatus = 'none' | 'accepting' | 'accepted' | 'failed';

/** Persisted state of an XTM job between poll cycles (appearance + business fields). */
export interface XtmJobState extends BaseJobState {
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
  eligible: boolean;
  lifecycleStatus: XtmLifecycleStatus;
  acceptStatus: XtmAcceptStatus;
  acceptedAt: string | null;
}

export type AppearanceEventType = 'first_seen' | 'relisted' | 'missing' | 'cold_start';

/** An appearance event, generic over the job-state shape it carries. */
export interface AppearanceEventOf<S> {
  jobKey: string;
  eventType: AppearanceEventType;
  occurredAt: string;
  pollCycleId: string;
  /** Snapshot of job fields at event time, for rendering notifications. */
  job: S;
  /** For relisted events: when this job was originally first seen. */
  firstSeenAt?: string;
}
export type AppearanceEvent = AppearanceEventOf<JobState>;

/** A field-level change on a still-visible job (FR-019: silent, no notification). */
export interface DetailsChange {
  jobKey: string;
  changes: { field: string; from: string | null; to: string | null }[];
}

export interface DiffResultOf<S> {
  events: AppearanceEventOf<S>[];
  nextStates: Map<string, S>;
  detailsChanges: DetailsChange[];
}
export type DiffResult = DiffResultOf<JobState>;

/**
 * Injected per-portal hooks that let the generic diff produce/refresh states and
 * keys without knowing the portal-specific fields (Constitution I). The appearance
 * algorithm (first_seen / missing / relisted) lives once in diff; partner and XTM
 * each provide an adapter.
 */
export interface DiffAdapter<Raw, State extends BaseJobState> {
  key(raw: Raw): string;
  hash(raw: Raw): string;
  build(key: string, raw: Raw, at: string, hash: string): State;
  apply(existing: State, raw: Raw, hash: string): State;
  changes(prev: State, raw: Raw): DetailsChange['changes'];
}
