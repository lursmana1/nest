import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ExamAttempt } from './exam-attempt.entity';

@Entity('user_answers')
@Index('idx_user_answers_attempt', ['attemptId'])
@Index('idx_user_answers_attempt_subject', ['attemptId', 'subject'])
@Index('idx_user_answers_question', ['questionId'])
export class UserAnswer {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  attemptId: number;

  @Column()
  questionId: number;

  @Column({ type: 'int', nullable: true })
  subject: number | null;

  @Column()
  correct: boolean;

  @Column({ type: 'varchar', length: 500 })
  chosenAnswer: string;

  @CreateDateColumn()
  createdAt: Date;

  @ManyToOne(() => ExamAttempt, (a) => a.answers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'attemptId' })
  attempt: ExamAttempt;
}
