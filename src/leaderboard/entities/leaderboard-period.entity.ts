import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('leaderboard_periods')
export class LeaderboardPeriod {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'timestamptz' })
  startDate: Date;

  @Column({ type: 'timestamptz' })
  endDate: Date;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
