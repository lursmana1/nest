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
  categoryFilterJson,
} from '../common/utils/attempt-category-filter.util.js';
import { computeReadiness, type ReadinessResult, EARLY_FAIL_WINDOW } from './readiness.util.js';
import {
  aggregateSubjectCounts,
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

export type ReadinessResponse = ReadinessResult &
  ReturnType<typeof formatExamRuleResponse> & {
    categoryName: string;
  };

export interface WeakQuestionItem {
  questionId: number;
  wrongCount: number;
  totalAttempts: number;
  question: unknown;
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

export interface UserStatsOverview {
  categoryId: number;
  categoryName: string;
  examRules: ReturnType<typeof formatExamRuleResponse>;
  readiness: ReadinessResult;
  subjectProgress: SubjectProgressResponse;
  weakSubjects: WeakSubjectsResponse;
  weakQuestions: WeakQuestionsResponse;
  questionPool: {
    distinctQuestionsAnswered: number;
    totalQuestionsInCategory: number;
    exposureRate: number;
  };
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

  async getOverview(
    userId: number,
    categoryId: number,
    lang: string = DEFAULT_LANG,
  ): Promise<UserStatsOverview> {
    const progress = await this.loadCategoryProgress(userId, categoryId, lang);
    const [readiness, weakSubjects, weakQuestions, pool] = await Promise.all([
      this.buildReadiness(userId, categoryId, progress),
      this.getWeakSubjects(userId, lang, categoryId),
      this.getWeakQuestions(userId, lang, categoryId),
      this.loadQuestionPoolExposure(userId, categoryId, lang),
    ]);

    const {
      categoryName,
      categoryId: _ruleCategoryId,
      questionCount: _questionCount,
      minCorrectToPass: _minCorrect,
      maxWrongAnswers: _maxWrong,
      durationMinutes: _duration,
      ...readinessScore
    } = readiness;

    return {
      categoryId,
      categoryName,
      examRules: formatExamRuleResponse(categoryId, progress.rule),
      readiness: readinessScore,
      subjectProgress: this.toSubjectProgressResponse(categoryId, progress),
      weakSubjects,
      weakQuestions,
      questionPool: pool,
    };
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

    return {
      categoryName: display.name,
      ...formatExamRuleResponse(categoryId, rule),
      ...readiness,
    };
  }

  async getWeakQuestions(
    userId: number,
    lang: string = DEFAULT_LANG,
    categoryId?: number,
  ): Promise<WeakQuestionsResponse> {
    const baseQb = this.answerRepo
      .createQueryBuilder('a')
      .innerJoin('a.attempt', 't')
      .where('t.userId = :userId', { userId })
      .select('a.questionId', 'questionId')
      .addSelect(
        'SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END)',
        'wrongCount',
      )
      .addSelect('COUNT(*)', 'totalAttempts')
      .groupBy('a.questionId')
      .having('SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END) > 0')
      .orderBy('SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END)', 'DESC');

    if (categoryId != null) {
      baseQb.andWhere(
        attemptMatchesCategoryWhere('t', categoryId),
        attemptCategoryMatchParams(categoryId),
      );
    }

    const [rows, total] = await Promise.all([
      baseQb.clone().limit(TOP_COUNT).getRawMany<{
        questionId: string;
        wrongCount: string;
        totalAttempts: string;
      }>(),
      this.countWeakQuestions(userId, categoryId ?? null),
    ]);
    const questionIds = rows.map((r) => Number(r.questionId));
    const questions =
      questionIds.length > 0
        ? await this.questionRepo
            .createQueryBuilder('q')
            .where('q.lang = :lang', { lang })
            .andWhere('q.id IN (:...questionIds)', { questionIds })
            .getMany()
        : [];
    const questionMap = new Map(questions.map((q) => [q.id, q]));

    return {
      categoryId: categoryId ?? null,
      data: rows.map((r) => ({
        questionId: Number(r.questionId),
        wrongCount: Number(r.wrongCount),
        totalAttempts: Number(r.totalAttempts),
        question: questionMap.get(Number(r.questionId)) ?? null,
      })),
      total,
    };
  }

  async getWeakSubjects(
    userId: number,
    lang: string = DEFAULT_LANG,
    categoryId?: number,
  ): Promise<WeakSubjectsResponse> {
    const [aggregatedRows, total, nameMap] = await Promise.all([
      this.loadWeakSubjectAggregates(userId, categoryId ?? null),
      this.countWeakSubjects(userId, categoryId ?? null),
      this.loadSubjectNameMap(categoryId, lang),
    ]);

    const topRows = aggregatedRows.slice(0, TOP_COUNT);
    if (topRows.length === 0) {
      return { categoryId: categoryId ?? null, data: [], total };
    }

    const subjectIds = topRows.map((x) => x.subjectId);
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

    const totalMap = new Map(
      totalBySubject.map((x) => [Number(x.subject), Number(x.count)]),
    );

    return {
      categoryId: categoryId ?? null,
      data: topRows.map((row) => ({
        subjectId: row.subjectId,
        name: nameMap.get(row.subjectId) ?? `Subject ${row.subjectId}`,
        wrongCount: row.wrongCount,
        correctCount: row.correctCount,
        attempted: row.attempted,
        correctnessRate: round3(row.correctnessRate),
        totalQuestions: totalMap.get(row.subjectId) ?? 0,
      })),
      total,
    };
  }

  /** Aggregate all answers by topic — not latest-per-question (that mirrors weak-questions). */
  private async loadWeakSubjectAggregates(
    userId: number,
    categoryId: number | null,
  ): Promise<
    {
      subjectId: number;
      wrongCount: number;
      correctCount: number;
      attempted: number;
      correctnessRate: number;
    }[]
  > {
    const params: unknown[] = [userId, MIN_SUBJECT_ATTEMPTS_FOR_STATS];
    let categoryClause = '';
    if (categoryId != null) {
      params.push(categoryFilterJson(categoryId), categoryId);
      categoryClause = `AND ${attemptMatchesCategorySql('t', `$${params.length - 1}`, `$${params.length}`)}`;
    }

    const rows = await this.answerRepo.manager.query<
      {
        subjectId: string;
        wrongCount: string;
        correctCount: string;
        attempted: string;
        correctnessRate: string;
      }[]
    >(
      `
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
      ORDER BY "correctnessRate" ASC, attempted DESC
      `,
      params,
    );

    return rows.map((row) => ({
      subjectId: Number(row.subjectId),
      wrongCount: Number(row.wrongCount),
      correctCount: Number(row.correctCount),
      attempted: Number(row.attempted),
      correctnessRate: Number(row.correctnessRate),
    }));
  }

  private async countWeakSubjects(
    userId: number,
    categoryId: number | null,
  ): Promise<number> {
    const params: unknown[] = [userId, MIN_SUBJECT_ATTEMPTS_FOR_STATS];
    let categoryClause = '';
    if (categoryId != null) {
      params.push(categoryFilterJson(categoryId), categoryId);
      categoryClause = `AND ${attemptMatchesCategorySql('t', `$${params.length - 1}`, `$${params.length}`)}`;
    }

    const row = await this.answerRepo.manager.query<{ count: string }[]>(
      `
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT a.subject
        FROM user_answers a
        INNER JOIN exam_attempts t ON a."attemptId" = t.id
        WHERE t."userId" = $1
          AND a.subject IS NOT NULL
          ${categoryClause}
        GROUP BY a.subject
        HAVING COUNT(*) >= $2
          AND SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END) > 0
      ) weak_subjects
      `,
      params,
    );

    return Number(row[0]?.count ?? 0);
  }

  private async loadSubjectNameMap(
    categoryId: number | undefined,
    lang: string,
  ): Promise<Map<number, string>> {
    if (categoryId == null) {
      return new Map();
    }

    const catalog = await this.loadCategorySubjectCatalog(categoryId, lang);
    return new Map(catalog.map((subject) => [subject.id, subject.name]));
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

    const [catalog, answerRows, distinctRows] = await Promise.all([
      this.loadCategorySubjectCatalog(categoryId, lang),
      this.loadAnswerRowsForCategory(userId, categoryId),
      this.loadDistinctQuestionsBySubject(userId, categoryId),
    ]);

    const progressRows = buildSubjectProgressRows(
      catalog,
      aggregateSubjectCounts(answerRows),
      distinctRows,
      passRate,
      MIN_SUBJECT_ATTEMPTS_FOR_STATS,
      SUBJECT_COVERAGE_RATIO,
    );

    return { display, rule, passRate, progressRows };
  }

  private async countWeakQuestions(
    userId: number,
    categoryId: number | null,
  ): Promise<number> {
    const qb = this.answerRepo
      .createQueryBuilder('a')
      .innerJoin('a.attempt', 't')
      .where('t.userId = :userId', { userId })
      .select('a.questionId', 'questionId')
      .groupBy('a.questionId')
      .having('SUM(CASE WHEN a.correct = false THEN 1 ELSE 0 END) > 0');

    if (categoryId != null) {
      qb.andWhere(
        attemptMatchesCategoryWhere('t', categoryId),
        attemptCategoryMatchParams(categoryId),
      );
    }

    const rows = await qb.getRawMany();
    return rows.length;
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
    const rows = await this.attemptRepo
      .createQueryBuilder('t')
      .leftJoin('t.answers', 'a')
      .select('t.id', 'id')
      .addSelect('t.minCorrectToPass', 'minCorrectToPass')
      .addSelect('t.passed', 'passed')
      .addSelect(
        'SUM(CASE WHEN a.correct = true THEN 1 ELSE 0 END)',
        'correctCount',
      )
      .addSelect('COUNT(a.id)', 'answeredCount')
      .where('t.userId = :userId', { userId })
      .andWhere('t.completedAt IS NOT NULL')
      .andWhere(
        attemptMatchesCategoryWhere('t', categoryId),
        attemptCategoryMatchParams(categoryId),
      )
      .groupBy('t.id')
      .addGroupBy('t.minCorrectToPass')
      .addGroupBy('t.passed')
      .addGroupBy('t.completedAt')
      .orderBy('t.completedAt', 'DESC')
      .limit(READINESS_MAX_ATTEMPTS)
      .getRawMany<{
        id: string;
        minCorrectToPass: string | null;
        passed: boolean | null;
        correctCount: string;
        answeredCount: string;
      }>();

    const fallbackThreshold = resolveGeorgianExamRule({
      categories: [categoryId],
    }).minCorrectToPass;

    const attemptIds = rows.map((row) => Number(row.id));
    const earlyWrongByAttempt =
      await this.loadEarlyWrongCounts(attemptIds);

    return rows.map((row) => {
      const id = Number(row.id);
      return {
        correctCount: Number(row.correctCount ?? 0),
        minCorrectToPass: Number(row.minCorrectToPass ?? fallbackThreshold),
        passed: row.passed === true,
        answeredCount: Number(row.answeredCount ?? 0),
        earlyWrongCount: earlyWrongByAttempt.get(id) ?? 0,
      };
    });
  }

  private async loadEarlyWrongCounts(
    attemptIds: number[],
  ): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (attemptIds.length === 0) return map;

    const rows = await this.answerRepo.manager.query<
      { attemptId: string; earlyWrongCount: string }[]
    >(
      `
      SELECT ranked."attemptId" AS "attemptId",
             COUNT(*) FILTER (WHERE ranked.correct = false)::int AS "earlyWrongCount"
      FROM (
        SELECT a."attemptId",
               a.correct,
               ROW_NUMBER() OVER (
                 PARTITION BY a."attemptId"
                 ORDER BY a."createdAt" ASC, a.id ASC
               ) AS rn
        FROM user_answers a
        WHERE a."attemptId" = ANY($1::int[])
      ) ranked
      WHERE ranked.rn <= $2
      GROUP BY ranked."attemptId"
      `,
      [attemptIds, EARLY_FAIL_WINDOW],
    );

    for (const row of rows) {
      map.set(Number(row.attemptId), Number(row.earlyWrongCount));
    }
    return map;
  }

  private async loadAnswerRowsForCategory(
    userId: number,
    categoryId: number | null,
  ): Promise<{ subjectId: number; correct: boolean }[]> {
    if (categoryId != null) {
      const categoryFilter = categoryFilterJson(categoryId);
      return this.answerRepo.manager.query<
        { subjectId: number; correct: boolean }[]
      >(
        `
        SELECT a.subject AS "subjectId", a.correct
        FROM user_answers a
        INNER JOIN exam_attempts t ON a."attemptId" = t.id
        WHERE t."userId" = $1
          AND ${attemptMatchesCategorySql('t', '$2', '$3')}
          AND a.subject IS NOT NULL
        `,
        [userId, categoryFilter, categoryId],
      );
    }

    return this.answerRepo.manager.query<
      { subjectId: number; correct: boolean }[]
    >(
      `
      SELECT a.subject AS "subjectId", a.correct
      FROM user_answers a
      INNER JOIN exam_attempts t ON a."attemptId" = t.id
      WHERE t."userId" = $1
        AND a.subject IS NOT NULL
      `,
      [userId],
    );
  }

  private async loadDistinctQuestionsBySubject(
    userId: number,
    categoryId: number,
  ): Promise<Map<number, number>> {
    const categoryFilter = categoryFilterJson(categoryId);
    const rows = await this.answerRepo.manager.query<
      { subjectId: number; count: string }[]
    >(
      `
      SELECT a.subject AS "subjectId", COUNT(DISTINCT a."questionId")::int AS count
      FROM user_answers a
      INNER JOIN exam_attempts t ON a."attemptId" = t.id
      WHERE t."userId" = $1
        AND ${attemptMatchesCategorySql('t', '$2', '$3')}
        AND a.subject IS NOT NULL
      GROUP BY a.subject
      `,
      [userId, categoryFilter, categoryId],
    );

    return new Map(rows.map((r) => [Number(r.subjectId), Number(r.count)]));
  }

  private async loadQuestionPoolExposure(
    userId: number,
    categoryId: number,
    lang: string,
  ): Promise<UserStatsOverview['questionPool']> {
    const categoryFilter = categoryFilterJson(categoryId);

    const [answeredRow, totalRow] = await Promise.all([
      this.answerRepo.manager.query<{ count: string }[]>(
        `
        SELECT COUNT(DISTINCT a."questionId")::int AS count
        FROM user_answers a
        INNER JOIN exam_attempts t ON a."attemptId" = t.id
        WHERE t."userId" = $1
          AND ${attemptMatchesCategorySql('t', '$2', '$3')}
        `,
        [userId, categoryFilter, categoryId],
      ),
      this.questionRepo
        .createQueryBuilder('q')
        .select('COUNT(*)', 'count')
        .where('q.lang = :lang', { lang })
        .andWhere(':categoryId = ANY(q.categories)', { categoryId })
        .getRawOne<{ count: string }>(),
    ]);

    const distinctQuestionsAnswered = Number(answeredRow[0]?.count ?? 0);
    const totalQuestionsInCategory = Number(totalRow?.count ?? 0);
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
