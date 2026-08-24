/**
 * Readiness score (მზაობის ქულა) — category-scoped, 0–100.
 *
 * Score is mainly recent exams (last 20), not bank coverage:
 *   core = 65% exam accuracy + 35% answer accuracy on those exams
 *   score = 90% × core + 10% × (coveredTopics / topicsTotal)
 *
 * Topic coverage only nudges the score and gates readyForExam (≥40% topics).
 * readyForExam: last exam passed + score ≥90 + ≥40% of topics covered.
 */

import {
  SUBJECT_COVERAGE_RATIO,
  READINESS_MAX_ATTEMPTS,
  READINESS_READY_SCORE_THRESHOLD,
  READINESS_READY_PRACTICE_THRESHOLD,
  MIN_SUBJECT_ATTEMPTS_FOR_STATS,
} from '../common/constants/exam.constants.js';
import { isSubjectCovered } from './user-stats-query.util.js';
import { round3 } from '../common/utils/round3.util.js';

export type ReadinessConfidence = 'none' | 'low' | 'medium' | 'high';

export const EARLY_FAIL_WINDOW = 10;
const EARLY_FAIL_SCORE_FACTOR = 0.3;
const EXAM_WEIGHT = 0.65;
const ANSWER_WEIGHT = 0.35;
/** Share of readiness score from recent exam form (rest = topic coverage). */
const FORM_WEIGHT = 0.9;
const COVERAGE_SCORE_WEIGHT = 0.1;
/**
 * Diagnostic coverage factor for API/UI (not the main score multiplier).
 * 0 covered → COVERAGE_FLOOR; all covered → 1.
 */
const COVERAGE_FLOOR = 0.55;

export type ReadinessAttemptInput = {
  correctCount: number;
  minCorrectToPass: number;
  passed: boolean;
  answeredCount?: number;
  earlyWrongCount?: number;
};

export type ReadinessSubjectInput = {
  subjectId: number;
  correctCount: number;
  wrongCount: number;
  distinctQuestionsAnswered: number;
  totalQuestions: number;
};

export type ComputeReadinessInput = {
  attempts: ReadinessAttemptInput[];
  subjects: ReadinessSubjectInput[];
  subjectsTotal: number;
  questionCount: number;
  passRate: number;
  minSubjectAttempts?: number;
  completedAttemptsTotal?: number;
  recentExamLimit?: number;
  readyScoreThreshold?: number;
  readyPracticeThreshold?: number;
};

export type ReadinessResult = {
  readinessScore: number;
  confidence: ReadinessConfidence;
  readyForExam: boolean;
  label: string;
  examAccuracy: number;
  answerAccuracy: number;
  /** Covered topics / total (0–1). */
  practicePart: number;
  coverageFactor: number;
  earlyFailCount: number;
  lastAttemptPassed: boolean | null;
  completedAttemptsTotal: number;
  completedAttemptsUsed: number;
  subjectsCovered: number;
  subjectsMastered: number;
  subjectsTotal: number;
  weakSubjectsCount: number;
  /** @deprecated aliases for older clients */
  examPart: number;
  passRatePart: number;
  coveragePart: number;
  masteryPart: number;
  stabilityPart: number;
};

export function isEarlyFail(
  attempt: ReadinessAttemptInput,
  questionCount: number,
  earlyWindow: number = EARLY_FAIL_WINDOW,
): boolean {
  if (attempt.passed) return false;

  const maxWrong = Math.max(1, questionCount - attempt.minCorrectToPass);
  const answered = attempt.answeredCount ?? attempt.correctCount;
  const earlyWrong = attempt.earlyWrongCount ?? 0;

  if (answered > 0 && answered <= earlyWindow) return true;
  if (earlyWrong >= maxWrong) return true;
  return false;
}

export function scoreAttemptAccuracy(
  attempt: ReadinessAttemptInput,
  questionCount: number,
): number {
  const denom = Math.max(1, questionCount);
  const raw = Math.max(0, Math.min(1, attempt.correctCount / denom));
  if (isEarlyFail(attempt, questionCount)) {
    return raw * EARLY_FAIL_SCORE_FACTOR;
  }
  return raw;
}

export function computeExamAccuracy(
  attempts: ReadinessAttemptInput[],
  questionCount: number,
): number {
  if (attempts.length === 0) return 0;
  let sum = 0;
  for (const attempt of attempts) {
    sum += scoreAttemptAccuracy(attempt, questionCount);
  }
  return sum / attempts.length;
}

export function computeAnswerAccuracy(
  subjects: ReadinessSubjectInput[],
): number {
  let correct = 0;
  let total = 0;
  for (const subject of subjects) {
    correct += subject.correctCount;
    total += subject.correctCount + subject.wrongCount;
  }
  if (total <= 0) return 0;
  return correct / total;
}

/** Answer accuracy from recent exam attempts only (not lifetime subject history). */
export function computeRecentAnswerAccuracy(
  attempts: ReadinessAttemptInput[],
): number {
  let correct = 0;
  let total = 0;
  for (const attempt of attempts) {
    correct += attempt.correctCount;
    total += attempt.answeredCount ?? attempt.correctCount;
  }
  if (total <= 0) return 0;
  return correct / total;
}

export function countCoveredSubjects(
  subjects: ReadinessSubjectInput[],
): number {
  let covered = 0;
  for (const subject of subjects) {
    if (
      isSubjectCovered(
        subject.distinctQuestionsAnswered,
        subject.totalQuestions,
        SUBJECT_COVERAGE_RATIO,
      )
    ) {
      covered += 1;
    }
  }
  return covered;
}

export function countMasteredSubjects(
  subjects: ReadinessSubjectInput[],
  minSubjectAttempts: number,
  passRate: number,
): number {
  let mastered = 0;
  for (const subject of subjects) {
    const attempted = subject.correctCount + subject.wrongCount;
    if (attempted < minSubjectAttempts) continue;
    if (subject.correctCount / attempted >= passRate) mastered += 1;
  }
  return mastered;
}

export function countWeakSubjects(
  subjects: ReadinessSubjectInput[],
  minSubjectAttempts: number,
  passRate: number,
): number {
  let weak = 0;
  for (const subject of subjects) {
    const attempted = subject.correctCount + subject.wrongCount;
    if (attempted < minSubjectAttempts) continue;
    if (subject.correctCount / attempted < passRate) weak += 1;
  }
  return weak;
}

/**
 * 0 covered → COVERAGE_FLOOR; all covered → 1.
 * Uses √ so early topic progress helps more than a linear gate.
 */
export function computeCoverageFactor(practicePart: number): number {
  const p = Math.max(0, Math.min(1, practicePart));
  return COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * Math.sqrt(p);
}

export function resolveReadinessConfidence(
  attemptCount: number,
): ReadinessConfidence {
  if (attemptCount <= 0) return 'none';
  if (attemptCount === 1) return 'low';
  if (attemptCount === 2) return 'medium';
  return 'high';
}

export function resolveReadinessLabel(
  readinessScore: number,
  confidence: ReadinessConfidence,
  readyForExam: boolean,
): string {
  if (confidence === 'none') {
    return 'გამოცდა ჯერ არ გაქვს გავლილი';
  }
  if (readyForExam) {
    return 'მზად ხარ გამოცდისთვის';
  }
  if (readinessScore < 50) return 'საჭიროებს მეტ სწავლას';
  if (readinessScore < 90) return 'კარგი პროგრესი';
  return 'თითქმის მზად ხარ';
}

export function computeReadiness(
  input: ComputeReadinessInput,
): ReadinessResult {
  const {
    attempts,
    subjects,
    subjectsTotal,
    questionCount,
    passRate,
    minSubjectAttempts = MIN_SUBJECT_ATTEMPTS_FOR_STATS,
    completedAttemptsTotal,
    recentExamLimit = READINESS_MAX_ATTEMPTS,
    readyScoreThreshold = READINESS_READY_SCORE_THRESHOLD,
    readyPracticeThreshold = READINESS_READY_PRACTICE_THRESHOLD,
  } = input;

  const recentAttempts = attempts.slice(0, recentExamLimit);
  const examAccuracy = computeExamAccuracy(recentAttempts, questionCount);
  const answerAccuracy =
    recentAttempts.length > 0
      ? computeRecentAnswerAccuracy(recentAttempts)
      : computeAnswerAccuracy(subjects);
  const subjectsCovered = countCoveredSubjects(subjects);
  const practicePart = subjectsTotal > 0 ? subjectsCovered / subjectsTotal : 0;
  const coverageFactor = computeCoverageFactor(practicePart);
  const subjectsMastered = countMasteredSubjects(
    subjects,
    minSubjectAttempts,
    passRate,
  );
  const weakSubjectsCount = countWeakSubjects(
    subjects,
    minSubjectAttempts,
    passRate,
  );
  const earlyFailCount = recentAttempts.filter((a) =>
    isEarlyFail(a, questionCount),
  ).length;

  const core = EXAM_WEIGHT * examAccuracy + ANSWER_WEIGHT * answerAccuracy;
  const readinessScore = Math.round(
    100 *
      Math.max(
        0,
        Math.min(1, FORM_WEIGHT * core + COVERAGE_SCORE_WEIGHT * practicePart),
      ),
  );

  const confidence = resolveReadinessConfidence(recentAttempts.length);
  const lastAttemptPassed =
    recentAttempts.length > 0 ? recentAttempts[0].passed : null;
  const readyForExam =
    confidence !== 'none' &&
    readinessScore >= readyScoreThreshold &&
    lastAttemptPassed === true &&
    practicePart >= readyPracticeThreshold;

  return {
    readinessScore,
    confidence,
    readyForExam,
    label: resolveReadinessLabel(readinessScore, confidence, readyForExam),
    examAccuracy: round3(examAccuracy),
    answerAccuracy: round3(answerAccuracy),
    practicePart: round3(practicePart),
    coverageFactor: round3(coverageFactor),
    earlyFailCount,
    lastAttemptPassed,
    completedAttemptsTotal: completedAttemptsTotal ?? attempts.length,
    completedAttemptsUsed: recentAttempts.length,
    subjectsCovered,
    subjectsMastered,
    subjectsTotal,
    weakSubjectsCount,
    examPart: round3(examAccuracy),
    passRatePart: round3(answerAccuracy),
    coveragePart: round3(practicePart),
    masteryPart: round3(
      subjectsTotal > 0 ? subjectsMastered / subjectsTotal : 0,
    ),
    stabilityPart: 0,
  };
}
