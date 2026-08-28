import { BadRequestException } from '@nestjs/common';
import { QuestionSelectionService } from './question-selection.service';
import { WeaknessService } from './weakness.service';
import { QuestionSamplingService } from './question-sampling.service';
import { FULL_RATIOS, LIGHT_RATIOS, WeaknessIds } from './selection.types';
import {
  MIN_ANSWERS_FOR_PERSONALIZATION,
  MIN_ANSWERS_FOR_FULL_PERSONALIZATION,
} from '../../common/constants/exam.constants';
import { DEFAULT_LANG } from '../../common/constants/lang.constants';

const WEAKNESS: WeaknessIds = {
  mistakeIds: [1, 2],
  successIds: [3],
  mistakeSubjects: [4],
  successSubjects: [5],
};

const ids = (count: number, from = 100) =>
  Array.from({ length: count }, (_, i) => from + i);

function setup(totalAnswers: number, available = 1000) {
  const weakness = {
    getTotalAnswerCount: jest.fn().mockResolvedValue(totalAnswers),
    getWeaknessIds: jest.fn().mockResolvedValue(WEAKNESS),
  };
  const sampling = {
    buildMatchFilter: jest.fn(
      (
        lang: string,
        subjects?: number[],
        categories?: number[],
        allSubjects?: boolean,
      ) => ({ lang, subjects, categories, allSubjects }),
    ),
    countMatching: jest.fn().mockResolvedValue(available),
    sampleRandom: jest.fn().mockResolvedValue([]),
    sampleWeighted: jest.fn().mockResolvedValue([]),
  };
  const service = new QuestionSelectionService(
    weakness as unknown as WeaknessService,
    sampling as unknown as QuestionSamplingService,
  );
  return { service, weakness, sampling };
}

describe('QuestionSelectionService', () => {
  describe('personalization tiers', () => {
    it('samples purely at random below the personalization threshold', async () => {
      const { service, sampling, weakness } = setup(
        MIN_ANSWERS_FOR_PERSONALIZATION - 1,
      );
      sampling.sampleRandom.mockResolvedValue(ids(30));

      const result = await service.selectQuestions({ userId: 7, lang: 'ka' });

      expect(sampling.sampleWeighted).not.toHaveBeenCalled();
      expect(weakness.getWeaknessIds).not.toHaveBeenCalled();
      expect(sampling.sampleRandom).toHaveBeenCalledWith(
        expect.objectContaining({ lang: 'ka' }),
        30,
      );
      expect(result).toHaveLength(30);
    });

    it('switches to light personalization at the threshold', async () => {
      const { service, sampling } = setup(MIN_ANSWERS_FOR_PERSONALIZATION);
      sampling.sampleWeighted.mockResolvedValue(ids(30));

      await service.selectQuestions({ userId: 7, lang: 'ka' });

      expect(sampling.sampleWeighted).toHaveBeenCalledWith(
        expect.anything(),
        30,
        WEAKNESS,
        LIGHT_RATIOS,
      );
    });

    it('stays on light personalization just below the full threshold', async () => {
      const { service, sampling } = setup(
        MIN_ANSWERS_FOR_FULL_PERSONALIZATION - 1,
      );
      sampling.sampleWeighted.mockResolvedValue(ids(30));

      await service.selectQuestions({ userId: 7, lang: 'ka' });

      expect(sampling.sampleWeighted).toHaveBeenCalledWith(
        expect.anything(),
        30,
        WEAKNESS,
        LIGHT_RATIOS,
      );
    });

    it('switches to full personalization at the full threshold', async () => {
      const { service, sampling } = setup(MIN_ANSWERS_FOR_FULL_PERSONALIZATION);
      sampling.sampleWeighted.mockResolvedValue(ids(30));

      await service.selectQuestions({ userId: 7, lang: 'ka' });

      expect(sampling.sampleWeighted).toHaveBeenCalledWith(
        expect.anything(),
        30,
        WEAKNESS,
        FULL_RATIOS,
      );
    });
  });

  describe('filling the ticket', () => {
    it('tops up with random questions when weighting comes up short', async () => {
      const { service, sampling } = setup(MIN_ANSWERS_FOR_FULL_PERSONALIZATION);
      const weighted = ids(24);
      sampling.sampleWeighted.mockResolvedValue(weighted);
      sampling.sampleRandom.mockResolvedValue(ids(6, 900));

      const result = await service.selectQuestions({ userId: 7, lang: 'ka' });

      expect(sampling.sampleRandom).toHaveBeenCalledWith(
        expect.anything(),
        6,
        weighted,
      );
      expect(result).toHaveLength(30);
      expect(new Set(result).size).toBe(30);
    });

    it('does not top up when weighting already filled the ticket', async () => {
      const { service, sampling } = setup(MIN_ANSWERS_FOR_FULL_PERSONALIZATION);
      sampling.sampleWeighted.mockResolvedValue(ids(30));

      await service.selectQuestions({ userId: 7, lang: 'ka' });

      expect(sampling.sampleRandom).not.toHaveBeenCalled();
    });

    it('returns the selected ids without adding or losing any', async () => {
      const { service, sampling } = setup(MIN_ANSWERS_FOR_FULL_PERSONALIZATION);
      const selected = ids(30);
      sampling.sampleWeighted.mockResolvedValue(selected);

      const result = await service.selectQuestions({ userId: 7, lang: 'ka' });

      expect([...result].sort((a, b) => a - b)).toEqual(selected);
    });
  });

  describe('question pool validation', () => {
    it('rejects a category whose live pool is too small', async () => {
      const { service } = setup(0, 1);

      await expect(
        service.selectQuestions({ userId: 7, lang: 'ka', categories: [1] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('skips the pool check when no category is requested', async () => {
      const { service, sampling } = setup(0, 1);
      sampling.sampleRandom.mockResolvedValue(ids(30));

      await service.selectQuestions({ userId: 7, lang: 'ka' });

      expect(sampling.countMatching).not.toHaveBeenCalled();
    });
  });

  describe('option handling', () => {
    it('falls back to the default language', async () => {
      const { service, sampling } = setup(0);

      await service.selectQuestions({
        userId: 7,
        lang: undefined as unknown as string,
      });

      expect(sampling.buildMatchFilter).toHaveBeenCalledWith(
        DEFAULT_LANG,
        undefined,
        undefined,
        undefined,
      );
    });

    it('passes subject and category filters through to sampling', async () => {
      const { service, sampling } = setup(0);

      await service.selectQuestions({
        userId: 7,
        lang: 'ru',
        subjects: [2, 3],
        categories: [1],
        allSubjects: true,
      });

      expect(sampling.buildMatchFilter).toHaveBeenCalledWith(
        'ru',
        [2, 3],
        [1],
        true,
      );
    });
  });
});
