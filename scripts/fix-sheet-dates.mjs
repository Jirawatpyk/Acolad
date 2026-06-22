/**
 * One-off: reformat the date columns of EXISTING Sheet rows to the readable
 * Bangkok-local "DD/MM/YYYY HH:mm" (same formatter the bot now uses for new rows).
 * Touches ONLY Received date (A), Due date (G), Accepted at (K), and only cells that
 * still hold an ISO timestamp (contain 'T') — so already-formatted or legacy values
 * are left untouched (idempotent, safe to re-run).
 */
import { google } from 'googleapis';
import { config as loadDotenv } from 'dotenv';
import { formatSheetDate } from '../dist/reporting/sheets.js';

loadDotenv();

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const TAB = process.env.SHEETS_TAB_NAME;
const KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || 'google-credentials.json';

const auth = new google.auth.GoogleAuth({
  keyFile: KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const reformat = (c) => (c && String(c).includes('T') ? formatSheetDate(String(c)) : (c ?? ''));

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: `${TAB}!A2:M`,
});
const rows = res.data.values ?? [];
if (rows.length === 0) {
  console.log('no data rows to reformat');
} else {
  const last = 1 + rows.length;
  let changed = 0;
  for (const row of rows) {
    for (const i of [0, 6, 10]) {
      if (reformat(row[i]) !== (row[i] ?? '')) changed++;
    }
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${TAB}!A2:A${last}`, values: rows.map((r) => [reformat(r[0])]) },
        { range: `${TAB}!G2:G${last}`, values: rows.map((r) => [reformat(r[6])]) },
        { range: `${TAB}!K2:K${last}`, values: rows.map((r) => [reformat(r[10])]) },
      ],
    },
  });
  console.log(`reformatted ${changed} date cell(s) across ${rows.length} row(s)`);
}
