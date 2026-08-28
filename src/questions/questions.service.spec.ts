import { Repository } from 'typeorm';
import { QuestionsService } from './questions.service';
import { Question } from './entities/question.entity';

const rows = [
  { id: 1, lang: 'ka', question: 'first' },
  { id: 2, lang: 'ka', question: 'second' },
] as unknown as Question[];

function setup(total: number, page: Question[] = rows) {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['andWhere', 'orderBy', 'skip', 'take', 'select']) {
    qb[method] = jest.fn(() => qb);
  }
  qb.clone = jest.fn(() => qb);
  qb.getCount = jest.fn(() => Promise.resolve(total));
  qb.getMany = jest.fn(() => Promise.resolve(page));

  const service = new QuestionsService({
    createQueryBuilder: () => qb,
  } as unknown as Repository<Question>);

  return { service, qb };
}

describe('QuestionsService.findPaged', () => {
  const opts = { lang: 'ka', page: 1, size: 20 as const };

  it('returns rows under the canonical `data` key', async () => {
    const { service } = setup(2);
    const result = await service.findPaged(opts);
    expect(result.data).toHaveLength(2);
    expect(result.pageSize).toBe(20);
  });

  it('still exposes the deprecated `items` and `size` aliases', async () => {
    const { service } = setup(2);
    const result = await service.findPaged(opts);
    expect(result.items).toEqual(result.data);
    expect(result.size).toBe(result.pageSize);
  });

  it('strips the lang field from every row', async () => {
    const { service } = setup(2);
    const result = await service.findPaged(opts);
    for (const row of result.data) {
      expect(row).not.toHaveProperty('lang');
    }
  });

  it('computes total pages from the unpaged count', async () => {
    const { service } = setup(45);
    const result = await service.findPaged(opts);
    expect(result.total).toBe(45);
    expect(result.totalPages).toBe(3);
  });

  it('offsets by whole pages', async () => {
    const { service, qb } = setup(45);
    await service.findPaged({ ...opts, page: 3 });
    expect(qb.skip).toHaveBeenCalledWith(40);
    expect(qb.take).toHaveBeenCalledWith(20);
  });

  it('reports no pages when nothing matches', async () => {
    const { service } = setup(0, []);
    const result = await service.findPaged(opts);
    expect(result.data).toEqual([]);
    expect(result.totalPages).toBe(0);
  });
});
