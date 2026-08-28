import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExamAttempt } from './entities/exam-attempt.entity';
import { UserAnswer } from './entities/user-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { QuestionSelectionService } from './question-selection/question-selection.service';
import { AttemptQueryService } from './attempt-query.service';
import { DEFAULT_LANG } from '../common/constants/lang.constants.js';
import {
  MAX_STATS_LIMIT,
  DEFAULT_HISTORY_PAGE_SIZE,
  EXAM_DURATION_MINUTES,
} from '../common/constants/exam.constants.js';
import {
  isExamPassed,
  resolveGeorgianExamRule,
} from '../common/utils/georgian-exam-rules.util.js';
import {
  attemptDeadline,
  computeAttemptDuration,
  isAttemptExpired,
  resolveDisplayDuration,
} from './attempt-duration.util.js';
import { type ExamQuestion } from './exam-question.view.js';
import type {
  StartAttemptOptions,
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
    @InjectRepository(UserAnswer)
    private readonly answerRepo: Repository<UserAnswer>,
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
    private readonly selectionService: QuestionSelectionService,
    private readonly queries: AttemptQueryService,
  ) {}

  async startAttempt(
    userId: number,
    options: StartAttemptOptions,
  ): Promise<{
    attemptId: number;
    endDate: Date;
    questions: ExamQuestion[];
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

    const questions = await this.queries.findExamQuestionsByIds(
      questionIds,
      lang,
    );

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
    const attempt = await this.queries.findAttemptForUser(attemptId, userId);
    if (attempt.completedAt) {
      throw new BadRequestException('Attempt already completed');
    }
    if (isAttemptExpired(attempt)) {
      // Settle it now so an abandoned attempt cannot linger as incomplete.
      await this.completeAttempt(attempt, this.settlementTime(attempt));
      throw new BadRequestException('Attempt expired');
    }

    this.assertAnswerable(attempt, questionId);

    // Only the grading columns — the full row carries ~2KB of tutor text.
    const question = await this.questionRepo.findOne({
      where: { id: questionId, lang: attempt.lang },
      select: { id: true, lang: true, correct_answer: true, subject: true },
    });
    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const correct = question.correct_answer === chosenAnswer;
    // `insert` rather than `save`: save() wraps this single row in its own
    // BEGIN/COMMIT, which costs two extra round trips per answer.
    await this.answerRepo.insert({
      attemptId,
      questionId,
      subject: question.subject,
      correct,
      chosenAnswer,
    });

    const previous = attempt.answers ?? [];
    if (previous.length + 1 >= attempt.questionIds.length) {
      const correctCount =
        previous.filter((a) => a.correct).length + (correct ? 1 : 0);
      await this.completeAttempt(attempt, new Date(), correctCount);
    }

    return { correct };
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
}
