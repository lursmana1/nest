/**
 * Create indexes used by /user-stats/* aggregations.
 * Safe to re-run (IF NOT EXISTS).
 *
 *   npx ts-node -r tsconfig-paths/register scripts/ensure-user-stats-indexes.ts
 */
import 'dotenv/config';
import { DataSource } from 'typeorm';

function pgDataSource(): DataSource {
  const url = process.env.DATABASE_URL;
  if (url) {
    return new DataSource({
      type: 'postgres',
      url,
      ssl:
        process.env.DATABASE_SSL === 'true'
          ? { rejectUnauthorized: false }
          : false,
    });
  }

  return new DataSource({
    type: 'postgres',
    host: process.env.PG_HOST || process.env.DB_HOST || 'localhost',
    port: Number(process.env.PG_PORT || process.env.DB_PORT) || 5432,
    username: process.env.PG_USERNAME || process.env.DB_USERNAME || 'postgres',
    password: process.env.PG_PASSWORD || process.env.DB_PASSWORD || '',
    database:
      process.env.PG_DATABASE ||
      process.env.DB_DATABASE ||
      'driving_theory_back',
  });
}

async function main() {
  const ds = pgDataSource();
  await ds.initialize();

  const statements = [
    `CREATE INDEX IF NOT EXISTS idx_exam_attempts_user_completed
       ON exam_attempts ("userId", "completedAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_exam_attempts_categories_gin
       ON exam_attempts USING gin (categories)`,
    `CREATE INDEX IF NOT EXISTS idx_user_answers_attempt
       ON user_answers ("attemptId")`,
    `CREATE INDEX IF NOT EXISTS idx_user_answers_attempt_subject
       ON user_answers ("attemptId", subject)`,
    `CREATE INDEX IF NOT EXISTS idx_user_answers_question
       ON user_answers ("questionId")`,
    `CREATE INDEX IF NOT EXISTS idx_questions_categories_gin
       ON questions USING gin (categories)`,
  ];

  for (const sql of statements) {
    await ds.query(sql);
    console.log('OK:', sql.replace(/\s+/g, ' ').trim());
  }

  await ds.destroy();
  console.log('User-stats indexes ready.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
