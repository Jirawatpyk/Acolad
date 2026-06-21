import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Config schema (contracts/config.md). Required vars fail fast at startup with
 * a message naming the offending variable. POLL_INTERVAL_MS is clamped at the
 * schema level to [20000, 25000] so interval + jitter stays within [20s, 30s]
 * (FR-003) and no faster than 20s between requests (FR-011). 002 defaults the
 * poll to the 20s floor to win the <1min snatch window (R7).
 */
const schema = z.object({
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
  GOOGLE_CHAT_WEBHOOK_DAILY_REPORT: z.string().url().optional().or(z.literal('')),
  HEALTHCHECKS_PING_URL: z.string().url(),
  POLL_INTERVAL_MS: z.coerce.number().int().min(20_000).max(25_000).default(20_000),
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
  // sanitized) every cycle so a missed job can be seen from the bot's exact view. Noisy
  // (one capture per ~20s) — turn off after diagnosis.
  DIAG: z
    .string()
    .optional()
    .transform((v) => v === '1'),
});

export type AppConfig = z.infer<typeof schema>;

/** Variable names that MUST never appear in logs/alerts/evidence (FR-012). */
export const SECRET_KEYS = [
  'XTM_ACOLAD_Password',
  'XTM_ACOLAD_Username',
  'XTM_ACOLAD_Company',
  'GOOGLE_CHAT_WEBHOOK_SYSTEM',
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
