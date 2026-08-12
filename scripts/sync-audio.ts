import 'reflect-metadata';
import 'dotenv/config';
import path from 'path';
import textToSpeech from '@google-cloud/text-to-speech';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { initPg } from './lib/pg-data-source';

type Lang = 'ka' | 'en' | 'ru';
const ENABLED_AUDIO_LANGS: Lang[] = ['en', 'ru'];

type QuestionRow = {
  id: number;
  lang: Lang;
  ai_tutor: string | null;
  audio: string | null;
};

const CHAR_LIMIT = Number(process.env.AUDIO_CHAR_LIMIT ?? 400000);
const DELAY_MS = Number(process.env.AUDIO_DELAY_MS ?? 2000);
const BATCH_LIMIT = Number(process.env.AUDIO_BATCH_LIMIT ?? 5000);
/** Regenerate if S3 object is missing or too small (corrupt / empty upload) */
const MIN_S3_BYTES = Number(process.env.AUDIO_MIN_S3_BYTES ?? 1000);

const VOICE_MAPPING: Record<Lang, { name?: string; langCode: string }> = {
  ka: { langCode: 'ka-GE' },
  en: { name: 'en-US-Chirp3-HD-Aoede', langCode: 'en-US' },
  ru: { name: 'ru-RU-Chirp3-HD-Aoede', langCode: 'ru-RU' },
};

const KA_VOICE_CANDIDATES = [
  'ka-GE-Chirp3-HD-Aoede',
  'ka-GE-Neural2-A',
  'ka-GE-Wavenet-A',
  'ka-GE-Standard-A',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableTtsError(err: unknown): boolean {
  const code = (err as { code?: number | string })?.code;
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  return (
    code === 13 ||
    code === 14 ||
    code === 8 ||
    code === 4 ||
    msg.includes('internal') ||
    msg.includes('unavailable') ||
    msg.includes('deadline') ||
    msg.includes('resource exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('429')
  );
}

async function synthesizeWithRetry(
  tts: InstanceType<typeof textToSpeech.TextToSpeechClient>,
  text: string,
  lang: Lang,
  maxAttempts = 5,
): Promise<{ audioContent?: Uint8Array | string | null }> {
  const voiceConfig = VOICE_MAPPING[lang];
  const voiceAttempts =
    lang === 'ka'
      ? [...KA_VOICE_CANDIDATES, undefined]
      : [voiceConfig.name, undefined];

  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    for (const candidate of voiceAttempts) {
      try {
        if (attempt === 1) {
          console.log(
            `🎙️ Requesting: ${candidate || '(auto)'} for [${lang}]`,
          );
        } else {
          console.log(
            `🎙️ Retry ${attempt}/${maxAttempts}: ${candidate || '(auto)'} for [${lang}]`,
          );
        }
        const [res] = await tts.synthesizeSpeech({
          input: { text },
          voice: {
            ...(candidate ? { name: candidate } : {}),
            languageCode: voiceConfig.langCode,
          },
          audioConfig: { audioEncoding: 'MP3' },
        });
        return res;
      } catch (err) {
        lastErr = err;
        const msg = (err as Error)?.message?.toLowerCase() ?? '';
        if (msg.includes('does not exist') || msg.includes('invalid_argument')) {
          continue; // try next voice candidate
        }
        if (isRetryableTtsError(err) && attempt < maxAttempts) {
          const backoff = Math.min(30_000, 2000 * 2 ** (attempt - 1));
          console.warn(
            `TTS transient error (attempt ${attempt}/${maxAttempts}) → sleep ${backoff / 1000}s`,
          );
          await sleep(backoff);
          break; // next outer attempt
        }
        throw err;
      }
    }
  }

  throw lastErr;
}

function getPublicUrl(bucket: string, region: string, key: string): string {
  const base =
    process.env.AWS_PUBLIC_BASE_URL ||
    `https://${bucket}.s3.${region}.amazonaws.com`;
  return `${base.replace(/\/$/, '')}/${key}`;
}

function isNotFoundError(err: unknown): boolean {
  const code = (err as { name?: string; Code?: string })?.name;
  const code2 = (err as { Code?: string })?.Code;
  const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
  return (
    code === 'NotFound' ||
    code === 'NoSuchKey' ||
    code2 === 'NotFound' ||
    code2 === 'NoSuchKey' ||
    status === 404
  );
}

async function main() {
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_S3_BUCKET || 'prava-ge-assets';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!region) throw new Error('AWS_REGION is required');
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required');
  }

  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(process.cwd(), process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : path.resolve(process.cwd(), 'google-cloud-key.json');

  const ds = await initPg();
  const s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  const tts = new textToSpeech.TextToSpeechClient({
    keyFilename: keyFile,
    apiEndpoint: 'texttospeech.googleapis.com',
  });

  let totalChars = 0;
  let processed = 0;
  let generated = 0;
  let reused = 0;

  const rows = (await ds.query(
    `SELECT id, lang, ai_tutor, audio
     FROM questions
     WHERE lang = ANY($1::varchar[])
       AND ai_tutor IS NOT NULL
       AND TRIM(ai_tutor) <> ''
       AND (audio IS NULL OR TRIM(audio) = '')
     ORDER BY id ASC, lang ASC
     LIMIT $2`,
    [ENABLED_AUDIO_LANGS, BATCH_LIMIT],
  )) as QuestionRow[];

  console.log(
    `Starting audio sync. charLimit=${CHAR_LIMIT}, delayMs=${DELAY_MS}, batchLimit=${BATCH_LIMIT}, candidates=${rows.length}`,
  );

  for (const doc of rows) {
    const text = (doc.ai_tutor || '').trim();
    if (!text) continue;

    const key = `audio/${doc.lang}/tutor_${doc.id}.mp3`;
    const url = getPublicUrl(bucket, region, key);

    try {
      const head = await s3.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      if ((head.ContentLength ?? 0) >= MIN_S3_BYTES) {
        await ds.query(
          `UPDATE questions SET audio = $1 WHERE id = $2 AND lang = $3`,
          [url, doc.id, doc.lang],
        );
        processed++;
        reused++;
        console.log(
          `[${processed}] Reused existing ${doc.lang} audio for ID ${doc.id} -> ${key}`,
        );
        continue;
      }
      console.warn(
        `[${doc.id}/${doc.lang}] S3 object too small (${head.ContentLength ?? 0} < ${MIN_S3_BYTES} bytes), regenerating`,
      );
    } catch (err) {
      if (!isNotFoundError(err)) {
        throw err;
      }
    }

    const chars = text.length;
    if (totalChars + chars > CHAR_LIMIT) {
      console.warn(
        `Stopping before ID ${doc.id}/${doc.lang}: char budget would exceed ${CHAR_LIMIT}. current=${totalChars}, next=${chars}`,
      );
      break;
    }

    let res;
    try {
      res = await synthesizeWithRetry(tts, text, doc.lang);
    } catch (err) {
      console.error(
        `[${doc.id}/${doc.lang}] TTS failed after retries — skip:`,
        (err as Error)?.message ?? err,
      );
      await sleep(DELAY_MS);
      continue;
    }
    if (!res) {
      console.error(`[${doc.id}/${doc.lang}] empty TTS response — skip`);
      continue;
    }

    if (!res.audioContent) {
      throw new Error(`TTS returned empty audio for ID ${doc.id}/${doc.lang}`);
    }

    const body = Buffer.isBuffer(res.audioContent)
      ? res.audioContent
      : Buffer.from(res.audioContent as Uint8Array);

    if (body.length < MIN_S3_BYTES) {
      throw new Error(
        `TTS buffer too small (${body.length} bytes) for ID ${doc.id}/${doc.lang}`,
      );
    }

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'audio/mpeg',
      }),
    );

    await ds.query(
      `UPDATE questions SET audio = $1 WHERE id = $2 AND lang = $3`,
      [url, doc.id, doc.lang],
    );

    totalChars += chars;
    processed++;
    generated++;

    console.log(
      `[${processed}] Generated ${doc.lang} audio for ID ${doc.id} | chars=${chars} | totalChars=${totalChars}/${CHAR_LIMIT}`,
    );

    await sleep(DELAY_MS);
  }

  await ds.destroy();

  console.log(
    `Done. processed=${processed}, generated=${generated}, reused=${reused}, totalChars=${totalChars}/${CHAR_LIMIT}`,
  );
}

main().catch((err) => {
  console.error('Audio sync failed:', err);
  process.exit(1);
});

