import { liveQuestionJoinSql } from '../utils/attempt-category-filter.util.js';
import { answerJoinedCategorySql } from '../utils/attempt-category-filter.util.js';

export type CombinedAnswersOptions = {
  userIdPlaceholder: string;
  /** When set, exam rows use answerJoinedCategorySql; practice uses categoryIdPlaceholder. */
  categoryFilterPlaceholder?: string;
  categoryIdPlaceholder?: string;
  /** Include a.subject / practice subject (required for subject aggregates). */
  includeSubject?: boolean;
  /** Only graded practice rows (correct IS NOT NULL). Default true. */
  gradedPracticeOnly?: boolean;
};

/**
 * Exam `user_answers` ∪ `practice_answers` (live questions only).
 * Columns: "questionId", correct, "answeredAt" [, subject].
 */
export function combinedGradedAnswersCte(
  cteName: string,
  options: CombinedAnswersOptions,
): string {
  const {
    userIdPlaceholder,
    categoryFilterPlaceholder,
    categoryIdPlaceholder,
    includeSubject = false,
    gradedPracticeOnly = true,
  } = options;

  const examSubjectSelect = includeSubject ? `a.subject AS subject,` : '';
  const practiceSubjectSelect = includeSubject
    ? `COALESCE(p.subject, lq.subject) AS subject,`
    : '';
  const examSubjectWhere = includeSubject ? `AND a.subject IS NOT NULL` : '';
  const practiceSubjectWhere = includeSubject
    ? `AND COALESCE(p.subject, lq.subject) IS NOT NULL`
    : '';

  let examCategory = '';
  if (categoryFilterPlaceholder && categoryIdPlaceholder) {
    examCategory = `AND ${answerJoinedCategorySql('t', 'a', categoryFilterPlaceholder, categoryIdPlaceholder)}`;
  }

  let practiceCategory = '';
  if (categoryIdPlaceholder) {
    practiceCategory = `AND ${categoryIdPlaceholder} = ANY(lq.categories)`;
  }

  const practiceGrade = gradedPracticeOnly ? `AND p.correct IS NOT NULL` : '';

  return `
${cteName} AS (
  SELECT
    a."questionId" AS "questionId",
    ${examSubjectSelect}
    a.correct AS correct,
    a."createdAt" AS "answeredAt"
  FROM user_answers a
  INNER JOIN exam_attempts t ON a."attemptId" = t.id
  ${liveQuestionJoinSql('a', 't')}
  WHERE t."userId" = ${userIdPlaceholder}
    ${examSubjectWhere}
    ${examCategory}

  UNION ALL

  SELECT
    p."questionId" AS "questionId",
    ${practiceSubjectSelect}
    p.correct AS correct,
    p."updatedAt" AS "answeredAt"
  FROM practice_answers p
  INNER JOIN questions lq
    ON lq.id = p."questionId"
   AND lq.lang = p.lang
  WHERE p."userId" = ${userIdPlaceholder}
    ${practiceGrade}
    ${practiceSubjectWhere}
    ${practiceCategory}
)`;
}

/**
 * One row per questionId with correctRate and optional subject (latest subject wins).
 */
export function perQuestionRateCte(
  sourceCte: string,
  cteName: string,
  includeSubject: boolean,
): string {
  const subjectSelect = includeSubject
    ? `(ARRAY_AGG(${sourceCte}.subject ORDER BY ${sourceCte}."answeredAt" DESC))[1] AS subject,`
    : '';

  return `
${cteName} AS (
  SELECT
    ${sourceCte}."questionId",
    ${subjectSelect}
    SUM(CASE WHEN ${sourceCte}.correct = false THEN 1 ELSE 0 END)::int AS "wrongCount",
    COUNT(*)::int AS "totalAttempts",
    (SUM(CASE WHEN ${sourceCte}.correct = true THEN 1 ELSE 0 END)::float
      / COUNT(*)) AS "correctRate"
  FROM ${sourceCte}
  GROUP BY ${sourceCte}."questionId"
)`;
}
