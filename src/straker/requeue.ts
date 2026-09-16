/**
 * `npm run straker:outbox:requeue` — bring dead Straker outcomes back to pending.
 *
 * ## Why this exists
 *
 * `outbox.ts` says "**Dead is visible, not lost**: a dead row still holds its payload and
 * `requeueDead` brings it back, which is what an operator does after fixing a webhook."
 * That sentence was false for as long as there was no caller. `npm run outbox:requeue`
 * opens the **XTM** database through `src/config/index.ts`, which Straker may not import
 * (R11) and whose `STATE_DIR` is not Straker's anyway — so bringing a dead Straker row back
 * meant hand-written SQL, and in practice meant losing the outcome.
 *
 * A dead row is a won claim nobody was told about, or a tracking row the record never got.
 * Reconciliation does not repair either: the work *is* held, so it finds nothing missing.
 *
 * ## What it does, and what it deliberately does not
 *
 * It moves every `dead` row back to `pending` and lets the dispatcher try again on the next
 * cycle. It does **not** send anything itself — a second sender would be a second place for
 * the delivery rules to live, and the dispatcher already owns them.
 *
 * Run it **after** fixing the destination. Requeuing into a webhook that is still revoked
 * just spends the retry ladder again and returns the rows to `dead`.
 *
 * Reads only `STRAKER_STATE_DIR`, not the full bot configuration: an ops tool that moves
 * rows between two states has no use for a portal password, and putting one within reach of
 * it is a cost with no benefit — the reasoning `winRateReport.ts` established.
 */

import { config as loadDotenv } from 'dotenv';
import { StrakerOutbox } from './outbox.js';
import { STRAKER_DEFAULT_STATE_DIR } from './combinedSummary.js';
import { openStrakerDatabase } from './strakerStore.js';

function main(): void {
  loadDotenv();
  const stateDir = (process.env['STRAKER_STATE_DIR'] ?? '').trim() || STRAKER_DEFAULT_STATE_DIR;
  const nowMs = Date.now();

  const opened = openStrakerDatabase(stateDir, nowMs);
  try {
    const outbox = new StrakerOutbox(opened.db);
    const dead = outbox.countByStatus('dead');
    if (dead === 0) {
      process.stdout.write(`no dead rows in ${stateDir} — nothing to requeue\n`);
      return;
    }
    const moved = outbox.requeueDead(nowMs);
    process.stdout.write(
      `requeued ${String(moved)} dead outcome(s) -> pending in ${stateDir}\n` +
        'they go out on the next poll cycle; the bot stops failing its heartbeat once the queue drains\n',
    );
  } finally {
    opened.db.close();
  }
}

main();
