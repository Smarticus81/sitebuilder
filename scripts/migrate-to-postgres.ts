// One-shot data migration: SQLite (local) → Postgres (Neon/Supabase/...).
//
//   DATABASE_URL=sqlite:./data/storefront.db \
//   POSTGRES_URL=postgres://user:pass@host/db \
//   pnpm migrate:pg
//
// Copies every table in FK order, preserving ids, then fixes the Postgres
// identity sequences. Idempotent-ish: refuses to run against a non-empty
// target unless --force is passed.
//
// ⚠ Run this against a production database only after taking a backup, and
// stop the worker while it runs.

import '../apps/worker/src/env.js';
import { openDb, migrate, SqliteDriver, PostgresDriver } from '@storefront/db';

const TABLES = [
  'leads',
  'demos',
  'sequences',
  'messages',
  'suppression',
  'sms_messages',
  'sms_suppression',
  'proposals',
  'domain_requests',
  'ab_assignments',
  'experiments',
  'config',
  'events',
];

const ID_TABLES = new Set([
  'leads', 'demos', 'sequences', 'messages', 'sms_messages', 'proposals',
  'domain_requests', 'events',
]);

async function main() {
  const force = process.argv.includes('--force');
  const sqliteUrl = process.env.DATABASE_URL ?? 'sqlite:./data/storefront.db';
  const pgUrl = process.env.POSTGRES_URL;
  if (!pgUrl?.startsWith('postgres')) {
    console.error('Set POSTGRES_URL=postgres://... (target database)');
    process.exit(1);
  }
  if (sqliteUrl.startsWith('postgres')) {
    console.error('DATABASE_URL must point at the SOURCE SQLite database');
    process.exit(1);
  }

  const src = openDb(sqliteUrl);
  const dst = openDb(pgUrl);
  if (!(src instanceof SqliteDriver) || !(dst instanceof PostgresDriver)) {
    console.error('Driver mismatch — source must be sqlite, target postgres');
    process.exit(1);
  }

  console.log(`\nMigrating ${sqliteUrl} → ${pgUrl.replace(/\/\/[^@]+@/, '//***@')}\n`);
  await migrate(dst);

  const existing = await dst.get<{ n: number }>(`SELECT COUNT(*) AS n FROM leads`);
  if ((existing?.n ?? 0) > 0 && !force) {
    console.error(
      `Target already has ${existing!.n} lead(s). Re-run with --force to append anyway ` +
        `(NOT recommended — prefer an empty target).`,
    );
    process.exit(1);
  }

  let total = 0;
  for (const table of TABLES) {
    const rows = await src.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
    for (const row of rows) {
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(', ');
      await dst.run(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        cols.map((c) => row[c]),
      );
    }
    // Realign the identity sequence so future inserts don't collide.
    if (ID_TABLES.has(table) && rows.length) {
      await dst.run(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}))`,
      );
    }
    console.log(`  ✓ ${table.padEnd(16)} ${rows.length} row(s)`);
    total += rows.length;
  }

  console.log(`\n✅ migrated ${total} rows. Point DATABASE_URL at Postgres and restart the worker.\n`);
  await src.close();
  await dst.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
