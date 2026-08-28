import { EXAM_DURATION_MINUTES } from '../common/constants/exam.constants.js';
import type { ExamAttempt } from './entities/exam-attempt.entity';

const MAX_DURATION_SECONDS = EXAM_DURATION_MINUTES * 60;

/**
 * Time spent: completedAt − createdAt, capped at the exam window.
 * An attempt settled after its deadline is graded as of the deadline, so the
 * cap only bites on rows predating server-side timer enforcement.
 */
export function computeAttemptDuration(
  attempt: ExamAttempt,
  completedAt: Date,
): number {
  const startedAt = toEpochMs(attempt.createdAt);
  const endedAt = toEpochMs(completedAt);
  if (startedAt == null || endedAt == null) return 0;
  const seconds = Math.round(Math.abs(endedAt - startedAt) / 1000);
  return Math.min(seconds, MAX_DURATION_SECONDS);
}

export function resolveDisplayDuration(attempt: ExamAttempt): number | null {
  if (!attempt.completedAt) return null;
  return computeAttemptDuration(attempt, attempt.completedAt);
}

/** Server-side deadline as a real Date, or null when unset / unparseable. */
export function attemptDeadline(
  attempt: Pick<ExamAttempt, 'endDate'>,
): Date | null {
  const ms = toEpochMs(attempt.endDate);
  return ms == null ? null : new Date(ms);
}

/** True once the attempt's deadline has passed — no further answers allowed. */
export function isAttemptExpired(
  attempt: Pick<ExamAttempt, 'endDate'>,
  now: Date = new Date(),
): boolean {
  const deadline = attemptDeadline(attempt);
  return deadline != null && now.getTime() > deadline.getTime();
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
