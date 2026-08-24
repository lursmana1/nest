import {
  aggregateSubjectCounts,
  buildSubjectProgressRows,
  isSubjectCovered,
  isQuestionStatCorrect,
} from './user-stats-query.util';

describe('subject coverage', () => {
  const catalog = [
    { id: 1, name: 'Topic 1', questionsCount: 40 },
    { id: 2, name: 'Topic 2', questionsCount: 35 },
  ];

  it('requires ≥70% of topic questions, not a flat answer count', () => {
    expect(isSubjectCovered(5, 40)).toBe(false);
    expect(isSubjectCovered(27, 40)).toBe(false);
    expect(isSubjectCovered(28, 40)).toBe(true);
  });

  it('marks covered only when pool coverage is met', () => {
    const counts = aggregateSubjectCounts(
      Array.from({ length: 10 }, () => ({ subjectId: 1, correct: true })),
    );
    const low = buildSubjectProgressRows(
      catalog,
      counts,
      new Map([[1, 5]]),
      25 / 30,
    );
    expect(low[0].covered).toBe(false);

    const high = buildSubjectProgressRows(
      catalog,
      counts,
      new Map([[1, 28]]),
      25 / 30,
    );
    expect(high[0].covered).toBe(true);
    expect(high[0].coverageRate).toBeCloseTo(0.7, 2);
  });
});

describe('isQuestionStatCorrect (≥60% of answers on that id)', () => {
  it('counts as mistake when mostly wrong even if last was right (3/10)', () => {
    expect(isQuestionStatCorrect(3, 10)).toBe(false);
  });

  it('counts as correct when ≥60% right (6/10, 7/10)', () => {
    expect(isQuestionStatCorrect(6, 10)).toBe(true);
    expect(isQuestionStatCorrect(7, 10)).toBe(true);
  });

  it('single wrong → mistake; single correct → correct', () => {
    expect(isQuestionStatCorrect(0, 1)).toBe(false);
    expect(isQuestionStatCorrect(1, 1)).toBe(true);
  });
});
