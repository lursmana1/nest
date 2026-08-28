import {
  buildSyncPrompt,
  hasAiTutor,
  isFullySynced,
  isPlaceholderExplanation,
} from './sync-prompt.builder';
import type { QuestionRow } from './question-sync.types';

const PLACEHOLDER = 'განმარტება მალე დაემატება';
const LAW_PLACEHOLDER = 'იხილე კანონი საგზაო მოძრაობის შესახებ';

const synced = (lang: string, overrides: Partial<QuestionRow> = {}) =>
  ({
    id: 1,
    lang,
    ai_tutor: 'tutor text',
    question_explained: 'a real legal explanation',
    ...overrides,
  }) as QuestionRow;

describe('isPlaceholderExplanation', () => {
  it.each([undefined, '', PLACEHOLDER, `${PLACEHOLDER}...`, LAW_PLACEHOLDER])(
    'treats %p as missing',
    (text) => {
      expect(isPlaceholderExplanation(text)).toBe(true);
    },
  );

  it('accepts a genuine explanation', () => {
    expect(isPlaceholderExplanation('მძღოლი ვალდებულია გაჩერდეს')).toBe(false);
  });
});

describe('hasAiTutor', () => {
  it('requires non-whitespace content', () => {
    expect(hasAiTutor(synced('ka'))).toBe(true);
    expect(hasAiTutor(synced('ka', { ai_tutor: '   ' }))).toBe(false);
    expect(hasAiTutor(synced('ka', { ai_tutor: undefined }))).toBe(false);
    expect(hasAiTutor(undefined)).toBe(false);
  });
});

describe('isFullySynced', () => {
  it('passes when all three languages have tutor text and a real explanation', () => {
    expect(
      isFullySynced({
        ka: synced('ka'),
        ru: synced('ru'),
        en: synced('en'),
      }),
    ).toBe(true);
  });

  it.each(['ka', 'ru', 'en'] as const)(
    'fails when the %s row is missing entirely',
    (lang) => {
      const rows = {
        ka: synced('ka'),
        ru: synced('ru'),
        en: synced('en'),
      };
      expect(isFullySynced({ ...rows, [lang]: undefined })).toBe(false);
    },
  );

  it('fails when one language still has placeholder copy', () => {
    expect(
      isFullySynced({
        ka: synced('ka'),
        ru: synced('ru', { question_explained: PLACEHOLDER }),
        en: synced('en'),
      }),
    ).toBe(false);
  });

  it('fails when one language has no tutor text', () => {
    expect(
      isFullySynced({
        ka: synced('ka'),
        ru: synced('ru'),
        en: synced('en', { ai_tutor: '' }),
      }),
    ).toBe(false);
  });
});

describe('buildSyncPrompt', () => {
  const ka = synced('ka', {
    question: 'რა უნდა გააკეთოს მძღოლმა?',
    answer_1: 'პასუხი 1',
    answer_2: 'პასუხი 2',
    correct_answer: '2',
  });

  it('includes the question, answers and correct index', () => {
    const prompt = buildSyncPrompt(ka, []);
    expect(prompt).toContain('რა უნდა გააკეთოს მძღოლმა?');
    expect(prompt).toContain('პასუხი 1');
    expect(prompt).toContain('Correct Answer Index: 2');
  });

  it('borrows the correct answer from another language when ka lacks one', () => {
    const prompt = buildSyncPrompt(synced('ka', { correct_answer: '' }), [
      synced('ru', { correct_answer: '3' }),
    ]);
    expect(prompt).toContain('Correct Answer Index: 3');
  });

  it('prefers the Georgian correct answer over the fallbacks', () => {
    const prompt = buildSyncPrompt(ka, [synced('ru', { correct_answer: '4' })]);
    expect(prompt).toContain('Correct Answer Index: 2');
  });

  it('asks the model to reconstruct the law when the source is a placeholder', () => {
    const prompt = buildSyncPrompt(
      synced('ka', { question_explained: PLACEHOLDER }),
      [],
    );
    expect(prompt).toContain(PLACEHOLDER);
  });

  it('falls back to reconstruction text when there is no explanation at all', () => {
    const prompt = buildSyncPrompt(
      synced('ka', { question_explained: '   ' }),
      [],
    );
    expect(prompt).toContain('Reconstruct a legally accurate explanation');
  });
});
