import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Question } from '../questions/entities/question.entity';
import { QuestionSyncController } from './question-sync.controller';
import { QuestionSyncService } from './question-sync.service';
import { GeminiClient } from './gemini.client';
import { QuestionUpsertWriter } from './question-upsert.writer';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([Question]), AuthModule],
  controllers: [QuestionSyncController],
  providers: [QuestionSyncService, GeminiClient, QuestionUpsertWriter],
  exports: [QuestionSyncService],
})
export class QuestionSyncModule {}
