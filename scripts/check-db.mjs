/**
 * One-off: read-only health snapshot of the outbox + job store, to confirm jobs
 * are being recorded (not stuck pending/dead). Safe to run while the bot polls
 * (SQLite WAL allows concurrent readers).
 */
import Database from 'better-sqlite3';

const db = new Database('state/acolad.db', { readonly: true });

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((t) => t.name);
console.log('tables:', tables.join(', '));

console.log('\n=== outbox by channel + status ===');
for (const r of db
  .prepare(
    'SELECT channel, status, COUNT(*) n FROM outbox GROUP BY channel, status ORDER BY channel, status',
  )
  .all())
  console.log(`  ${r.channel.padEnd(7)} ${r.status.padEnd(8)} ${r.n}`);

const dump = (table, limit = 8) => {
  if (!tables.includes(table)) return;
  const n = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  console.log(`\n=== ${table}: ${n} rows | cols: ${cols.join(', ')} ===`);
  for (const r of db
    .prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid DESC LIMIT ${limit}`)
    .all())
    console.log('  ', JSON.stringify(r));
};

dump('outbox', 6);
dump('jobs', 10);
dump('appearance_events', 6);

db.close();
