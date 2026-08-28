import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Question } from './entities/question.entity';
import { applyQuestionFilters, stripLangField } from './question-query.util';

type QuestionListRow = Omit<Question, 'lang'>;

/**
 * `data`/`pageSize` match the other list endpoints. `items`/`size` are the
 * original keys, kept until the frontend migrates.
 */
export type PagedQuestions = {
  data: QuestionListRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** @deprecated alias for `data` */
  items: QuestionListRow[];
  /** @deprecated alias for `pageSize` */
  size: number;
};

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
  }): Promise<PagedQuestions> {
    const { lang, category, subjects, page, size } = opts;

    const baseQb = this.questionRepo.createQueryBuilder('q');
    applyQuestionFilters(baseQb, 'q', { lang, category, subjects });

    const total = await baseQb.getCount();
    const rows = await baseQb
      .clone()
      .orderBy('q.id', 'ASC')
      .skip((page - 1) * size)
      .take(size)
      .getMany();

    const data = rows.map(stripLangField);

    return {
      data,
      page,
      pageSize: size,
      total,
      totalPages: Math.ceil(total / size),
      items: data,
      size,
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
}
