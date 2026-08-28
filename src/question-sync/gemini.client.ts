import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { GeminiResponse } from './question-sync.types.js';

const MAX_RETRIES = 5;
const DEFAULT_RETRY_DELAY_MS = 15_000;
const MIN_RETRY_DELAY_MS = 1000;

/** Internal API id (not display name). Override with GEMINI_MODEL in .env if needed */
const MODEL = 'gemini-3.1-flash-lite-preview';

/** Thrown on HTTP 404 so runSync can stop immediately — the ID is not written to DB. */
export class ModelIdMismatchError extends Error {
  constructor(message = 'Model ID mismatch') {
    super(message);
    this.name = 'ModelIdMismatchError';
  }
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 503;
}

function statusOf(err: unknown): number {
  return (err as { status?: number })?.status ?? 0;
}

/** Gemini reports its own backoff, either structured or inside the message. */
export function getRetryDelayMs(err: unknown): number {
  const details = (err as { errorDetails?: Array<{ retryDelay?: string }> })
    ?.errorDetails;

  for (const detail of details ?? []) {
    const raw = detail?.retryDelay;
    if (typeof raw === 'string') {
      const seconds = parseFloat(raw.replace(/s$/, '').trim());
      if (Number.isFinite(seconds)) {
        return Math.max(MIN_RETRY_DELAY_MS, Math.ceil(seconds * 1000));
      }
    }
  }

  const match = ((err as Error)?.message ?? '').match(
    /retry in (\d+(?:\.\d+)?)\s*s/i,
  );
  if (match) {
    const seconds = parseFloat(match[1]);
    if (Number.isFinite(seconds)) {
      return Math.max(MIN_RETRY_DELAY_MS, Math.ceil(seconds * 1000));
    }
  }

  return DEFAULT_RETRY_DELAY_MS;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Gemini transport: one JSON generation call, with rate-limit retries. */
@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);
  private readonly genAI: GoogleGenerativeAI | null;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    this.genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
  }

  /** Retries 429/503 on Gemini's own schedule; other failures propagate. */
  async generateWithRetry(
    prompt: string,
    label: string,
  ): Promise<GeminiResponse> {
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.generate(prompt);
      } catch (err) {
        if (err instanceof ModelIdMismatchError) throw err;

        lastErr = err;
        const status = statusOf(err);
        if (attempt >= MAX_RETRIES || !isRetryable(status)) throw err;

        const waitMs = getRetryDelayMs(err);
        this.logger.warn(
          `${label} ${status === 429 ? 'rate limited' : '503'}, retry in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(waitMs);
      }
    }

    throw lastErr;
  }

  private async generate(prompt: string): Promise<GeminiResponse> {
    if (!this.genAI) {
      throw new Error('GEMINI_API_KEY is not set');
    }

    const model = this.genAI.getGenerativeModel({
      model: this.config.get<string>('GEMINI_MODEL') || MODEL,
      generationConfig: { responseMimeType: 'application/json' },
    });

    try {
      const text = (await model.generateContent(prompt)).response.text();
      if (!text) {
        throw new Error('Empty response from Gemini');
      }
      return JSON.parse(text.trim()) as GeminiResponse;
    } catch (err) {
      if (statusOf(err) === 404) {
        this.logger.error(
          'Model ID mismatch: wrong internal model name for generateContent. Check GEMINI_MODEL in .env (e.g. gemini-3.1-flash-lite-preview) or ListModels in Google AI Studio.',
        );
        throw new ModelIdMismatchError();
      }
      throw err;
    }
  }
}
