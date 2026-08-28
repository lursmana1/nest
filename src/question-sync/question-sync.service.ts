import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Question } from '../questions/entities/question.entity';
import { GeminiClient, ModelIdMismatchError, sleep } from './gemini.client.js';
import { QuestionUpsertWriter } from './question-upsert.writer.js';
import { buildSyncPrompt, isFullySynced } from './sync-prompt.builder.js';
import type {
  QuestionRow,
  QuestionTranslations,
  SyncOptions,
} from './question-sync.types.js';

/** 5s between IDs ≈ 12 RPM — under the 15 RPM free-tier limit. */
const DELAY_MS = 5000;
const DEFAULT_LIMIT = 5;

export type SyncSummary = { processed: number; errors: number };

/**
 * Per-ID outcome. `skipped` counts as processed (nothing left to do), while
 * `missing` counts as neither. `stop` aborts the run to preserve quota.
 */
type IdOutcome = 'processed' | 'skipped' | 'missing' | 'failed' | 'stop';

@Injectable()
export class QuestionSyncService {
  private readonly logger = new Logger(QuestionSyncService.name);

  constructor(
    @InjectRepository(Question)
    private readonly questionRepo: Repository<Question>,
    private readonly gemini: GeminiClient,
    private readonly writer: QuestionUpsertWriter,
  ) {}

  async runSync(options: SyncOptions = {}): Promise<SyncSummary> {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const offset = options.offset ?? 0;

    const ids = await this.loadQuestionIds();
    const slice = ids.slice(offset, offset + limit);
    const displayTotal = Math.min(offset + limit, ids.length);

    let processed = 0;
    let errors = 0;

    for (const [index, id] of slice.entries()) {
      const label = `[${offset + index + 1}/${displayTotal}]`;
      const outcome = await this.syncId(id, label);

      if (outcome === 'stop') return { processed, errors: errors + 1 };
      if (outcome === 'processed' || outcome === 'skipped') processed++;
      if (outcome === 'failed') errors++;

      if (index < slice.length - 1) {
        await sleep(DELAY_MS);
      }
    }

    return { processed, errors };
  }

  /** A failure here leaves the row untouched, so the next run retries it. */
  private async syncId(id: number, label: string): Promise<IdOutcome> {
    try {
      const translations = await this.loadTranslations(id);
      const ka = translations.ka;

      if (!ka) {
        this.logger.warn(`${label} Skipping ID ${id}: missing ka row`);
        return 'missing';
      }

      if (isFullySynced(translations)) {
        this.logger.log(
          `${label} Skipping ID ${id} (ai_tutor already set for ka, ru, en)`,
        );
        return 'skipped';
      }

      const prompt = buildSyncPrompt(
        ka,
        [translations.ru, translations.en].filter(
          (row): row is QuestionRow => row != null,
        ),
      );
      const result = await this.gemini.generateWithRetry(
        prompt,
        `${label} ID ${id}`,
      );

      await this.writer.writeTranslations(id, ka, result);
      this.logger.log(`${label} Processed ID ${id}`);
      return 'processed';
    } catch (err) {
      if (err instanceof ModelIdMismatchError) {
        this.logger.error(
          `${label} Sync stopped: Model ID mismatch. Fix GEMINI_MODEL and restart — ID ${id} was not saved and will retry next run.`,
        );
        return 'stop';
      }
      this.logger.error(
        `${label} Error on ID ${id}`,
        err instanceof Error ? err.stack : String(err),
      );
      return 'failed';
    }
  }

  private async loadQuestionIds(): Promise<number[]> {
    const rows = await this.questionRepo
      .createQueryBuilder('q')
      .select('DISTINCT q.id', 'id')
      .orderBy('q.id', 'ASC')
      .getRawMany<{ id: string }>();
    return rows.map((row) => Number(row.id));
  }

  private async loadTranslations(id: number): Promise<QuestionTranslations> {
    const rows = await this.questionRepo.find({ where: { id } });
    return Object.fromEntries(
      rows.map((row) => [row.lang, row]),
    ) as QuestionTranslations;
  }
}
