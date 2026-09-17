/**
 * Straker configuration — TWO loaders, deliberately.
 *
 * Deliberately SEPARATE from `src/config/index.ts`: that schema fail-fasts on start for
 * the live XTM bot, so adding required STRAKER_* variables there would stop the running
 * bot dead the moment this file shipped.
 *
 * The same hazard exists one level down, which is why the probe's loader is NOT widened
 * into the bot's: `jobcatch-straker-recon` is running in production right now, and a new
 * required field in its schema would fail-fast the probe mid-capture — losing exactly the
 * SC-000 evidence the bot is waiting for. `loadStrakerReconConfig` therefore stays as it
 * was; `loadStrakerBotConfig` layers the bot's own variables on top of the same base.
 */

import { z } from 'zod';
import { parseHHMM, parseWorkdays, resolveThroughput } from '../schedule/parseSchedule.js';

/** What the probe and the bot both need: where the portal is and who we sign in as. */
const portalShape = {
  STRAKER_BASE_URL: z.string().url(),
  STRAKER_LOGIN_ID: z.string().min(1),
  STRAKER_PASSWORD: z.string().min(1),
  STRAKER_TOTP_CODE: z.string().min(1).optional(),
  // 10s = 6 req/min = 2% of the 300 req/min budget recon measured. The floor keeps a
  // fat-fingered value from turning a read-only probe into accidental load.
  //
  // Kept at 10s for the BOT too, and now on evidence rather than on the probe-era guess
  // (decided 2026-09-15, spec.md §Clarifications): the shortest observed window between an
  // offer appearing and a competitor taking it was 204 seconds, so a ten-second rhythm sees
  // it with ~194 seconds to spare. A one-second rhythm would buy nine of those seconds and
  // cost ten times the request budget against an allowance the bot must never crowd
  // (SC-003). Revisit if a materially shorter lifetime is ever measured.
  STRAKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
};

const reconSchema = z.object({
  ...portalShape,
  STRAKER_CAPTURE_DIR: z.string().min(1).default('fixtures/straker'),
});

export interface StrakerReconConfig {
  readonly baseUrl: string;
  readonly loginId: string;
  readonly password: string;
  readonly totpCode?: string;
  readonly pollIntervalMs: number;
  readonly captureDir: string;
}

export function loadStrakerReconConfig(env: NodeJS.ProcessEnv): StrakerReconConfig {
  const value = parseOrThrow(reconSchema, env, 'Straker recon config invalid');
  return {
    baseUrl: value.STRAKER_BASE_URL,
    loginId: value.STRAKER_LOGIN_ID,
    password: value.STRAKER_PASSWORD,
    ...(value.STRAKER_TOTP_CODE === undefined ? {} : { totpCode: value.STRAKER_TOTP_CODE }),
    pollIntervalMs: value.STRAKER_POLL_INTERVAL_MS,
    captureDir: value.STRAKER_CAPTURE_DIR,
  };
}

/** The port and state directory the live XTM bot owns; Straker may never take either. */
const XTM_SINGLE_INSTANCE_PORT = 47811;
const XTM_STATE_DIR = 'state';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const botSchema = z
  .object({
    ...portalShape,

    // --- Straker's OWN ceiling and throughput (FR-009) -----------------------------
    // Never read from, never shared with, the XTM bot's ACCEPT_MAX_* figures. Required
    // rather than defaulted: a ceiling guessed by the code is a commitment nobody made.
    STRAKER_MAX_WORDS_PER_DAY: z.coerce.number().int().positive(),
    STRAKER_THROUGHPUT_WORDS_PER_HOUR: z.coerce.number().positive().optional(),

    // --- The same two knobs again, for work that is not translation (2026-09-17) ---------
    // The portal offers DTP preparation: source and target are the same language, and the
    // offer carries `target_lang: null` because there is nothing to translate into. Word
    // count is a poor measure of that work — a 956-word document might be an hour of
    // formatting or four — so it gets its OWN budget rather than spending the translation
    // one. Without this, three DTP jobs would exhaust the translation ceiling for the day
    // and the bot would refuse real translation work it had capacity for.
    STRAKER_DTP_MAX_WORDS_PER_DAY: z.coerce.number().int().positive(),
    STRAKER_DTP_THROUGHPUT_WORDS_PER_HOUR: z.coerce.number().positive().optional(),

    // --- Isolation from the live XTM bot (FR-024) ----------------------------------
    STRAKER_SINGLE_INSTANCE_PORT: z.coerce.number().int().min(1).max(65_535).default(47812),
    STRAKER_STATE_DIR: z.string().min(1).default('state/straker'),

    // --- Reporting: its own file and its own channel (FR-014, FR-015) --------------
    STRAKER_SHEETS_ID: z.string().min(1),
    STRAKER_SHEETS_TAB_NAME: z.string().min(1).default('Straker_Tracking'),
    // The SAME variable the XTM bot reads, for the same reason `GOOGLE_CHAT_WEBHOOK_SYSTEM`
    // is shared: one machine, one service account, one key file. Two bots able to point at
    // different credentials is a way to fail, not a capability. The sheet ID above is the
    // opposite case and must be Straker's own — the two records are separate files (FR-014).
    GOOGLE_SERVICE_ACCOUNT_KEY_PATH: z.string().min(1).default('google-credentials.json'),
    STRAKER_CHAT_WEBHOOK_OFFERS: z.string().url(),
    // Alerts stay unified (FR-026b): this is the SAME variable the XTM bot reads, on
    // purpose. On-call watches one place, so the two bots must not be able to drift onto
    // different alert destinations — sharing the variable is what guarantees they cannot.
    GOOGLE_CHAT_WEBHOOK_SYSTEM: z.string().url(),

    // --- Its own liveness signal (FR-026a) -----------------------------------------
    STRAKER_HEALTHCHECKS_PING_URL: z.string().url(),

    // --- Eligibility (FR-011 + the exclusion-list lever) ---------------------------
    // Defaults to empty so the agreed behaviour — all 44 registered directions — is
    // unchanged. It exists so an unstaffable direction is a setting change, not a release.
    STRAKER_EXCLUDED_LANGUAGE_PAIRS: z.string().default(''),

    STRAKER_LOG_DIR: z.string().min(1).default('logs'),

    // --- The team's scheduling rules, reused unchanged ------------------------------
    // Read from the SAME variables the XTM bot reads: the spec reuses the team's working
    // hours, workdays and holiday calendar wholesale, and only the ceiling and throughput
    // figures are Straker's own. Straker-only copies of these would let the two bots
    // disagree about when the team works, which is not a difference anyone intends.
    ACCEPT_HOURS_START: z.string().regex(HHMM, 'must be HH:MM').default('09:00'),
    ACCEPT_HOURS_END: z.string().regex(HHMM, 'must be HH:MM').default('18:00'),
    ACCEPT_WORKDAYS: z
      .string()
      .default('1-5')
      .superRefine((s, ctx) => {
        try {
          parseWorkdays(s);
        } catch (e) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
        }
      }),
  })
  .superRefine((c, ctx) => {
    // Both guards are config-level on purpose. Left to runtime, a shared port means one
    // bot silently refusing to start, and a shared state directory means two processes
    // opening one SQLite file — the exact bulkhead breach the separate-store rule exists
    // to prevent, and the kind that shows up as corruption rather than as an error.
    if (c.STRAKER_SINGLE_INSTANCE_PORT === XTM_SINGLE_INSTANCE_PORT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRAKER_SINGLE_INSTANCE_PORT'],
        message: `must not be ${XTM_SINGLE_INSTANCE_PORT} — the XTM bot holds that port`,
      });
    }
    if (normalizeDir(c.STRAKER_STATE_DIR) === normalizeDir(XTM_STATE_DIR)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STRAKER_STATE_DIR'],
        message: `must not be the XTM bot state directory (${XTM_STATE_DIR})`,
      });
    }
    if (parseHHMM(c.ACCEPT_HOURS_END) <= parseHHMM(c.ACCEPT_HOURS_START)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ACCEPT_HOURS_END'],
        message: 'must be later than ACCEPT_HOURS_START',
      });
    }
  });

export interface StrakerBotConfig {
  readonly baseUrl: string;
  readonly loginId: string;
  readonly password: string;
  readonly totpCode?: string;
  /** Independent of the XTM bot's rhythm (FR-001); the value itself is set from the
   *  measured offer lifetime once the capture probe reaches its exit (SC-000). */
  readonly pollIntervalMs: number;

  /** Where the Google service-account key lives. Shared with the XTM bot by design. */
  readonly serviceAccountKeyPath: string;
  readonly maxWordsPerDay: number;
  readonly throughputWordsPerHour: number;
  /** The separate budget for non-translation work (DTP), and its derived rate. */
  readonly dtpMaxWordsPerDay: number;
  readonly dtpThroughputWordsPerHour: number;

  readonly singleInstancePort: number;
  readonly stateDir: string;
  readonly logDir: string;

  readonly trackingSheetId: string;
  readonly trackingTabName: string;
  readonly offersWebhookUrl: string;
  readonly alertsWebhookUrl: string;
  readonly healthcheckPingUrl: string;

  /** Lower-cased so a comparison never turns on how the portal cased its identifiers. */
  readonly excludedLanguagePairs: readonly string[];

  readonly hoursStartMin: number;
  readonly hoursEndMin: number;
  readonly workdays: ReadonlySet<number>;
}

export function loadStrakerBotConfig(env: NodeJS.ProcessEnv): StrakerBotConfig {
  const c = parseOrThrow(botSchema, env, 'Straker bot config invalid');

  const hoursStartMin = parseHHMM(c.ACCEPT_HOURS_START);
  const hoursEndMin = parseHHMM(c.ACCEPT_HOURS_END);

  return {
    baseUrl: c.STRAKER_BASE_URL,
    loginId: c.STRAKER_LOGIN_ID,
    password: c.STRAKER_PASSWORD,
    ...(c.STRAKER_TOTP_CODE === undefined ? {} : { totpCode: c.STRAKER_TOTP_CODE }),
    pollIntervalMs: c.STRAKER_POLL_INTERVAL_MS,

    serviceAccountKeyPath: c.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    maxWordsPerDay: c.STRAKER_MAX_WORDS_PER_DAY,
    // Same derivation the XTM bot uses (`resolveThroughput`), fed Straker's OWN ceiling:
    // one knob to turn, with an explicit override for the slowest direction the crew
    // plausibly handles — which the spec requires over an average across 44 directions.
    throughputWordsPerHour: resolveThroughput({
      ...(c.STRAKER_THROUGHPUT_WORDS_PER_HOUR === undefined
        ? {}
        : { explicit: c.STRAKER_THROUGHPUT_WORDS_PER_HOUR }),
      maxWordsPerDay: c.STRAKER_MAX_WORDS_PER_DAY,
      hoursStartMin,
      hoursEndMin,
    }),

    dtpMaxWordsPerDay: c.STRAKER_DTP_MAX_WORDS_PER_DAY,
    // Derived the same way, from the DTP ceiling — one knob per kind of work, matching how
    // the XTM bot resolves its own throughput.
    dtpThroughputWordsPerHour: resolveThroughput({
      ...(c.STRAKER_DTP_THROUGHPUT_WORDS_PER_HOUR === undefined
        ? {}
        : { explicit: c.STRAKER_DTP_THROUGHPUT_WORDS_PER_HOUR }),
      maxWordsPerDay: c.STRAKER_DTP_MAX_WORDS_PER_DAY,
      hoursStartMin,
      hoursEndMin,
    }),

    singleInstancePort: c.STRAKER_SINGLE_INSTANCE_PORT,
    stateDir: c.STRAKER_STATE_DIR,
    logDir: c.STRAKER_LOG_DIR,

    trackingSheetId: c.STRAKER_SHEETS_ID,
    trackingTabName: c.STRAKER_SHEETS_TAB_NAME,
    offersWebhookUrl: c.STRAKER_CHAT_WEBHOOK_OFFERS,
    alertsWebhookUrl: c.GOOGLE_CHAT_WEBHOOK_SYSTEM,
    healthcheckPingUrl: c.STRAKER_HEALTHCHECKS_PING_URL,

    excludedLanguagePairs: parseExclusionList(c.STRAKER_EXCLUDED_LANGUAGE_PAIRS),

    hoursStartMin,
    hoursEndMin,
    workdays: parseWorkdays(c.ACCEPT_WORKDAYS),
  };
}

/** Every secret the Straker bot holds, for the logger's value-level redaction. */
export function strakerSecretValues(cfg: StrakerBotConfig): string[] {
  return [
    cfg.password,
    cfg.totpCode,
    cfg.offersWebhookUrl,
    cfg.alertsWebhookUrl,
    cfg.healthcheckPingUrl,
  ].filter((v): v is string => typeof v === 'string' && v !== '');
}

function parseExclusionList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
}

/** Trailing slashes and back-slashes must not let a `state\` slip past the guard. */
function normalizeDir(dir: string): string {
  return dir.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * A blank line in a `.env` file means "not set", and every schema here has to see it that
 * way.
 *
 * dotenv turns `KEY=` into `''`, never `undefined` — while zod's `.optional()` and
 * `.default()` only treat `undefined` as absent, and `z.coerce.number()` turns `''` into 0.
 * So `.env.example`'s own bare lines ("empty = derived", "leave blank until 2FA is on")
 * produced a config error, and a first deploy would have been a PM2 crash loop with the
 * operator having followed the file exactly.
 *
 * Stripping blanks once, here, rather than wrapping eighteen fields individually: the cause
 * is a property of how `.env` files are read, not of any one variable, and a per-field fix
 * is one the next variable added would silently miss. A required variable left blank still
 * fails — it now fails as "Required", naming itself, instead of as a confusing type error.
 */
function stripBlanks(raw: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== '') out[key] = value;
  }
  return out;
}

/** One error shape for both loaders: the failing variable is always named. */
function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  env: NodeJS.ProcessEnv,
  prefix: string,
): z.infer<T> {
  const parsed = schema.safeParse(stripBlanks(env));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`${prefix} — ${detail}`);
  }
  return parsed.data as z.infer<T>;
}
