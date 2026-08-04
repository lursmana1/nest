import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
  PaginatedAttempts,
  RawAnswerRow,
} from './types/exam-attempts.types.js';

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
    questions: unknown[];
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

    const attempt = this.attemptRepo.create({
      userId,
      questionIds,
      lang,
      minCorrectToPass: examRule.minCorrectToPass,
      categories: options.categories ?? [],
      subjects: options.subjects ?? [],
    });
    const saved = await this.attemptRepo.save(attempt);

    const endDate = new Date(
      saved.createdAt.getTime() + EXAM_DURATION_MINUTES * 60 * 1000,
    );
    await this.attemptRepo.update(saved.id, { endDate });

    const questions = await this.findQuestionsByIds(questionIds, lang);

    return {
      attemptId: saved.id,
      endDate,
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

    this.validateQuestionInAttempt(attempt, questionId);

    const question = await this.questionRepo.findOne({
      where: { id: questionId, lang: attempt.lang },
    });

    if (!question) {
      throw new NotFoundException('Question not found');
    }

    const correct = question.correct_answer === chosenAnswer;

    await this.answerRepo.save(
      this.answerRepo.create({
        attemptId,
        questionId,
        subject: question.subject,
        correct,
        chosenAnswer,
      }),
    );

    const updatedAttempt = await this.findAttemptForUser(attemptId, userId);
    const allAnswered =
      updatedAttempt.answers.length >= updatedAttempt.questionIds.length;
    if (allAnswered && !updatedAttempt.completedAt) {
      const correctCount = updatedAttempt.answers.filter(
        (a) => a.correct,
      ).length;
      const passed = this.evaluatePass(updatedAttempt, correctCount);
      const completedAt = new Date();
      const durationSeconds = Math.round(
        (completedAt.getTime() - updatedAttempt.createdAt.getTime()) / 1000,
      );
      await this.attemptRepo.update(attemptId, {
        completedAt,
        passed,
        durationSeconds,
      });
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
        durationSeconds: attempt.durationSeconds ?? 0,
      };
    }

    const correctCount = attempt.answers.filter((a) => a.correct).length;
    const passed = this.evaluatePass(attempt, correctCount);
    const completedAt = new Date();
    const durationSeconds = Math.round(
      (completedAt.getTime() - attempt.createdAt.getTime()) / 1000,
    );
    await this.attemptRepo.update(attemptId, {
      completedAt,
      passed,
      durationSeconds,
    });

    return { completedAt, passed, durationSeconds };
  }

  async getHistory(
    userId: number,
    page = 1,
    size = DEFAULT_HISTORY_PAGE_SIZE,
  ): Promise<PaginatedAttempts> {
    const pageSize = Math.min(Math.max(1, size), MAX_HISTORY_PAGE_SIZE);
    const pageNum = Math.max(1, page);

    const baseQb = this.attemptRepo
      .createQueryBuilder('e')
      .where('e.userId = :userId', { userId })
      .andWhere(
        'EXISTS (SELECT 1 FROM user_answers ua WHERE ua."attemptId" = e.id)',
      );

    const [attempts, total] = await Promise.all([
      baseQb
        .clone()
        .orderBy('e.createdAt', 'DESC')
        .skip((pageNum - 1) * pageSize)
        .take(pageSize)
        .getMany(),
      baseQb.clone().getCount(),
    ]);

    const answerStats = await this.loadAnswerStats(
      attempts.map((a) => a.id),
    );

    const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

    return {
      data: attempts.map((a) =>
        this.toAttemptSummary(a, answerStats.get(a.id)),
      ),
      total,
      page: pageNum,
      pageSize,
      totalPages,
    };
  }

  private async loadAnswerStats(
    attemptIds: number[],
  ): Promise<Map<number, { answeredCount: number; correctCount: number }>> {
    const map = new Map<number, { answeredCount: number; correctCount: number }>();
    if (attemptIds.length === 0) {
      return map;
    }

    const rows = await this.answerRepo
      .createQueryBuilder('a')
      .select('a.attemptId', 'attemptId')
      .addSelect('COUNT(*)', 'answeredCount')
      .addSelect(
        'SUM(CASE WHEN a.correct = true THEN 1 ELSE 0 END)',
        'correctCount',
      )
      .where('a.attemptId IN (:...attemptIds)', { attemptIds })
      .groupBy('a.attemptId')
      .getRawMany<{
        attemptId: string;
        answeredCount: string;
        correctCount: string;
      }>();

    for (const row of rows) {
      map.set(Number(row.attemptId), {
        answeredCount: Number(row.answeredCount),
        correctCount: Number(row.correctCount),
      });
    }

    return map;
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
      durationSeconds: attempt.durationSeconds,
      minCorrectToPass: attempt.minCorrectToPass,
      categories: attempt.categories,
      subjects: attempt.subjects,
    };
  }

  async getRawAnswers(
    userId: number,
    limit = MAX_STATS_LIMIT,
  ): Promise<RawAnswerRow[]> {
    const answers = await this.answerRepo.find({
      where: { attempt: { userId } },
      relations: ['attempt'],
      order: { createdAt: 'DESC' },
      take: limit,
    });

    return answers.map((a) => ({
      questionId: a.questionId,
      subject: a.subject,
      correct: a.correct,
      chosenAnswer: a.chosenAnswer,
      createdAt: a.createdAt,
    }));
  }

  private async findQuestionsByIds(ids: number[], lang: string) {
    if (!ids.length) return [];
    return this.questionRepo
      .createQueryBuilder('q')
      .where('q.lang = :lang', { lang })
      .andWhere('q.id IN (:...ids)', { ids })
      .getMany();
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

  private validateQuestionInAttempt(
    attempt: ExamAttempt,
    questionId: number,
  ): void {
    if (!attempt.questionIds.includes(questionId)) {
      throw new ForbiddenException('Question not in this attempt');
    }
    if (attempt.answers.some((a) => a.questionId === questionId)) {
      throw new ForbiddenException('Already answered this question');
    }
  }

  private evaluatePass(attempt: ExamAttempt, correctCount: number): boolean {
    const threshold = attempt.minCorrectToPass;
    if (threshold != null) {
      return isExamPassed(correctCount, threshold);
    }

    const fallback = resolveGeorgianExamRule({
      categories: attempt.categories,
      count: attempt.questionIds.length,
    });
    return isExamPassed(correctCount, fallback.minCorrectToPass);
  }

  private toAttemptSummary(
    attempt: ExamAttempt,
    stats?: { answeredCount: number; correctCount: number },
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
      durationSeconds: attempt.durationSeconds,
    };
  }
}
