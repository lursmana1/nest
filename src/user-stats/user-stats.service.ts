import { Injectable, NotFoundException } from '@nestjs/common';
import { CategorySubjectRow } from '../categories/entities/category.entity';
import { DEFAULT_LANG } from '../common/constants/lang.constants.js';
import {
  MIN_SUBJECT_ATTEMPTS_FOR_STATS,
  SUBJECT_COVERAGE_RATIO,
  READINESS_MAX_ATTEMPTS,
  READINESS_READY_PRACTICE_THRESHOLD,
  READINESS_READY_SCORE_THRESHOLD,
} from '../common/constants/exam.constants.js';
import { getCategoryDisplayMeta } from '../common/constants/category.constants.js';
import {
  formatExamRuleResponse,
  resolveGeorgianExamRule,
} from '../common/utils/georgian-exam-rules.util.js';
import { round3 } from '../common/utils/round3.util.js';
import { computeReadiness } from './readiness.util.js';
import { buildSubjectProgressRows } from './user-stats-query.util.js';
import { UserStatsQueryService } from './user-stats-query.service';
import type {
  CategoryProgress,
  QuestionPoolResponse,
  ReadinessResponse,
  SubjectProgressResponse,
  UserStatsSummary,
  WeakQuestionsResponse,
  WeakSubjectsResponse,
} from './user-stats.types.js';

export type {
  QuestionPoolResponse,
  ReadinessResponse,
  SubjectProgressResponse,
  UserStatsSummary,
  WeakQuestionItem,
  WeakQuestionPreview,
  WeakQuestionsResponse,
  WeakSubjectItem,
  WeakSubjectsResponse,
} from './user-stats.types.js';

/**
 * Builds the /user-stats API responses. All SQL lives in `UserStatsQueryService`;
 * this service composes rows into the payloads the profile screens consume.
 */
@Injectable()
export class UserStatsService {
  constructor(private readonly query: UserStatsQueryService) {}

  async getSummary(
    userId: number,
    categoryId: number,
    lang: string = DEFAULT_LANG,
  ): Promise<UserStatsSummary> {
    const progress = await this.loadCategoryProgress(userId, categoryId, lang);
    const [readiness, pool] = await Promise.all([
      this.buildReadiness(userId, categoryId, progress),
      this.query.loadQuestionPoolExposure(userId, categoryId, lang),
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
    const pool = await this.query.loadQuestionPoolExposure(
      userId,
      categoryId,
      lang,
    );
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

  async getWeakQuestions(
    userId: number,
    lang: string = DEFAULT_LANG,
    categoryId?: number,
  ): Promise<WeakQuestionsResponse> {
    const { rows, total } = await this.query.loadWeakQuestionCounts(
      userId,
      categoryId,
    );
    const previews = await this.query.loadQuestionPreviews(
      rows.map((r) => r.questionId),
      lang,
    );

    return {
      categoryId: categoryId ?? null,
      data: rows.map((row) => ({
        questionId: row.questionId,
        wrongCount: row.wrongCount,
        totalAttempts: row.totalAttempts,
        preview: previews.get(row.questionId) ?? null,
      })),
      total,
    };
  }

  async getWeakSubjects(
    userId: number,
    lang: string = DEFAULT_LANG,
    categoryId?: number,
  ): Promise<WeakSubjectsResponse> {
    const [top, catalog] = await Promise.all([
      this.query.loadWeakSubjectTop(userId, categoryId ?? null),
      categoryId != null
        ? this.query.loadCategorySubjectCatalog(categoryId, lang)
        : Promise.resolve([] as CategorySubjectRow[]),
    ]);

    if (top.rows.length === 0) {
      return { categoryId: categoryId ?? null, data: [], total: top.total };
    }

    const nameMap = new Map(catalog.map((s) => [s.id, s.name]));
    const totalMap = new Map(catalog.map((s) => [s.id, s.questionsCount]));

    let fallbackTotals = new Map<number, number>();
    if (catalog.length === 0) {
      fallbackTotals = await this.query.loadQuestionTotalsBySubject(
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
          totalMap.get(row.subjectId) ?? fallbackTotals.get(row.subjectId) ?? 0,
      })),
      total: top.total,
    };
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
      this.query.loadRecentCompletedAttempts(userId, categoryId),
      this.query.countCompletedAttemptsForCategory(userId, categoryId),
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
      this.query.loadCategorySubjectCatalog(categoryId, lang),
      this.query.loadSubjectAggregatesForCategory(userId, categoryId),
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
}
