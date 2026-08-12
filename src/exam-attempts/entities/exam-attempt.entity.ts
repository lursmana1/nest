import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { UserAnswer } from './user-answer.entity';

@Entity('exam_attempts')
@Index('idx_exam_attempts_user_completed', ['userId', 'completedAt'])
export class ExamAttempt {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @Column({ type: 'jsonb' })
  questionIds: number[];

  @Column({ default: 'ka' })
  lang: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  endDate: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'boolean', nullable: true })
  passed: boolean | null;

  @Column({ type: 'int', nullable: true })
  durationSeconds: number | null;

  /** Pass threshold frozen at attempt start (Georgian exam rules). */
  @Column({ type: 'int', nullable: true })
  minCorrectToPass: number | null;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  categories: number[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  subjects: number[];

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @OneToMany(() => UserAnswer, (a) => a.attempt)
  answers: UserAnswer[];
}
