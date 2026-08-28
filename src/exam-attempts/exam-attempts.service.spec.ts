import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExamAttemptsService } from './exam-attempts.service';
import { ExamAttempt } from './entities/exam-attempt.entity';
import { UserAnswer } from './entities/user-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { QuestionSelectionService } from './question-selection/question-selection.service';
import { AttemptQueryService } from './attempt-query.service';
import { EXAM_QUESTION_COLUMNS } from './exam-question.view';

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
  let answerRepo: { insert: jest.Mock; save: jest.Mock; create: jest.Mock };
  let questionRepo: { findOne: jest.Mock };
  let queries: { findAttemptForUser: jest.Mock; findQuestionsByIds: jest.Mock };
  let module: TestingModule;

  beforeEach(async () => {
    attemptRepo = {
      update: jest.fn().mockResolvedValue(undefined),
      save: jest.fn((e: unknown) =>
        Promise.resolve({ id: 1, ...(e as object) }),
      ),
      create: jest.fn((e: unknown) => e),
    };
    answerRepo = {
      insert: jest.fn(() => Promise.resolve({ identifiers: [{ id: 1 }] })),
      save: jest.fn((e: unknown) => Promise.resolve(e)),
      create: jest.fn((e: unknown) => e),
    };
    questionRepo = { findOne: jest.fn() };
    queries = {
      findAttemptForUser: jest.fn(),
      findQuestionsByIds: jest.fn().mockResolvedValue([]),
      findExamQuestionsByIds: jest.fn().mockResolvedValue([]),
    };

    module = await Test.createTestingModule({
      providers: [
        ExamAttemptsService,
        { provide: getRepositoryToken(ExamAttempt), useValue: attemptRepo },
        { provide: getRepositoryToken(UserAnswer), useValue: answerRepo },
        { provide: getRepositoryToken(Question), useValue: questionRepo },
        {
          provide: QuestionSelectionService,
          useValue: { selectQuestions: jest.fn() },
        },
        { provide: AttemptQueryService, useValue: queries },
      ],
    }).compile();

    service = module.get(ExamAttemptsService);
  });

  describe('answer-key exposure', () => {
    it('never selects an answer-revealing column', () => {
      expect(EXAM_QUESTION_COLUMNS).toEqual(
        expect.not.arrayContaining([
          'correct_answer',
          'question_explained',
          'ai_tutor',
        ]),
      );
    });

    it('still selects the columns needed to render a question', () => {
      expect(EXAM_QUESTION_COLUMNS).toEqual(
        expect.arrayContaining(['id', 'question', 'answer_1', 'answer_4']),
      );
    });

    it('startAttempt reads questions through the answer-free projection', async () => {
      const selection = module.get<{ selectQuestions: jest.Mock }>(
        QuestionSelectionService,
      );
      selection.selectQuestions.mockResolvedValue([10]);

      await service.startAttempt(7, { lang: 'ka', count: 30 });

      expect(queries.findExamQuestionsByIds).toHaveBeenCalledWith([10], 'ka');
      expect(queries.findQuestionsByIds).not.toHaveBeenCalled();
    });
  });

  describe('submitAnswer', () => {
    it.each([
      ['b', true],
      ['a', false],
    ])(
      'grades answer %s against the stored correct_answer',
      async (chosen, expected) => {
        queries.findAttemptForUser.mockResolvedValue(openAttempt());
        questionRepo.findOne.mockResolvedValue({
          id: 10,
          subject: 3,
          correct_answer: 'b',
        });

        await expect(service.submitAnswer(7, 1, 10, chosen)).resolves.toEqual({
          correct: expected,
        });
      },
    );

    it('rejects a second answer to the same question', async () => {
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({
          answers: [{ questionId: 10, correct: true }] as UserAnswer[],
        }),
      );

      await expect(service.submitAnswer(7, 1, 10, 'b')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects answers submitted after the deadline', async () => {
      const createdAt = new Date(Date.now() - 2 * HALF_HOUR_MS);
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({
          createdAt,
          endDate: new Date(createdAt.getTime() + HALF_HOUR_MS),
        }),
      );

      await expect(service.submitAnswer(7, 1, 10, 'b')).rejects.toThrow(
        new BadRequestException('Attempt expired'),
      );
      expect(answerRepo.insert).not.toHaveBeenCalled();
    });

    it('settles the expired attempt instead of leaving it incomplete', async () => {
      const createdAt = new Date(Date.now() - 2 * HALF_HOUR_MS);
      const endDate = new Date(createdAt.getTime() + HALF_HOUR_MS);
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({ createdAt, endDate }),
      );

      await expect(service.submitAnswer(7, 1, 10, 'b')).rejects.toThrow(
        BadRequestException,
      );

      expect(attemptRepo.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          completedAt: endDate,
          passed: false,
          durationSeconds: HALF_HOUR_MS / 1000,
        }),
      );
    });

    // Each extra round trip to Neon costs ~70ms on a single answer.
    it('writes the answer with insert, not save', async () => {
      queries.findAttemptForUser.mockResolvedValue(openAttempt());
      questionRepo.findOne.mockResolvedValue({
        id: 10,
        subject: 3,
        correct_answer: 'b',
      });

      await service.submitAnswer(7, 1, 10, 'b');

      expect(answerRepo.insert).toHaveBeenCalledTimes(1);
      // save() wraps a single row in START TRANSACTION / COMMIT.
      expect(answerRepo.save).not.toHaveBeenCalled();
    });

    it('reads only the grading columns of the question', async () => {
      queries.findAttemptForUser.mockResolvedValue(openAttempt());
      questionRepo.findOne.mockResolvedValue({
        id: 10,
        subject: 3,
        correct_answer: 'b',
      });

      await service.submitAnswer(7, 1, 10, 'b');

      const [options] = questionRepo.findOne.mock.calls[0] as [
        { select?: Record<string, boolean> },
      ];
      expect(options.select).toBeDefined();
      for (const heavyField of ['ai_tutor', 'question_explained', 'question']) {
        expect(options.select).not.toHaveProperty(heavyField);
      }
    });

    it('counts earlier answers when grading the final one', async () => {
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({
          questionIds: [10, 11],
          minCorrectToPass: 2,
          answers: [{ questionId: 11, correct: true }] as UserAnswer[],
        }),
      );
      questionRepo.findOne.mockResolvedValue({
        id: 10,
        subject: 3,
        correct_answer: 'b',
      });

      await service.submitAnswer(7, 1, 10, 'b');

      expect(attemptRepo.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ passed: true }),
      );
    });

    it('fails the attempt when earlier answers were wrong', async () => {
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({
          questionIds: [10, 11],
          minCorrectToPass: 2,
          answers: [{ questionId: 11, correct: false }] as UserAnswer[],
        }),
      );
      questionRepo.findOne.mockResolvedValue({
        id: 10,
        subject: 3,
        correct_answer: 'b',
      });

      await service.submitAnswer(7, 1, 10, 'b');

      expect(attemptRepo.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ passed: false }),
      );
    });

    it('auto-completes once every question is answered', async () => {
      queries.findAttemptForUser.mockResolvedValue(
        openAttempt({
          questionIds: [10],
          minCorrectToPass: 1,
        }),
      );
      questionRepo.findOne.mockResolvedValue({
        id: 10,
        subject: 3,
        correct_answer: 'b',
      });

      await service.submitAnswer(7, 1, 10, 'b');

      expect(attemptRepo.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ passed: true }),
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
