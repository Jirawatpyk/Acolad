/**
 * `npm run straker:unbar` — let the bot claim again after the portal barred the account.
 *
 * ## Why this is a command and not a rule
 *
 * Contract §4a says a barred account means "alert immediately and **stop claiming**", and
 * never retry around it. T073 found that the flag implementing "stop" lived inside one
 * `runOnce()`, so the stop lasted ten seconds — the bot went straight back to a portal that
 * had already refused, which is how a suspension becomes permanent rather than temporary.
 *
 * Making it durable raised the question the code cannot answer on its own: **what lifts it?**
 * A successful sign-in is the obvious candidate and is the wrong one, because an account can
 * be signed in and barred at the same moment. Every other signal the bot can observe has the
 * same defect — none of them is the thing that actually changed, which is a human at Straker
 * deciding this account may claim again. So a human tells the bot, and this is how.
 *
 * ## What it does, and what it deliberately does not
 *
 * It deletes one row. It does **not** check with the portal first: a probe claim to find out
 * whether the bar is lifted is exactly the retry contract §4a forbids, and would spend the
 * account's goodwill to answer a question the operator already knows the answer to.
 *
 * Run it **after** Straker confirms the account may claim again. Running it while the bar
 * still stands simply earns another 403 on the next cycle, which re-bars and re-alerts.
 *
 * Reads only `STRAKER_STATE_DIR`, not the full bot configuration — the reasoning
 * `winRateReport.ts` established and `requeue.ts` follows: an ops tool that flips one flag
 * has no use for a portal password, and putting one within its reach is a cost with no gain.
 */

import { config as loadDotenv } from 'dotenv';
import { STRAKER_DEFAULT_STATE_DIR } from './combinedSummary.js';
import { StrakerStore, openStrakerDatabase } from './strakerStore.js';

function main(): void {
  loadDotenv();
  const stateDir = (process.env['STRAKER_STATE_DIR'] ?? '').trim() || STRAKER_DEFAULT_STATE_DIR;
  const nowMs = Date.now();

  const opened = openStrakerDatabase(stateDir, nowMs);
  try {
    const store = new StrakerStore(opened.db);
    const barredSince = store.barredSinceMs();
    if (barredSince === null) {
      process.stdout.write(
        `claiming is not barred in ${stateDir} — nothing to clear\n` +
          'if the bot is still not claiming, the reason is something else: check the logs for ' +
          'claiming_halted, and the ceiling with `npm run report:combined`\n',
      );
      return;
    }

    store.clearBar();
    const heldFor = Math.round((nowMs - barredSince) / 60_000);
    process.stdout.write(
      `claiming unbarred in ${stateDir} — it had been barred since ` +
        `${new Date(barredSince).toISOString()} (${String(heldFor)} minutes)\n` +
        'the next poll cycle claims again; a portal that still refuses will re-bar and re-alert\n',
    );
  } finally {
    opened.db.close();
  }
}

main();
