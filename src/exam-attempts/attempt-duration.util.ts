import { EXAM_DURATION_MINUTES } from '../common/constants/exam.constants.js';
import type { ExamAttempt } from './entities/exam-attempt.entity';

const MAX_DURATION_SECONDS = EXAM_DURATION_MINUTES * 60;
/** createdAt/completedAt mix UTC and Georgia local; strip UTC+4 when present. */
const GEORGIA_OFFSET_SECONDS = 4 * 60 * 60;

function elapsedSecondsBetween(startMs: number, endMs: number): number {
  let seconds = Math.round(Math.abs(endMs - startMs) / 1000);
  if (seconds > MAX_DURATION_SECONDS) {
    const withoutOffset = seconds - GEORGIA_OFFSET_SECONDS;
    if (withoutOffset >= 0 && withoutOffset <= MAX_DURATION_SECONDS) {
      seconds = withoutOffset;
    } else {
      seconds = Math.min(seconds, MAX_DURATION_SECONDS);
    }
  }
  return seconds;
}

/**
 * Time spent: |completedAt − createdAt|, ignoring a UTC+4 storage skew.
 */
export function computeAttemptDuration(
  attempt: ExamAttempt,
  completedAt: Date,
): number {
  const startedAt = toEpochMs(attempt.createdAt);
  const endedAt = toEpochMs(completedAt);
  if (startedAt == null || endedAt == null) return 0;
  return elapsedSecondsBetween(startedAt, endedAt);
}

export function resolveDisplayDuration(attempt: ExamAttempt): number | null {
  if (!attempt.completedAt) return null;
  return computeAttemptDuration(attempt, attempt.completedAt);
}

function toEpochMs(value?: Date | string | number | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
