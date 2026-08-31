import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ExamAttempt } from './entities/exam-attempt.entity';
import { QuestionSelectionService } from './question-selection/question-selection.service';
import { AttemptQueryService } from './attempt-query.service';
import { DEFAULT_LANG } from '../common/constants/lang.constants.js';
import {
  MAX_STATS_LIMIT,
  DEFAULT_HISTORY_PAGE_SIZE,
  EXAM_DURATION_MINUTES,
} from '../common/constants/exam.constants.js';
import {
  DEFAULT_GEORGIAN_EXAM_RULE,
  isExamPassed,
  resolveGeorgianExamRule,
} from '../common/utils/georgian-exam-rules.util.js';
import { parsePgBoolean } from '../common/utils/pg-row.util.js';
import {
  SUBMIT_ANSWER_SQL,
  type SubmitAnswerRow,
} from './submit-answer.query.js';
import {
  attemptDeadline,
  computeAttemptDuration,
  isAttemptExpired,
  resolveDisplayDuration,
} from './attempt-duration.util.js';
import type {
  StartAttemptOptions,
  StartAttemptResponse,
  PaginatedAttempts,
  RawAnswerRow,
  AttemptDetail,
} from './types/exam-attempts.types.js';

/** Write-side + thin facade over query service (controller stays unchanged). */
@Injectable()
export class ExamAttemptsService {
  constructor(
    @InjectRepository(ExamAttempt)
    private readonly attemptRepo: Repository<ExamAttempt>,
    @InjectEntityManager()
    private readonly manager: EntityManager,
    private readonly selectionService: QuestionSelectionService,
    private readonly queries: AttemptQueryService,
  ) {}

  async startAttempt(
    userId: number,
    options: StartAttemptOptions,
  ): Promise<StartAttemptResponse> {
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

    const questions = await this.queries.findQuestionsByIds(questionIds, lang);

    const startedAt = saved.createdAt ?? createdAt;
    const deadline = saved.endDate ?? endDate;

    return {
      attemptId: saved.id,
      createdAt: startedAt,
      endDate: deadline,
      durationMinutes: EXAM_DURATION_MINUTES,
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
    const rows = await this.manager.query<SubmitAnswerRow[]>(
      SUBMIT_ANSWER_SQL,
      [
        attemptId,
        userId,
        questionId,
        chosenAnswer,
        EXAM_DURATION_MINUTES * 60,
        DEFAULT_GEORGIAN_EXAM_RULE.minCorrectToPass,
      ],
    );

    return this.readSubmitAnswer(rows[0]);
  }

  async finishAttempt(
    userId: number,
    attemptId: number,
  ): Promise<{ completedAt: Date; passed: boolean; durationSeconds: number }> {
    const attempt = await this.queries.findAttemptForUser(attemptId, userId);
    if (attempt.completedAt) {
      return {
        completedAt: attempt.completedAt,
        passed: attempt.passed ?? false,
        durationSeconds: resolveDisplayDuration(attempt) ?? 0,
      };
    }

    return this.completeAttempt(attempt, this.settlementTime(attempt));
  }

  getHistory(
    userId: number,
    page = 1,
    size = DEFAULT_HISTORY_PAGE_SIZE,
  ): Promise<PaginatedAttempts> {
    return this.queries.getHistory(userId, page, size);
  }

  getAttempt(userId: number, attemptId: number): Promise<AttemptDetail> {
    return this.queries.getAttempt(userId, attemptId);
  }

  getRawAnswers(
    userId: number,
    limit = MAX_STATS_LIMIT,
  ): Promise<RawAnswerRow[]> {
    return this.queries.getRawAnswers(userId, limit);
  }

  /** Grade an expired attempt as of its deadline, not the later request time. */
  private settlementTime(attempt: ExamAttempt): Date {
    return isAttemptExpired(attempt)
      ? (attemptDeadline(attempt) ?? new Date())
      : new Date();
  }

  private async completeAttempt(
    attempt: ExamAttempt,
    completedAt: Date,
    correctCount = (attempt.answers ?? []).filter((a) => a.correct).length,
  ): Promise<{
    completedAt: Date;
    passed: boolean;
    durationSeconds: number;
  }> {
    const passed = this.evaluatePass(attempt, correctCount);
    const durationSeconds = computeAttemptDuration(attempt, completedAt);

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

  private readSubmitAnswer(row: SubmitAnswerRow | undefined): {
    correct: boolean;
  } {
    switch (row?.status) {
      case 'ok':
        return { correct: parsePgBoolean(row.correct) };
      case 'already_completed':
        throw new BadRequestException('Attempt already completed');
      case 'expired':
        throw new BadRequestException('Attempt expired');
      case 'not_in_ticket':
        throw new ForbiddenException('Question not in this attempt');
      case 'already_answered':
        throw new ConflictException('Already answered this question');
      case 'question_not_found':
        throw new NotFoundException('Question not found');
      default:
        throw new NotFoundException('Attempt not found');
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
}
