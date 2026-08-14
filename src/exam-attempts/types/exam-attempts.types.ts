export interface StartAttemptOptions {
  lang: string;
  count?: number;
  subjects?: number[];
  categories?: number[];
  allSubjects?: boolean;
}

export interface AttemptSummary {
  id: number;
  questionCount: number;
  answeredCount: number;
  correctCount: number;
  minCorrectToPass: number | null;
  createdAt: Date;
  endDate: Date | null;
  completedAt: Date | null;
  passed: boolean | null;
  durationSeconds: number | null;
}

/** Full-history aggregates (not limited to the current page). */
export interface AttemptHistoryCounts {
  total: number;
  passed: number;
  failed: number;
  incomplete: number;
  /** 0–100 integer: passed / (passed + failed). */
  passRate: number;
}

export interface PaginatedAttempts {
  data: AttemptSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counts: AttemptHistoryCounts;
}

export interface RawAnswerRow {
  questionId: number;
  subject: number | null;
  correct: boolean;
  chosenAnswer: string;
  createdAt: Date;
}
