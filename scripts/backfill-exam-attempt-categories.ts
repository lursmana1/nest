import 'dotenv/config';
import { Client } from 'pg';

/**
 * Backfill exam_attempts.categories for legacy rows where categories = [].
 * Infers the primary category from question tags on the attempt.
 */
async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost')
      ? undefined
      : { rejectUnauthorized: false },
  });
  await client.connect();

  const before = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM exam_attempts
    WHERE COALESCE(jsonb_array_length(categories), 0) = 0
  `);

  const result = await client.query<{ id: number; categories: number[] }>(`
    WITH expanded AS (
      SELECT
        ea.id AS attempt_id,
        unnest(q.categories) AS cat
      FROM exam_attempts ea
      CROSS JOIN LATERAL jsonb_array_elements_text(ea."questionIds") AS elem(qid)
      INNER JOIN questions q
        ON q.id = elem.qid::int
       AND q.lang = ea.lang
      WHERE COALESCE(jsonb_array_length(ea.categories), 0) = 0
    ),
    ranked AS (
      SELECT
        attempt_id,
        cat,
        COUNT(*) AS cnt,
        ROW_NUMBER() OVER (
          PARTITION BY attempt_id
          ORDER BY COUNT(*) DESC, cat ASC
        ) AS rn
      FROM expanded
      GROUP BY attempt_id, cat
    ),
    updated AS (
      UPDATE exam_attempts ea
      SET categories = jsonb_build_array(r.cat)
      FROM ranked r
      WHERE ea.id = r.attempt_id
        AND r.rn = 1
      RETURNING ea.id, ea.categories
    )
    SELECT id, categories FROM updated
  `);

  const after = await client.query<{ count: string }>(`
    SELECT COUNT(*)::text AS count
    FROM exam_attempts
    WHERE COALESCE(jsonb_array_length(categories), 0) = 0
  `);

  console.log(
    `Backfilled ${result.rowCount} exam attempts (${before.rows[0]?.count ?? 0} empty before, ${after.rows[0]?.count ?? 0} empty after).`,
  );

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
