import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Question } from '../../questions/entities/question.entity';
import {
  applyQuestionFilters,
  QuestionFilterOpts,
} from '../../questions/question-query.util';
import type { SelectionRatios, WeaknessIds } from './selection.types.js';

@Injectable()
export class QuestionSamplingService {
  constructor(
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
  ) {}

  buildMatchFilter(
    lang: string,
    subjects?: number[],
    categories?: number[],
    allSubjects?: boolean,
  ): QuestionFilterOpts {
    return {
      lang,
      subjects,
      categories,
      allSubjects,
    };
  }

  async countMatching(filter: QuestionFilterOpts): Promise<number> {
    const qb = this.questionRepo.createQueryBuilder('q');
    applyQuestionFilters(qb, 'q', filter);
    return qb.getCount();
  }

  async sampleRandom(
    filter: QuestionFilterOpts,
    limit: number,
    exclude: number[] = [],
  ): Promise<number[]> {
    if (limit <= 0) return [];

    const qb = this.questionRepo.createQueryBuilder('q').select('q.id', 'id');
    applyQuestionFilters(qb, 'q', filter);

    if (exclude.length) {
      qb.andWhere('q.id NOT IN (:...exclude)', { exclude });
    }

    const rows = await qb.orderBy('RANDOM()').limit(limit).getRawMany<{
      id: string;
    }>();
    return rows.map((r) => Number(r.id));
  }

  async sampleWeighted(
    filter: QuestionFilterOpts,
    count: number,
    weakness: WeaknessIds,
    ratios: SelectionRatios,
  ): Promise<number[]> {
    const randomCount = Math.round(count * ratios.random);
    const mistakesCount = Math.round(count * ratios.mistakes);
    const successCount = count - randomCount - mistakesCount;

    const selectedIds = await this.sampleMistakesAndSuccess(
      filter,
      weakness,
      mistakesCount,
      successCount,
    );
    const randomIds = await this.sampleRandom(filter, randomCount, selectedIds);

    return [...selectedIds, ...randomIds];
  }

  private async sampleMistakesAndSuccess(
    filter: QuestionFilterOpts,
    weakness: WeaknessIds,
    mistakesCount: number,
    successCount: number,
  ): Promise<number[]> {
    const { mistakeIds, successIds, mistakeSubjects, successSubjects } =
      weakness;

    const [mistakeRows, successRows] = await Promise.all([
      this.sampleMistakeIds(filter, mistakeIds, mistakeSubjects, mistakesCount),
      this.sampleSuccessIds(
        filter,
        mistakeIds,
        successIds,
        successSubjects,
        successCount,
      ),
    ]);

    return [...mistakeRows, ...successRows];
  }

  private async sampleMistakeIds(
    filter: QuestionFilterOpts,
    mistakeIds: number[],
    mistakeSubjects: number[],
    limit: number,
  ): Promise<number[]> {
    if (limit <= 0) return [];
    const hasMistakes = mistakeIds.length > 0 || mistakeSubjects.length > 0;
    if (!hasMistakes) return [];

    const qb = this.questionRepo.createQueryBuilder('q').select('q.id', 'id');
    applyQuestionFilters(qb, 'q', filter);

    const orParts: string[] = [];
    const params: Record<string, unknown> = {};
    if (mistakeIds.length) {
      orParts.push('q.id IN (:...mistakeIds)');
      params.mistakeIds = mistakeIds;
    }
    if (mistakeSubjects.length) {
      orParts.push('q.subject IN (:...mistakeSubjects)');
      params.mistakeSubjects = mistakeSubjects;
    }
    qb.andWhere(`(${orParts.join(' OR ')})`, params);

    const rows = await qb.orderBy('RANDOM()').limit(limit).getRawMany<{
      id: string;
    }>();
    return rows.map((r) => Number(r.id));
  }

  private async sampleSuccessIds(
    filter: QuestionFilterOpts,
    mistakeIds: number[],
    successIds: number[],
    successSubjects: number[],
    limit: number,
  ): Promise<number[]> {
    if (limit <= 0) return [];
    const hasSuccess = successIds.length > 0 || successSubjects.length > 0;
    if (!hasSuccess) return [];

    const qb = this.questionRepo.createQueryBuilder('q').select('q.id', 'id');
    applyQuestionFilters(qb, 'q', filter);

    if (mistakeIds.length) {
      qb.andWhere('q.id NOT IN (:...mistakeIds)', { mistakeIds });
    }

    const orParts: string[] = [];
    const params: Record<string, unknown> = {};
    if (successIds.length) {
      orParts.push('q.id IN (:...successIds)');
      params.successIds = successIds;
    }
    if (successSubjects.length) {
      orParts.push('q.subject IN (:...successSubjects)');
      params.successSubjects = successSubjects;
    }
    qb.andWhere(`(${orParts.join(' OR ')})`, params);

    const rows = await qb.orderBy('RANDOM()').limit(limit).getRawMany<{
      id: string;
    }>();
    return rows.map((r) => Number(r.id));
  }
}
