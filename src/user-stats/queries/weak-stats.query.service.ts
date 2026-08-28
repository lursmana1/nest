import { Injectable } from '@nestjs/common';
import { InjectEntityManager, InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Question } from '../../questions/entities/question.entity';
import {
  MIN_SUBJECT_ATTEMPTS_FOR_STATS,
  QUESTION_MASTERY_CORRECT_RATIO,
} from '../../common/constants/exam.constants.js';
import { categoryFilterJson } from '../../common/utils/attempt-category-filter.util.js';
import {
  combinedGradedAnswersCte,
  perQuestionRateCte,
} from '../../common/sql/combined-answers.sql.js';
import { SqlParams } from '../../common/sql/sql-params.js';
import type {
  WeakQuestionCountRow,
  WeakQuestionPreview,
  WeakSubjectAggregateRow,
} from '../user-stats.types.js';

/** How many rows the weak-questions / weak-subjects lists return. */
const TOP_COUNT = 5;

/** Reads behind `GET /user-stats/weak-questions` and `weak-subjects`. */
@Injectable()
export class WeakStatsQueryService {
  constructor(
    @InjectEntityManager()
    private readonly manager: EntityManager,
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
  ) {}

  /** Questions whose correct-rate is below mastery, worst first. */
  async loadWeakQuestionCounts(
    userId: number,
    categoryId?: number,
  ): Promise<{ rows: WeakQuestionCountRow[]; total: number }> {
    const sp = new SqlParams();
    const userPh = sp.add(userId);
    const limitPh = sp.add(TOP_COUNT);
    let filterPh: string | undefined;
    let catPh: string | undefined;
    if (categoryId != null) {
      filterPh = sp.add(categoryFilterJson(categoryId));
      catPh = sp.add(categoryId);
    }
    const masteryPh = sp.add(QUESTION_MASTERY_CORRECT_RATIO);

    const rows = await this.manager.query<
      {
        questionId: string;
        wrongCount: string;
        totalAttempts: string;
        total: string;
      }[]
    >(
      `
      WITH ${combinedGradedAnswersCte('combined', {
        userIdPlaceholder: userPh,
        categoryFilterPlaceholder: filterPh,
        categoryIdPlaceholder: catPh,
      })},
      ${perQuestionRateCte('combined', 'per_q', false)},
      agg AS (
        SELECT
          per_q."questionId",
          per_q."wrongCount",
          per_q."totalAttempts"
        FROM per_q
        WHERE per_q."correctRate" < ${masteryPh}
      ),
      ranked AS (
        SELECT
          agg.*,
          COUNT(*) OVER()::int AS total,
          ROW_NUMBER() OVER (ORDER BY agg."wrongCount" DESC, agg."totalAttempts" DESC) AS rn
        FROM agg
      )
      SELECT "questionId", "wrongCount", "totalAttempts", total
      FROM ranked
      WHERE rn <= ${limitPh}
      ORDER BY rn
      `,
      sp.all(),
    );

    return {
      total: Number(rows[0]?.total ?? 0),
      rows: rows.map((row) => ({
        questionId: Number(row.questionId),
        wrongCount: Number(row.wrongCount),
        totalAttempts: Number(row.totalAttempts),
      })),
    };
  }

  /** List-row fields for weak-question previews (no answers / explanations). */
  async loadQuestionPreviews(
    questionIds: number[],
    lang: string,
  ): Promise<Map<number, WeakQuestionPreview>> {
    if (questionIds.length === 0) return new Map();

    const questions = await this.questionRepo
      .createQueryBuilder('q')
      .select(['q.id', 'q.question', 'q.hasImg', 'q.img', 'q.subject'])
      .where('q.lang = :lang', { lang })
      .andWhere('q.id IN (:...questionIds)', { questionIds })
      .getMany();

    return new Map(
      questions.map((q) => [
        q.id,
        {
          question: q.question,
          hasImg: q.hasImg,
          img: q.img ?? null,
          subject: q.subject,
        },
      ]),
    );
  }

  /** Aggregate all answers by topic — not latest-per-question (that mirrors weak-questions). */
  async loadWeakSubjectTop(
    userId: number,
    categoryId: number | null,
  ): Promise<{ rows: WeakSubjectAggregateRow[]; total: number }> {
    const sp = new SqlParams();
    const userPh = sp.add(userId);
    const minAttemptsPh = sp.add(MIN_SUBJECT_ATTEMPTS_FOR_STATS);
    const limitPh = sp.add(TOP_COUNT);
    let filterPh: string | undefined;
    let catPh: string | undefined;
    if (categoryId != null) {
      filterPh = sp.add(categoryFilterJson(categoryId));
      catPh = sp.add(categoryId);
    }
    const masteryPh = sp.add(QUESTION_MASTERY_CORRECT_RATIO);

    const rows = await this.manager.query<
      {
        subjectId: string;
        wrongCount: string;
        correctCount: string;
        attempted: string;
        correctnessRate: string;
        total: string;
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
      ),
      agg AS (
        SELECT
          classified.subject AS "subjectId",
          SUM(CASE WHEN classified."isCorrect" = false THEN 1 ELSE 0 END)::int AS "wrongCount",
          SUM(CASE WHEN classified."isCorrect" = true THEN 1 ELSE 0 END)::int AS "correctCount",
          COUNT(*)::int AS attempted,
          (SUM(CASE WHEN classified."isCorrect" = true THEN 1 ELSE 0 END)::float
            / COUNT(*)) AS "correctnessRate"
        FROM classified
        GROUP BY classified.subject
        HAVING COUNT(*) >= ${minAttemptsPh}
          AND SUM(CASE WHEN classified."isCorrect" = false THEN 1 ELSE 0 END) > 0
      ),
      ranked AS (
        SELECT
          agg.*,
          COUNT(*) OVER()::int AS total,
          ROW_NUMBER() OVER (
            ORDER BY agg."correctnessRate" ASC, agg.attempted DESC
          ) AS rn
        FROM agg
      )
      SELECT "subjectId", "wrongCount", "correctCount", attempted, "correctnessRate", total
      FROM ranked
      WHERE rn <= ${limitPh}
      ORDER BY rn
      `,
      sp.all(),
    );

    return {
      total: Number(rows[0]?.total ?? 0),
      rows: rows.map((row) => ({
        subjectId: Number(row.subjectId),
        wrongCount: Number(row.wrongCount),
        correctCount: Number(row.correctCount),
        attempted: Number(row.attempted),
        correctnessRate: Number(row.correctnessRate),
      })),
    };
  }

  /** Live question counts per topic, used when a category has no subject catalog. */
  async loadQuestionTotalsBySubject(
    subjectIds: number[],
    lang: string,
    categoryId?: number,
  ): Promise<Map<number, number>> {
    if (subjectIds.length === 0) return new Map();

    const totalQb = this.questionRepo
      .createQueryBuilder('q')
      .select('q.subject', 'subject')
      .addSelect('COUNT(*)', 'count')
      .where('q.lang = :lang', { lang })
      .andWhere('q.subject IN (:...subjectIds)', { subjectIds })
      .groupBy('q.subject');

    if (categoryId != null) {
      totalQb.andWhere(':categoryId = ANY(q.categories)', { categoryId });
    }

    const totalBySubject = await totalQb.getRawMany<{
      subject: string;
      count: string;
    }>();

    return new Map(
      totalBySubject.map((x) => [Number(x.subject), Number(x.count)]),
    );
  }
}
