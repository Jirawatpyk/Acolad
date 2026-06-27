/**
 * One-off correction: captions.json WAS accepted live (user-confirmed, menu shows
 * Finish task) but the pre-fix stale re-read recorded it accept_failed. Set its true
 * state in BOTH the bot DB and the Sheet so they agree and the bot does not later
 * re-write a wrong status when the job leaves Active. Run with the bot STOPPED (the
 * DB write would otherwise be clobbered by the next cycle's upsert).
 */
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import { config as loadDotenv } from 'dotenv';
import { formatSheetDate } from '../dist/reporting/sheets.js';

loadDotenv();

const JOB_KEY = '4716302-1-19 (id-b2cf8d0d04bd)_captions.json|post-editing (pe) 1|corrector';
const ACCEPTED_AT = '2026-06-22T11:14:00.000Z'; // ~18:14 +07, when the bot clicked accept

// 1) Bot DB
const db = new Database('state/acolad.db');
const info = db
  .prepare(
    "UPDATE jobs SET accept_status='accepted', lifecycle_status='accepted', accepted_at=? WHERE job_key=?",
  )
  .run(ACCEPTED_AT, JOB_KEY);
console.log(`DB: updated ${info.changes} row (accept_status=accepted)`);
db.close();

// 2) Sheet row (status col B + accepted-at col K), found by _job_key in col M
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || 'google-credentials.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });
const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const TAB = process.env.SHEETS_TAB_NAME;

const mcol =
  (await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${TAB}!M:M` })).data
    .values ?? [];
const idx = mcol.findIndex((r) => (r[0] ?? '') === JOB_KEY);
if (idx === -1) {
  console.log('Sheet: captions row not found (col M)');
} else {
  const rowNum = idx + 1;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${TAB}!B${rowNum}`, values: [['Accepted']] },
        { range: `${TAB}!K${rowNum}`, values: [[formatSheetDate(ACCEPTED_AT)]] },
        { range: `${TAB}!L${rowNum}`, values: [['']] }, // clear the stale failure note
      ],
    },
  });
  console.log(`Sheet: row ${rowNum} → Accepted, acceptedAt=${formatSheetDate(ACCEPTED_AT)}`);
}
