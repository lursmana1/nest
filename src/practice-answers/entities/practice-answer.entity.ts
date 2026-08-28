import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * Ticket / trainer practice outside timed exams.
 * Unique per (user, question, lang) — upsert on re-answer.
 * `correct` null = seen only (still counts toward coverage).
 */
@Entity('practice_answers')
@Unique('uq_practice_answers_user_question_lang', [
  'userId',
  'questionId',
  'lang',
])
@Index('idx_practice_answers_user', ['userId'])
@Index('idx_practice_answers_user_subject', ['userId', 'subject'])
@Index('idx_practice_answers_question', ['questionId'])
export class PracticeAnswer {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'int' })
  userId: number;

  @Column({ type: 'int' })
  questionId: number;

  @Column({ type: 'varchar', length: 5, default: 'ka' })
  lang: string;

  @Column({ type: 'int', nullable: true })
  subject: number | null;

  /** null = seen without grading; boolean = answered. */
  @Column({ type: 'boolean', nullable: true })
  correct: boolean | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  chosenAnswer: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;
}
