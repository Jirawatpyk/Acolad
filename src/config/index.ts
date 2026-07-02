import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { unitOf } from '../schedule/effort.js';
import { parseHHMM, parseWorkdays, resolveThroughput } from '../schedule/parseSchedule.js';

loadDotenv();

/**
 * Config schema (contracts/config.md). Required vars fail fast at startup with
 * a message naming the offending variable. POLL_INTERVAL_MS is clamped at the
 * schema level to [20000, 25000] so interval + jitter stays within [20s, 30s]
 * (FR-003) and no faster than 20s between requests (FR-011). 002 defaults the
 * poll to the 20s floor to win the <1min snatch window (R7).
 */
const schema = z
  .object({
    // --- XTM Cloud (002 target) ---
    XTM_ACOLAD_PORTAL_URL: z.string().url(),
    XTM_ACOLAD_OFFERS_URL: z.string().url(),
    XTM_ACOLAD_CLOSED_URL: z.string().url().optional().or(z.literal('')),
    XTM_ACOLAD_Company: z.string().min(1),
    XTM_ACOLAD_Username: z.string().min(1),
    XTM_ACOLAD_Password: z.string().min(1),
    // --- Google Sheets (002 required) ---
    GOOGLE_SHEETS_ID: z.string().min(1),
    GOOGLE_SERVICE_ACCOUNT_KEY_PATH: z.string().min(1).default('google-credentials.json'),
    SHEETS_TAB_NAME: z.string().min(1),
    // --- Accept control (FR-012/025) ---
    ACCEPT_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === '1'),
    // Evidence-only: when 1 (and ACCEPT_ENABLED=0), capture the real per-row accept
    // menu DOM (hover only, NEVER clicks accept) so the live "Accept task" vs "Finish
    // task" signal can be confirmed and computed into acceptAvailable. Safe to leave on.
    ACCEPT_RECON: z
      .string()
      .optional()
      .transform((v) => v === '1'),
    ACCEPT_LANGUAGES: z
      .string()
      .default('Malay (Malaysia)')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ACCEPT_MAX_WORDS: z.coerce.number().int().min(0).default(0),
    ACCEPT_MAX_PER_CYCLE: z.coerce.number().int().min(0).default(0),
    GOOGLE_CHAT_WEBHOOK_SYSTEM: z.string().url(),
    GOOGLE_CHAT_WEBHOOK_TEAM: z.string().url(),
    GOOGLE_CHAT_WEBHOOK_DAILY_REPORT: z.string().url().optional().or(z.literal('')),
    HEALTHCHECKS_PING_URL: z.string().url(),
    POLL_INTERVAL_MS: z.coerce.number().int().min(20_000).max(25_000).default(20_000),
    // Port-bind single-instance lock token (src/runtime/singleInstance.ts). The bot binds
    // 127.0.0.1:<this> at startup; a second instance refuses. Change only if it ever clashes.
    // NOTE: scripts/deploy.ps1 hardcodes this same port and does NOT read .env — if you
    // override it here, change deploy.ps1's $Port too or the orphan-sweep watches the wrong port.
    SINGLE_INSTANCE_PORT: z.coerce.number().int().min(1).max(65_535).default(47811),
    LOGIN_MAX_RETRY: z.coerce.number().int().positive().default(3),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
    BROWSER_RECYCLE_HOURS: z.coerce.number().int().positive().default(6),
    OUTBOX_RETRY_CAP: z.coerce.number().int().positive().default(10),
    OUTBOX_DEAD_AFTER_HOURS: z.coerce.number().int().positive().default(6),
    REQUESTS_PER_HOUR_CAP: z.coerce.number().int().positive().default(180),
    LOG_DIR: z.string().default('logs'),
    STATE_DIR: z.string().default('state'),
    TZ_DISPLAY: z.string().default('Asia/Bangkok'),
    LIVE_PORTAL: z
      .string()
      .optional()
      .transform((v) => v === '1'),
    // Diagnostic: when 1, capture the bot's OWN rendered inbox (HTML + iframe + screenshot,
    // sanitized) so a missed job can be seen from the bot's exact view. Throttled to ~60s
    // in xtmPollLoop (≈ every 3rd cycle at the 20s poll) — turn off after diagnosis.
    DIAG: z
      .string()
      .optional()
      .transform((v) => v === '1'),
    // --- auto-yield (shared-account session-collision back-off) ---
    XTM_YIELD_ENABLED: z
      .string()
      .optional()
      .transform((v) => {
        const s = (v ?? '').trim().toLowerCase();
        return !['0', 'false', 'off', 'no'].includes(s);
      }), // default ON; '0'/'false'/'off'/'no' disables
    XTM_YIELD_WINDOW_MS: z.coerce.number().int().positive().default(600_000),
    XTM_YIELD_MAX_MINUTES: z.coerce.number().int().positive().default(60),
    // --- Accept schedule (when to accept, capacity limits, throughput) ---
    ACCEPT_SCHEDULE_ENABLED: z
      .string()
      .optional()
      .transform((v) => {
        const s = (v ?? '').trim().toLowerCase();
        return !['0', 'false', 'off', 'no'].includes(s);
      }), // default ON; '0'/'false'/'off'/'no' disables
    ACCEPT_HOURS_START: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ACCEPT_HOURS_START must be in HH:MM format (e.g. 09:00)')
      .default('09:00'),
    ACCEPT_HOURS_END: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ACCEPT_HOURS_END must be in HH:MM format (e.g. 18:00)')
      .default('18:00'),
    ACCEPT_WORKDAYS: z
      .string()
      .default('1-5')
      .refine((s) => {
        try {
          parseWorkdays(s);
          return true;
        } catch {
          return false;
        }
      }, 'ACCEPT_WORKDAYS must be a valid day-of-week spec (e.g. 1-5 or 1,3,5)'),
    ACCEPT_MAX_WORDS_PER_DAY: z.coerce.number().int().min(0).default(1000),
    ACCEPT_EFFORT_METRIC: z.enum(['wwc', 'words']).default('wwc'),
    ACCEPT_MAX_WWC_PER_DAY: z.coerce.number().int().min(0).default(1000),
    ACCEPT_THROUGHPUT_WWC_PER_HOUR: z.preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.coerce.number().positive().optional(),
    ),
    // Use preprocess to distinguish "unset" from empty string — Number('') === 0 which
    // would look like an explicit zero and not trigger the derived-throughput path.
    ACCEPT_THROUGHPUT_WORDS_PER_HOUR: z.preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.coerce.number().positive().optional(),
    ),
  })
  // Derive schedule fields once at load so consumers never need to re-parse.
  // Field-level regex/refines above guarantee parseHHMM/parseWorkdays won't throw here.
  .transform((c) => {
    const hoursStartMin = parseHHMM(c.ACCEPT_HOURS_START);
    const hoursEndMin = parseHHMM(c.ACCEPT_HOURS_END);
    // ReadonlySet: consumers only `.has()` it; typing it read-only stops a caller from
    // mutating the shared derived config (Set is assignable to ReadonlySet).
    const workdays: ReadonlySet<number> = parseWorkdays(c.ACCEPT_WORKDAYS);
    const activeMaxPerDay =
      c.ACCEPT_EFFORT_METRIC === 'wwc' ? c.ACCEPT_MAX_WWC_PER_DAY : c.ACCEPT_MAX_WORDS_PER_DAY;
    const activeOverride =
      c.ACCEPT_EFFORT_METRIC === 'wwc'
        ? c.ACCEPT_THROUGHPUT_WWC_PER_HOUR
        : c.ACCEPT_THROUGHPUT_WORDS_PER_HOUR;
    const throughputPerHour = resolveThroughput({
      ...(activeOverride !== undefined ? { explicit: activeOverride } : {}),
      maxWordsPerDay: activeMaxPerDay, // param name is legacy; it is the ACTIVE cap
      hoursStartMin,
      hoursEndMin,
    });
    const unit = unitOf(c.ACCEPT_EFFORT_METRIC);
    return {
      ...c,
      hoursStartMin,
      hoursEndMin,
      workdays,
      activeMaxPerDay,
      throughputPerHour,
      unit,
    };
  })
  // Only enforce the window floor when yield is ENABLED — otherwise a stale/small window
  // value would block the kill-switch (an operator must always be able to disable the
  // feature without first fixing an unrelated value). F7.
  .refine((c) => !c.XTM_YIELD_ENABLED || c.XTM_YIELD_WINDOW_MS >= 3 * c.POLL_INTERVAL_MS, {
    path: ['XTM_YIELD_WINDOW_MS'],
    message:
      'XTM_YIELD_WINDOW_MS must be >= 3 x POLL_INTERVAL_MS (yield would otherwise be a no-op)',
  })
  // Schedule refines only apply when ACCEPT_SCHEDULE_ENABLED — the kill-switch must
  // always let an operator disable without first fixing unrelated values.
  .refine((c) => !c.ACCEPT_SCHEDULE_ENABLED || c.hoursStartMin < c.hoursEndMin, {
    path: ['ACCEPT_HOURS_END'],
    message: 'ACCEPT_HOURS_END must be after ACCEPT_HOURS_START',
  })
  .refine(
    (c) =>
      !c.ACCEPT_SCHEDULE_ENABLED ||
      // wwc: words-params inactive; throughput validated by the active-cap refines below
      c.ACCEPT_EFFORT_METRIC === 'wwc' ||
      c.ACCEPT_THROUGHPUT_WORDS_PER_HOUR !== undefined ||
      c.ACCEPT_MAX_WORDS_PER_DAY > 0,
    {
      path: ['ACCEPT_THROUGHPUT_WORDS_PER_HOUR'],
      message:
        'set ACCEPT_THROUGHPUT_WORDS_PER_HOUR (>0) or ACCEPT_MAX_WORDS_PER_DAY (>0) so throughput is resolvable',
    },
  )
  // Capacity cap must be positive when the gate is on — an override must NOT except it, so this is
  // a SEPARATE refine from throughput-resolvability. Both gate behind ACCEPT_SCHEDULE_ENABLED so the
  // kill-switch always lets an operator disable without fixing unrelated values.
  // I-2: superRefine so the error path names the ACTIVE metric's var (ACCEPT_MAX_WWC_PER_DAY in
  // wwc mode, ACCEPT_MAX_WORDS_PER_DAY in words mode) — an operator in words mode seeing the wrong
  // var name would fix the wrong knob → prolonged outage.
  .superRefine((c, ctx) => {
    if (c.ACCEPT_SCHEDULE_ENABLED && c.activeMaxPerDay <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [
          c.ACCEPT_EFFORT_METRIC === 'wwc' ? 'ACCEPT_MAX_WWC_PER_DAY' : 'ACCEPT_MAX_WORDS_PER_DAY',
        ],
        message: 'the active daily cap must be > 0 when the schedule gate is on',
      });
    }
  })
  .refine((c) => !c.ACCEPT_SCHEDULE_ENABLED || c.throughputPerHour > 0, {
    path: ['ACCEPT_THROUGHPUT_WWC_PER_HOUR'],
    message: 'throughput must be resolvable to > 0 for the active metric',
  });

export type AppConfig = z.infer<typeof schema>;

/** Variable names that MUST never appear in logs/alerts/evidence (FR-012). */
export const SECRET_KEYS = [
  'XTM_ACOLAD_Password',
  'XTM_ACOLAD_Username',
  'XTM_ACOLAD_Company',
  'GOOGLE_CHAT_WEBHOOK_SYSTEM',
  'GOOGLE_CHAT_WEBHOOK_TEAM',
  'GOOGLE_CHAT_WEBHOOK_DAILY_REPORT',
  'HEALTHCHECKS_PING_URL',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Concrete secret values to redact from any emitted text (derived from config). */
export function secretValues(cfg: AppConfig): string[] {
  return SECRET_KEYS.map((k) => cfg[k]).filter((v): v is string => Boolean(v));
}
