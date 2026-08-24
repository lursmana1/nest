import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserAnswer } from '../exam-attempts/entities/user-answer.entity';
import { ExamAttempt } from '../exam-attempts/entities/exam-attempt.entity';
import { Question } from '../questions/entities/question.entity';
import {
  Category,
  CategorySubjectRow,
} from '../categories/entities/category.entity';
import {
  MIN_SUBJECT_ATTEMPTS_FOR_STATS,
  QUESTION_MASTERY_CORRECT_RATIO,
  READINESS_MAX_ATTEMPTS,
} from '../common/constants/exam.constants.js';
import { resolveGeorgianExamRule } from '../common/utils/georgian-exam-rules.util.js';
import {
  attemptCategoryMatchParams,
  attemptMatchesCategorySql,
  attemptMatchesCategoryWhere,
  categoryFilterJson,
  liveQuestionJoinSql,
} from '../common/utils/attempt-category-filter.util.js';
import {
  combinedGradedAnswersCte,
  perQuestionRateCte,
} from '../common/sql/combined-answers.sql.js';
import { SqlParams } from '../common/sql/sql-params.js';
import { round3 } from '../common/utils/round3.util.js';
import { EARLY_FAIL_WINDOW } from './readiness.util.js';
import type {
  QuestionPoolExposure,
  RecentAttemptRow,
  SubjectAggregateRow,
  WeakQuestionCountRow,
  WeakQuestionPreview,
  WeakSubjectAggregateRow,
} from './user-stats.types.js';

/** How many rows the weak-questions / weak-subjects lists return. */
const TOP_COUNT = 5;

/**
 * All database access for user stats. Returns coerced rows only — no response
 * shaping, so `UserStatsService` owns the API contract.
 */
@Injectable()
export class UserStatsQueryService {
  constructor(
    @InjectRepository(UserAnswer)
    private readonly answerRepo: Repository<UserAnswer>,
    @InjectRepository(ExamAttempt)
    private readonly attemptRepo: Repository<ExamAttempt>,
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
  ) {}

  /** Questions whose correct-rate is below mastery, worst first. */
  async loadWeakQuestionCounts(
    userId: number,
    categoryId?: number,
  ): Promise<{ rows: WeakQuestionCountRow[]; total: number }> {
    const sp = new SqlParams();
    const userPh = sp.add(userId);
    const limitPh = sp.add(TOP_COUNT);
    let filterPh: string | undefined;
    let catPh: string | undefined;
    if (categoryId != null) {
      filterPh = sp.add(categoryFilterJson(categoryId));
      catPh = sp.add(categoryId);
    }
    const masteryPh = sp.add(QUESTION_MASTERY_CORRECT_RATIO);

    const rows = await this.answerRepo.manager.query<
      {
        questionId: string;
        wrongCount: string;
        totalAttempts: string;
        total: string;
      }[]
    >(
      `
      WITH ${combinedGradedAnswersCte('combined', {
        userIdPlaceholder: userPh,
        categoryFilterPlaceholder: filterPh,
        categoryIdPlaceholder: catPh,
      })},
      ${perQuestionRateCte('combined', 'per_q', false)},
      agg AS (
        SELECT
          per_q."questionId",
          per_q."wrongCount",
          per_q."totalAttempts"
        FROM per_q
        WHERE per_q."correctRate" < ${masteryPh}
      ),
      ranked AS (
        SELECT
          agg.*,
          COUNT(*) OVER()::int AS total,
          ROW_NUMBER() OVER (ORDER BY agg."wrongCount" DESC, agg."totalAttempts" DESC) AS rn
        FROM agg
      )
      SELECT "questionId", "wrongCount", "totalAttempts", total
      FROM ranked
      WHERE rn <= ${limitPh}
      ORDER BY rn
      `,
      sp.all(),
    );

    return {
      total: Number(rows[0]?.total ?? 0),
      rows: rows.map((row) => ({
        questionId: Number(row.questionId),
        wrongCount: Number(row.wrongCount),
        totalAttempts: Number(row.totalAttempts),
      })),
    };
  }

  /** List-row fields for weak-question previews (no answers / explanations). */
  async loadQuestionPreviews(
    questionIds: number[],
    lang: string,
  ): Promise<Map<number, WeakQuestionPreview>> {
    if (questionIds.length === 0) return new Map();

    const questions = await this.questionRepo
      .createQueryBuilder('q')
      .select(['q.id', 'q.question', 'q.hasImg', 'q.img', 'q.subject'])
      .where('q.lang = :lang', { lang })
      .andWhere('q.id IN (:...questionIds)', { questionIds })
      .getMany();

    return new Map(
      questions.map((q) => [
        q.id,
        {
          question: q.question,
          hasImg: q.hasImg,
          img: q.img ?? null,
          subject: q.subject,
        },
      ]),
    );
  }

  /** Aggregate all answers by topic — not latest-per-question (that mirrors weak-questions). */
  async loadWeakSubjectTop(
    userId: number,
    categoryId: number | null,
  ): Promise<{ rows: WeakSubjectAggregateRow[]; total: number }> {
    const sp = new SqlParams();
    const userPh = sp.add(userId);
    const minAttemptsPh = sp.add(MIN_SUBJECT_ATTEMPTS_FOR_STATS);
    const limitPh = sp.add(TOP_COUNT);
    let filterPh: string | undefined;
    let catPh: string | undefined;
    if (categoryId != null) {
      filterPh = sp.add(categoryFilterJson(categoryId));
      catPh = sp.add(categoryId);
    }
    const masteryPh = sp.add(QUESTION_MASTERY_CORRECT_RATIO);

    const rows = await this.answerRepo.manager.query<
      {
        subjectId: string;
        wrongCount: string;
        correctCount: string;
        attempted: string;
        correctnessRate: string;
        total: string;
      }[]
    >(
      `
      WITH ${combinedGradedAnswersCte('combined', {
        userIdPlaceholder: userPh,
        categoryFilterPlaceholder: filterPh,
        categoryIdPlaceholder: catPh,
        includeSubject: true,
      })},
      ${perQuestionRateCte('combined', 'per_q', true)},
      classified AS (
        SELECT
          per_q.subject,
          CASE
            WHEN per_q."correctRate" >= ${masteryPh} THEN true
            ELSE false
          END AS "isCorrect"
        FROM per_q
      ),
      agg AS (
        SELECT
          classified.subject AS "subjectId",
          SUM(CASE WHEN classified."isCorrect" = false THEN 1 ELSE 0 END)::int AS "wrongCount",
          SUM(CASE WHEN classified."isCorrect" = true THEN 1 ELSE 0 END)::int AS "correctCount",
          COUNT(*)::int AS attempted,
          (SUM(CASE WHEN classified."isCorrect" = true THEN 1 ELSE 0 END)::float
            / COUNT(*)) AS "correctnessRate"
        FROM classified
        GROUP BY classified.subject
        HAVING COUNT(*) >= ${minAttemptsPh}
          AND SUM(CASE WHEN classified."isCorrect" = false THEN 1 ELSE 0 END) > 0
      ),
      ranked AS (
        SELECT
          agg.*,
          COUNT(*) OVER()::int AS total,
          ROW_NUMBER() OVER (
            ORDER BY agg."correctnessRate" ASC, agg.attempted DESC
          ) AS rn
        FROM agg
      )
      SELECT "subjectId", "wrongCount", "correctCount", attempted, "correctnessRate", total
      FROM ranked
      WHERE rn <= ${limitPh}
      ORDER BY rn
      `,
      sp.all(),
    );

    return {
      total: Number(rows[0]?.total ?? 0),
      rows: rows.map((row) => ({
        subjectId: Number(row.subjectId),
        wrongCount: Number(row.wrongCount),
        correctCount: Number(row.correctCount),
        attempted: Number(row.attempted),
        correctnessRate: Number(row.correctnessRate),
      })),
    };
  }

  /** Live question counts per topic, used when a category has no subject catalog. */
  async loadQuestionTotalsBySubject(
    subjectIds: number[],
    lang: string,
    categoryId?: number,
  ): Promise<Map<number, number>> {
    if (subjectIds.length === 0) return new Map();

    const totalQb = this.questionRepo
      .createQueryBuilder('q')
      .select('q.subject', 'subject')
      .addSelect('COUNT(*)', 'count')
      .where('q.lang = :lang', { lang })
      .andWhere('q.subject IN (:...subjectIds)', { subjectIds })
      .groupBy('q.subject');

    if (categoryId != null) {
      totalQb.andWhere(':categoryId = ANY(q.categories)', { categoryId });
    }

    const totalBySubject = await totalQb.getRawMany<{
      subject: string;
      count: string;
    }>();

    return new Map(
      totalBySubject.map((x) => [Number(x.subject), Number(x.count)]),
    );
  }

  async countCompletedAttemptsForCategory(
    userId: number,
    categoryId: number,
  ): Promise<number> {
    const row = await this.attemptRepo
      .createQueryBuilder('t')
      .select('COUNT(*)', 'count')
      .where('t.userId = :userId', { userId })
      .andWhere('t.completedAt IS NOT NULL')
      .andWhere(
        attemptMatchesCategoryWhere('t', categoryId),
        attemptCategoryMatchParams(categoryId),
      )
      .getRawOne<{ count: string }>();

    return Number(row?.count ?? 0);
  }

  async loadRecentCompletedAttempts(
    userId: number,
    categoryId: number,
  ): Promise<RecentAttemptRow[]> {
    const categoryFilter = categoryFilterJson(categoryId);
    const fallbackThreshold = resolveGeorgianExamRule({
      categories: [categoryId],
    }).minCorrectToPass;

    const rows = await this.answerRepo.manager.query<
      {
        id: string;
        minCorrectToPass: string | null;
        passed: boolean | string | null;
        correctCount: string;
        answeredCount: string;
        earlyWrongCount: string;
      }[]
    >(
      `
      WITH recent AS (
        SELECT t.id, t."minCorrectToPass", t.passed, t."completedAt"
        FROM exam_attempts t
        WHERE t."userId" = $1
          AND t."completedAt" IS NOT NULL
          AND ${attemptMatchesCategorySql('t', '$2', '$3')}
        ORDER BY t."completedAt" DESC
        LIMIT $4
      ),
      answer_stats AS (
        SELECT
          a."attemptId" AS "attemptId",
          SUM(CASE WHEN a.correct = true THEN 1 ELSE 0 END)::int AS "correctCount",
          COUNT(*)::int AS "answeredCount"
        FROM user_answers a
        INNER JOIN exam_attempts t ON a."attemptId" = t.id
        ${liveQuestionJoinSql('a', 't')}
        WHERE a."attemptId" IN (SELECT id FROM recent)
        GROUP BY a."attemptId"
      ),
      early AS (
        SELECT
          ranked."attemptId" AS "attemptId",
          COUNT(*) FILTER (WHERE ranked.correct = false)::int AS "earlyWrongCount"
        FROM (
          SELECT
            a."attemptId",
            a.correct,
            ROW_NUMBER() OVER (
              PARTITION BY a."attemptId"
              ORDER BY a."createdAt" ASC, a.id ASC
            ) AS rn
          FROM user_answers a
          INNER JOIN exam_attempts t ON a."attemptId" = t.id
          ${liveQuestionJoinSql('a', 't')}
          WHERE a."attemptId" IN (SELECT id FROM recent)
        ) ranked
        WHERE ranked.rn <= $5
        GROUP BY ranked."attemptId"
      )
      SELECT
        r.id,
        r."minCorrectToPass",
        r.passed,
        COALESCE(s."correctCount", 0)::text AS "correctCount",
        COALESCE(s."answeredCount", 0)::text AS "answeredCount",
        COALESCE(e."earlyWrongCount", 0)::text AS "earlyWrongCount"
      FROM recent r
      LEFT JOIN answer_stats s ON s."attemptId" = r.id
      LEFT JOIN early e ON e."attemptId" = r.id
      ORDER BY r."completedAt" DESC
      `,
      [
        userId,
        categoryFilter,
        categoryId,
        READINESS_MAX_ATTEMPTS,
        EARLY_FAIL_WINDOW,
      ],
    );

    return rows.map((row) => ({
      correctCount: Number(row.correctCount ?? 0),
      minCorrectToPass: Number(row.minCorrectToPass ?? fallbackThreshold),
      passed:
        row.passed === true || row.passed === 't' || row.passed === 'true',
      answeredCount: Number(row.answeredCount ?? 0),
      earlyWrongCount: Number(row.earlyWrongCount ?? 0),
    }));
  }

  async loadSubjectAggregatesForCategory(
    userId: number,
    categoryId: number,
  ): Promise<SubjectAggregateRow[]> {
    const sp = new SqlParams();
    const userPh = sp.add(userId);
    const filterPh = sp.add(categoryFilterJson(categoryId));
    const catPh = sp.add(categoryId);
    const masteryPh = sp.add(QUESTION_MASTERY_CORRECT_RATIO);

    const rows = await this.answerRepo.manager.query<
      {
        subjectId: string;
        correctCount: string;
        wrongCount: string;
        distinctQuestions: string;
      }[]
    >(
      `
      WITH ${combinedGradedAnswersCte('combined', {
        userIdPlaceholder: userPh,
        categoryFilterPlaceholder: filterPh,
        categoryIdPlaceholder: catPh,
        includeSubject: true,
      })},
      ${perQuestionRateCte('combined', 'per_q', true)},
      classified AS (
        SELECT
          per_q.subject,
          CASE
            WHEN per_q."correctRate" >= ${masteryPh} THEN true
            ELSE false
          END AS "isCorrect"
        FROM per_q
      )
      SELECT
        classified.subject AS "subjectId",
        SUM(CASE WHEN classified."isCorrect" = true THEN 1 ELSE 0 END)::int AS "correctCount",
        SUM(CASE WHEN classified."isCorrect" = false THEN 1 ELSE 0 END)::int AS "wrongCount",
        COUNT(*)::int AS "distinctQuestions"
      FROM classified
      GROUP BY classified.subject
      `,
      sp.all(),
    );

    return rows.map((row) => ({
      subjectId: Number(row.subjectId),
      correctCount: Number(row.correctCount),
      wrongCount: Number(row.wrongCount),
      distinctQuestions: Number(row.distinctQuestions),
    }));
  }

  async loadQuestionPoolExposure(
    userId: number,
    categoryId: number,
    lang: string,
  ): Promise<QuestionPoolExposure> {
    const sp = new SqlParams();
    const userPh = sp.add(userId);
    const filterPh = sp.add(categoryFilterJson(categoryId));
    const catPh = sp.add(categoryId);

    const [answeredRow, categoryCountRow] = await Promise.all([
      this.answerRepo.manager.query<{ count: string }[]>(
        `
        WITH ${combinedGradedAnswersCte('combined', {
          userIdPlaceholder: userPh,
          categoryFilterPlaceholder: filterPh,
          categoryIdPlaceholder: catPh,
          gradedPracticeOnly: false,
        })}
        SELECT COUNT(DISTINCT "questionId")::int AS count
        FROM combined
        `,
        sp.all(),
      ),
      this.questionRepo
        .createQueryBuilder('q')
        .select('COUNT(*)', 'count')
        .where('q.lang = :lang', { lang })
        .andWhere(':categoryId = ANY(q.categories)', { categoryId })
        .getRawOne<{ count: string }>(),
    ]);

    const totalQuestionsInCategory = Number(categoryCountRow?.count ?? 0);
    const distinctQuestionsAnswered = Number(answeredRow[0]?.count ?? 0);
    const exposureRate =
      totalQuestionsInCategory > 0
        ? round3(distinctQuestionsAnswered / totalQuestionsInCategory)
        : 0;

    return {
      distinctQuestionsAnswered,
      totalQuestionsInCategory,
      exposureRate,
    };
  }

  /** Category subject catalog, with counts recomputed from the live question pool. */
  async loadCategorySubjectCatalog(
    categoryId: number,
    lang: string,
  ): Promise<CategorySubjectRow[]> {
    const [category, liveRows] = await Promise.all([
      this.categoryRepo.findOne({
        where: { id: categoryId },
        select: ['id', 'subjects'],
      }),
      this.questionRepo
        .createQueryBuilder('q')
        .select('q.subject', 'subject')
        .addSelect('COUNT(*)', 'count')
        .where('q.lang = :lang', { lang })
        .andWhere(':categoryId = ANY(q.categories)', { categoryId })
        .andWhere('q.subject IS NOT NULL')
        .groupBy('q.subject')
        .orderBy('q.subject', 'ASC')
        .getRawMany<{ subject: string; count: string }>(),
    ]);

    const liveCounts = new Map(
      liveRows.map((r) => [Number(r.subject), Number(r.count)]),
    );

    if (category?.subjects?.length) {
      return [...category.subjects]
        .map((s) => ({
          ...s,
          questionsCount: liveCounts.get(s.id) ?? 0,
        }))
        .filter((s) => s.questionsCount > 0)
        .sort((a, b) => a.id - b.id);
    }

    return liveRows.map((r) => ({
      id: Number(r.subject),
      name: `Subject ${r.subject}`,
      questionsCount: Number(r.count),
    }));
  }
}
