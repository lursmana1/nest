import 'dotenv/config';
import { Client } from 'pg';

/**
 * Convert every `timestamp without time zone` column to `timestamptz`.
 *
 * Why: naive columns are serialized in the *writing process's* local zone, so
 * the same row means different instants on a UTC server vs a UTC+4 one, and a
 * DST zone (e.g. Europe/Berlin) shifts it twice a year.
 *
 * Interpretation of existing values:
 *   - TypeORM-generated (@CreateDateColumn/@UpdateDateColumn) wrote UTC text.
 *   - Explicitly-passed JS Dates wrote local (Asia/Tbilisi) text — listed below.
 * Anything discovered that is not classified here aborts the run.
 *
 * Usage (npm swallows `--yes`, so the apply flag is `--confirm`):
 *   npm run db:migrate-timestamptz                              # dry run
 *   npm run db:migrate-timestamptz -- --confirm
 *   npm run db:migrate-timestamptz -- --confirm --wipe-attempts # also clear attempts
 */

/** Columns written from an explicit JS Date, i.e. stored as Georgia local time. */
const LOCAL_WRITTEN = new Set([
  'exam_attempts.endDate',
  'exam_attempts.completedAt',
  'leaderboard_periods.startDate',
  'leaderboard_periods.endDate',
]);

/** Columns written by TypeORM's date decorators, i.e. stored as UTC text. */
const UTC_WRITTEN = new Set([
  'exam_attempts.createdAt',
  'user_answers.createdAt',
  'practice_answers.createdAt',
  'practice_answers.updatedAt',
  'blogs.createdAt',
  'exams.createdAt',
  'exams.updatedAt',
  'leaderboard_periods.createdAt',
]);

const LOCAL_ZONE = 'Asia/Tbilisi';

interface ColumnRow {
  table_name: string;
  column_name: string;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--confirm');
  const wipeAttempts = args.includes('--wipe-attempts');

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    ssl:
      url.includes('sslmode=require') || url.includes('neon.tech')
        ? { rejectUnauthorized: false }
        : undefined,
  });
  await client.connect();

  const { rows: columns } = await client.query<ColumnRow>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND data_type = 'timestamp without time zone'
    ORDER BY table_name, column_name
  `);

  if (columns.length === 0) {
    console.log('Nothing to do — no naive timestamp columns remain.');
    await client.end();
    return;
  }

  const unknown = columns
    .map((c) => `${c.table_name}.${c.column_name}`)
    .filter((key) => !LOCAL_WRITTEN.has(key) && !UTC_WRITTEN.has(key));

  if (unknown.length > 0) {
    console.error(
      'Unclassified timestamp columns — add them to the maps before running:',
    );
    unknown.forEach((k) => console.error(`  - ${k}`));
    await client.end();
    process.exit(1);
  }

  console.log(`Found ${columns.length} naive timestamp column(s):`);
  for (const { table_name, column_name } of columns) {
    const key = `${table_name}.${column_name}`;
    const zone = LOCAL_WRITTEN.has(key) ? LOCAL_ZONE : 'UTC';
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table_name}" WHERE "${column_name}" IS NOT NULL`,
    );
    console.log(`  ${key.padEnd(34)} ${String(rows[0]?.n).padStart(6)} rows  →  interpret as ${zone}`);
  }

  if (!apply) {
    console.log('\nDry run. Re-run with --confirm to apply.');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    if (wipeAttempts) {
      const { rowCount } = await client.query('DELETE FROM exam_attempts');
      console.log(`\nWiped ${rowCount} exam attempts (answers cascade).`);
    }

    for (const { table_name, column_name } of columns) {
      const key = `${table_name}.${column_name}`;
      const zone = LOCAL_WRITTEN.has(key) ? LOCAL_ZONE : 'UTC';
      await client.query(
        `ALTER TABLE "${table_name}"
         ALTER COLUMN "${column_name}" TYPE timestamptz
         USING "${column_name}" AT TIME ZONE '${zone}'`,
      );
      console.log(`  converted ${key} (as ${zone})`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  const { rows: left } = await client.query<{ n: string }>(`
    SELECT count(*)::text AS n
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
  `);
  console.log(`\nDone. Naive timestamp columns remaining: ${left[0]?.n}`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
