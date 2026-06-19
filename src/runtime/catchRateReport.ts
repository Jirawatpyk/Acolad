import { google } from 'googleapis';
import { loadConfig } from '../config/index.js';

export interface CatchRate {
  accepted: number;
  missing: number;
  failed: number;
  /** Accepted / (Accepted + Missing + Accept failed) as a percentage; null if none decided. */
  ratePct: number | null;
}

/**
 * SC-001 catch rate from the Sheet data rows (no header). Counts only bot-managed
 * Malay rows (those with a `_job_key`, FR-026) whose status is one of the decided
 * outcomes. Pure — the runner supplies the rows. Column layout (0-based):
 * B(1)=Status, F(5)=Target, M(12)=_job_key (contracts/sheets.md).
 */
export function computeCatchRate(rows: string[][], acceptLanguages: string[]): CatchRate {
  const norm = (s: string | undefined): string => (s ?? '').trim().toLowerCase();
  const langs = acceptLanguages.map(norm);
  let accepted = 0;
  let missing = 0;
  let failed = 0;
  for (const row of rows) {
    const key = row[12];
    if (!key || key === '') continue; // historical / non-bot row (FR-026)
    if (!langs.includes(norm(row[5]))) continue; // non-Malay
    const status = row[1];
    if (status === 'Accepted') accepted++;
    else if (status === 'Missing') missing++;
    else if (status === 'Accept failed') failed++;
  }
  const denom = accepted + missing + failed;
  return { accepted, missing, failed, ratePct: denom === 0 ? null : (accepted / denom) * 100 };
}

/** Runner (npm run report:catch-rate): read the Sheet and print SC-001. */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const auth = new google.auth.GoogleAuth({
    keyFile: cfg.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: cfg.GOOGLE_SHEETS_ID,
    range: `${cfg.SHEETS_TAB_NAME}!A:M`,
  });
  const all = (res.data.values ?? []) as string[][];
  const cr = computeCatchRate(all.slice(1), cfg.ACCEPT_LANGUAGES); // slice off the header
  const rate = cr.ratePct === null ? 'n/a (ยังไม่มีงานที่ตัดสินผล)' : `${cr.ratePct.toFixed(1)}%`;
  console.log(
    `SC-001 catch rate (มาเลย์): ${rate} — accepted ${cr.accepted} / (accepted ${cr.accepted} + missing ${cr.missing} + accept_failed ${cr.failed})`,
  );
}

// Run only when invoked as the entrypoint (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith('catchRateReport.js')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
