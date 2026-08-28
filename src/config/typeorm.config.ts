import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Blog } from '../blogs/entities/blog.entity';
import { Category } from '../categories/entities/category.entity';
import { ExamAttempt } from '../exam-attempts/entities/exam-attempt.entity';
import { UserAnswer } from '../exam-attempts/entities/user-answer.entity';
import { PracticeAnswer } from '../practice-answers/entities/practice-answer.entity';
import { LeaderboardPeriod } from '../leaderboard/entities/leaderboard-period.entity';
import { Question } from '../questions/entities/question.entity';
import { User } from '../users/entities/user.entity';

export const TYPEORM_ENTITIES = [
  User,
  Blog,
  ExamAttempt,
  UserAnswer,
  PracticeAnswer,
  LeaderboardPeriod,
  Question,
  Category,
];

function pgConnection(config: ConfigService) {
  const url = config.get<string>('DATABASE_URL');
  if (url) {
    const needsSsl =
      config.get('DATABASE_SSL') === 'true' ||
      url.includes('sslmode=require') ||
      url.includes('neon.tech');
    return {
      type: 'postgres' as const,
      url,
      ssl: needsSsl ? { rejectUnauthorized: false } : false,
    };
  }

  return {
    type: 'postgres' as const,
    host: config.get<string>('PG_HOST') || 'localhost',
    port: Number(config.get<string>('PG_PORT')) || 5432,
    username: config.get<string>('PG_USERNAME') || 'postgres',
    password: config.get<string>('PG_PASSWORD') || '',
    database: config.get<string>('PG_DATABASE') || 'driving_theory_back',
  };
}

export function buildTypeOrmOptions(
  config: ConfigService,
): TypeOrmModuleOptions {
  return {
    ...pgConnection(config),
    entities: TYPEORM_ENTITIES,
    // Never let schema sync run against production, whatever the env says.
    synchronize:
      config.get('NODE_ENV') !== 'production' &&
      config.get('DB_SYNCHRONIZE') === 'true',
  };
}
