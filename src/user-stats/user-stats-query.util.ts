import type { CategorySubjectRow } from '../categories/entities/category.entity';
import {
  SUBJECT_COVERAGE_RATIO,
  MIN_SUBJECT_ATTEMPTS_FOR_STATS,
} from '../common/constants/exam.constants.js';

export type SubjectCountRow = {
  subjectId: number;
  correctCount: number;
  wrongCount: number;
};

export type SubjectProgressRow = SubjectCountRow & {
  name: string;
  attempted: number;
  correctnessRate: number;
  /** Covered when distinctQuestionsAnswered / totalQuestions ≥ SUBJECT_COVERAGE_RATIO. */
  covered: boolean;
  mastered: boolean;
  totalQuestions: number;
  distinctQuestionsAnswered: number;
  coverageRate: number;
};

export function isSubjectCovered(
  distinctQuestionsAnswered: number,
  totalQuestions: number,
  coverageRatio: number = SUBJECT_COVERAGE_RATIO,
): boolean {
  if (totalQuestions <= 0) return false;
  return distinctQuestionsAnswered / totalQuestions >= coverageRatio;
}

export function isSubjectMastered(
  attempted: number,
  correctnessRate: number,
  passRate: number,
  minMasteryAttempts: number = MIN_SUBJECT_ATTEMPTS_FOR_STATS,
): boolean {
  return attempted >= minMasteryAttempts && correctnessRate >= passRate;
}

export function aggregateSubjectCounts(
  rows: { subjectId: number; correct: boolean }[],
): Map<number, { correctCount: number; wrongCount: number }> {
  const bySubject = new Map<
    number,
    { correctCount: number; wrongCount: number }
  >();
  for (const row of rows) {
    if (row.subjectId == null) continue;
    const subjectId = Number(row.subjectId);
    const curr = bySubject.get(subjectId) ?? {
      correctCount: 0,
      wrongCount: 0,
    };
    if (row.correct) curr.correctCount += 1;
    else curr.wrongCount += 1;
    bySubject.set(subjectId, curr);
  }
  return bySubject;
}

export function buildSubjectProgressRows(
  catalog: CategorySubjectRow[],
  countsBySubject: Map<number, { correctCount: number; wrongCount: number }>,
  distinctBySubject: Map<number, number>,
  passRate: number,
  minMasteryAttempts: number = MIN_SUBJECT_ATTEMPTS_FOR_STATS,
  coverageRatio: number = SUBJECT_COVERAGE_RATIO,
): SubjectProgressRow[] {
  return catalog.map((subject) => {
    const counts = countsBySubject.get(subject.id) ?? {
      correctCount: 0,
      wrongCount: 0,
    };
    const attempted = counts.correctCount + counts.wrongCount;
    const correctnessRate =
      attempted > 0 ? counts.correctCount / attempted : 0;
    const distinctQuestionsAnswered = distinctBySubject.get(subject.id) ?? 0;
    const totalQuestions = subject.questionsCount;
    const coverageRate =
      totalQuestions > 0 ? distinctQuestionsAnswered / totalQuestions : 0;

    return {
      subjectId: subject.id,
      name: subject.name,
      attempted,
      correctCount: counts.correctCount,
      wrongCount: counts.wrongCount,
      correctnessRate: round3(correctnessRate),
      covered: isSubjectCovered(
        distinctQuestionsAnswered,
        totalQuestions,
        coverageRatio,
      ),
      mastered: isSubjectMastered(
        attempted,
        correctnessRate,
        passRate,
        minMasteryAttempts,
      ),
      totalQuestions,
      distinctQuestionsAnswered,
      coverageRate: round3(coverageRate),
    };
  });
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
