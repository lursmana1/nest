import {
  Body,
  Controller,
  Post,
  Query,
  Req,
  UseGuards,
  Headers,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { parseLang } from '../common/utils/parse-lang.util.js';
import { PracticeAnswersService } from './practice-answers.service';
import type { RecordPracticeResult } from './practice-answers.service';
import { RecordPracticeAnswerDto } from './dto/record-practice-answer.dto';

type AuthRequest = { user: { userId: number } };

@Controller('practice-answers')
@UseGuards(JwtAuthGuard)
export class PracticeAnswersController {
  constructor(private readonly practiceAnswers: PracticeAnswersService) {}

  /**
   * Record ticket/trainer answer (or seen-only) for coverage.
   * Prefer `{ questionId, chosenAnswer }` when the user picks an option.
   */
  @Post()
  record(
    @Req() req: AuthRequest,
    @Body() body: RecordPracticeAnswerDto,
    @Query('lang') langQuery?: string,
    @Headers('accept-language') langHeader?: string,
  ): Promise<RecordPracticeResult> {
    return this.practiceAnswers.record(req.user.userId, {
      questionId: body.questionId,
      lang: parseLang(langQuery, langHeader),
      chosenAnswer: body.chosenAnswer,
    });
  }
}
