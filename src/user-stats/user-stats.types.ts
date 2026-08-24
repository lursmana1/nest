import type { CategoryDisplayMeta } from '../common/constants/category.constants.js';
import type { ResolvedGeorgianExamRule } from '../common/utils/georgian-exam-rules.util.js';
import type { ReadinessResult } from './readiness.util.js';
import type { SubjectProgressRow } from './user-stats-query.util.js';

/** Category metadata + exam rule + per-topic rows, shared by readiness and progress. */
export type CategoryProgress = {
  display: CategoryDisplayMeta;
  rule: ResolvedGeorgianExamRule;
  passRate: number;
  progressRows: SubjectProgressRow[];
};

export type ReadinessResponse = {
  categoryId: number;
  categoryName: string;
  questionCount: number;
  minCorrectToPass: number;
  maxWrongAnswers: number;
  durationMinutes: number;
  readinessScore: number;
  confidence: ReadinessResult['confidence'];
  readyForExam: boolean;
  label: string;
  examAccuracy: number;
  answerAccuracy: number;
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
};

/** Compact first-paint payload for the profile stats grid. */
export interface UserStatsSummary {
  categoryId: number;
  categoryName: string;
  readinessScore: number;
  readyForExam: boolean;
  confidence: ReadinessResult['confidence'];
  label: string;
  subjectsCovered: number;
  subjectsMastered: number;
  subjectsTotal: number;
  weakSubjectsCount: number;
  completedAttemptsTotal: number;
  distinctQuestionsAnswered: number;
  totalQuestionsInCategory: number;
  exposureRate: number;
  questionCount: number;
  minCorrectToPass: number;
}

export interface WeakQuestionPreview {
  question: string;
  hasImg: number;
  img: string | null;
  subject: number | null;
}

export interface WeakQuestionItem {
  questionId: number;
  wrongCount: number;
  totalAttempts: number;
  /** List-row fields only — no answers / explanations (keeps JSON tiny). */
  preview: WeakQuestionPreview | null;
}

export interface WeakSubjectItem {
  subjectId: number;
  name: string;
  wrongCount: number;
  correctCount: number;
  attempted: number;
  correctnessRate: number;
  totalQuestions: number;
}

export interface WeakQuestionsResponse {
  categoryId: number | null;
  data: WeakQuestionItem[];
  total: number;
}

export interface WeakSubjectsResponse {
  categoryId: number | null;
  data: WeakSubjectItem[];
  total: number;
}

export interface SubjectProgressResponse {
  categoryId: number;
  categoryName: string;
  passRate: number;
  /** Distinct questions / topic pool required to count as covered (0.7). */
  coverageRatioRequired: number;
  minAttemptsForMastery: number;
  subjectsTotal: number;
  subjectsCovered: number;
  subjectsMastered: number;
  data: SubjectProgressRow[];
}

export interface QuestionPoolResponse {
  categoryId: number;
  distinctQuestionsAnswered: number;
  totalQuestionsInCategory: number;
  exposureRate: number;
}

export type QuestionPoolExposure = Omit<QuestionPoolResponse, 'categoryId'>;

// --- Query-layer row shapes (already coerced from raw SQL strings) ---

export interface WeakQuestionCountRow {
  questionId: number;
  wrongCount: number;
  totalAttempts: number;
}

export interface WeakSubjectAggregateRow {
  subjectId: number;
  wrongCount: number;
  correctCount: number;
  attempted: number;
  correctnessRate: number;
}

export interface RecentAttemptRow {
  correctCount: number;
  minCorrectToPass: number;
  passed: boolean;
  answeredCount: number;
  earlyWrongCount: number;
}

export interface SubjectAggregateRow {
  subjectId: number;
  correctCount: number;
  wrongCount: number;
  distinctQuestions: number;
}
