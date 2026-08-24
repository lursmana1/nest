import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExamAttempt } from './entities/exam-attempt.entity';
import { UserAnswer } from './entities/user-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { ExamAttemptsController } from './exam-attempts.controller';
import { ExamAttemptsService } from './exam-attempts.service';
import { AttemptQueryService } from './attempt-query.service';
import { QuestionSelectionService } from './question-selection/question-selection.service';
import { WeaknessService } from './question-selection/weakness.service';
import { QuestionSamplingService } from './question-selection/question-sampling.service';
import { AuthModule } from '../auth/auth.module';
import { PracticeAnswersModule } from '../practice-answers/practice-answers.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ExamAttempt, UserAnswer, Question]),
    AuthModule,
    PracticeAnswersModule,
  ],
  controllers: [ExamAttemptsController],
  providers: [
    ExamAttemptsService,
    AttemptQueryService,
    QuestionSelectionService,
    WeaknessService,
    QuestionSamplingService,
  ],
  exports: [ExamAttemptsService, QuestionSelectionService, WeaknessService],
})
export class ExamAttemptsModule {}
