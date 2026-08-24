import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { BlogsModule } from './blogs/blogs.module';
import { CategoriesModule } from './categories/categories.module';
import { ExamsModule } from './exams/exams.module';
import { ExamAttemptsModule } from './exam-attempts/exam-attempts.module';
import { LeaderboardModule } from './leaderboard/leaderboard.module';
import { QuestionsModule } from './questions/questions.module';
import { UploadsModule } from './uploads/uploads.module';
import { UsersModule } from './users/users.module';
import { UserStatsModule } from './user-stats/user-stats.module';
import { QuestionSyncModule } from './question-sync/question-sync.module';
import { PracticeAnswersModule } from './practice-answers/practice-answers.module';
import { buildTypeOrmOptions } from './config/typeorm.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => buildTypeOrmOptions(config),
      inject: [ConfigService],
    }),
    AuthModule,
    BlogsModule,
    CategoriesModule,
    ExamsModule,
    ExamAttemptsModule,
    PracticeAnswersModule,
    LeaderboardModule,
    QuestionsModule,
    UploadsModule,
    UsersModule,
    UserStatsModule,
    QuestionSyncModule,
  ],
})
export class AppModule {}
