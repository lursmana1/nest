import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Question } from './entities/question.entity';
import { applyQuestionFilters, stripLangField } from './question-query.util';

@Injectable()
export class QuestionsService {
  constructor(
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
  ) {}

  async findPaged(opts: {
    lang: string;
    category?: number;
    subjects?: number[];
    page: number;
    size: 10 | 20 | 40;
  }) {
    const { lang, category, subjects, page, size } = opts;
    const skip = (page - 1) * size;

    const baseQb = this.questionRepo.createQueryBuilder('q');
    applyQuestionFilters(baseQb, 'q', { lang, category, subjects });

    const total = await baseQb.getCount();
    const rows = await baseQb
      .clone()
      .orderBy('q.id', 'ASC')
      .skip(skip)
      .take(size)
      .getMany();

    return {
      items: rows.map(stripLangField),
      page,
      size,
      total,
      totalPages: Math.ceil(total / size),
    };
  }

  async findRandom(opts: {
    lang: string;
    count: number;
    category?: number;
    subjects?: number[];
  }) {
    const { lang, count, category, subjects } = opts;

    const qb = this.questionRepo.createQueryBuilder('q');
    applyQuestionFilters(qb, 'q', { lang, category, subjects });
    const rows = await qb.orderBy('RANDOM()').take(count).getMany();

    return rows.map((row) => {
      const { categories: _categories, lang: _lang, ...rest } = row;
      return rest;
    });
  }

  async findOne(id: string, lang: string) {
    const numId = Number(id);
    if (!Number.isFinite(numId)) {
      return null;
    }
    return this.questionRepo.findOne({ where: { id: numId, lang } });
  }

  async findByIds(ids: number[], lang: string): Promise<Question[]> {
    if (!ids.length) return [];
    return this.questionRepo
      .createQueryBuilder('q')
      .where('q.lang = :lang', { lang })
      .andWhere('q.id IN (:...ids)', { ids })
      .getMany();
  }
}
