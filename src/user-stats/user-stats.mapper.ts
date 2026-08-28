import type { CategorySubjectRow } from '../categories/entities/category.entity';
import type { ExamRuleResponse } from '../common/utils/georgian-exam-rules.util.js';
import { round3 } from '../common/utils/round3.util.js';
import type { ReadinessResult } from './readiness.types.js';
import type {
  ReadinessResponse,
  WeakSubjectAggregateRow,
  WeakSubjectItem,
} from './user-stats.types.js';

/**
 * Names and pool sizes come from the category catalog when it exists. Older
 * categories have no catalog entry, so totals fall back to a live question
 * count and the name degrades to the raw subject id.
 */
export function toWeakSubjectItems(
  rows: WeakSubjectAggregateRow[],
  catalog: CategorySubjectRow[],
  fallbackTotals: Map<number, number>,
): WeakSubjectItem[] {
  const names = new Map(catalog.map((subject) => [subject.id, subject.name]));
  const totals = new Map(
    catalog.map((subject) => [subject.id, subject.questionsCount]),
  );

  return rows.map((row) => ({
    subjectId: row.subjectId,
    name: names.get(row.subjectId) ?? `Subject ${row.subjectId}`,
    wrongCount: row.wrongCount,
    correctCount: row.correctCount,
    attempted: row.attempted,
    correctnessRate: round3(row.correctnessRate),
    totalQuestions:
      totals.get(row.subjectId) ?? fallbackTotals.get(row.subjectId) ?? 0,
  }));
}

/** Flattens the exam rule and the computed score into one API payload. */
export function toReadinessResponse(
  categoryName: string,
  rules: ExamRuleResponse,
  readiness: ReadinessResult,
): ReadinessResponse {
  return {
    categoryName,
    categoryId: rules.categoryId,
    questionCount: rules.questionCount,
    minCorrectToPass: rules.minCorrectToPass,
    maxWrongAnswers: rules.maxWrongAnswers,
    durationMinutes: rules.durationMinutes,
    readinessScore: readiness.readinessScore,
    confidence: readiness.confidence,
    readyForExam: readiness.readyForExam,
    label: readiness.label,
    examAccuracy: readiness.examAccuracy,
    answerAccuracy: readiness.answerAccuracy,
    practicePart: readiness.practicePart,
    coverageFactor: readiness.coverageFactor,
    earlyFailCount: readiness.earlyFailCount,
    lastAttemptPassed: readiness.lastAttemptPassed,
    completedAttemptsTotal: readiness.completedAttemptsTotal,
    completedAttemptsUsed: readiness.completedAttemptsUsed,
    subjectsCovered: readiness.subjectsCovered,
    subjectsMastered: readiness.subjectsMastered,
    subjectsTotal: readiness.subjectsTotal,
    weakSubjectsCount: readiness.weakSubjectsCount,
  };
}
