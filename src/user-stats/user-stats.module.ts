import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStatsController } from './user-stats.controller';
import { UserStatsService } from './user-stats.service';
import { WeakStatsQueryService } from './queries/weak-stats.query.service';
import { AttemptStatsQueryService } from './queries/attempt-stats.query.service';
import { CoverageStatsQueryService } from './queries/coverage-stats.query.service';
import { UserAnswer } from '../exam-attempts/entities/user-answer.entity';
import { ExamAttempt } from '../exam-attempts/entities/exam-attempt.entity';
import { Question } from '../questions/entities/question.entity';
import { Category } from '../categories/entities/category.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserAnswer, ExamAttempt, Question, Category]),
    AuthModule,
  ],
  controllers: [UserStatsController],
  providers: [
    UserStatsService,
    WeakStatsQueryService,
    AttemptStatsQueryService,
    CoverageStatsQueryService,
  ],
})
export class UserStatsModule {}
