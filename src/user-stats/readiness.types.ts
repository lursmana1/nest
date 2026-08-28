export type ReadinessConfidence = 'none' | 'low' | 'medium' | 'high';

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
