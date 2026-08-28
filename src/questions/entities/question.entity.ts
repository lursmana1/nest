import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One row per (id, lang). Same logical question id appears up to 3 times (ka, ru, en).
 */
@Entity('questions')
@Index(['lang', 'id'])
@Index(['lang', 'subject'])
export class Question {
  @PrimaryColumn({ type: 'int' })
  id: number;

  @PrimaryColumn({ type: 'varchar', length: 5 })
  lang: string;

  @Column({ type: 'text' })
  question: string;

  @Column({ type: 'text', nullable: true })
  question_explained: string;

  @Column({ type: 'smallint', default: 0 })
  hasImg: number;

  @Column({ type: 'varchar', length: 10, nullable: true })
  correct_answer: string;

  @Column({ type: 'text', nullable: true })
  answer_1: string;

  @Column({ type: 'text', nullable: true })
  answer_2: string;

  @Column({ type: 'text', nullable: true })
  answer_3: string;

  @Column({ type: 'text', nullable: true })
  answer_4: string;

  @Column({ type: 'int', nullable: true })
  subject: number | null;

  /** PostgreSQL integer[] — GIN index added in migration script for category filters. */
  @Column({
    type: 'int',
    array: true,
    default: () => "'{}'",
  })
  categories: number[];

  @Column({ type: 'varchar', length: 512, nullable: true })
  audio: string;

  @Column({ type: 'text', nullable: true })
  ai_tutor: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  img: string;
}
