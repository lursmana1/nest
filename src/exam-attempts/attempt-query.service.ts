import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ExamAttempt } from './entities/exam-attempt.entity';
import { UserAnswer } from './entities/user-answer.entity';
import { Question } from '../questions/entities/question.entity';
import {
  MAX_STATS_LIMIT,
  MAX_HISTORY_PAGE_SIZE,
  DEFAULT_HISTORY_PAGE_SIZE,
} from '../common/constants/exam.constants.js';
import { resolveDisplayDuration } from './attempt-duration.util.js';
import type {
  AttemptSummary,
  AttemptHistoryCounts,
  AttemptDetail,
  PaginatedAttempts,
  RawAnswerRow,
} from './types/exam-attempts.types.js';

type AnswerStats = {
  answeredCount: number;
  correctCount: number;
  lastAnswerAt: Date | null;
};

/** Read-side: history, attempt detail, raw answer log. */
@Injectable()
export class AttemptQueryService {
  constructor(
    @InjectRepository(ExamAttempt)
    private readonly attemptRepo: Repository<ExamAttempt>,
    @InjectRepository(UserAnswer)
    private readonly answerRepo: Repository<UserAnswer>,
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
  ) {}

  async getHistory(
    userId: number,
    page = 1,
    size = DEFAULT_HISTORY_PAGE_SIZE,
  ): Promise<PaginatedAttempts> {
    const pageSize = Math.min(Math.max(1, size), MAX_HISTORY_PAGE_SIZE);
    const pageNum = Math.max(1, page);

    const [attempts, counts] = await Promise.all([
      this.attemptsWithAnswersQb(userId)
        .orderBy('e.createdAt', 'DESC')
        .skip((pageNum - 1) * pageSize)
        .take(pageSize)
        .getMany(),
      this.loadHistoryCounts(userId),
    ]);

    const answerStats = await this.loadAnswerStats(attempts.map((a) => a.id));
    const totalPages =
      counts.total === 0 ? 0 : Math.ceil(counts.total / pageSize);

    return {
      data: attempts.map((a) =>
        this.toAttemptSummary(a, answerStats.get(a.id)),
      ),
      total: counts.total,
      page: pageNum,
      pageSize,
      totalPages,
      counts,
    };
  }

  async getAttempt(userId: number, attemptId: number): Promise<AttemptDetail> {
    const attempt = await this.findAttemptForUser(attemptId, userId);
    const questions = await this.findQuestionsByIds(
      attempt.questionIds,
      attempt.lang,
    );

    return {
      id: attempt.id,
      questionIds: attempt.questionIds,
      questions,
      answers: attempt.answers,
      createdAt: attempt.createdAt,
      endDate: attempt.endDate,
      completedAt: attempt.completedAt,
      passed: attempt.passed,
      durationSeconds: resolveDisplayDuration(attempt),
      minCorrectToPass: attempt.minCorrectToPass,
      categories: attempt.categories,
      subjects: attempt.subjects,
    };
  }

  async getRawAnswers(
    userId: number,
    limit = MAX_STATS_LIMIT,
  ): Promise<RawAnswerRow[]> {
    const rows = await this.answerRepo
      .createQueryBuilder('a')
      .innerJoin('a.attempt', 't')
      .select('a.questionId', 'questionId')
      .addSelect('a.subject', 'subject')
      .addSelect('a.correct', 'correct')
      .addSelect('a.chosenAnswer', 'chosenAnswer')
      .addSelect('a.createdAt', 'createdAt')
      .where('t.userId = :userId', { userId })
      .orderBy('a.createdAt', 'DESC')
      .take(limit)
      .getRawMany<{
        questionId: string;
        subject: string | null;
        correct: boolean | string;
        chosenAnswer: string;
        createdAt: Date | string;
      }>();

    return rows.map((a) => ({
      questionId: Number(a.questionId),
      subject: a.subject == null ? null : Number(a.subject),
      correct: a.correct === true || a.correct === 't' || a.correct === 'true',
      chosenAnswer: a.chosenAnswer,
      createdAt: new Date(a.createdAt),
    }));
  }

  async findAttemptForUser(
    attemptId: number,
    userId: number,
  ): Promise<ExamAttempt> {
    const attempt = await this.attemptRepo.findOne({
      where: { id: attemptId, userId },
      relations: ['answers'],
    });
    if (!attempt) {
      throw new NotFoundException('Attempt not found');
    }
    return attempt;
  }

  /** Preserve ticket order from `questionIds` (IN-query order is undefined). */
  async findQuestionsByIds(ids: number[], lang: string): Promise<Question[]> {
    if (!ids.length) return [];
    const rows = await this.questionRepo
      .createQueryBuilder('q')
      .where('q.lang = :lang', { lang })
      .andWhere('q.id IN (:...ids)', { ids })
      .getMany();
    const byId = new Map(rows.map((q) => [q.id, q]));
    return ids
      .map((id) => byId.get(id))
      .filter((q): q is Question => q != null);
  }

  private attemptsWithAnswersQb(
    userId: number,
  ): SelectQueryBuilder<ExamAttempt> {
    return this.attemptRepo
      .createQueryBuilder('e')
      .where('e.userId = :userId', { userId })
      .andWhere(
        'EXISTS (SELECT 1 FROM user_answers ua WHERE ua."attemptId" = e.id)',
      );
  }

  private async loadHistoryCounts(
    userId: number,
  ): Promise<AttemptHistoryCounts> {
    const row = await this.attemptsWithAnswersQb(userId)
      .select('COUNT(*)', 'total')
      .addSelect(
        `SUM(CASE WHEN e.completedAt IS NOT NULL AND e.passed = true THEN 1 ELSE 0 END)`,
        'passed',
      )
      .addSelect(
        `SUM(CASE WHEN e.completedAt IS NOT NULL AND e.passed = false THEN 1 ELSE 0 END)`,
        'failed',
      )
      .addSelect(
        `SUM(CASE WHEN e.completedAt IS NULL THEN 1 ELSE 0 END)`,
        'incomplete',
      )
      .getRawOne<{
        total: string;
        passed: string;
        failed: string;
        incomplete: string;
      }>();

    const total = Number(row?.total ?? 0);
    const passed = Number(row?.passed ?? 0);
    const failed = Number(row?.failed ?? 0);
    const incomplete = Number(row?.incomplete ?? 0);
    const completed = passed + failed;

    return {
      total,
      passed,
      failed,
      incomplete,
      passRate: completed > 0 ? Math.round((passed / completed) * 100) : 0,
    };
  }

  private async loadAnswerStats(
    attemptIds: number[],
  ): Promise<Map<number, AnswerStats>> {
    const map = new Map<number, AnswerStats>();
    if (attemptIds.length === 0) return map;

    const rows = await this.answerRepo
      .createQueryBuilder('a')
      .select('a.attemptId', 'attemptId')
      .addSelect('COUNT(*)', 'answeredCount')
      .addSelect(
        'SUM(CASE WHEN a.correct = true THEN 1 ELSE 0 END)',
        'correctCount',
      )
      .addSelect('MAX(a.createdAt)', 'lastAnswerAt')
      .where('a.attemptId IN (:...attemptIds)', { attemptIds })
      .groupBy('a.attemptId')
      .getRawMany<{
        attemptId: string;
        answeredCount: string;
        correctCount: string;
        lastAnswerAt: Date | string | null;
      }>();

    for (const row of rows) {
      map.set(Number(row.attemptId), {
        answeredCount: Number(row.answeredCount),
        correctCount: Number(row.correctCount),
        lastAnswerAt: row.lastAnswerAt ? new Date(row.lastAnswerAt) : null,
      });
    }

    return map;
  }

  private toAttemptSummary(
    attempt: ExamAttempt,
    stats?: AnswerStats,
  ): AttemptSummary {
    return {
      id: attempt.id,
      questionCount: attempt.questionIds.length,
      answeredCount: stats?.answeredCount ?? 0,
      correctCount: stats?.correctCount ?? 0,
      minCorrectToPass: attempt.minCorrectToPass,
      createdAt: attempt.createdAt,
      endDate: attempt.endDate,
      completedAt: attempt.completedAt,
      passed: attempt.passed,
      durationSeconds: resolveDisplayDuration(attempt),
    };
  }
}
