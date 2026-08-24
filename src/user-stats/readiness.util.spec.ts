import { computeReadiness } from './readiness.util';

describe('computeReadiness', () => {
  const base = {
    subjectsTotal: 32,
    questionCount: 30,
    passRate: 25 / 30,
  };

  const uncovered = (id: number) => ({
    subjectId: id,
    correctCount: 4,
    wrongCount: 2,
    distinctQuestionsAnswered: 5,
    totalQuestions: 40,
  });

  const covered = (id: number) => ({
    subjectId: id,
    correctCount: 20,
    wrongCount: 5,
    distinctQuestionsAnswered: 28,
    totalQuestions: 40,
  });

  it('returns none confidence with no completed attempts', () => {
    const result = computeReadiness({
      ...base,
      attempts: [],
      subjects: [],
    });
    expect(result.confidence).toBe('none');
    expect(result.readinessScore).toBe(0);
  });

  it('keeps score low when recent exams are early fails', () => {
    const subjects = Array.from({ length: 20 }, (_, i) => uncovered(i + 1));

    const result = computeReadiness({
      ...base,
      attempts: [
        {
          correctCount: 2,
          minCorrectToPass: 25,
          passed: false,
          answeredCount: 8,
          earlyWrongCount: 6,
        },
        {
          correctCount: 4,
          minCorrectToPass: 25,
          passed: false,
          answeredCount: 10,
          earlyWrongCount: 6,
        },
      ],
      subjects,
      completedAttemptsTotal: 8,
    });

    expect(result.subjectsCovered).toBe(0);
    expect(result.readinessScore).toBeLessThan(20);
  });

  it('strong recent streak scores high even with few topics covered', () => {
    // Score is ~90% recent form + 10% coverage — not crushed by 5/32 topics
    const subjects = [
      ...Array.from({ length: 5 }, (_, i) => covered(i + 1)),
      ...Array.from({ length: 27 }, (_, i) => uncovered(i + 6)),
    ];
    const strongPass = {
      correctCount: 29,
      minCorrectToPass: 25,
      passed: true,
      answeredCount: 30,
    };

    const result = computeReadiness({
      ...base,
      attempts: Array.from({ length: 20 }, () => strongPass),
      subjects,
      completedAttemptsTotal: 24,
    });

    expect(result.subjectsCovered).toBe(5);
    expect(result.completedAttemptsUsed).toBe(20);
    expect(result.readinessScore).toBeGreaterThanOrEqual(85);
    expect(result.readyForExam).toBe(false); // coverage < 40%
  });

  it('heavily discounts early fails', () => {
    const earlyFail = computeReadiness({
      ...base,
      attempts: [
        {
          correctCount: 5,
          minCorrectToPass: 25,
          passed: false,
          answeredCount: 10,
          earlyWrongCount: 5,
        },
      ],
      subjects: [],
    });
    expect(earlyFail.earlyFailCount).toBe(1);
    expect(earlyFail.examAccuracy).toBeLessThan(0.1);
  });

  it('readyForExam needs pass + high score + covered topics', () => {
    const subjects = Array.from({ length: 24 }, (_, i) => ({
      ...covered(i + 1),
      correctCount: 24,
      wrongCount: 1,
    }));

    const result = computeReadiness({
      ...base,
      subjectsTotal: 24,
      attempts: [
        { correctCount: 28, minCorrectToPass: 25, passed: true },
        { correctCount: 27, minCorrectToPass: 25, passed: true },
        { correctCount: 26, minCorrectToPass: 25, passed: true },
      ],
      subjects,
      completedAttemptsTotal: 10,
    });

    expect(result.practicePart).toBe(1);
    expect(result.coverageFactor).toBe(1);
    expect(result.readinessScore).toBeGreaterThanOrEqual(90);
    expect(result.readyForExam).toBe(true);
  });

  it('uses recent exam answers for answerAccuracy, not lifetime subject totals', () => {
    const subjects = Array.from({ length: 20 }, (_, i) => ({
      ...uncovered(i + 1),
      correctCount: 1,
      wrongCount: 99,
    }));

    const result = computeReadiness({
      ...base,
      attempts: [
        {
          correctCount: 28,
          minCorrectToPass: 25,
          passed: true,
          answeredCount: 30,
        },
        {
          correctCount: 27,
          minCorrectToPass: 25,
          passed: true,
          answeredCount: 30,
        },
      ],
      subjects,
      completedAttemptsTotal: 40,
    });

    // 55/60 from recent exams — not the lifetime 1/100 subject ratio
    expect(result.answerAccuracy).toBeCloseTo(55 / 60, 2);
    expect(result.completedAttemptsUsed).toBe(2);
  });

  it('one pass alone does not mark ready without topic coverage', () => {
    const subjects = Array.from({ length: 4 }, (_, i) => uncovered(i + 1));

    const result = computeReadiness({
      ...base,
      attempts: [
        { correctCount: 26, minCorrectToPass: 25, passed: true },
        { correctCount: 14, minCorrectToPass: 25, passed: false },
      ],
      subjects,
    });

    expect(result.lastAttemptPassed).toBe(true);
    expect(result.readyForExam).toBe(false);
  });
});
