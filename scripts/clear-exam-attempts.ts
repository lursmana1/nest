import 'dotenv/config';
import { Client } from 'pg';

/**
 * Wipe exam attempt history (and cascaded user_answers) for a clean stats slate.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/clear-exam-attempts.ts --yes
 *   npx ts-node -r tsconfig-paths/register scripts/clear-exam-attempts.ts --yes --email=you@example.com
 *   npx ts-node -r tsconfig-paths/register scripts/clear-exam-attempts.ts --yes --userId=1
 */
async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const emailArg = args.find((a) => a.startsWith('--email='));
  const userIdArg = args.find((a) => a.startsWith('--userId='));
  const email = emailArg?.slice('--email='.length)?.trim();
  const userId = userIdArg
    ? Number(userIdArg.slice('--userId='.length))
    : undefined;

  if (!yes) {
    console.error(
      'Refusing to run without --yes (deletes exam_attempts + user_answers).',
    );
    process.exit(1);
  }

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

  let filterUserId = userId;
  if (email) {
    const user = await client.query<{ id: number }>(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [email],
    );
    if (!user.rows[0]) {
      console.error(`No user with email ${email}`);
      await client.end();
      process.exit(1);
    }
    filterUserId = user.rows[0].id;
  }

  const beforeAttempts = await client.query<{ count: string }>(
    filterUserId != null
      ? `SELECT COUNT(*)::text AS count FROM exam_attempts WHERE "userId" = $1`
      : `SELECT COUNT(*)::text AS count FROM exam_attempts`,
    filterUserId != null ? [filterUserId] : [],
  );
  const beforeAnswers = await client.query<{ count: string }>(
    filterUserId != null
      ? `SELECT COUNT(*)::text AS count
         FROM user_answers a
         INNER JOIN exam_attempts t ON a."attemptId" = t.id
         WHERE t."userId" = $1`
      : `SELECT COUNT(*)::text AS count FROM user_answers`,
    filterUserId != null ? [filterUserId] : [],
  );

  console.log(
    `Before: ${beforeAttempts.rows[0]?.count ?? 0} attempts, ${beforeAnswers.rows[0]?.count ?? 0} answers` +
      (filterUserId != null ? ` (userId=${filterUserId})` : ' (ALL users)'),
  );

  if (filterUserId != null) {
    await client.query(`DELETE FROM exam_attempts WHERE "userId" = $1`, [
      filterUserId,
    ]);
  } else {
    await client.query(`DELETE FROM user_answers`);
    await client.query(`DELETE FROM exam_attempts`);
  }

  const afterAttempts = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM exam_attempts`,
  );
  const afterAnswers = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM user_answers`,
  );

  console.log(
    `After:  ${afterAttempts.rows[0]?.count ?? 0} attempts, ${afterAnswers.rows[0]?.count ?? 0} answers`,
  );
  console.log('Exam history cleared.');

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
