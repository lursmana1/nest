import { Repository } from 'typeorm';
import { WeaknessService } from './weakness.service';
import { UserAnswer } from '../entities/user-answer.entity';
import { PracticeAnswer } from '../../practice-answers/entities/practice-answer.entity';
import {
  MAX_HISTORY_FOR_WEIGHTING,
  MAX_WEAKNESS_IDS_CAP,
  MIN_SUBJECT_ATTEMPTS_FOR_STATS,
} from '../../common/constants/exam.constants';

/** Shape returned by the raw weakness queries, before coercion. */
type RawRow = {
  a_questionId: number | string;
  a_subject: number | string | null;
  a_correct: boolean | string | null;
  a_createdAt: Date | string;
};

const CHAIN_METHODS = [
  'innerJoin',
  'where',
  'andWhere',
  'select',
  'addSelect',
  'orderBy',
  'limit',
];

function chainableQb(rows: RawRow[], count = 0) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of CHAIN_METHODS) {
    qb[method] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn(() => Promise.resolve(rows));
  qb.getCount = jest.fn(() => Promise.resolve(count));
  return qb;
}

function makeService(
  examRows: RawRow[],
  practiceRows: RawRow[] = [],
  counts: { exam?: number; practice?: number } = {},
) {
  const examQb = chainableQb(examRows, counts.exam ?? 0);
  const practiceQb = chainableQb(practiceRows, counts.practice ?? 0);
  const service = new WeaknessService(
    { createQueryBuilder: () => examQb } as unknown as Repository<UserAnswer>,
    {
      createQueryBuilder: () => practiceQb,
    } as unknown as Repository<PracticeAnswer>,
  );
  return { service, examQb, practiceQb };
}

const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime();

/** Minutes-ago offsets keep recency explicit where slicing is under test. */
function row(
  questionId: number,
  subject: number | null,
  correct: boolean | string | null,
  minutesAgo = 0,
): RawRow {
  return {
    a_questionId: questionId,
    a_subject: subject,
    a_correct: correct,
    a_createdAt: new Date(BASE_TIME - minutesAgo * 60_000),
  };
}

/** `correctCount` right and `wrongCount` wrong answers, each a distinct question. */
function subjectRows(
  subject: number,
  correctCount: number,
  wrongCount: number,
  minutesAgo = 0,
): RawRow[] {
  const rows: RawRow[] = [];
  let id = subject * 10_000;
  for (let i = 0; i < correctCount; i++) {
    rows.push(row(id++, subject, true, minutesAgo));
  }
  for (let i = 0; i < wrongCount; i++) {
    rows.push(row(id++, subject, false, minutesAgo));
  }
  return rows;
}

describe('WeaknessService', () => {
  describe('getTotalAnswerCount', () => {
    it('sums graded exam and practice answers', async () => {
      const { service } = makeService([], [], { exam: 12, practice: 30 });
      await expect(service.getTotalAnswerCount(7)).resolves.toBe(42);
    });
  });

  describe('question-level scoring', () => {
    it('treats a question as weak when wrong answers outnumber right ones', async () => {
      const { service } = makeService([
        row(1, 5, false),
        row(1, 5, false),
        row(1, 5, true),
      ]);
      const { mistakeIds, successIds } = await service.getWeaknessIds(7);
      expect(mistakeIds).toEqual([1]);
      expect(successIds).toEqual([]);
    });

    it('treats a question as mastered when right answers outnumber wrong ones', async () => {
      const { service } = makeService([
        row(1, 5, true),
        row(1, 5, true),
        row(1, 5, false),
      ]);
      const { mistakeIds, successIds } = await service.getWeaknessIds(7);
      expect(successIds).toEqual([1]);
      expect(mistakeIds).toEqual([]);
    });

    it('excludes an evenly split question from both buckets', async () => {
      const { service } = makeService([row(1, 5, true), row(1, 5, false)]);
      const { mistakeIds, successIds } = await service.getWeaknessIds(7);
      expect(mistakeIds).toEqual([]);
      expect(successIds).toEqual([]);
    });

    it('reads Postgres boolean strings as well as real booleans', async () => {
      const { service } = makeService([
        row(1, 5, 't'),
        row(2, 5, 'true'),
        row(3, 5, 'f'),
        row(4, 5, false),
      ]);
      const { mistakeIds, successIds } = await service.getWeaknessIds(7);
      expect(successIds.sort()).toEqual([1, 2]);
      expect(mistakeIds.sort()).toEqual([3, 4]);
    });

    it('drops rows with no subject or no graded result', async () => {
      const { service } = makeService([
        row(1, null, false),
        row(2, 5, null),
        row(3, 5, false),
      ]);
      const { mistakeIds } = await service.getWeaknessIds(7);
      expect(mistakeIds).toEqual([3]);
    });

    it('caps each bucket at MAX_WEAKNESS_IDS_CAP', async () => {
      const rows = Array.from({ length: MAX_WEAKNESS_IDS_CAP + 50 }, (_, i) =>
        row(i + 1, 5, false),
      );
      const { service } = makeService(rows);
      const { mistakeIds } = await service.getWeaknessIds(7);
      expect(mistakeIds).toHaveLength(MAX_WEAKNESS_IDS_CAP);
    });
  });

  describe('subject-level scoring', () => {
    it('ignores subjects below the minimum sample size', async () => {
      const belowMinimum = MIN_SUBJECT_ATTEMPTS_FOR_STATS - 1;
      const { service } = makeService(subjectRows(3, 0, belowMinimum));
      const { mistakeSubjects } = await service.getWeaknessIds(7);
      expect(mistakeSubjects).toEqual([]);
    });

    it('flags a subject once it has enough attempts and a sub-50% rate', async () => {
      const { service } = makeService(subjectRows(3, 4, 6));
      const { mistakeSubjects } = await service.getWeaknessIds(7);
      expect(mistakeSubjects).toEqual([3]);
    });

    it('excludes a subject sitting exactly on the 50% pass rate', async () => {
      const { service } = makeService(subjectRows(3, 5, 5));
      const { mistakeSubjects, successSubjects } =
        await service.getWeaknessIds(7);
      expect(mistakeSubjects).toEqual([]);
      expect(successSubjects).toEqual([]);
    });

    it('orders weak subjects weakest first', async () => {
      const { service } = makeService([
        ...subjectRows(1, 4, 6),
        ...subjectRows(2, 1, 9),
      ]);
      const { mistakeSubjects } = await service.getWeaknessIds(7);
      expect(mistakeSubjects).toEqual([2, 1]);
    });

    it('orders strong subjects strongest first', async () => {
      const { service } = makeService([
        ...subjectRows(1, 6, 4),
        ...subjectRows(2, 9, 1),
      ]);
      const { successSubjects } = await service.getWeaknessIds(7);
      expect(successSubjects).toEqual([2, 1]);
    });
  });

  describe('merging exam and practice history', () => {
    it('scores practice answers alongside exam answers', async () => {
      const { service } = makeService(
        [row(1, 5, false)],
        [row(2, 5, false, 1)],
      );
      const { mistakeIds } = await service.getWeaknessIds(7);
      expect(mistakeIds.sort()).toEqual([1, 2]);
    });

    it('lets a later practice answer cancel an earlier exam mistake', async () => {
      const { service } = makeService(
        [row(1, 5, false, 10)],
        [row(1, 5, true)],
      );
      const { mistakeIds, successIds } = await service.getWeaknessIds(7);
      expect(mistakeIds).toEqual([]);
      expect(successIds).toEqual([]);
    });

    it('keeps only the most recent MAX_HISTORY_FOR_WEIGHTING answers', async () => {
      const recent = Array.from({ length: MAX_HISTORY_FOR_WEIGHTING }, (_, i) =>
        row(i + 1, 1, true),
      );
      const stale = subjectRows(2, 0, 20, 60);
      const { service } = makeService(recent, stale);

      const { mistakeIds, mistakeSubjects } = await service.getWeaknessIds(7);

      expect(mistakeIds).toEqual([]);
      expect(mistakeSubjects).toEqual([]);
    });

    it('keeps stale answers when they fit inside the history window', async () => {
      const { service } = makeService(
        subjectRows(1, 10, 0),
        subjectRows(2, 0, 20, 60),
      );
      const { mistakeSubjects } = await service.getWeaknessIds(7);
      expect(mistakeSubjects).toEqual([2]);
    });
  });
});
