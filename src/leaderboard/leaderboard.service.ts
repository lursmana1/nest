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

    const baseQb = this.answerRepo
      .createQueryBuilder('a')
      .innerJoin('a.attempt', 't')
      .innerJoin('t.user', 'u')
      .where('a.correct = :correct', { correct: true })
      .andWhere('t.completedAt IS NOT NULL')
      .andWhere('a.createdAt >= :startDate', { startDate })
      .andWhere('a.createdAt < :endDate', { endDate })
      .select(['u.id', 'u.name', 'u.surname'])
      .addSelect('COUNT(*)', 'score')
      .groupBy('u.id')
      .addGroupBy('u.name')
      .addGroupBy('u.surname')
      .orderBy('COUNT(*)', 'DESC');

    const allRows = await baseQb.getRawMany<{
      u_id: number;
      u_name: string;
      u_surname: string | null;
      score: string;
    }>();

    const totalCount = allRows.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limit));
    const safePage = Math.max(1, Math.min(page, totalPages));
    const offset = (safePage - 1) * limit;
    const paginatedRows = allRows.slice(offset, offset + limit);

    const data: LeaderboardEntry[] = paginatedRows.map((r, i) => ({
      userId: r.u_id,
      place: offset + i + 1,
      name: r.u_name,
      surname: r.u_surname,
      score: Number(r.score),
    }));

    const currentUserRow =
      userId != null ? allRows.find((r) => r.u_id === userId) : undefined;
    const user =
      userId != null
        ? await this.userRepo.findOne({ where: { id: userId } })
        : null;
    const placeIndex =
      userId != null ? allRows.findIndex((r) => r.u_id === userId) : -1;

    const currentUser = {
      userId: userId ?? 0,
      place: placeIndex >= 0 ? placeIndex + 1 : null,
      name: user?.name ?? '',
      surname: user?.surname ?? null,
      score: currentUserRow ? Number(currentUserRow.score) : 0,
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
