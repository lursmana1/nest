import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PracticeAnswer } from './entities/practice-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { DEFAULT_LANG } from '../common/constants/lang.constants.js';

export type RecordPracticeInput = {
  questionId: number;
  lang?: string;
  /** If omitted / empty → seen-only (coverage credit, no grade). */
  chosenAnswer?: string | null;
};

export type RecordPracticeResult = {
  questionId: number;
  lang: string;
  subject: number | null;
  correct: boolean | null;
  seenOnly: boolean;
};

@Injectable()
export class PracticeAnswersService {
  constructor(
    @InjectRepository(PracticeAnswer)
    private readonly practiceRepo: Repository<PracticeAnswer>,
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
  ) {}

  /**
   * Upsert practice row for coverage (+ optional correct/wrong).
   * Prefer calling only when the user answers (chosenAnswer set).
   */
  async record(
    userId: number,
    input: RecordPracticeInput,
  ): Promise<RecordPracticeResult> {
    const lang = (input.lang ?? DEFAULT_LANG).trim() || DEFAULT_LANG;
    const question = await this.questionRepo.findOne({
      where: { id: input.questionId, lang },
    });
    if (!question) {
      throw new NotFoundException(
        `Question ${input.questionId} (${lang}) not found in live bank`,
      );
    }

    const rawChoice = input.chosenAnswer?.trim() ?? '';
    const seenOnly = rawChoice.length === 0;
    const correct = seenOnly ? null : question.correct_answer === rawChoice;

    const existing = await this.practiceRepo.findOne({
      where: { userId, questionId: input.questionId, lang },
    });

    if (existing) {
      if (!seenOnly) {
        existing.correct = correct;
        existing.chosenAnswer = rawChoice;
      }
      existing.subject = question.subject;
      await this.practiceRepo.save(existing);
      return {
        questionId: existing.questionId,
        lang: existing.lang,
        subject: existing.subject,
        correct: existing.correct,
        seenOnly: existing.correct == null,
      };
    }

    const saved = await this.practiceRepo.save(
      this.practiceRepo.create({
        userId,
        questionId: input.questionId,
        lang,
        subject: question.subject,
        correct,
        chosenAnswer: seenOnly ? null : rawChoice,
      }),
    );

    return {
      questionId: saved.questionId,
      lang: saved.lang,
      subject: saved.subject,
      correct: saved.correct,
      seenOnly,
    };
  }
}
