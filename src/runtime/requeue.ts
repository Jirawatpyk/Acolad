import { loadConfig } from '../config/index.js';
import { openDatabase } from '../state/db.js';
import { Outbox } from '../state/outbox.js';
import { systemClock } from './pollLoop.js';

/** Ops tool: requeue dead outbox rows back to pending (npm run outbox:requeue). */
function main(): void {
  const cfg = loadConfig();
  const opened = openDatabase(cfg.STATE_DIR, systemClock.nowIso());
  try {
    const outbox = new Outbox(opened.db, cfg.OUTBOX_RETRY_CAP, cfg.OUTBOX_DEAD_AFTER_HOURS);
    const dead = outbox.countByStatus('dead');
    const moved = outbox.requeueDead(systemClock.nowIso());
    console.log(`requeued ${moved} dead row(s) -> pending (was ${dead})`);
  } finally {
    opened.db.close();
  }
}

main();
