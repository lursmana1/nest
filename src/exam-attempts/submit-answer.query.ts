/**
 * One Postgres round trip for POST /exam-attempts/:id/answer.
 *
 * Load, grade, insert, expire-settle, and last-question complete all run in
 * the same statement so a distant API (Vercel → Neon) pays one hop, not three.
 *
 * Data-modifying CTEs are joined in the final SELECT so Postgres actually
 * executes them (unreferenced DML CTEs are skipped).
 */
export const SUBMIT_ANSWER_SQL = `
WITH input AS (
  SELECT
    $1::int AS attempt_id,
    $2::int AS user_id,
    $3::int AS question_id,
    $4::text AS chosen,
    $5::int AS max_duration,
    $6::int AS fallback_min_correct
),
attempt AS (
  SELECT
    e.id,
    e.lang,
    e."questionIds",
    e."endDate",
    e."completedAt",
    e."createdAt",
    e."minCorrectToPass"
  FROM exam_attempts e
  JOIN input i ON e.id = i.attempt_id AND e."userId" = i.user_id
),
graded AS (
  SELECT
    a.id,
    a."endDate",
    a."completedAt",
    a."createdAt",
    a."minCorrectToPass",
    i.question_id,
    i.chosen,
    i.max_duration,
    i.fallback_min_correct,
    (a."endDate" IS NOT NULL AND a."endDate" < NOW()) AS expired,
    (a."questionIds" @> to_jsonb(i.question_id)) AS in_ticket,
    EXISTS (
      SELECT 1
      FROM user_answers ua
      WHERE ua."attemptId" = a.id AND ua."questionId" = i.question_id
    ) AS already_answered,
    jsonb_array_length(a."questionIds") AS ticket_size,
    (
      SELECT COUNT(*)::int FROM user_answers ua WHERE ua."attemptId" = a.id
    ) AS answered_count,
    (
      SELECT COUNT(*) FILTER (WHERE ua.correct)::int
      FROM user_answers ua
      WHERE ua."attemptId" = a.id
    ) AS prior_correct,
    q.id AS question_pk,
    q.subject,
    (COALESCE(q.correct_answer = i.chosen, false)) AS is_correct
  FROM attempt a
  CROSS JOIN input i
  LEFT JOIN questions q ON q.id = i.question_id AND q.lang = a.lang
),
settled AS (
  UPDATE exam_attempts e
  SET
    "completedAt" = g."endDate",
    passed = g.prior_correct >= COALESCE(g."minCorrectToPass", g.fallback_min_correct),
    "durationSeconds" = LEAST(
      GREATEST(0, ROUND(EXTRACT(EPOCH FROM (g."endDate" - g."createdAt")))::int),
      g.max_duration
    )
  FROM graded g
  WHERE e.id = g.id
    AND g."completedAt" IS NULL
    AND g.expired
  RETURNING e.id
),
inserted AS (
  INSERT INTO user_answers ("attemptId", "questionId", subject, correct, "chosenAnswer")
  SELECT g.id, g.question_id, g.subject, g.is_correct, g.chosen
  FROM graded g
  WHERE g."completedAt" IS NULL
    AND NOT g.expired
    AND g.in_ticket
    AND NOT g.already_answered
    AND g.question_pk IS NOT NULL
  RETURNING "attemptId", correct
),
completed AS (
  UPDATE exam_attempts e
  SET
    "completedAt" = NOW(),
    passed = (g.prior_correct + CASE WHEN ins.correct THEN 1 ELSE 0 END)
      >= COALESCE(g."minCorrectToPass", g.fallback_min_correct),
    "durationSeconds" = LEAST(
      GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - g."createdAt")))::int),
      g.max_duration
    )
  FROM graded g
  INNER JOIN inserted ins ON ins."attemptId" = g.id
  WHERE e.id = g.id
    AND g.answered_count + 1 >= g.ticket_size
  RETURNING e.id
)
SELECT
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM attempt) THEN 'not_found'
    WHEN g."completedAt" IS NOT NULL THEN 'already_completed'
    WHEN g.expired THEN 'expired'
    WHEN NOT g.in_ticket THEN 'not_in_ticket'
    WHEN g.already_answered THEN 'already_answered'
    WHEN g.question_pk IS NULL THEN 'question_not_found'
    ELSE 'ok'
  END AS status,
  g.is_correct AS correct
FROM input
LEFT JOIN graded g ON TRUE
LEFT JOIN settled ON TRUE
LEFT JOIN inserted ON TRUE
LEFT JOIN completed ON TRUE
`;

export type SubmitAnswerRow = {
  status: string;
  correct: unknown;
};
