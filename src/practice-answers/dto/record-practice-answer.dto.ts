import { IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class RecordPracticeAnswerDto {
  @Type(() => Number)
  @IsNumber()
  questionId!: number;

  /** Omit or empty = seen-only. Prefer sending a real choice ("1"–"4"). */
  @IsOptional()
  @IsString()
  chosenAnswer?: string;
}
