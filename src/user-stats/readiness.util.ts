/**
 * Readiness score (მზაობის ქულა) — category-scoped, 0–100.
 *
 * Score is mainly recent exams (last 20), not bank coverage:
 *   core = 65% exam accuracy + 35% answer accuracy on those exams
 *   score = 90% × core + 10% × (coveredTopics / topicsTotal)
 *
 * Topic coverage only nudges the score and gates readyForExam (≥40% topics).
 * readyForExam: last exam passed + score ≥90 + ≥40% of topics covered.
 *
 * Scoring primitives live in `readiness.scoring.ts`, wording in
 * `readiness.labels.ts`, shapes in `readiness.types.ts`.
 */

import {
  READINESS_MAX_ATTEMPTS,
  READINESS_READY_SCORE_THRESHOLD,
  READINESS_READY_PRACTICE_THRESHOLD,
  MIN_SUBJECT_ATTEMPTS_FOR_STATS,
} from '../common/constants/exam.constants.js';
import { round3 } from '../common/utils/round3.util.js';
import {
  computeAnswerAccuracy,
  computeCoverageFactor,
  computeCoreScore,
  computeExamAccuracy,
  computeReadinessScore,
  computeRecentAnswerAccuracy,
  countCoveredSubjects,
  countSubjectsByMastery,
  isEarlyFail,
} from './readiness.scoring.js';
import {
  resolveReadinessConfidence,
  resolveReadinessLabel,
} from './readiness.labels.js';
import type {
  ComputeReadinessInput,
  ReadinessResult,
} from './readiness.types.js';

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
  // Lifetime subject history stands in until the user has sat an exam.
  const answerAccuracy =
    recentAttempts.length > 0
      ? computeRecentAnswerAccuracy(recentAttempts)
      : computeAnswerAccuracy(subjects);

  const subjectsCovered = countCoveredSubjects(subjects);
  const practicePart = subjectsTotal > 0 ? subjectsCovered / subjectsTotal : 0;
  const { mastered, weak } = countSubjectsByMastery(
    subjects,
    minSubjectAttempts,
    passRate,
  );

  const readinessScore = computeReadinessScore(
    computeCoreScore(examAccuracy, answerAccuracy),
    practicePart,
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
    coverageFactor: round3(computeCoverageFactor(practicePart)),
    earlyFailCount: recentAttempts.filter((a) => isEarlyFail(a, questionCount))
      .length,
    lastAttemptPassed,
    completedAttemptsTotal: completedAttemptsTotal ?? attempts.length,
    completedAttemptsUsed: recentAttempts.length,
    subjectsCovered,
    subjectsMastered: mastered,
    subjectsTotal,
    weakSubjectsCount: weak,
    examPart: round3(examAccuracy),
    passRatePart: round3(answerAccuracy),
    coveragePart: round3(practicePart),
    masteryPart: round3(subjectsTotal > 0 ? mastered / subjectsTotal : 0),
    stabilityPart: 0,
  };
}
