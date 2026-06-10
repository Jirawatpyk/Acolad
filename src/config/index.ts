import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/**
 * Config schema (contracts/config.md). Required vars fail fast at startup with
 * a message naming the offending variable. POLL_INTERVAL_MS is clamped at the
 * schema level to [20000, 25000] so interval + jitter stays within [20s, 30s]
 * (FR-003) and no faster than 20s between requests (FR-011).
 */
const schema = z.object({
  ACOLAD_PORTAL_URL: z.string().url(),
  ACOLAD_OFFERS_URL: z
    .string()
    .url()
    .default('https://partner.acolad.com/project/offer/list/pending?view=card&grouped=false'),
  ACOLAD_EMAIL: z.string().min(1),
  ACOLAD_PASSWORD: z.string().min(1),
  GOOGLE_CHAT_WEBHOOK_SYSTEM: z.string().url(),
  GOOGLE_CHAT_WEBHOOK_DAILY_REPORT: z.string().url().optional().or(z.literal('')),
  HEALTHCHECKS_PING_URL: z.string().url(),
  POLL_INTERVAL_MS: z.coerce.number().int().min(20_000).max(25_000).default(25_000),
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
});

export type AppConfig = z.infer<typeof schema>;

/** Variable names that MUST never appear in logs/alerts/evidence (FR-012). */
export const SECRET_KEYS = [
  'ACOLAD_PASSWORD',
  'ACOLAD_EMAIL',
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
