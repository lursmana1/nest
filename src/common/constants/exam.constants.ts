/** Minimum total answers before any personalization (100–499: mainly random; 500+: full). */
export const MIN_ANSWERS_FOR_PERSONALIZATION = 100;

/** Minimum answers for full personalization (50/40/10). Below this, use mainly-random ratios. */
export const MIN_ANSWERS_FOR_FULL_PERSONALIZATION = 500;

/** Default question count per exam when no category is specified (A-category rules). */
export const DEFAULT_QUESTION_COUNT = 30;

/** Exam duration in minutes. */
export const EXAM_DURATION_MINUTES = 30;

/** Max history entries to load for weakness computation. */
export const MAX_HISTORY_FOR_WEIGHTING = 500;

/** Max IDs per bucket to keep the `IN (...)` lists in weighted sampling fast. */
export const MAX_WEAKNESS_IDS_CAP = 100;

/** Max raw answers to return in stats. */
export const MAX_STATS_LIMIT = 1000;

/** Minimum per-subject attempts (correct + wrong) before weak-subject ranking is reliable. */
export const MIN_SUBJECT_ATTEMPTS_FOR_STATS = 10;

/**
 * Share of a topic's question pool (distinct) required to count as covered.
 * Example: topic with 40 questions → need ≥28 unique answered.
 */
export const SUBJECT_COVERAGE_RATIO = 0.7;

/**
 * Per questionId: count as "correct" for subject cards only if
 * correctAnswers / totalAnswers ≥ this ratio; otherwise count as mistake.
 * Example: 3/10 correct (30%) → mistake even if the last answer was right.
 */
export const QUESTION_MASTERY_CORRECT_RATIO = 0.6;

/** Completed attempts used for readiness exam + recent answer accuracy (most recent first). */
export const READINESS_MAX_ATTEMPTS = 20;

/** Answers from the start of an attempt that count towards an "early fail". */
export const EARLY_FAIL_WINDOW = 10;

/** Readiness score >= this + last pass + topic coverage → readyForExam. */
export const READINESS_READY_SCORE_THRESHOLD = 90;

/** Minimum share of topics covered for readyForExam (not full bank). */
export const READINESS_READY_PRACTICE_THRESHOLD = 0.4;

/** Max page size for history. */
export const MAX_HISTORY_PAGE_SIZE = 50;

/** Default page size for history. */
export const DEFAULT_HISTORY_PAGE_SIZE = 10;
