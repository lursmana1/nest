import type {
  QuestionRow,
  QuestionTranslations,
} from './question-sync.types.js';

const PLACEHOLDER_EXPLANATION_PREFIX = 'განმარტება მალე დაემატება';
const PLACEHOLDER_EXPLANATION_KEYWORD = 'იხილე კანონი საგზაო მოძრაობის შესახებ';

/**
 * Treats the stock "explanation coming soon" copy as absent, so those rows get
 * regenerated. Covers trailing-ellipsis variants of the same phrase.
 */
export function isPlaceholderExplanation(text?: string): boolean {
  if (!text) return true;
  const normalized = text.trim().toLowerCase();
  return (
    normalized.includes(PLACEHOLDER_EXPLANATION_PREFIX.toLowerCase()) ||
    normalized.includes(PLACEHOLDER_EXPLANATION_KEYWORD.toLowerCase())
  );
}

export function hasAiTutor(row?: QuestionRow): boolean {
  const tutor = row?.ai_tutor;
  return typeof tutor === 'string' && tutor.trim().length > 0;
}

/** Every language already has both a tutor blurb and a real explanation. */
export function isFullySynced({ ka, ru, en }: QuestionTranslations): boolean {
  const rows = [ka, ru, en];
  return rows.every(
    (row) =>
      row &&
      hasAiTutor(row) &&
      !isPlaceholderExplanation(row.question_explained),
  );
}

export function buildSyncPrompt(
  ka: QuestionRow,
  fallback: QuestionRow[],
): string {
  const correctAnswer =
    ka.correct_answer ||
    fallback.find((row) => row?.correct_answer)?.correct_answer ||
    '';
  const sourceLaw =
    (ka.question_explained || '').trim() ||
    'No reliable legal explanation provided. Reconstruct a legally accurate explanation from the question and answer choices.';

  return `You are a Georgian driving instructor. I will provide a Georgian driving exam question and its official legal explanation.

Translate the Georgian question and answers into Russian and English.

Generate a formal legal explanation in Georgian, Russian, and English for the question_explained column.

Generate a friendly, simplified "AI Tutor" explanation in Georgian, Russian, and English for the ai_tutor column.

Always refer to the Georgian "Law on Road Traffic" where relevant.

Focus on WHY the correct answer (index: ${correctAnswer}) is right.

Source Question (KA): ${ka.question || ''}

Source Answers (KA):
1) ${ka.answer_1 || ''}
2) ${ka.answer_2 || ''}
3) ${ka.answer_3 || ''}
4) ${ka.answer_4 || ''}

Source Law (KA): ${sourceLaw}

Correct Answer Index: ${correctAnswer}

Return valid JSON only, no markdown:
{ "ru_question": "...", "en_question": "...", "ru_answer_1": "...", "ru_answer_2": "...", "ru_answer_3": "...", "ru_answer_4": "...", "en_answer_1": "...", "en_answer_2": "...", "en_answer_3": "...", "en_answer_4": "...", "ka_explained": "...", "ru_explained": "...", "en_explained": "...", "ka_tutor": "...", "ru_tutor": "...", "en_tutor": "..." }`;
}
