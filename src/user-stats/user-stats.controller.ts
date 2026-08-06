import {
  Controller,
  Get,
  Headers,
  Query,
  ParseIntPipe,
  UseGuards,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { UserStatsService } from './user-stats.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { parseLang } from '../common/utils/parse-lang.util.js';
import { isValidCategoryId } from '../common/constants/category.constants.js';

@Controller('user-stats')
@UseGuards(JwtAuthGuard)
export class UserStatsController {
  constructor(private readonly userStatsService: UserStatsService) {}

  /** All dashboard stats for one license category in one call. */
  @Get('overview')
  getOverview(
    @Req() req: { user: { userId: number } },
    @Query('category', ParseIntPipe) category: number,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    this.assertCategory(category);
    const lang = parseLang(undefined, acceptLanguage);
    return this.userStatsService.getOverview(req.user.userId, category, lang);
  }

  @Get('readiness')
  getReadiness(
    @Req() req: { user: { userId: number } },
    @Query('category', ParseIntPipe) category: number,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    this.assertCategory(category);
    const lang = parseLang(undefined, acceptLanguage);
    return this.userStatsService.getReadiness(
      req.user.userId,
      category,
      lang,
    );
  }

  /** Per-topic progress for subject picker (all subjects, including untouched). */
  @Get('subject-progress')
  getSubjectProgress(
    @Req() req: { user: { userId: number } },
    @Query('category', ParseIntPipe) category: number,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    this.assertCategory(category);
    const lang = parseLang(undefined, acceptLanguage);
    return this.userStatsService.getSubjectProgress(
      req.user.userId,
      category,
      lang,
    );
  }

  @Get('weak-questions')
  getWeakQuestions(
    @Req() req: { user: { userId: number } },
    @Query('category') category?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const lang = parseLang(undefined, acceptLanguage);
    const categoryId = this.parseOptionalCategory(category);
    return this.userStatsService.getWeakQuestions(
      req.user.userId,
      lang,
      categoryId,
    );
  }

  @Get('weak-subjects')
  getWeakSubjects(
    @Req() req: { user: { userId: number } },
    @Query('category') category?: string,
    @Headers('accept-language') acceptLanguage?: string,
  ) {
    const lang = parseLang(undefined, acceptLanguage);
    const categoryId = this.parseOptionalCategory(category);
    return this.userStatsService.getWeakSubjects(
      req.user.userId,
      lang,
      categoryId,
    );
  }

  private assertCategory(category: number): void {
    if (!isValidCategoryId(category)) {
      throw new BadRequestException('category must be between 0 and 9');
    }
  }

  private parseOptionalCategory(category?: string): number | undefined {
    if (category == null || category.trim() === '') {
      return undefined;
    }
    const id = parseInt(category, 10);
    if (!Number.isFinite(id) || !isValidCategoryId(id)) {
      throw new BadRequestException('category must be between 0 and 9');
    }
    return id;
  }
}
