import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserAnswer } from '../exam-attempts/entities/user-answer.entity';
import { ExamAttempt } from '../exam-attempts/entities/exam-attempt.entity';
import { Question } from '../questions/entities/question.entity';
import { Category, CategorySubjectRow } from '../categories/entities/category.entity';
import { DEFAULT_LANG } from '../common/constants/lang.constants.js';
import {
  MIN_SUBJECT_ATTEMPTS_FOR_STATS,
  SUBJECT_COVERAGE_RATIO,
  READINESS_MAX_ATTEMPTS,
  READINESS_READY_PRACTICE_THRESHOLD,
  READINESS_READY_SCORE_THRESHOLD,
} from '../common/constants/exam.constants.js';
import { getCategoryDisplayMeta, type CategoryDisplayMeta } from '../common/constants/category.constants.js';
import {
  formatExamRuleResponse,
  resolveGeorgianExamRule,
  type ResolvedGeorgianExamRule,
} from '../common/utils/georgian-exam-rules.util.js';
import {
  attemptCategoryMatchParams,
  attemptMatchesCategorySql,
  attemptMatchesCategoryWhere,
  answerJoinedCategorySql,
  categoryFilterJson,
} from '../common/utils/attempt-category-filter.util.js';
import { computeReadiness, type ReadinessResult, EARLY_FAIL_WINDOW } from './readiness.util.js';
import {
  buildSubjectProgressRows,
  type SubjectProgressRow,
} from './user-stats-query.util.js';

const TOP_COUNT = 5;

type CategoryProgress = {
  display: CategoryDisplayMeta;
  rule: ResolvedGeorgianExamRule;
  passRate: number;
  progressRows: SubjectProgressRow[];
};

export type ReadinessResponse = {
  categoryId: number;
  categoryName: string;
  questionCount: number;
  minCorrectToPass: number;
  maxWrongAnswers: number;
  durationMinutes: number;
  readinessScore: number;
  confidence: ReadinessResult['confidence'];
  readyForExam: boolean;
  label: string;
  examAccuracy: number;
  answerAccuracy: number;
  practicePart: number;
  coverageFactor: number;
  earlyFailCount: number;
  lastAttemptPassed: boolean | null;
  completedAttemptsTotal: number;
  completedAttemptsUsed: number;
  subjectsCovered: number;
  subjectsMastered: number;
  subjectsTotal: number;
  weakSubjectsCount: number;
};

/** Compact first-paint payload for the profile stats grid. */
export interface UserStatsSummary {
  categoryId: number;
  categoryName: string;
  readinessScore: number;
  readyForExam: boolean;
  confidence: ReadinessResult['confidence'];
  label: string;
  subjectsCovered: number;
  subjectsMastered: number;
  subjectsTotal: number;
  weakSubjectsCount: number;
  completedAttemptsTotal: number;
  distinctQuestionsAnswered: number;
  totalQuestionsInCategory: number;
  exposureRate: number;
  questionCount: number;
  minCorrectToPass: number;
}

export interface WeakQuestionPreview {
  question: string;
  hasImg: number;
  img: string | null;
  subject: number | null;
}

export interface WeakQuestionItem {
  questionId: number;
  wrongCount: number;
  totalAttempts: number;
  /** List-row fields only — no answers / explanations (keeps JSON tiny). */
  preview: WeakQuestionPreview | null;
}

export interface WeakSubjectItem {
  subjectId: number;
  name: string;
  wrongCount: number;
  correctCount: number;
  attempted: number;
  correctnessRate: number;
  totalQuestions: number;
}

export interface WeakQuestionsResponse {
  categoryId: number | null;
  data: WeakQuestionItem[];
  total: number;
}

export interface WeakSubjectsResponse {
  categoryId: number | null;
  data: WeakSubjectItem[];
  total: number;
}

export interface SubjectProgressResponse {
  categoryId: number;
  categoryName: string;
  passRate: number;
  /** Distinct questions / topic pool required to count as covered (0.7). */
  coverageRatioRequired: number;
  minAttemptsForMastery: number;
  subjectsTotal: number;
  subjectsCovered: number;
  subjectsMastered: number;
  data: SubjectProgressRow[];
}

export interface QuestionPoolResponse {
  categoryId: number;
  distinctQuestionsAnswered: number;
  totalQuestionsInCategory: number;
  exposureRate: number;
}

@Injectable()
export class UserStatsService {
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

  async getSummary(
    userId: number,
    categoryId: number,
    lang: string = DEFAULT_LANG,
  ): Promise<UserStatsSummary> {
    const progress = await this.loadCategoryProgress(userId, categoryId, lang);
    const [readiness, pool] = await Promise.all([
      this.buildReadiness(userId, categoryId, progress),
      this.loadQuestionPoolExposure(userId, categoryId, lang),
    ]);

    return {
      categoryId,
      categoryName: readiness.categoryName,
      readinessScore: readiness.readinessScore,
      readyForExam: readiness.readyForExam,
      confidence: readiness.confidence,
      label: readiness.label,
      subjectsCovered: readiness.subjectsCovered,
      subjectsMastered: readiness.subjectsMastered,
      subjectsTotal: readiness.subjectsTotal,
      weakSubjectsCount: readiness.weakSubjectsCount,
      completedAttemptsTotal: readiness.completedAttemptsTotal,
      distinctQuestionsAnswered: pool.distinctQuestionsAnswered,
      totalQuestionsInCategory: pool.totalQuestionsInCategory,
      exposureRate: pool.exposureRate,
      questionCount: readiness.questionCount,
      minCorrectToPass: readiness.minCorrectToPass,
    };
  }

  async getQuestionPool(
    userId: number,
    categoryId: number,
    lang: string = DEFAULT_LANG,
  ): Promise<QuestionPoolResponse> {
    const pool = await this.loadQuestionPoolExposure(userId, categoryId, lang);
    return { categoryId, ...pool };
  }

  async getReadiness(
    userId: number,
    categoryId: number,
    lang: string = DEFAULT_LANG,
  ): Promise<ReadinessResponse> {
    const progress = await this.loadCategoryProgress(userId, categoryId, lang);
    return this.buildReadiness(userId, categoryId, progress);
  }

  async getSubjectProgress(
    userId: number,
    categoryId: number,
    lang: string = DEFAULT_LANG,
  ): Promise<SubjectProgressResponse> {
    const progress = await this.loadCategoryProgress(userId, categoryId, lang);
    return this.toSubjectProgressResponse(categoryId, progress);
  }

  private toSubjectProgressResponse(
    categoryId: number,
    progress: CategoryProgress,
  ): SubjectProgressResponse {
    const { display, passRate, progressRows } = progress;
    return {
      categoryId,
      categoryName: display.name,
      passRate: round3(passRate),
      coverageRatioRequired: SUBJECT_COVERAGE_RATIO,
      minAttemptsForMastery: MIN_SUBJECT_ATTEMPTS_FOR_STATS,
      subjectsTotal: progressRows.length,
      subjectsCovered: progressRows.filter((s) => s.covered).length,
      subjectsMastered: progressRows.filter((s) => s.mastered).length,
      data: progressRows,
    };
  }

  private async buildReadiness(
    userId: number,
    categoryId: number,
    progress: CategoryProgress,
  ): Promise<ReadinessResponse> {
    const { display, rule, passRate, progressRows } = progress;
    const [attemptRows, completedAttemptsTotal] = await Promise.all([
      this.loadRecentCompletedAttempts(userId, categoryId),
      this.countCompletedAttemptsForCategory(userId, categoryId),
    ]);

    const readiness = computeReadiness({
      attempts: attemptRows.map((row) => ({
        correctCount: row.correctCount,
        minCorrectToPass: row.minCorrectToPass,
        passed: row.passed,
        answeredCount: row.answeredCount,
        earlyWrongCount: row.earlyWrongCount,
      })),
      subjects: progressRows.map((row) => ({
        subjectId: row.subjectId,
        correctCount: row.correctCount,
        wrongCount: row.wrongCount,
        distinctQuestionsAnswered: row.distinctQuestionsAnswered,
        totalQuestions: row.totalQuestions,
      })),
      subjectsTotal: progressRows.length,
      questionCount: rule.questionCount,
      passRate,
      minSubjectAttempts: MIN_SUBJECT_ATTEMPTS_FOR_STATS,
      completedAttemptsTotal,
      recentExamLimit: READINESS_MAX_ATTEMPTS,
      readyScoreThreshold: READINESS_READY_SCORE_THRESHOLD,
      readyPracticeThreshold: READINESS_READY_PRACTICE_THRESHOLD,
    });

    const rules = formatExamRuleResponse(categoryId, rule);
    return {
      categoryName: display.name,
      categoryId: rules.categoryId,
      questionCount: rules.questionCount,
      minCorrectToPass: rules.minCorrectToPass,
      maxWrongAnswers: rules.maxWrongAnswers,
      durationMinutes: rules.durationMinutes,
      readinessScore: readiness.readinessScore,
      confidence: readiness.confidence,
      readyForExam: readiness.readyForExam,
      label: readiness.label,
      examAccuracy: readiness.examAccuracy,
      answerAccuracy: readiness.answerAccuracy,
      practicePart: readiness.practicePart,
      coverageFactor: readiness.coverageFactor,
      earlyFailCount: readiness.earlyFailCount,
      lastAttemptPassed: readiness.lastAttemptPassed,
      completedAttemptsTotal: readiness.completedAttemptsTotal,
      completedAttemptsUsed: readiness.completedAttemptsUsed,
      subjectsCovered: readiness.subjectsCovered,
      subjectsMastered: readiness.subjectsMastered,
      subjectsTotal: readiness.subjectsTotal,
      weakSubjectsCount: readiness.weakSubjectsCount,
    };
  }

  async getWeakQuestions(
    userId: number,
    lang: string = DEFAULT_LANG,
    categoryId?: number,
  ): Promise<WeakQuestionsResponse> {
    const params: unknown[] = [userId, TOP_COUNT];
    let categoryClause = '';
    if (categoryId != null) {
      params.push(categoryFilterJson(categoryId), categoryId);
      categoryClause = `AND ${answerJoinedCategorySql('t', 'a', `$${params.length - 1}`, `$${params.length}`)}`;
    }

    const rows = await this.answerRepo.manager.query<
      {
        questionId: string;
        wrongCount: string;
        totalAttempts: string;
        total: string;
      }[]
    >(
      `
      WITH agg AS (
        SELECT
          a."questionId" AS "questionId",
          SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END)::int AS "wrongCount",
          COUNT(*)::int AS "totalAttempts"
        FROM user_answers a
        INNER JOIN exam_attempts t ON a."attemptId" = t.id
        WHERE t."userId" = $1
          ${categoryClause}
        GROUP BY a."questionId"
        HAVING SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END) > 0
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
      WHERE rn <= $2
      ORDER BY rn
      `,
      params,
    );

    const total = Number(rows[0]?.total ?? 0);
    const questionIds = rows.map((r) => Number(r.questionId));
    const questions =
      questionIds.length > 0
        ? await this.questionRepo
            .createQueryBuilder('q')
            .select(['q.id', 'q.question', 'q.hasImg', 'q.img', 'q.subject'])
            .where('q.lang = :lang', { lang })
            .andWhere('q.id IN (:...questionIds)', { questionIds })
            .getMany()
        : [];
    const questionMap = new Map(questions.map((q) => [q.id, q]));

    return {
      categoryId: categoryId ?? null,
      data: rows.map((r) => {
        const q = questionMap.get(Number(r.questionId));
        return {
          questionId: Number(r.questionId),
          wrongCount: Number(r.wrongCount),
          totalAttempts: Number(r.totalAttempts),
          preview: q
            ? {
                question: q.question,
                hasImg: q.hasImg,
                img: q.img ?? null,
                subject: q.subject,
              }
            : null,
        };
      }),
      total,
    };
  }

  async getWeakSubjects(
    userId: number,
    lang: string = DEFAULT_LANG,
    categoryId?: number,
  ): Promise<WeakSubjectsResponse> {
    const [top, catalog] = await Promise.all([
      this.loadWeakSubjectTop(userId, categoryId ?? null),
      categoryId != null
        ? this.loadCategorySubjectCatalog(categoryId, lang)
        : Promise.resolve([] as CategorySubjectRow[]),
    ]);

    if (top.rows.length === 0) {
      return { categoryId: categoryId ?? null, data: [], total: top.total };
    }

    const nameMap = new Map(catalog.map((s) => [s.id, s.name]));
    const totalMap = new Map(catalog.map((s) => [s.id, s.questionsCount]));

    let fallbackTotals = new Map<number, number>();
    if (catalog.length === 0) {
      fallbackTotals = await this.loadQuestionTotalsBySubject(
        top.rows.map((x) => x.subjectId),
        lang,
        categoryId,
      );
    }

    return {
      categoryId: categoryId ?? null,
      data: top.rows.map((row) => ({
        subjectId: row.subjectId,
        name: nameMap.get(row.subjectId) ?? `Subject ${row.subjectId}`,
        wrongCount: row.wrongCount,
        correctCount: row.correctCount,
        attempted: row.attempted,
        correctnessRate: round3(row.correctnessRate),
        totalQuestions:
          totalMap.get(row.subjectId) ??
          fallbackTotals.get(row.subjectId) ??
          0,
      })),
      total: top.total,
    };
  }

  /** Aggregate all answers by topic — not latest-per-question (that mirrors weak-questions). */
  private async loadWeakSubjectTop(
    userId: number,
    categoryId: number | null,
  ): Promise<{
    rows: {
      subjectId: number;
      wrongCount: number;
      correctCount: number;
      attempted: number;
      correctnessRate: number;
    }[];
    total: number;
  }> {
    const params: unknown[] = [userId, MIN_SUBJECT_ATTEMPTS_FOR_STATS, TOP_COUNT];
    let categoryClause = '';
    if (categoryId != null) {
      params.push(categoryFilterJson(categoryId), categoryId);
      categoryClause = `AND ${answerJoinedCategorySql('t', 'a', `$${params.length - 1}`, `$${params.length}`)}`;
    }

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
      WITH agg AS (
        SELECT
          a.subject AS "subjectId",
          SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END)::int AS "wrongCount",
          SUM(CASE WHEN a.correct = true THEN 1 ELSE 0 END)::int AS "correctCount",
          COUNT(*)::int AS attempted,
          (SUM(CASE WHEN a.correct = true THEN 1 ELSE 0 END)::float / COUNT(*)) AS "correctnessRate"
        FROM user_answers a
        INNER JOIN exam_attempts t ON a."attemptId" = t.id
        WHERE t."userId" = $1
          AND a.subject IS NOT NULL
          ${categoryClause}
        GROUP BY a.subject
        HAVING COUNT(*) >= $2
          AND SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END) > 0
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
      WHERE rn <= $3
      ORDER BY rn
      `,
      params,
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

  private async loadQuestionTotalsBySubject(
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

  private async loadCategoryProgress(
    userId: number,
    categoryId: number,
    lang: string,
  ): Promise<CategoryProgress> {
    const display = getCategoryDisplayMeta(categoryId);
    if (!display) {
      throw new NotFoundException(`Category ${categoryId} not found`);
    }

    const rule = resolveGeorgianExamRule({ categories: [categoryId] });
    const passRate = rule.minCorrectToPass / rule.questionCount;

    const [catalog, subjectStats] = await Promise.all([
      this.loadCategorySubjectCatalog(categoryId, lang),
      this.loadSubjectAggregatesForCategory(userId, categoryId),
    ]);

    const countsBySubject = new Map<
      number,
      { correctCount: number; wrongCount: number }
    >();
    const distinctBySubject = new Map<number, number>();
    for (const row of subjectStats) {
      countsBySubject.set(row.subjectId, {
        correctCount: row.correctCount,
        wrongCount: row.wrongCount,
      });
      distinctBySubject.set(row.subjectId, row.distinctQuestions);
    }

    const progressRows = buildSubjectProgressRows(
      catalog,
      countsBySubject,
      distinctBySubject,
      passRate,
      MIN_SUBJECT_ATTEMPTS_FOR_STATS,
      SUBJECT_COVERAGE_RATIO,
    );

    return { display, rule, passRate, progressRows };
  }

  private async countCompletedAttemptsForCategory(
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

  private async loadRecentCompletedAttempts(
    userId: number,
    categoryId: number,
  ): Promise<
    {
      correctCount: number;
      minCorrectToPass: number;
      passed: boolean;
      answeredCount: number;
      earlyWrongCount: number;
    }[]
  > {
    const categoryFilter = categoryFilterJson(categoryId);
    const fallbackThreshold = resolveGeorgianExamRule({
      categories: [categoryId],
    }).minCorrectToPass;

    const rows = await this.answerRepo.manager.query<
      {
        id: string;
        minCorrectToPass: string | null;
        passed: boolean | null;
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
      passed: row.passed === true,
      answeredCount: Number(row.answeredCount ?? 0),
      earlyWrongCount: Number(row.earlyWrongCount ?? 0),
    }));
  }

  private async loadSubjectAggregatesForCategory(
    userId: number,
    categoryId: number,
  ): Promise<
    {
      subjectId: number;
      correctCount: number;
      wrongCount: number;
      distinctQuestions: number;
    }[]
  > {
    const categoryFilter = categoryFilterJson(categoryId);
    const rows = await this.answerRepo.manager.query<
      {
        subjectId: string;
        correctCount: string;
        wrongCount: string;
        distinctQuestions: string;
      }[]
    >(
      `
      SELECT
        a.subject AS "subjectId",
        SUM(CASE WHEN a.correct = true THEN 1 ELSE 0 END)::int AS "correctCount",
        SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END)::int AS "wrongCount",
        COUNT(DISTINCT a."questionId")::int AS "distinctQuestions"
      FROM user_answers a
      INNER JOIN exam_attempts t ON a."attemptId" = t.id
      WHERE t."userId" = $1
        AND ${answerJoinedCategorySql('t', 'a', '$2', '$3')}
        AND a.subject IS NOT NULL
      GROUP BY a.subject
      `,
      [userId, categoryFilter, categoryId],
    );

    return rows.map((row) => ({
      subjectId: Number(row.subjectId),
      correctCount: Number(row.correctCount),
      wrongCount: Number(row.wrongCount),
      distinctQuestions: Number(row.distinctQuestions),
    }));
  }

  private async loadQuestionPoolExposure(
    userId: number,
    categoryId: number,
    lang: string,
  ): Promise<Omit<QuestionPoolResponse, 'categoryId'>> {
    const categoryFilter = categoryFilterJson(categoryId);

    const [answeredRow, category] = await Promise.all([
      this.answerRepo.manager.query<{ count: string }[]>(
        `
        SELECT COUNT(DISTINCT a."questionId")::int AS count
        FROM user_answers a
        INNER JOIN exam_attempts t ON a."attemptId" = t.id
        WHERE t."userId" = $1
          AND ${answerJoinedCategorySql('t', 'a', '$2', '$3')}
        `,
        [userId, categoryFilter, categoryId],
      ),
      this.categoryRepo.findOne({
        where: { id: categoryId },
        select: ['id', 'questionsCount'],
      }),
    ]);

    let totalQuestionsInCategory = Number(category?.questionsCount ?? 0);
    if (totalQuestionsInCategory <= 0) {
      const totalRow = await this.questionRepo
        .createQueryBuilder('q')
        .select('COUNT(*)', 'count')
        .where('q.lang = :lang', { lang })
        .andWhere(':categoryId = ANY(q.categories)', { categoryId })
        .getRawOne<{ count: string }>();
      totalQuestionsInCategory = Number(totalRow?.count ?? 0);
    }

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

  private async loadCategorySubjectCatalog(
    categoryId: number,
    lang: string,
  ): Promise<CategorySubjectRow[]> {
    const category = await this.categoryRepo.findOne({
      where: { id: categoryId },
      select: ['id', 'subjects', 'questionsCount'],
    });

    if (category?.subjects?.length) {
      return [...category.subjects].sort((a, b) => a.id - b.id);
    }

    const rows = await this.questionRepo
      .createQueryBuilder('q')
      .select('q.subject', 'subject')
      .addSelect('COUNT(*)', 'count')
      .where('q.lang = :lang', { lang })
      .andWhere(':categoryId = ANY(q.categories)', { categoryId })
      .andWhere('q.subject IS NOT NULL')
      .groupBy('q.subject')
      .orderBy('q.subject', 'ASC')
      .getRawMany<{ subject: string; count: string }>();

    return rows.map((r) => ({
      id: Number(r.subject),
      name: `Subject ${r.subject}`,
      questionsCount: Number(r.count),
    }));
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
