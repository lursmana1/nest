/**
 * Creates practice_answers for ticket/trainer coverage tracking.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/ensure-practice-answers.ts
 */
import 'dotenv/config';
import { initPg } from './lib/pg-data-source';

async function main() {
  const ds = await initPg();
  try {
    await ds.query(`
      CREATE TABLE IF NOT EXISTS practice_answers (
        id SERIAL PRIMARY KEY,
        "userId" integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        "questionId" integer NOT NULL,
        lang varchar(5) NOT NULL DEFAULT 'ka',
        subject integer NULL,
        correct boolean NULL,
        "chosenAnswer" varchar(500) NULL,
        "createdAt" timestamptz NOT NULL DEFAULT NOW(),
        "updatedAt" timestamptz NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_practice_answers_user_question_lang
          UNIQUE ("userId", "questionId", lang)
      );
    `);
    await ds.query(`
      CREATE INDEX IF NOT EXISTS idx_practice_answers_user
        ON practice_answers ("userId");
    `);
    await ds.query(`
      CREATE INDEX IF NOT EXISTS idx_practice_answers_user_subject
        ON practice_answers ("userId", subject);
    `);
    await ds.query(`
      CREATE INDEX IF NOT EXISTS idx_practice_answers_question
        ON practice_answers ("questionId");
    `);
    console.log('practice_answers table + indexes ready');
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
