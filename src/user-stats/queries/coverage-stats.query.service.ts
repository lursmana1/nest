import { Injectable } from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Question } from '../../questions/entities/question.entity';
import {
  Category,
  CategorySubjectRow,
} from '../../categories/entities/category.entity';
import { QUESTION_MASTERY_CORRECT_RATIO } from '../../common/constants/exam.constants.js';
import { categoryFilterJson } from '../../common/utils/attempt-category-filter.util.js';
import {
  combinedGradedAnswersCte,
  perQuestionRateCte,
} from '../../common/sql/combined-answers.sql.js';
import { SqlParams } from '../../common/sql/sql-params.js';
import { round3 } from '../../common/utils/round3.util.js';
import type {
  QuestionPoolExposure,
  SubjectAggregateRow,
} from '../user-stats.types.js';

/** Topic catalog and how much of the question pool the user has covered. */
@Injectable()
export class CoverageStatsQueryService {
  constructor(
    @InjectEntityManager()
    private readonly manager: EntityManager,
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
  ) {}

  /** Per-topic mastered / not-mastered counts across exam + practice answers. */
  async loadSubjectAggregatesForCategory(
    userId: number,
    categoryId: number,
  ): Promise<SubjectAggregateRow[]> {
    const sp = new SqlParams();
    const userPh = sp.add(userId);
    const filterPh = sp.add(categoryFilterJson(categoryId));
    const catPh = sp.add(categoryId);
    const masteryPh = sp.add(QUESTION_MASTERY_CORRECT_RATIO);

    const rows = await this.manager.query<
      {
        subjectId: string;
        correctCount: string;
        wrongCount: string;
        distinctQuestions: string;
      }[]
    >(
      `
      WITH ${combinedGradedAnswersCte('combined', {
        userIdPlaceholder: userPh,
        categoryFilterPlaceholder: filterPh,
        categoryIdPlaceholder: catPh,
        includeSubject: true,
      })},
      ${perQuestionRateCte('combined', 'per_q', true)},
      classified AS (
        SELECT
          per_q.subject,
          CASE
            WHEN per_q."correctRate" >= ${masteryPh} THEN true
            ELSE false
          END AS "isCorrect"
        FROM per_q
      )
      SELECT
        classified.subject AS "subjectId",
        SUM(CASE WHEN classified."isCorrect" = true THEN 1 ELSE 0 END)::int AS "correctCount",
        SUM(CASE WHEN classified."isCorrect" = false THEN 1 ELSE 0 END)::int AS "wrongCount",
        COUNT(*)::int AS "distinctQuestions"
      FROM classified
      GROUP BY classified.subject
      `,
      sp.all(),
    );

    return rows.map((row) => ({
      subjectId: Number(row.subjectId),
      correctCount: Number(row.correctCount),
      wrongCount: Number(row.wrongCount),
      distinctQuestions: Number(row.distinctQuestions),
    }));
  }

  /** Distinct questions seen (graded or not) vs the category pool size. */
  async loadQuestionPoolExposure(
    userId: number,
    categoryId: number,
    lang: string,
  ): Promise<QuestionPoolExposure> {
    const sp = new SqlParams();
    const userPh = sp.add(userId);
    const filterPh = sp.add(categoryFilterJson(categoryId));
    const catPh = sp.add(categoryId);

    const [answeredRow, categoryCountRow] = await Promise.all([
      this.manager.query<{ count: string }[]>(
        `
        WITH ${combinedGradedAnswersCte('combined', {
          userIdPlaceholder: userPh,
          categoryFilterPlaceholder: filterPh,
          categoryIdPlaceholder: catPh,
          gradedPracticeOnly: false,
        })}
        SELECT COUNT(DISTINCT "questionId")::int AS count
        FROM combined
        `,
        sp.all(),
      ),
      this.questionRepo
        .createQueryBuilder('q')
        .select('COUNT(*)', 'count')
        .where('q.lang = :lang', { lang })
        .andWhere(':categoryId = ANY(q.categories)', { categoryId })
        .getRawOne<{ count: string }>(),
    ]);

    const totalQuestionsInCategory = Number(categoryCountRow?.count ?? 0);
    const distinctQuestionsAnswered = Number(answeredRow[0]?.count ?? 0);
    const exposureRate =
      totalQuestionsInCategory > 0
        ? round3(distinctQuestionsAnswered / totalQuestionsInCategory)
        : 0;

    return {
      distinctQuestionsAnswered,
      totalQuestionsInCategory,
      exposureRate,
    };
  }

  /** Category subject catalog, with counts recomputed from the live question pool. */
  async loadCategorySubjectCatalog(
    categoryId: number,
    lang: string,
  ): Promise<CategorySubjectRow[]> {
    const [category, liveRows] = await Promise.all([
      this.categoryRepo.findOne({
        where: { id: categoryId },
        select: ['id', 'subjects'],
      }),
      this.questionRepo
        .createQueryBuilder('q')
        .select('q.subject', 'subject')
        .addSelect('COUNT(*)', 'count')
        .where('q.lang = :lang', { lang })
        .andWhere(':categoryId = ANY(q.categories)', { categoryId })
        .andWhere('q.subject IS NOT NULL')
        .groupBy('q.subject')
        .orderBy('q.subject', 'ASC')
        .getRawMany<{ subject: string; count: string }>(),
    ]);

    const liveCounts = new Map(
      liveRows.map((r) => [Number(r.subject), Number(r.count)]),
    );

    if (category?.subjects?.length) {
      return [...category.subjects]
        .map((s) => ({
          ...s,
          questionsCount: liveCounts.get(s.id) ?? 0,
        }))
        .filter((s) => s.questionsCount > 0)
        .sort((a, b) => a.id - b.id);
    }

    return liveRows.map((r) => ({
      id: Number(r.subject),
      name: `Subject ${r.subject}`,
      questionsCount: Number(r.count),
    }));
  }
}
