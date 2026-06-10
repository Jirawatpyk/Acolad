import { loadConfig } from '../config/index.js';
import { openDatabase } from '../state/db.js';
import { createOutbox } from '../state/outbox.js';
import { systemClock } from '../clock.js';

/** Ops tool: requeue dead outbox rows back to pending (npm run outbox:requeue). */
function main(): void {
  const cfg = loadConfig();
  const opened = openDatabase(cfg.STATE_DIR, systemClock.nowIso());
  try {
    const outbox = createOutbox(opened.db, cfg);
    const dead = outbox.countByStatus('dead');
    const moved = outbox.requeueDead(systemClock.nowIso());
    console.log(`requeued ${moved} dead row(s) -> pending (was ${dead})`);
  } finally {
    opened.db.close();
  }
}

main();
