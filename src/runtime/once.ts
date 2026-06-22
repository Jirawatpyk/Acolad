import { ColdStartHistory } from './coldStartHistory.js';
import { createXtmBot } from './bootstrap.js';
import { systemClock } from '../clock.js';
import { loadConfig } from '../config/index.js';
import { acquireSingleInstanceLock } from './singleInstance.js';
import { withTimeout } from '../withTimeout.js';

/** Run a single poll cycle then exit (smoke test — npm run poll:once). */
async function main(): Promise<void> {
  const cfg0 = loadConfig();
  // Single-instance: refuse if the 24/7 bot (or another poll:once) is running — a concurrent
  // poll on the shared account could double-accept. Stop the bot before poll:once.
  let release: () => Promise<void>;
  try {
    release = await acquireSingleInstanceLock({ port: cfg0.SINGLE_INSTANCE_PORT, retryMs: 0 });
  } catch {
    console.error(
      `acolad-bot: another instance owns port ${cfg0.SINGLE_INSTANCE_PORT} — stop the bot before poll:once.`,
    );
    process.exit(1);
    return;
  }

  const { cfg, db, client, loop } = createXtmBot();
  try {
    const ok = await loop.runOnce();
    console.log(ok ? 'poll:once OK' : 'poll:once completed with errors (see logs/alerts)');
    if (ok) new ColdStartHistory(cfg.LOG_DIR).record(systemClock.nowIso());
  } finally {
    // Bounded + non-throwing (withTimeout never rejects), so db.close()/release() always run
    // even if Chromium hangs — mirrors main.ts so poll:once can't hang or strand the lock.
    await withTimeout(client.dispose(), 8_000);
    db.close();
    await release().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
