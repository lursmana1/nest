import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ExamAttempt } from './entities/exam-attempt.entity';
import { UserAnswer } from './entities/user-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { QuestionSelectionService } from './question-selection/question-selection.service';
import { DEFAULT_LANG } from '../common/constants/lang.constants.js';
import {
  MAX_STATS_LIMIT,
  MAX_HISTORY_PAGE_SIZE,
  DEFAULT_HISTORY_PAGE_SIZE,
  EXAM_DURATION_MINUTES,
} from '../common/constants/exam.constants.js';
import {
  isExamPassed,
  resolveGeorgianExamRule,
} from '../common/utils/georgian-exam-rules.util.js';
import type {
  StartAttemptOptions,
  AttemptSummary,
  AttemptHistoryCounts,
  PaginatedAttempts,
  RawAnswerRow,
} from './types/exam-attempts.types.js';

type AnswerStats = {
  answeredCount: number;
  correctCount: number;
  lastAnswerAt: Date | null;
};

@Injectable()
export class ExamAttemptsService {
  constructor(
    @InjectRepository(ExamAttempt)
    private readonly attemptRepo: Repository<ExamAttempt>,
    @InjectRepository(UserAnswer)
    private readonly answerRepo: Repository<UserAnswer>,
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
    private readonly selectionService: QuestionSelectionService,
  ) {}

  async startAttempt(
    userId: number,
    options: StartAttemptOptions,
  ): Promise<{
    attemptId: number;
    endDate: Date;
    questions: Question[];
    questionCount: number;
    minCorrectToPass: number;
    categoryId: number | null;
  }> {
    const lang = options.lang ?? DEFAULT_LANG;
    const examRule = resolveGeorgianExamRule({
      categories: options.categories,
      count: options.count,
    });
    const questionIds = await this.selectionService.selectQuestions({
      ...options,
      userId,
      count: examRule.questionCount,
    });

    const createdAt = new Date();
    const endDate = new Date(
      createdAt.getTime() + EXAM_DURATION_MINUTES * 60 * 1000,
    );

    const saved = await this.attemptRepo.save(
      this.attemptRepo.create({
        userId,
        questionIds,
        lang,
        createdAt,
        endDate,
        minCorrectToPass: examRule.minCorrectToPass,
        categories: options.categories ?? [],
        subjects: options.subjects ?? [],
      }),
    );

    const questions = await this.findQuestionsByIds(questionIds, lang);

    return {
      attemptId: saved.id,
      endDate: saved.endDate ?? endDate,
      questions,
      questionCount: examRule.questionCount,
      minCorrectToPass: examRule.minCorrectToPass,
      categoryId: examRule.categoryId,
    };
  }

  async submitAnswer(
    userId: number,
    attemptId: number,
    questionId: number,
    chosenAnswer: string,
  ): Promise<{ correct: boolean }> {
    const attempt = await this.findAttemptForUser(attemptId, userId);
    if (attempt.completedAt) {
      throw new BadRequestException('Attempt already completed');
    }

    this.assertAnswerable(attempt, questionId);

    const question = await this.questionRepo.findOne({
      where: { id: questionId, lang: attempt.lang },
    });
    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const correct = question.correct_answer === chosenAnswer;
    const savedAnswer = await this.answerRepo.save(
      this.answerRepo.create({
        attemptId,
        questionId,
        subject: question.subject,
        correct,
        chosenAnswer,
      }),
    );

    // Keep in-memory answers in sync — avoids a second full attempt reload.
    attempt.answers = [...(attempt.answers ?? []), savedAnswer];
    if (attempt.answers.length >= attempt.questionIds.length) {
      await this.completeAttempt(attempt);
    }

    return { correct };
  }

  async finishAttempt(
    userId: number,
    attemptId: number,
  ): Promise<{ completedAt: Date; passed: boolean; durationSeconds: number }> {
    const attempt = await this.findAttemptForUser(attemptId, userId);
    if (attempt.completedAt) {
      return {
        completedAt: attempt.completedAt,
        passed: attempt.passed ?? false,
        durationSeconds: this.resolveDisplayDuration(attempt) ?? 0,
      };
    }

    return this.completeAttempt(attempt);
  }

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

  async getAttempt(userId: number, attemptId: number) {
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
      durationSeconds: this.resolveDisplayDuration(attempt),
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

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async completeAttempt(attempt: ExamAttempt): Promise<{
    completedAt: Date;
    passed: boolean;
    durationSeconds: number;
  }> {
    const correctCount = (attempt.answers ?? []).filter((a) => a.correct).length;
    const passed = this.evaluatePass(attempt, correctCount);
    const completedAt = new Date();
    const durationSeconds = this.computeAttemptDuration(attempt, completedAt);

    await this.attemptRepo.update(attempt.id, {
      completedAt,
      passed,
      durationSeconds,
    });

    attempt.completedAt = completedAt;
    attempt.passed = passed;
    attempt.durationSeconds = durationSeconds;

    return { completedAt, passed, durationSeconds };
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

  /** Preserve ticket order from `questionIds` (IN-query order is undefined). */
  private async findQuestionsByIds(
    ids: number[],
    lang: string,
  ): Promise<Question[]> {
    if (!ids.length) return [];
    const rows = await this.questionRepo
      .createQueryBuilder('q')
      .where('q.lang = :lang', { lang })
      .andWhere('q.id IN (:...ids)', { ids })
      .getMany();
    const byId = new Map(rows.map((q) => [q.id, q]));
    return ids.map((id) => byId.get(id)).filter((q): q is Question => q != null);
  }

  private async findAttemptForUser(
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

  private assertAnswerable(attempt: ExamAttempt, questionId: number): void {
    if (!attempt.questionIds.includes(questionId)) {
      throw new ForbiddenException('Question not in this attempt');
    }
    if (attempt.answers?.some((a) => a.questionId === questionId)) {
      throw new ConflictException('Already answered this question');
    }
  }

  private evaluatePass(attempt: ExamAttempt, correctCount: number): boolean {
    if (attempt.minCorrectToPass != null) {
      return isExamPassed(correctCount, attempt.minCorrectToPass);
    }

    const fallback = resolveGeorgianExamRule({
      categories: attempt.categories,
      count: attempt.questionIds.length,
    });
    return isExamPassed(correctCount, fallback.minCorrectToPass);
  }

  /**
   * Actual time spent answering: last answer − start.
   * Cap at official exam length only as a safety max.
   */
  private computeAttemptDuration(
    attempt: ExamAttempt,
    completedAt: Date,
    lastAnswerAt?: Date | number | null,
  ): number {
    const startedAt = attempt.createdAt.getTime();
    const lastAnswerMs = this.toEpochMs(lastAnswerAt) ?? this.latestAnswerTime(attempt.answers);
    const endedAt = lastAnswerMs ?? completedAt.getTime();
    const rawSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
    return Math.min(rawSeconds, EXAM_DURATION_MINUTES * 60);
  }

  private toEpochMs(value?: Date | number | null): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    return null;
  }

  private latestAnswerTime(answers: UserAnswer[] | undefined): number | null {
    if (!answers?.length) return null;
    let latest = 0;
    for (const answer of answers) {
      const t = answer.createdAt?.getTime?.() ?? 0;
      if (t > latest) latest = t;
    }
    return latest > 0 ? latest : null;
  }

  private resolveDisplayDuration(
    attempt: ExamAttempt,
    lastAnswerAt?: Date | null,
  ): number | null {
    if (!attempt.completedAt) return null;

    // Prefer persisted duration when we have no answer timestamps to recompute from.
    if (
      attempt.durationSeconds != null &&
      !lastAnswerAt &&
      !attempt.answers?.length
    ) {
      return Math.min(attempt.durationSeconds, EXAM_DURATION_MINUTES * 60);
    }

    return this.computeAttemptDuration(
      attempt,
      attempt.completedAt,
      lastAnswerAt,
    );
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
      durationSeconds: this.resolveDisplayDuration(
        attempt,
        stats?.lastAnswerAt,
      ),
    };
  }
}
