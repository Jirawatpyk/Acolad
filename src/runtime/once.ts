import { ColdStartHistory } from './coldStartHistory.js';
import { createBot } from './bootstrap.js';
import { systemClock } from '../clock.js';

/** Run a single poll cycle then exit (smoke test — npm run poll:once). */
async function main(): Promise<void> {
  const { cfg, db, client, loop } = createBot();
  try {
    const ok = await loop.runOnce();
    console.log(ok ? 'poll:once OK' : 'poll:once completed with errors (see logs/alerts)');
    if (ok) new ColdStartHistory(cfg.LOG_DIR).record(systemClock.nowIso());
  } finally {
    await client.dispose();
    db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
