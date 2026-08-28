import {
  SUBJECT_COVERAGE_RATIO,
  EARLY_FAIL_WINDOW,
} from '../common/constants/exam.constants.js';
import { isSubjectCovered } from './user-stats-query.util.js';
import type {
  ReadinessAttemptInput,
  ReadinessSubjectInput,
} from './readiness.types.js';

/** An attempt that collapsed early scores a fraction of its raw accuracy. */
const EARLY_FAIL_SCORE_FACTOR = 0.3;

const EXAM_WEIGHT = 0.65;
const ANSWER_WEIGHT = 0.35;

/** Share of the readiness score from recent exam form (rest = topic coverage). */
const FORM_WEIGHT = 0.9;
const COVERAGE_SCORE_WEIGHT = 0.1;

/**
 * Diagnostic coverage factor for API/UI (not the main score multiplier).
 * 0 covered → COVERAGE_FLOOR; all covered → 1.
 */
const COVERAGE_FLOOR = 0.55;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * A failed attempt counts as an early fail when the user gave up in the first
 * few answers, or burned their whole wrong-answer budget inside that window.
 */
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
  return earlyWrong >= maxWrong;
}

export function scoreAttemptAccuracy(
  attempt: ReadinessAttemptInput,
  questionCount: number,
): number {
  const raw = clamp01(attempt.correctCount / Math.max(1, questionCount));
  return isEarlyFail(attempt, questionCount)
    ? raw * EARLY_FAIL_SCORE_FACTOR
    : raw;
}

export function computeExamAccuracy(
  attempts: ReadinessAttemptInput[],
  questionCount: number,
): number {
  if (attempts.length === 0) return 0;
  const sum = attempts.reduce(
    (acc, attempt) => acc + scoreAttemptAccuracy(attempt, questionCount),
    0,
  );
  return sum / attempts.length;
}

/** Lifetime per-subject accuracy — the fallback when there are no exams yet. */
export function computeAnswerAccuracy(
  subjects: ReadinessSubjectInput[],
): number {
  let correct = 0;
  let total = 0;
  for (const subject of subjects) {
    correct += subject.correctCount;
    total += subject.correctCount + subject.wrongCount;
  }
  return total > 0 ? correct / total : 0;
}

/** Answer accuracy from recent exam attempts only. */
export function computeRecentAnswerAccuracy(
  attempts: ReadinessAttemptInput[],
): number {
  let correct = 0;
  let total = 0;
  for (const attempt of attempts) {
    correct += attempt.correctCount;
    total += attempt.answeredCount ?? attempt.correctCount;
  }
  return total > 0 ? correct / total : 0;
}

export function countCoveredSubjects(
  subjects: ReadinessSubjectInput[],
): number {
  return subjects.filter((subject) =>
    isSubjectCovered(
      subject.distinctQuestionsAnswered,
      subject.totalQuestions,
      SUBJECT_COVERAGE_RATIO,
    ),
  ).length;
}

/** Subjects with enough attempts to judge, split by the pass-rate threshold. */
export function countSubjectsByMastery(
  subjects: ReadinessSubjectInput[],
  minSubjectAttempts: number,
  passRate: number,
): { mastered: number; weak: number } {
  let mastered = 0;
  let weak = 0;

  for (const subject of subjects) {
    const attempted = subject.correctCount + subject.wrongCount;
    if (attempted < minSubjectAttempts) continue;
    if (subject.correctCount / attempted >= passRate) mastered += 1;
    else weak += 1;
  }

  return { mastered, weak };
}

/**
 * 0 covered → COVERAGE_FLOOR; all covered → 1.
 * Uses √ so early topic progress helps more than a linear gate.
 */
export function computeCoverageFactor(practicePart: number): number {
  return (
    COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * Math.sqrt(clamp01(practicePart))
  );
}

/** Recent-form component: exam accuracy weighted against answer accuracy. */
export function computeCoreScore(
  examAccuracy: number,
  answerAccuracy: number,
): number {
  return EXAM_WEIGHT * examAccuracy + ANSWER_WEIGHT * answerAccuracy;
}

/** Final 0–100 score: mostly recent form, nudged by topic coverage. */
export function computeReadinessScore(
  core: number,
  practicePart: number,
): number {
  return Math.round(
    100 * clamp01(FORM_WEIGHT * core + COVERAGE_SCORE_WEIGHT * practicePart),
  );
}
