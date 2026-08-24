import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PracticeAnswer } from './entities/practice-answer.entity';
import { Question } from '../questions/entities/question.entity';
import { PracticeAnswersController } from './practice-answers.controller';
import { PracticeAnswersService } from './practice-answers.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([PracticeAnswer, Question]), AuthModule],
  controllers: [PracticeAnswersController],
  providers: [PracticeAnswersService],
  exports: [PracticeAnswersService, TypeOrmModule],
})
export class PracticeAnswersModule {}
