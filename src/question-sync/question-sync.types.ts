export interface SyncOptions {
  /** Max number of IDs to process (default: 5 for testing) */
  limit?: number;
  /** Skip first N IDs (for Day 2: offset=1200) */
  offset?: number;
}

/** One API call per ID — Gemini returns all languages */
export interface GeminiResponse {
  ka_explained: string;
  ru_question: string;
  en_question: string;
  ru_answer_1: string;
  ru_answer_2: string;
  ru_answer_3: string;
  ru_answer_4: string;
  en_answer_1: string;
  en_answer_2: string;
  en_answer_3: string;
  en_answer_4: string;
  ru_explained: string;
  en_explained: string;
  ka_tutor: string;
  ru_tutor: string;
  en_tutor: string;
}

export type QuestionRow = {
  id: number;
  lang: string;
  question?: string;
  question_explained?: string;
  correct_answer?: string;
  answer_1?: string;
  answer_2?: string;
  answer_3?: string;
  answer_4?: string;
  subject?: number;
  categories?: number[];
  hasImg?: number;
  img?: string;
  audio?: string;
  ai_tutor?: string;
};

/** The three language rows for a single question id. */
export type QuestionTranslations = {
  ka?: QuestionRow;
  ru?: QuestionRow;
  en?: QuestionRow;
};
