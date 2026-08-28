import type { Question } from '../questions/entities/question.entity';

/**
 * Fields that give away the answer. Withheld while an attempt is in progress,
 * then returned once it is finished so the review screen can explain mistakes.
 */
type AnswerKeyField = 'correct_answer' | 'question_explained' | 'ai_tutor';

export type ExamQuestion = Omit<Question, AnswerKeyField>;

/**
 * Columns selected for a live exam. Typed as `keyof ExamQuestion`, so an
 * answer-key column cannot be added here without failing the build.
 */
export const EXAM_QUESTION_COLUMNS: (keyof ExamQuestion)[] = [
  'id',
  'lang',
  'question',
  'hasImg',
  'answer_1',
  'answer_2',
  'answer_3',
  'answer_4',
  'subject',
  'categories',
  'audio',
  'img',
];
