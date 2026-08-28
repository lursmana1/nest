import { Injectable } from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ExamAttempt } from '../../exam-attempts/entities/exam-attempt.entity';
import {
  READINESS_MAX_ATTEMPTS,
  EARLY_FAIL_WINDOW,
} from '../../common/constants/exam.constants.js';
import { resolveGeorgianExamRule } from '../../common/utils/georgian-exam-rules.util.js';
import {
  attemptCategoryMatchParams,
  attemptMatchesCategorySql,
  attemptMatchesCategoryWhere,
  categoryFilterJson,
  liveQuestionJoinSql,
} from '../../common/utils/attempt-category-filter.util.js';
import { parsePgBoolean } from '../../common/utils/pg-row.util.js';
import type { RecentAttemptRow } from '../user-stats.types.js';

/** Completed-exam history that feeds the readiness score. */
@Injectable()
export class AttemptStatsQueryService {
  constructor(
    @InjectEntityManager()
    private readonly manager: EntityManager,
    @InjectRepository(ExamAttempt)
    private readonly attemptRepo: Repository<ExamAttempt>,
  ) {}

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

  /**
   * Most recent completed attempts with per-attempt score and early-window
   * wrong count. Only live questions are graded.
   */
  async loadRecentCompletedAttempts(
    userId: number,
    categoryId: number,
  ): Promise<RecentAttemptRow[]> {
    const categoryFilter = categoryFilterJson(categoryId);
    const fallbackThreshold = resolveGeorgianExamRule({
      categories: [categoryId],
    }).minCorrectToPass;

    const rows = await this.manager.query<
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
      passed: parsePgBoolean(row.passed),
      answeredCount: Number(row.answeredCount ?? 0),
      earlyWrongCount: Number(row.earlyWrongCount ?? 0),
    }));
  }
}
