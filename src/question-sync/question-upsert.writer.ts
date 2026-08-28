import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Question } from '../questions/entities/question.entity';
import { isPlaceholderExplanation } from './sync-prompt.builder.js';
import type { GeminiResponse, QuestionRow } from './question-sync.types.js';

/** Persists one Gemini result across the ka/ru/en rows of a question. */
@Injectable()
export class QuestionUpsertWriter {
  constructor(
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
  ) {}

  async writeTranslations(
    id: number,
    ka: QuestionRow,
    result: GeminiResponse,
  ): Promise<void> {
    await this.updateGeorgian(id, ka, result);
    await this.upsertTranslation(id, ka, 'ru', result);
    await this.upsertTranslation(id, ka, 'en', result);
  }

  /** Keeps a real Georgian legal explanation; only fills placeholders. */
  private async updateGeorgian(
    id: number,
    ka: QuestionRow,
    result: GeminiResponse,
  ): Promise<void> {
    const update: Record<string, string> = { ai_tutor: result.ka_tutor };
    if (isPlaceholderExplanation(ka.question_explained)) {
      update.question_explained = result.ka_explained;
    }
    await this.questionRepo.update({ id, lang: 'ka' }, update);
  }

  private async upsertTranslation(
    id: number,
    ka: QuestionRow,
    lang: 'ru' | 'en',
    result: GeminiResponse,
  ): Promise<void> {
    await this.questionRepo.upsert(
      {
        id,
        lang,
        // Language-neutral fields always mirror the Georgian source row.
        correct_answer: ka.correct_answer || '',
        hasImg: ka.hasImg ?? 0,
        img: ka.img || '',
        subject: ka.subject ?? null,
        categories: ka.categories || [],
        audio: ka.audio || '',
        question: result[`${lang}_question`],
        answer_1: result[`${lang}_answer_1`],
        answer_2: result[`${lang}_answer_2`],
        answer_3: result[`${lang}_answer_3`],
        answer_4: result[`${lang}_answer_4`],
        question_explained: result[`${lang}_explained`],
        ai_tutor: result[`${lang}_tutor`],
      },
      { conflictPaths: ['id', 'lang'] },
    );
  }
}
