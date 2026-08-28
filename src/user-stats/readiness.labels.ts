import type { ReadinessConfidence } from './readiness.types.js';

/** Confidence tracks how many recent exams the score is based on. */
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
