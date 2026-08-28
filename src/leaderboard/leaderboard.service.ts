import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserAnswer } from '../exam-attempts/entities/user-answer.entity';
import { User } from '../users/entities/user.entity';
import { LeaderboardPeriod } from './entities/leaderboard-period.entity';
import type {
  LeaderboardEntry,
  LeaderboardResponse,
} from './types/leaderboard.types.js';

const DEFAULT_PAGE_SIZE = 10;

interface RankedRow {
  userId: number;
  name: string;
  surname: string | null;
  score: number;
  place: number;
}

/**
 * Ranks every user with correct answers in the period. Ties break on user id so
 * LIMIT/OFFSET paging stays stable — without it, pages can repeat or skip rows.
 */
const RANKED_CTE = `
  WITH ranked AS (
    SELECT
      u.id      AS "userId",
      u.name    AS name,
      u.surname AS surname,
      COUNT(*)::int AS score,
      (ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, u.id ASC))::int AS place
    FROM user_answers a
    INNER JOIN exam_attempts t ON t.id = a."attemptId"
    INNER JOIN users u ON u.id = t."userId"
    WHERE a.correct = true
      AND t."completedAt" IS NOT NULL
      AND a."createdAt" >= $1
      AND a."createdAt" < $2
    GROUP BY u.id, u.name, u.surname
  )
`;

function toEntry(row: RankedRow): LeaderboardEntry {
  return {
    userId: row.userId,
    place: row.place,
    name: row.name,
    surname: row.surname,
    score: Number(row.score),
  };
}

@Injectable()
export class LeaderboardService {
  constructor(
    @InjectRepository(UserAnswer)
    private readonly answerRepo: Repository<UserAnswer>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(LeaderboardPeriod)
    private readonly periodRepo: Repository<LeaderboardPeriod>,
  ) {}

  async getLeaderboard(
    userId: number | null,
    periodId: number,
    page = 1,
    limit = DEFAULT_PAGE_SIZE,
  ): Promise<LeaderboardResponse> {
    const period = await this.periodRepo.findOne({ where: { id: periodId } });
    if (!period) {
      throw new NotFoundException('Leaderboard period not found');
    }

    const { startDate, endDate } = period;
    const manager = this.answerRepo.manager;

    const totalCount = await this.countRankedUsers(startDate, endDate);
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const offset = (safePage - 1) * limit;

    const [pageRows, selfRows] = await Promise.all([
      manager.query<RankedRow[]>(
        `${RANKED_CTE} SELECT * FROM ranked ORDER BY place LIMIT $3 OFFSET $4`,
        [startDate, endDate, limit, offset],
      ),
      userId == null
        ? Promise.resolve([])
        : manager.query<RankedRow[]>(
            `${RANKED_CTE} SELECT * FROM ranked WHERE "userId" = $3`,
            [startDate, endDate, userId],
          ),
    ]);

    const data: LeaderboardEntry[] = pageRows.map(toEntry);

    // A user with no correct answers this period is absent from the ranking.
    const self = selfRows[0];
    const fallbackUser =
      userId != null && !self
        ? await this.userRepo.findOne({ where: { id: userId } })
        : null;

    const currentUser = self
      ? toEntry(self)
      : {
          userId: userId ?? 0,
          place: null,
          name: fallbackUser?.name ?? '',
          surname: fallbackUser?.surname ?? null,
          score: 0,
        };

    return {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      data,
      currentUser,
      total: totalCount,
      page: safePage,
      totalPages,
    };
  }

  private async countRankedUsers(
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    const rows = await this.answerRepo.manager.query<[{ total: number }]>(
      `SELECT COUNT(DISTINCT t."userId")::int AS total
       FROM user_answers a
       INNER JOIN exam_attempts t ON t.id = a."attemptId"
       WHERE a.correct = true
         AND t."completedAt" IS NOT NULL
         AND a."createdAt" >= $1
         AND a."createdAt" < $2`,
      [startDate, endDate],
    );
    return rows[0]?.total ?? 0;
  }

  async getCurrentPeriod(): Promise<LeaderboardPeriod | null> {
    const now = new Date();
    return this.periodRepo
      .createQueryBuilder('p')
      .where('p.startDate <= :now', { now })
      .andWhere('p.endDate > :now', { now })
      .orderBy('p.startDate', 'DESC')
      .getOne();
  }

  async createPeriod(dto: {
    startDate: Date;
    endDate: Date;
    name?: string;
  }): Promise<LeaderboardPeriod> {
    if (dto.startDate >= dto.endDate) {
      throw new BadRequestException('startDate must be before endDate');
    }

    const existing = await this.periodRepo.find();
    const overlaps = existing.some(
      (p) => dto.startDate < p.endDate && dto.endDate > p.startDate,
    );
    if (overlaps) {
      throw new ConflictException(
        'Cannot add leaderboard: dates overlap with an existing leaderboard',
      );
    }

    const period = this.periodRepo.create({
      startDate: dto.startDate,
      endDate: dto.endDate,
      name: dto.name ?? null,
    });
    return this.periodRepo.save(period);
  }
}
