import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Category } from '../src/categories/entities/category.entity';

const CATEGORY_META: Record<number, { name: string; iconKey: string }> = {
  0: { name: 'AM', iconKey: 'am' },
  1: { name: 'B', iconKey: 'b' },
  2: { name: 'A', iconKey: 'a' },
  3: { name: 'C', iconKey: 'c' },
  4: { name: 'D', iconKey: 'd' },
  5: { name: 'C1', iconKey: 'c1' },
  6: { name: 'D1', iconKey: 'd1' },
  7: { name: 'Military', iconKey: 'military' },
  8: { name: 'Tram', iconKey: 'tram' },
  9: { name: 'T/S', iconKey: 'ts' },
};

function pgDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT) || 5432,
    username: process.env.PG_USERNAME || 'postgres',
    password: process.env.PG_PASSWORD || '',
    database: process.env.PG_DATABASE || 'driving_theory_back',
    entities: [Category],
    synchronize: true,
  });
}

async function main() {
  const ds = pgDataSource();
  await ds.initialize();

  const rows = await ds.query(`
    SELECT
      cat_id AS id,
      COUNT(*)::int AS "questionsCount",
      COUNT(DISTINCT subject)::int AS "subjectCount",
      COALESCE(
        jsonb_agg(
          DISTINCT jsonb_build_object(
            'id', subject,
            'name', 'Subject ' || subject::text,
            'questionsCount', 0
          )
        ) FILTER (WHERE subject IS NOT NULL),
        '[]'::jsonb
      ) AS subjects
    FROM questions q
    CROSS JOIN LATERAL unnest(q.categories) AS cat_id
    WHERE q.lang = 'ka'
    GROUP BY cat_id
    ORDER BY cat_id
  `);

  const repo = ds.getRepository(Category);
  for (const r of rows) {
    const subjects = (r.subjects as Array<{ id: number; name: string }>).map(
      (s) => ({
        id: Number(s.id),
        name: s.name,
        questionsCount: 0,
      }),
    );

    for (const s of subjects) {
      const [countRow] = await ds.query(
        `SELECT COUNT(*)::int AS c
         FROM questions
         WHERE lang = 'ka' AND subject = $1 AND $2 = ANY(categories)`,
        [s.id, Number(r.id)],
      );
      s.questionsCount = Number(countRow?.c ?? 0);
    }

    await repo.save({
      id: Number(r.id),
      name: CATEGORY_META[Number(r.id)]?.name ?? `Category ${r.id}`,
      iconKey: CATEGORY_META[Number(r.id)]?.iconKey ?? null,
      questionsCount: Number(r.questionsCount),
      subjectCount: Number(r.subjectCount),
      subjects,
    });
  }

  console.log(`Seeded ${rows.length} categories from questions.`);
  await ds.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
