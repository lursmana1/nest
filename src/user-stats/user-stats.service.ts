import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserAnswer } from '../exam-attempts/entities/user-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { DEFAULT_LANG } from '../common/constants/lang.constants.js';
import { MIN_SUBJECT_ATTEMPTS_FOR_STATS } from '../common/constants/exam.constants.js';

const TOP_COUNT = 10;

export interface WeakQuestionItem {
  questionId: number;
  wrongCount: number;
  question: unknown;
}

export interface WeakSubjectItem {
  subjectId: number;
  wrongCount: number;
  correctCount: number;
  totalQuestions: number;
}

export interface WeakQuestionsResponse {
  data: WeakQuestionItem[];
  total: number;
}

export interface WeakSubjectsResponse {
  data: WeakSubjectItem[];
  total: number;
}

@Injectable()
export class UserStatsService {
  constructor(
    @InjectRepository(UserAnswer)
    private readonly answerRepo: Repository<UserAnswer>,
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
  ) {}

  async getWeakQuestions(
    userId: number,
    lang: string = DEFAULT_LANG,
  ): Promise<WeakQuestionsResponse> {
    const baseQb = this.answerRepo
      .createQueryBuilder('a')
      .innerJoin('a.attempt', 't')
      .where('t.userId = :userId', { userId })
      .andWhere('a.correct = :correct', { correct: false })
      .select('a.questionId', 'questionId')
      .addSelect('COUNT(*)', 'wrongCount')
      .groupBy('a.questionId')
      .orderBy('COUNT(*)', 'DESC');

    const [rows, countResult] = await Promise.all([
      baseQb
        .clone()
        .limit(TOP_COUNT)
        .getRawMany<{ questionId: string; wrongCount: string }>(),
      this.answerRepo
        .createQueryBuilder('a')
        .innerJoin('a.attempt', 't')
        .where('t.userId = :userId', { userId })
        .andWhere('a.correct = :correct', { correct: false })
        .select('COUNT(DISTINCT a.questionId)', 'cnt')
        .getRawOne<{ cnt: string }>(),
    ]);

    const total = Number(countResult?.cnt ?? 0);
    const questionIds = rows.map((r) => Number(r.questionId));
    const questions =
      questionIds.length > 0
        ? await this.questionRepo
            .createQueryBuilder('q')
            .where('q.lang = :lang', { lang })
            .andWhere('q.id IN (:...questionIds)', { questionIds })
            .getMany()
        : [];
    const questionMap = new Map(questions.map((q) => [q.id, q]));

    return {
      data: rows.map((r) => ({
        questionId: Number(r.questionId),
        wrongCount: Number(r.wrongCount),
        question: questionMap.get(Number(r.questionId)) ?? null,
      })),
      total,
    };
  }

  async getWeakSubjects(
    userId: number,
    lang: string = DEFAULT_LANG,
  ): Promise<WeakSubjectsResponse> {
    type SubjectCounts = { wrongCount: number; correctCount: number };
    type EligibleSubject = {
      subjectId: number;
      counts: SubjectCounts;
      attempted: number;
      correctnessRate: number;
    };

    const rawRows = await this.answerRepo.manager.query<
      { subjectId: number; correct: boolean }[]
    >(
      `
      SELECT a.subject AS "subjectId", a.correct
      FROM user_answers a
      INNER JOIN exam_attempts t ON a."attemptId" = t.id
      INNER JOIN (
        SELECT a2."questionId", MAX(a2.id) AS "latestId"
        FROM user_answers a2
        INNER JOIN exam_attempts t2 ON a2."attemptId" = t2.id
        WHERE t2."userId" = $1
        GROUP BY a2."questionId"
      ) latest ON a."questionId" = latest."questionId" AND a.id = latest."latestId"
      WHERE t."userId" = $2
      `,
      [userId, userId],
    );

    const bySubject = new Map<number, SubjectCounts>();
    for (const r of rawRows) {
      const sub = Number(r.subjectId);
      const curr = bySubject.get(sub) ?? {
        wrongCount: 0,
        correctCount: 0,
      };
      if (r.correct) {
        curr.correctCount += 1;
      } else {
        curr.wrongCount += 1;
      }
      bySubject.set(sub, curr);
    }

    const eligible: EligibleSubject[] = [];
    for (const [subjectId, counts] of bySubject.entries()) {
      const attempted = counts.correctCount + counts.wrongCount;
      if (
        attempted < MIN_SUBJECT_ATTEMPTS_FOR_STATS ||
        counts.wrongCount === 0
      ) {
        continue;
      }
      eligible.push({
        subjectId,
        counts,
        attempted,
        correctnessRate: counts.correctCount / attempted,
      });
    }

    eligible.sort((a, b) => {
      if (a.correctnessRate !== b.correctnessRate) {
        return a.correctnessRate - b.correctnessRate;
      }
      return b.attempted - a.attempted;
    });

    const total = eligible.length;
    const topRows = eligible.slice(0, TOP_COUNT);
    const subjectIds = topRows.map((x) => x.subjectId);
    if (subjectIds.length === 0) {
      return { data: [], total };
    }

    const totalBySubject = await this.questionRepo
      .createQueryBuilder('q')
      .select('q.subject', 'subject')
      .addSelect('COUNT(*)', 'count')
      .where('q.lang = :lang', { lang })
      .andWhere('q.subject IN (:...subjectIds)', { subjectIds })
      .groupBy('q.subject')
      .getRawMany<{ subject: string; count: string }>();

    const totalMap = new Map(
      totalBySubject.map((x) => [Number(x.subject), Number(x.count)]),
    );

    return {
      data: topRows.map(({ subjectId, counts }) => ({
        subjectId,
        wrongCount: counts.wrongCount,
        correctCount: counts.correctCount,
        totalQuestions: totalMap.get(subjectId) ?? 0,
      })),
      total,
    };
  }
}
