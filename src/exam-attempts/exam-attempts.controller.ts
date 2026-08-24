import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Headers,
  ParseIntPipe,
  UseGuards,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { ExamAttemptsService } from './exam-attempts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { parseLang } from '../common/utils/parse-lang.util.js';
import {
  parseIdList,
  parseCount,
  parseNumericId,
} from '../common/utils/parse-ids.util.js';
import {
  MAX_STATS_LIMIT,
  MAX_HISTORY_PAGE_SIZE,
  DEFAULT_HISTORY_PAGE_SIZE,
} from '../common/constants/exam.constants.js';
import {
  GEORGIAN_EXAM_RULES_BY_CATEGORY,
  resolveGeorgianExamRule,
  formatExamRuleResponse,
} from '../common/utils/georgian-exam-rules.util.js';

@Controller('exam-attempts')
export class ExamAttemptsController {
  constructor(private readonly attemptsService: ExamAttemptsService) {}

  /** Public — used by subject picker before login. */
  @Get('rules')
  getExamRules(@Query('category') category?: string) {
    if (category == null || category.trim() === '') {
      return Object.entries(GEORGIAN_EXAM_RULES_BY_CATEGORY).map(([id, rule]) =>
        formatExamRuleResponse(Number(id), rule),
      );
    }

    const categoryId = parseInt(category, 10);
    if (!Number.isFinite(categoryId)) {
      throw new BadRequestException('category must be a number');
    }

    const rule = resolveGeorgianExamRule({ categories: [categoryId] });
    return formatExamRuleResponse(rule.categoryId ?? categoryId, rule);
  }

  @Post('start')
  @UseGuards(JwtAuthGuard)
  start(
    @Req() req: { user: { userId: number } },
    @Query('lang') langQuery?: string,
    @Headers('accept-language') langHeader?: string,
    @Query('subjects') subjects?: string,
    @Query('categories') categories?: string,
    @Query('count') count?: string,
    @Query('allSubjects') allSubjects?: string,
  ) {
    return this.attemptsService.startAttempt(req.user.userId, {
      lang: parseLang(langQuery, langHeader),
      subjects: parseIdList(subjects),
      categories: parseIdList(categories),
      count: parseCount(count),
      allSubjects: allSubjects === 'true',
    });
  }

  @Post(':attemptId/finish')
  @UseGuards(JwtAuthGuard)
  finish(
    @Req() req: { user: { userId: number } },
    @Param('attemptId', ParseIntPipe) attemptId: number,
  ) {
    return this.attemptsService.finishAttempt(req.user.userId, attemptId);
  }

  @Post(':attemptId/answer')
  @UseGuards(JwtAuthGuard)
  submitAnswer(
    @Req() req: { user: { userId: number } },
    @Param('attemptId', ParseIntPipe) attemptId: number,
    @Body('questionId') questionId: unknown,
    @Body('chosenAnswer') chosenAnswer: string,
  ) {
    const qId = parseNumericId(questionId);
    if (qId === null) {
      throw new BadRequestException('questionId must be a number');
    }
    return this.attemptsService.submitAnswer(
      req.user.userId,
      attemptId,
      qId,
      chosenAnswer ?? '',
    );
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard)
  getRawAnswers(
    @Req() req: { user: { userId: number } },
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    const safeLimit =
      limit != null
        ? Math.min(Math.max(1, limit), MAX_STATS_LIMIT)
        : MAX_STATS_LIMIT;
    return this.attemptsService.getRawAnswers(req.user.userId, safeLimit);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  getHistory(
    @Req() req: { user: { userId: number } },
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('size', new ParseIntPipe({ optional: true })) size?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    const pageSize = size ?? limit ?? DEFAULT_HISTORY_PAGE_SIZE;
    return this.attemptsService.getHistory(
      req.user.userId,
      Math.max(1, page ?? 1),
      Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, pageSize)),
    );
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  getAttempt(
    @Req() req: { user: { userId: number } },
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.attemptsService.getAttempt(req.user.userId, id);
  }
}
