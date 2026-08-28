import { Repository } from 'typeorm';
import { QuestionSamplingService } from './question-sampling.service';
import { Question } from '../../questions/entities/question.entity';
import { FULL_RATIOS, LIGHT_RATIOS, WeaknessIds } from './selection.types';

type Qb = Record<string, jest.Mock>;

const FILTER = { lang: 'ka' };

const WEAKNESS: WeaknessIds = {
  mistakeIds: [1, 2],
  successIds: [3, 4],
  mistakeSubjects: [5],
  successSubjects: [6],
};

const EMPTY_WEAKNESS: WeaknessIds = {
  mistakeIds: [],
  successIds: [],
  mistakeSubjects: [],
  successSubjects: [],
};

/**
 * Each `createQueryBuilder` call yields the next row set, so assertions can
 * inspect the builders in creation order: mistakes, success, then random.
 */
function setup(rowsPerCall: number[][] = [], count = 0) {
  const builders: Qb[] = [];
  const repo = {
    createQueryBuilder: jest.fn(() => {
      const rows = (rowsPerCall[builders.length] ?? []).map((id) => ({
        id: String(id),
      }));
      const qb: Qb = {};
      for (const method of ['select', 'andWhere', 'orderBy', 'limit']) {
        qb[method] = jest.fn(() => qb);
      }
      qb.getRawMany = jest.fn(() => Promise.resolve(rows));
      qb.getCount = jest.fn(() => Promise.resolve(count));
      builders.push(qb);
      return qb;
    }),
  };
  const service = new QuestionSamplingService(
    repo as unknown as Repository<Question>,
  );
  return { service, builders, repo };
}

/** Every `andWhere` fragment applied to a builder, for clause assertions. */
const clauses = (qb: Qb): string[] =>
  (qb.andWhere.mock.calls as unknown[][]).map((call) => String(call[0]));

const limitOf = (qb: Qb): number =>
  Number((qb.limit.mock.calls as unknown[][])[0]?.[0]);

describe('QuestionSamplingService', () => {
  describe('sampleRandom', () => {
    it('converts raw string ids to numbers', async () => {
      const { service } = setup([[10, 11]]);
      await expect(service.sampleRandom(FILTER, 2)).resolves.toEqual([10, 11]);
    });

    it('skips the query entirely for a non-positive limit', async () => {
      const { service, repo } = setup();
      await expect(service.sampleRandom(FILTER, 0)).resolves.toEqual([]);
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('excludes already-selected ids', async () => {
      const { service, builders } = setup([[10]]);
      await service.sampleRandom(FILTER, 1, [7, 8]);
      expect(clauses(builders[0])).toContain('q.id NOT IN (:...exclude)');
    });

    it('omits the exclusion clause when nothing is excluded', async () => {
      const { service, builders } = setup([[10]]);
      await service.sampleRandom(FILTER, 1);
      expect(clauses(builders[0])).not.toContain('q.id NOT IN (:...exclude)');
    });
  });

  describe('sampleWeighted ratio arithmetic', () => {
    it('splits a 30-question ticket by the full ratios', async () => {
      const { service, builders } = setup();
      await service.sampleWeighted(FILTER, 30, WEAKNESS, FULL_RATIOS);

      expect(limitOf(builders[0])).toBe(12);
      expect(limitOf(builders[1])).toBe(3);
      expect(limitOf(builders[2])).toBe(15);
    });

    it('splits a 30-question ticket by the light ratios', async () => {
      const { service, builders } = setup();
      await service.sampleWeighted(FILTER, 30, WEAKNESS, LIGHT_RATIOS);

      expect(limitOf(builders[0])).toBe(8);
      expect(limitOf(builders[1])).toBe(1);
      expect(limitOf(builders[2])).toBe(21);
    });

    it('never requests more than the ticket size after rounding', async () => {
      for (const count of [10, 20, 25, 30, 40]) {
        const { service, builders } = setup();
        await service.sampleWeighted(FILTER, count, WEAKNESS, LIGHT_RATIOS);
        const requested = builders.reduce((sum, qb) => sum + limitOf(qb), 0);
        expect(requested).toBe(count);
      }
    });
  });

  describe('sampleWeighted bucket behaviour', () => {
    it('returns mistakes first, then successes, then random fill', async () => {
      const { service } = setup([[1, 2], [3], [90, 91]]);
      const result = await service.sampleWeighted(
        FILTER,
        30,
        WEAKNESS,
        FULL_RATIOS,
      );
      expect(result).toEqual([1, 2, 3, 90, 91]);
    });

    it('matches weak questions by id or by weak subject', async () => {
      const { service, builders } = setup();
      await service.sampleWeighted(FILTER, 30, WEAKNESS, FULL_RATIOS);
      expect(clauses(builders[0])).toContain(
        '(q.id IN (:...mistakeIds) OR q.subject IN (:...mistakeSubjects))',
      );
    });

    it('keeps known mistakes out of the success bucket', async () => {
      const { service, builders } = setup();
      await service.sampleWeighted(FILTER, 30, WEAKNESS, FULL_RATIOS);
      expect(clauses(builders[1])).toContain('q.id NOT IN (:...mistakeIds)');
    });

    it('skips the weakness queries when there is no history to weight', async () => {
      const { service, builders } = setup([[], [], [90]]);
      const result = await service.sampleWeighted(
        FILTER,
        30,
        EMPTY_WEAKNESS,
        FULL_RATIOS,
      );

      expect(builders).toHaveLength(1);
      expect(limitOf(builders[0])).toBe(15);
      expect(result).toEqual([]);
    });

    it('passes the ids it already picked to the random top-up', async () => {
      const { service, builders } = setup([[1, 2], [3]]);
      await service.sampleWeighted(FILTER, 30, WEAKNESS, FULL_RATIOS);

      expect(clauses(builders[2])).toContain('q.id NOT IN (:...exclude)');
    });
  });

  describe('buildMatchFilter', () => {
    it('carries every selection option into the filter', () => {
      const { service } = setup();
      expect(service.buildMatchFilter('ru', [1, 2], [3], true)).toEqual({
        lang: 'ru',
        subjects: [1, 2],
        categories: [3],
        allSubjects: true,
      });
    });
  });

  describe('countMatching', () => {
    it('returns the filtered pool size', async () => {
      const { service } = setup([], 137);
      await expect(service.countMatching(FILTER)).resolves.toBe(137);
    });
  });
});
