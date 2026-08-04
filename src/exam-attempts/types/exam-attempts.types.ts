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

export interface PaginatedAttempts {
  data: AttemptSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface RawAnswerRow {
  questionId: number;
  subject: number | null;
  correct: boolean;
  chosenAnswer: string;
  createdAt: Date;
}
