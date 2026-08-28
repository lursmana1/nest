import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  ParseIntPipe,
  UseGuards,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CreatePeriodDto } from './dto/create-period.dto.js';
import { resolvePageParams } from '../common/utils/pagination.util.js';

const DEFAULT_LEADERBOARD_PAGE_SIZE = 10;
const MAX_LEADERBOARD_PAGE_SIZE = 100;

@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  @Get()
  async getLeaderboard(
    @Req() req: { user?: { userId: number } },
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('size', new ParseIntPipe({ optional: true })) size?: number,
  ) {
    const current = await this.leaderboardService.getCurrentPeriod();
    if (!current) {
      throw new BadRequestException(
        'No active leaderboard. Leaderboard is only available between its startDate and endDate.',
      );
    }

    const { page: pageNum, size: pageSize } = resolvePageParams(
      { page, size, limit },
      {
        defaultSize: DEFAULT_LEADERBOARD_PAGE_SIZE,
        maxSize: MAX_LEADERBOARD_PAGE_SIZE,
      },
    );
    return this.leaderboardService.getLeaderboard(
      req.user?.userId ?? null,
      current.id,
      pageNum,
      pageSize,
    );
  }

  @Post('periods')
  @UseGuards(JwtAuthGuard, AdminGuard)
  createPeriod(@Body() dto: CreatePeriodDto) {
    return this.leaderboardService.createPeriod({
      startDate: new Date(dto.startDate),
      endDate: new Date(dto.endDate),
      name: dto.name,
    });
  }
}
