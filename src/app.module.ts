import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { BlogsModule } from './blogs/blogs.module';
import { CategoriesModule } from './categories/categories.module';
import { ExamAttemptsModule } from './exam-attempts/exam-attempts.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { QuestionsModule } from './questions/questions.module';
import { UploadsModule } from './uploads/uploads.module';
import { UsersModule } from './users/users.module';
import { UserStatsModule } from './user-stats/user-stats.module';
import { QuestionSyncModule } from './question-sync/question-sync.module';
import { PracticeAnswersModule } from './practice-answers/practice-answers.module';
import { buildTypeOrmOptions } from './config/typeorm.config';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Baseline ceiling for every route; auth routes tighten this with @Throttle.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => buildTypeOrmOptions(config),
      inject: [ConfigService],
    }),
    AuthModule,
    BlogsModule,
    CategoriesModule,
    ExamAttemptsModule,
    PracticeAnswersModule,
    LeaderboardModule,
    QuestionsModule,
    UploadsModule,
    UsersModule,
    UserStatsModule,
    QuestionSyncModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
