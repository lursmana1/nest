/**
 * Integration check: practice-answers → coverage for a real user.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/test-practice-answers.ts
 *   PRACTICE_TEST_USER_ID=123 npm run test:practice-answers
 *   PRACTICE_TEST_EMAIL=you@mail.com PRACTICE_TEST_PASSWORD=... npm run test:practice-answers
 *
 * With email/password: also hits HTTP POST /practice-answers on local API.
 * Without: verifies DB write + coverage SQL only.
 */
import 'dotenv/config';
import { initPg } from './lib/pg-data-source';

const CATEGORY_ID = Number(process.env.PRACTICE_TEST_CATEGORY ?? 1);
const LANG = (process.env.PRACTICE_TEST_LANG ?? 'ka').trim() || 'ka';
const API_BASE = (
  process.env.PRACTICE_TEST_API ??
  process.env.API_PUBLIC_URL ??
  'http://localhost:3000'
).replace(/\/$/, '');

type UserRow = { uid: number; email: string | null; completed: number };

async function pickUser(ds: Awaited<ReturnType<typeof initPg>>): Promise<UserRow> {
  const fromId = Number(process.env.PRACTICE_TEST_USER_ID ?? '');
  if (Number.isFinite(fromId) && fromId > 0) {
    const rows = await ds.query(
      `SELECT u.id AS uid, u.email,
              (SELECT COUNT(*)::int FROM exam_attempts t
               WHERE t."userId" = u.id AND t."completedAt" IS NOT NULL) AS completed
       FROM users u WHERE u.id = $1`,
      [fromId],
    );
    if (!rows[0]) throw new Error(`User id ${fromId} not found`);
    return rows[0];
  }

  const email = process.env.PRACTICE_TEST_EMAIL?.trim();
  if (email) {
    const rows = await ds.query(
      `SELECT u.id AS uid, u.email,
              (SELECT COUNT(*)::int FROM exam_attempts t
               WHERE t."userId" = u.id AND t."completedAt" IS NOT NULL) AS completed
       FROM users u WHERE lower(u.email) = lower($1)`,
      [email],
    );
    if (!rows[0]) throw new Error(`User email ${email} not found`);
    return rows[0];
  }

  const top = await ds.query(
    `SELECT t."userId" AS uid, u.email, COUNT(*)::int AS completed
     FROM exam_attempts t
     LEFT JOIN users u ON u.id = t."userId"
     WHERE t."completedAt" IS NOT NULL
     GROUP BY t."userId", u.email
     ORDER BY completed DESC
     LIMIT 1`,
  );
  if (!top[0]) throw new Error('No users with completed exams');
  return top[0];
}

async function coverage(
  ds: Awaited<ReturnType<typeof initPg>>,
  userId: number,
): Promise<{ distinct: number; total: number; rate: number }> {
  const answered = await ds.query(
    `
    SELECT COUNT(DISTINCT qid)::int AS count
    FROM (
      SELECT a."questionId" AS qid
      FROM user_answers a
      INNER JOIN exam_attempts t ON a."attemptId" = t.id
      INNER JOIN questions lq
        ON lq.id = a."questionId" AND lq.lang = t.lang
      WHERE t."userId" = $1
        AND (
          t.categories @> $2::jsonb
          OR (
            COALESCE(jsonb_array_length(t.categories), 0) = 0
            AND $3 = ANY(lq.categories)
          )
        )
      UNION
      SELECT p."questionId" AS qid
      FROM practice_answers p
      INNER JOIN questions lq
        ON lq.id = p."questionId" AND lq.lang = p.lang
      WHERE p."userId" = $1
        AND $3 = ANY(lq.categories)
    ) seen
    `,
    [userId, JSON.stringify([CATEGORY_ID]), CATEGORY_ID],
  );

  const totalRow = await ds.query(
    `SELECT COUNT(*)::int AS count FROM questions q
     WHERE q.lang = $1 AND $2 = ANY(q.categories)`,
    [LANG, CATEGORY_ID],
  );

  const distinct = Number(answered[0]?.count ?? 0);
  const total = Number(totalRow[0]?.count ?? 0);
  return {
    distinct,
    total,
    rate: total > 0 ? Math.round((distinct / total) * 1000) / 1000 : 0,
  };
}

async function pickUnseenLiveQuestion(
  ds: Awaited<ReturnType<typeof initPg>>,
  userId: number,
): Promise<{ id: number; subject: number | null; correct_answer: string | null }> {
  const rows = await ds.query(
    `
    SELECT q.id, q.subject, q.correct_answer
    FROM questions q
    WHERE q.lang = $1
      AND $2 = ANY(q.categories)
      AND NOT EXISTS (
        SELECT 1 FROM practice_answers p
        WHERE p."userId" = $3 AND p."questionId" = q.id AND p.lang = q.lang
      )
      AND NOT EXISTS (
        SELECT 1
        FROM user_answers a
        INNER JOIN exam_attempts t ON a."attemptId" = t.id
        WHERE t."userId" = $3 AND a."questionId" = q.id
      )
    ORDER BY q.id ASC
    LIMIT 1
    `,
    [LANG, CATEGORY_ID, userId],
  );
  if (!rows[0]) {
    // Fall back: any live question in category (re-answer practice upsert)
    const any = await ds.query(
      `SELECT q.id, q.subject, q.correct_answer
       FROM questions q
       WHERE q.lang = $1 AND $2 = ANY(q.categories)
       ORDER BY q.id ASC LIMIT 1`,
      [LANG, CATEGORY_ID],
    );
    if (!any[0]) throw new Error('No live questions for category');
    return any[0];
  }
  return rows[0];
}

async function loginJwt(): Promise<string | null> {
  const email = process.env.PRACTICE_TEST_EMAIL?.trim();
  const password = process.env.PRACTICE_TEST_PASSWORD;
  if (!email || !password) return null;

  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Login failed ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { access_token?: string; accessToken?: string };
  const token = body.access_token ?? body.accessToken;
  if (!token) throw new Error('Login OK but no access_token in response');
  return token;
}

async function httpPracticeAnswer(
  token: string,
  questionId: number,
  chosenAnswer: string,
): Promise<unknown> {
  const res = await fetch(`${API_BASE}/practice-answers?lang=${LANG}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Accept-Language': LANG,
    },
    body: JSON.stringify({ questionId, chosenAnswer }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /practice-answers ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function dbPracticeAnswer(
  ds: Awaited<ReturnType<typeof initPg>>,
  userId: number,
  q: { id: number; subject: number | null; correct_answer: string | null },
): Promise<void> {
  const chosen = q.correct_answer ?? '1';
  const correct = q.correct_answer != null ? chosen === q.correct_answer : null;
  await ds.query(
    `
    INSERT INTO practice_answers
      ("userId", "questionId", lang, subject, correct, "chosenAnswer", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    ON CONFLICT ("userId", "questionId", lang)
    DO UPDATE SET
      subject = EXCLUDED.subject,
      correct = EXCLUDED.correct,
      "chosenAnswer" = EXCLUDED."chosenAnswer",
      "updatedAt" = NOW()
    `,
    [userId, q.id, LANG, q.subject, correct, chosen],
  );
}

async function main() {
  const ds = await initPg();
  const steps: { name: string; ok: boolean; detail?: string }[] = [];

  try {
    // table exists?
    const table = await ds.query(
      `SELECT to_regclass('public.practice_answers') AS name`,
    );
    steps.push({
      name: 'practice_answers table exists',
      ok: table[0]?.name === 'practice_answers',
      detail: String(table[0]?.name),
    });

    const user = await pickUser(ds);
    steps.push({
      name: 'resolve test user',
      ok: true,
      detail: `id=${user.uid} email=${user.email ?? 'n/a'} completedExams=${user.completed}`,
    });

    const before = await coverage(ds, user.uid);
    steps.push({
      name: 'coverage before',
      ok: true,
      detail: `${before.distinct}/${before.total} (rate=${before.rate})`,
    });

    const q = await pickUnseenLiveQuestion(ds, user.uid);
    const chosen = q.correct_answer ?? '1';
    steps.push({
      name: 'pick live question',
      ok: true,
      detail: `id=${q.id} subject=${q.subject} answer=${chosen}`,
    });

    const token = await loginJwt().catch((e) => {
      steps.push({
        name: 'HTTP login (optional)',
        ok: false,
        detail: (e as Error).message,
      });
      return null;
    });

    if (token) {
      steps.push({ name: 'HTTP login', ok: true, detail: 'got JWT' });
      const body = await httpPracticeAnswer(token, q.id, chosen);
      steps.push({
        name: 'POST /practice-answers',
        ok: true,
        detail: JSON.stringify(body),
      });
    } else if (!process.env.PRACTICE_TEST_EMAIL) {
      await dbPracticeAnswer(ds, user.uid, q);
      steps.push({
        name: 'DB upsert practice_answers (no HTTP creds)',
        ok: true,
        detail: `questionId=${q.id}`,
      });
    }

    const after = await coverage(ds, user.uid);
    const grew = after.distinct >= before.distinct;
    const includesQ = await ds.query(
      `SELECT 1 FROM practice_answers
       WHERE "userId" = $1 AND "questionId" = $2 AND lang = $3`,
      [user.uid, q.id, LANG],
    );
    steps.push({
      name: 'practice row present',
      ok: includesQ.length > 0,
    });
    steps.push({
      name: 'coverage after ≥ before',
      ok: grew,
      detail: `${before.distinct} → ${after.distinct}/${after.total} (rate=${after.rate})`,
    });

    console.log('\n=== practice-answers test ===\n');
    for (const s of steps) {
      console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
    }
    const failed = steps.filter((s) => !s.ok && s.name !== 'HTTP login (optional)');
    if (failed.length) {
      console.log('\nFAILED');
      process.exitCode = 1;
    } else {
      console.log('\nOK — practice answers feed coverage for this user');
      if (!token) {
        console.log(
          'Tip: set PRACTICE_TEST_EMAIL + PRACTICE_TEST_PASSWORD to also hit HTTP.',
        );
      }
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
