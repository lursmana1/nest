import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { getEntityManagerToken, getRepositoryToken } from '@nestjs/typeorm';
import { ExamAttemptsService } from './exam-attempts.service';
import { ExamAttempt } from './entities/exam-attempt.entity';
import { QuestionSelectionService } from './question-selection/question-selection.service';
import { AttemptQueryService } from './attempt-query.service';
import { SUBMIT_ANSWER_SQL } from './submit-answer.query';
import { UserAnswer } from './entities/user-answer.entity';

const HALF_HOUR_MS = 30 * 60 * 1000;

/** An open attempt started `startedMinutesAgo` ago, with a 30-minute window. */
function openAttempt(overrides: Partial<ExamAttempt> = {}): ExamAttempt {
  const createdAt = new Date(Date.now() - 5 * 60 * 1000);
  return {
    id: 1,
    userId: 7,
    lang: 'ka',
    questionIds: [10, 11],
    answers: [],
    createdAt,
    endDate: new Date(createdAt.getTime() + HALF_HOUR_MS),
    completedAt: null,
    passed: null,
    durationSeconds: null,
    minCorrectToPass: 2,
    categories: [1],
    subjects: [],
    ...overrides,
  } as unknown as ExamAttempt;
}

describe('ExamAttemptsService', () => {
  let service: ExamAttemptsService;
  let attemptRepo: { update: jest.Mock; save: jest.Mock; create: jest.Mock };
  let manager: { query: jest.Mock };
  let queries: {
    findAttemptForUser: jest.Mock;
    findQuestionsByIds: jest.Mock;
  };
  let module: TestingModule;

  beforeEach(async () => {
    attemptRepo = {
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn((e: unknown) =>
        Promise.resolve({ id: 1, ...(e as object) }),
      ),
      create: jest.fn((e: unknown) => e),
    };
    manager = { query: jest.fn() };
    queries = {
      findAttemptForUser: jest.fn(),
      findQuestionsByIds: jest.fn().mockResolvedValue([]),
    };

    module = await Test.createTestingModule({
      providers: [
        ExamAttemptsService,
        { provide: getRepositoryToken(ExamAttempt), useValue: attemptRepo },
        { provide: getEntityManagerToken(), useValue: manager },
        {
          provide: QuestionSelectionService,
          useValue: { selectQuestions: jest.fn() },
        },
        { provide: AttemptQueryService, useValue: queries },
      ],
    }).compile();

    service = module.get(ExamAttemptsService);
  });

  describe('startAttempt', () => {
    it('returns the full question rows including the answer key', async () => {
      const selection = module.get<{ selectQuestions: jest.Mock }>(
        QuestionSelectionService,
      );
      selection.selectQuestions.mockResolvedValue([10]);

      await service.startAttempt(7, { lang: 'ka', count: 30 });

      expect(queries.findQuestionsByIds).toHaveBeenCalledWith([10], 'ka');
    });
  });

  describe('submitAnswer', () => {
    it.each([[true], [false]])(
      'returns the grade from the single Postgres statement (%s)',
      async (expected) => {
        manager.query.mockResolvedValue([{ status: 'ok', correct: expected }]);

        await expect(service.submitAnswer(7, 1, 10, 'b')).resolves.toEqual({
          correct: expected,
        });
        expect(manager.query).toHaveBeenCalledTimes(1);
        expect(manager.query.mock.calls[0][0]).toBe(SUBMIT_ANSWER_SQL);
        expect(queries.findAttemptForUser).not.toHaveBeenCalled();
      },
    );

    it('rejects a second answer to the same question', async () => {
      manager.query.mockResolvedValue([{ status: 'already_answered' }]);

      await expect(service.submitAnswer(7, 1, 10, 'b')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects a question that is not on the ticket', async () => {
      manager.query.mockResolvedValue([{ status: 'not_in_ticket' }]);

      await expect(service.submitAnswer(7, 1, 10, 'b')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('rejects answers submitted after the deadline', async () => {
      manager.query.mockResolvedValue([{ status: 'expired' }]);

      await expect(service.submitAnswer(7, 1, 10, 'b')).rejects.toThrow(
        new BadRequestException('Attempt expired'),
      );
      expect(attemptRepo.update).not.toHaveBeenCalled();
    });

    it('rejects a missing question', async () => {
      manager.query.mockResolvedValue([{ status: 'question_not_found' }]);

      await expect(service.submitAnswer(7, 1, 10, 'b')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects a missing attempt', async () => {
      manager.query.mockResolvedValue([{ status: 'not_found' }]);

      await expect(service.submitAnswer(7, 1, 10, 'b')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects answers on an already completed attempt', async () => {
      manager.query.mockResolvedValue([{ status: 'already_completed' }]);

      await expect(service.submitAnswer(7, 1, 10, 'b')).rejects.toThrow(
        new BadRequestException('Attempt already completed'),
      );
    });
  });

  describe('finishAttempt', () => {
    it('passes when correct answers meet the frozen threshold', async () => {
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({
          minCorrectToPass: 2,
          answers: [
            { questionId: 10, correct: true },
            { questionId: 11, correct: true },
          ] as UserAnswer[],
        }),
      );

      await expect(service.finishAttempt(7, 1)).resolves.toMatchObject({
        passed: true,
      });
    });

    it('fails when correct answers fall short of the frozen threshold', async () => {
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({
          minCorrectToPass: 2,
          answers: [
            { questionId: 10, correct: true },
            { questionId: 11, correct: false },
          ] as UserAnswer[],
        }),
      );

      await expect(service.finishAttempt(7, 1)).resolves.toMatchObject({
        passed: false,
      });
    });

    it('falls back to category rules when no threshold was frozen', async () => {
      // Category 1 (B) requires 27 of 30 correct.
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({
          minCorrectToPass: null,
          categories: [1],
          questionIds: Array.from({ length: 30 }, (_, i) => i + 1),
          answers: Array.from({ length: 27 }, (_, i) => ({
            questionId: i + 1,
            correct: true,
          })) as UserAnswer[],
        }),
      );

      await expect(service.finishAttempt(7, 1)).resolves.toMatchObject({
        passed: true,
      });
    });

    it('grades an expired attempt as of its deadline, not the request time', async () => {
      const createdAt = new Date(Date.now() - 3 * HALF_HOUR_MS);
      const endDate = new Date(createdAt.getTime() + HALF_HOUR_MS);
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({ createdAt, endDate }),
      );

      const result = await service.finishAttempt(7, 1);

      expect(result.completedAt).toEqual(endDate);
      expect(result.durationSeconds).toBe(HALF_HOUR_MS / 1000);
    });

    it('is idempotent once the attempt is already completed', async () => {
      const completedAt = new Date();
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({ completedAt, passed: true, durationSeconds: 120 }),
      );

      await expect(service.finishAttempt(7, 1)).resolves.toMatchObject({
        completedAt,
        passed: true,
      });
      expect(attemptRepo.update).not.toHaveBeenCalled();
    });
  });
});
