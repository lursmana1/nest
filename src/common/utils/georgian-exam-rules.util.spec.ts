import {
  DEFAULT_GEORGIAN_EXAM_RULE,
  GEORGIAN_EXAM_RULES_BY_CATEGORY,
  assertSufficientQuestionPool,
  isExamPassed,
  resolveGeorgianExamRule,
} from './georgian-exam-rules.util';

describe('resolveGeorgianExamRule', () => {
  it('returns AM rules for category 0', () => {
    expect(resolveGeorgianExamRule({ categories: [0] })).toEqual({
      categoryId: 0,
      questionCount: 20,
      minCorrectToPass: 18,
    });
  });

  it('returns B rules for category 1', () => {
    expect(resolveGeorgianExamRule({ categories: [1] })).toEqual({
      categoryId: 1,
      questionCount: 30,
      minCorrectToPass: 25,
    });
  });

  it('returns A rules for category 2', () => {
    expect(resolveGeorgianExamRule({ categories: [2] })).toEqual({
      categoryId: 2,
      questionCount: 30,
      minCorrectToPass: 27,
    });
  });

  it('returns C1 rules for category 5', () => {
    expect(resolveGeorgianExamRule({ categories: [5] })).toEqual({
      categoryId: 5,
      questionCount: 35,
      minCorrectToPass: 32,
    });
  });

  it('returns default A rules when no category is given', () => {
    expect(resolveGeorgianExamRule({})).toEqual({
      categoryId: null,
      ...DEFAULT_GEORGIAN_EXAM_RULE,
    });
  });

  it('scales pass threshold when count is overridden', () => {
    const rule = resolveGeorgianExamRule({ categories: [0], count: 10 });
    expect(rule.questionCount).toBe(10);
    expect(rule.minCorrectToPass).toBe(9);
  });
});

describe('isExamPassed', () => {
  it('passes at exact threshold', () => {
    expect(isExamPassed(18, 18)).toBe(true);
    expect(isExamPassed(17, 18)).toBe(false);
  });
});

describe('assertSufficientQuestionPool', () => {
  it('passes when pool is large enough', () => {
    expect(() =>
      assertSufficientQuestionPool(318, { questionCount: 20 }),
    ).not.toThrow();
  });

  it('throws when pool is too small', () => {
    expect(() =>
      assertSufficientQuestionPool(15, { questionCount: 20 }),
    ).toThrow('Insufficient questions');
  });
});

describe('GEORGIAN_EXAM_RULES_BY_CATEGORY', () => {
  it('defines all 10 license categories', () => {
    expect(Object.keys(GEORGIAN_EXAM_RULES_BY_CATEGORY)).toHaveLength(10);
  });
});
