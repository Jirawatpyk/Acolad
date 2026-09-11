/**
 * Phase 0 probe configuration.
 *
 * Deliberately SEPARATE from `src/config/index.ts`: that schema fail-fasts on start for
 * the live XTM bot, so adding required STRAKER_* variables there would stop the running
 * bot dead the moment this file shipped. The probe validates only its own variables.
 */

import { z } from 'zod';

const schema = z.object({
  STRAKER_BASE_URL: z.string().url(),
  STRAKER_LOGIN_ID: z.string().min(1),
  STRAKER_PASSWORD: z.string().min(1),
  STRAKER_TOTP_CODE: z.string().min(1).optional(),
  // 10s = 6 req/min = 2% of the 300 req/min budget recon measured. The floor keeps a
  // fat-fingered value from turning a read-only probe into accidental load.
  STRAKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
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
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Straker recon config invalid — ${detail}`);
  }

  const value = parsed.data;
  return {
    baseUrl: value.STRAKER_BASE_URL,
    loginId: value.STRAKER_LOGIN_ID,
    password: value.STRAKER_PASSWORD,
    ...(value.STRAKER_TOTP_CODE === undefined ? {} : { totpCode: value.STRAKER_TOTP_CODE }),
    pollIntervalMs: value.STRAKER_POLL_INTERVAL_MS,
    captureDir: value.STRAKER_CAPTURE_DIR,
  };
}
