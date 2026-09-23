/**
 * `npm run straker:drop-phantom-holds` — clear the duplicate holds a languageless purchase
 * order left behind before reconciliation learned to match them (2026-09-23).
 *
 * ## What went wrong, and why a command rather than a migration
 *
 * A per-hour DIRECT job was won in seven language pairs. Its purchase orders came back with
 * empty language codes, so they all keyed `<ref>||<service>` — a *bucket*, not an identity —
 * matched none of the seven claims, and were recovered as work nobody had recorded. Thirteen
 * holds for seven jobs, and a recovery event apiece inflating the win rate.
 *
 * The code no longer does this. What the code cannot do is decide about rows it already
 * wrote: releasing a hold is how the ceiling is handed back, and a bug in a rule that runs
 * itself at 03:00 is worse than one in a command somebody chose to run. So this reads first,
 * prints what it would touch, and writes only when told to — the same reasoning `unbar.ts`
 * follows, and the reason there is no `PO_ADOPTION_FLAG`-style one-shot for it.
 *
 * Which rows count as duplicates, and why that is safe for a real DTP job, is
 * {@link phantomHolds} — pure, in its own module, and tested there.
 *
 * ## What it touches
 *
 * - `held_work`: released, not deleted. The ceiling comes back and the audit trail stays.
 * - `offer_events`: the `recovery` row is **deleted**. That table is not append-only (the one
 *   that is, is `offer_skip_history`), the ids are purchase-order ids that exist nowhere else,
 *   and while the row stands `computeWinRate` counts it as a win of its own — the recovery
 *   never merged into the claim it duplicates, because their keys do not match.
 *
 * Run it AFTER deploying the fix. Run it before, and the next reconcile pass writes the same
 * rows back fifteen minutes later.
 *
 * Reads only `STRAKER_STATE_DIR`, not the whole bot configuration: an ops tool that touches a
 * handful of rows has no use for a portal password, and putting one within its reach is a
 * cost with no gain (`winRateReport.ts`'s reasoning, which `unbar.ts` follows too).
 *
 * Exports nothing, deliberately — so no test can import it and run it against the live
 * database by accident, which is exactly what happened when it did export something.
 */

import { config as loadDotenv } from 'dotenv';
import { STRAKER_DEFAULT_STATE_DIR } from './combinedSummary.js';
import { phantomHolds, type Phantom, type PhantomReport } from './phantomHolds.js';
import { StrakerStore, openStrakerDatabase, type StrakerDB } from './strakerStore.js';

function report(found: PhantomReport, wrote: boolean): string {
  const unexplained =
    found.unexplained.length === 0
      ? ''
      : `\n⚠ ${String(found.unexplained.length)} bucket-keyed recover${found.unexplained.length === 1 ? 'y' : 'ies'} left alone — ` +
        'their reference has fewer language-keyed holds than recoveries, so at least one of ' +
        'them is work nobody recorded twice. Look before releasing these:\n' +
        found.unexplained.map((id) => `  ${id}\n`).join('');

  if (found.phantoms.length === 0) {
    return (
      'no duplicate holds found — every open hold whose key names no language either has no ' +
      'language-keyed sibling (a real DTP job) or was won by a claim of its own (a real ' +
      'monolingual job), and neither is a duplicate\n' +
      unexplained
    );
  }
  const lines = found.phantoms.map(
    (p) =>
      `  ${p.objId}  ${p.workKey}  held since ` +
      `${new Date(p.heldSinceMs).toISOString()}  (duplicates ${String(p.siblings.length)}: ` +
      `${p.siblings.join(', ')})\n`,
  );
  return (
    `${String(found.phantoms.length)} duplicate hold${found.phantoms.length === 1 ? '' : 's'}:\n` +
    lines.join('') +
    (wrote
      ? 'released, and their recovery events removed so the win rate stops counting them twice\n'
      : 'nothing written — re-run with --apply to release these and drop their recovery events\n') +
    unexplained
  );
}

function apply(
  db: StrakerDB,
  store: StrakerStore,
  phantoms: readonly Phantom[],
  nowMs: number,
): void {
  const dropEvent = db.prepare(
    "DELETE FROM offer_events WHERE obj_id = ? AND event_type = 'recovery'",
  );
  // One transaction: a half-done cleanup leaves a released hold still counted as a win.
  store.transaction(() => {
    for (const p of phantoms) {
      store.release(p.objId, nowMs);
      dropEvent.run(p.objId);
    }
  });
}

function main(): void {
  loadDotenv();
  const stateDir = (process.env['STRAKER_STATE_DIR'] ?? '').trim() || STRAKER_DEFAULT_STATE_DIR;
  const writing = process.argv.includes('--apply');
  const nowMs = Date.now();

  const opened = openStrakerDatabase(stateDir, nowMs);
  try {
    const store = new StrakerStore(opened.db);
    // Which held rows reconciliation created, as against which the bot won itself. This is
    // what tells a phantom from a real monolingual claim of the same shape — see
    // `phantomHolds`. No store method exposes it, and adding one for a cleanup would widen
    // the store's surface for a single use.
    const recovered = new Set(
      (
        opened.db
          .prepare("SELECT obj_id FROM offer_events WHERE event_type = 'recovery'")
          .all() as { obj_id: string }[]
      ).map((r) => r.obj_id),
    );
    const found = phantomHolds(store.heldWork(), recovered);
    const wrote = writing && found.phantoms.length > 0;
    if (wrote) apply(opened.db, store, found.phantoms, nowMs);
    process.stdout.write(`${stateDir}\n${report(found, wrote)}`);
  } finally {
    opened.db.close();
  }
}

main();
