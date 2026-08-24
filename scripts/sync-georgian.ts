import 'dotenv/config';
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { initPg } from './lib/pg-data-source';

// ---------------------------------------------------------------------------
// Config (override: GEMINI_TTS_MODEL)
// ---------------------------------------------------------------------------

/** TTS preview — ხშირად აბრუნებს PCM (audio/L16), არა MP3. ცარიელი ფაილები იყო როცა base64/PCM არ იშლებოდა სწორად; ახლა extract + pcm16MonoToWav → სათამაშო WAV. */
const MODEL_NAME = 'gemini-2.5-flash-preview-tts';
const FALLBACK_MODEL_NAME = 'gemini-2.5-pro-preview-tts';
const VOICE_NAME = 'Zephyr';

function envMs(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Pause after each Gemini call (success or give-up). Keep ≥5s or 429s stack up. */
const REQUEST_DELAY_MS = envMs('GEORGIAN_REQUEST_DELAY_MS', 5_000);
/** First 429 wait; then exponential backoff */
const RATE_LIMIT_BASE_MS = envMs('GEORGIAN_429_BASE_MS', 30_000);
const RATE_LIMIT_MAX_MS = envMs('GEORGIAN_429_MAX_MS', 300_000);
/** Stop after this many consecutive 429s on the *current* model (0 = disabled) */
const MAX_429_STREAK = envMs('GEORGIAN_MAX_429_STREAK', 20);
/**
 * Stay on Flash unless you opt in: GEORGIAN_SWITCH_AFTER_429=3
 */
const SWITCH_AFTER_429 = envMs('GEORGIAN_SWITCH_AFTER_429', 0);
const DEFAULT_BUCKET = 'prava-ge-assets';
const MIN_S3_BYTES = 1000;
const MIN_DECODED_AUDIO_BYTES = 800;
const MAX_AUDIO_GENERATION_ATTEMPTS = 4;
const DEBUG = process.env.GEORGIAN_SYNC_DEBUG === '1';

type QuestionKaDoc = {
  id: number;
  lang: 'ka';
  ai_tutor: string | null;
  audio: string | null;
};

type ExtractedTtsAudio = {
  buffer: Buffer;
  contentType: string;
  fileExtension: 'mp3' | 'wav';
};

// ---------------------------------------------------------------------------
// Georgian text for TTS (digits → words)
// ---------------------------------------------------------------------------

function prepareGeorgianText(text: string): string {
  const numMap: Record<string, string> = {
    '1': 'ერთი',
    '2': 'ორი',
    '3': 'სამი',
    '4': 'ოთხი',
    '5': 'ხუთი',
    '6': 'ექვსი',
    '7': 'შვიდი',
    '8': 'რვა',
    '9': 'ცხრა',
    '10': 'ათი',
    '11': 'თერთმეტი',
    '12': 'თორმეტი',
    '13': 'ცამეტი',
    '14': 'თოთხმეტი',
    '15': 'თხუთმეტი',
    '16': 'თექვსმეტი',
    '17': 'ჩვიდმეტი',
    '18': 'თვრამეტი',
    '19': 'ცხრამეტი',
    '20': 'ოცი',
  };
  return text
    .replace(/^\s*გამარჯობა[!.,:;]?\s*/i, '')
    .replace(/\bგამარჯობა[!.,:;]?\s*/gi, '')
    .replace(/\b(\d+)\b/g, (m) => numMap[m] || m)
    .replace(/\//g, ' პროცენტი ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Gemini inline audio → Buffer (MP3 / WAV / PCM→WAV)
// ---------------------------------------------------------------------------

function inlineDataToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (typeof data !== 'string') {
    throw new Error(`inlineData.data: unsupported type ${typeof data}`);
  }
  let b64 = data.trim();
  if (b64.startsWith('data:')) {
    const i = b64.indexOf(',');
    if (i === -1) throw new Error('data URL: missing comma');
    b64 = b64.slice(i + 1);
  }
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  return Buffer.from(b64, 'base64');
}

function isMpegMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return m.includes('mpeg') || m.includes('mp3') || m === 'audio/mp4' || m.includes('mp4a');
}

function looksLikeMp3(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
  return buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
}

function looksLikeWav(buf: Buffer): boolean {
  return buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF';
}

function pcmRateFromMime(mime: string): number | null {
  const m = /rate=(\d+)/i.exec(mime);
  return m ? parseInt(m[1], 10) : null;
}

function isPcmL16Mime(mime: string): boolean {
  const m = mime.toLowerCase();
  return m.includes('l16') || (m.includes('pcm') && m.startsWith('audio/'));
}

/** PCM16 LE mono → RIFF WAV (ბრაუზერი იკითხავს; არ ატვირთო raw PCM როგორც audio/mpeg) */
function pcm16MonoToWav(pcm: Buffer, sampleRate: number): Buffer {
  const nCh = 1;
  const bits = 16;
  const byteRate = sampleRate * nCh * (bits / 8);
  const align = nCh * (bits / 8);
  const n = pcm.length;
  const out = Buffer.alloc(44 + n);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + n, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(nCh, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(byteRate, 28);
  out.writeUInt16LE(align, 32);
  out.writeUInt16LE(bits, 34);
  out.write('data', 36);
  out.writeUInt32LE(n, 40);
  pcm.copy(out, 44);
  return out;
}

function extractAudioFromTtsResponse(result: unknown): ExtractedTtsAudio {
  type Part = { inlineData?: { data?: string; mimeType?: string } };
  const res = result as {
    response?: {
      candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
      promptFeedback?: { blockReason?: string };
    };
  };

  const block = res.response?.promptFeedback?.blockReason;
  if (block) throw new Error(`Prompt blocked: ${block}`);

  const candidates = res.response?.candidates ?? [];
  const errs: string[] = [];

  for (let ci = 0; ci < candidates.length; ci++) {
    const c = candidates[ci];
    const fr = c?.finishReason;
    if (fr && fr !== 'STOP' && fr !== 'MAX_TOKENS') {
      errs.push(`c[${ci}] finish=${fr}`);
    }
    const parts = c?.content?.parts ?? [];
    for (let pi = 0; pi < parts.length; pi++) {
      const id = parts[pi]?.inlineData;
      if (!id?.data) continue;

      const mimeType = (id.mimeType || 'audio/mpeg').trim();
      let buf: Buffer;
      try {
        buf = inlineDataToBuffer(id.data);
      } catch (e) {
        errs.push(`c[${ci}]p[${pi}] ${(e as Error).message}`);
        continue;
      }
      if (buf.length < MIN_DECODED_AUDIO_BYTES) {
        errs.push(`c[${ci}]p[${pi}] small:${buf.length}b`);
        continue;
      }

      const ml = mimeType.toLowerCase();
      if (isMpegMime(mimeType) || looksLikeMp3(buf)) {
        return { buffer: buf, contentType: 'audio/mpeg', fileExtension: 'mp3' };
      }
      if (looksLikeWav(buf) || ml.includes('wav')) {
        return { buffer: buf, contentType: 'audio/wav', fileExtension: 'wav' };
      }
      if (isPcmL16Mime(mimeType)) {
        const hz = pcmRateFromMime(mimeType) ?? 24_000;
        const wav = pcm16MonoToWav(buf, hz);
        console.warn(`PCM ${mimeType} → WAV @ ${hz}Hz (${wav.length}b)`);
        return { buffer: wav, contentType: 'audio/wav', fileExtension: 'wav' };
      }
      errs.push(`c[${ci}]p[${pi}] mime:${mimeType}`);
    }
  }

  throw new Error(`No usable audio. ${errs.join('; ') || 'no inlineData'}`);
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

function getPublicUrl(bucket: string, region: string, key: string): string {
  const base =
    process.env.AWS_PUBLIC_BASE_URL ||
    `https://${bucket}.s3.${region}.amazonaws.com`;
  return `${base.replace(/\/$/, '')}/${key}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'NotFound' ||
    e?.name === 'NoSuchKey' ||
    e?.$metadata?.httpStatusCode === 404
  );
}

function isRateLimitError(err: unknown): boolean {
  const e = err as { status?: number };
  const msg = ((err as Error)?.message ?? '').toLowerCase();
  return e?.status === 429 || msg.includes('429') || msg.includes('rate limit');
}

function parseSyncLimit(): number {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--limit=')) {
      const n = Number.parseInt(a.slice(8), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const raw = (process.env.GEORGIAN_SYNC_LIMIT ?? process.env.SYNC_LIMIT ?? '').trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/** Resume from this question id (inclusive). --from=137 or GEORGIAN_SYNC_FROM */
function parseSyncFromId(): number {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--from=')) {
      const n = Number.parseInt(a.slice(7), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  const raw = (process.env.GEORGIAN_SYNC_FROM ?? '').trim();
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

async function s3ObjectExists(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return (head.ContentLength ?? 0) >= MIN_S3_BYTES;
  } catch (e) {
    if (isNotFoundError(e)) return false;
    throw e;
  }
}

async function findReusableS3AudioUrl(
  s3: S3Client,
  bucket: string,
  region: string,
  baseKey: string,
): Promise<string | null> {
  // Georgian assets are mostly .wav; a few early files are .mp3
  for (const ext of ['wav', 'mp3'] as const) {
    const key = `${baseKey}.${ext}`;
    if (await s3ObjectExists(s3, bucket, key)) {
      return getPublicUrl(bucket, region, key);
    }
  }
  return null;
}

/** Extract object key from our public S3 URL, if it belongs to this bucket. */
function keyFromPublicAudioUrl(
  url: string,
  bucket: string,
  region: string,
): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const bases = [
    (process.env.AWS_PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    `https://${bucket}.s3.${region}.amazonaws.com`,
    `https://${bucket}.s3.amazonaws.com`,
  ].filter(Boolean);
  for (const base of bases) {
    if (trimmed.startsWith(`${base}/`)) {
      return trimmed.slice(base.length + 1);
    }
  }
  const m = trimmed.match(/\.amazonaws\.com\/(.+)$/);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  const region = process.env.AWS_REGION || 'eu-north-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const bucket = process.env.AWS_S3_BUCKET || DEFAULT_BUCKET;

  if (!apiKey || !region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing env: GEMINI_API_KEY, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY',
    );
  }

  const primaryModel =
    process.env.GEMINI_TTS_MODEL?.trim() || MODEL_NAME;
  const fallbackModel =
    process.env.GEMINI_TTS_FALLBACK_MODEL?.trim() || FALLBACK_MODEL_NAME;
  const fallbackEnabled =
    SWITCH_AFTER_429 > 0 &&
    primaryModel !== fallbackModel &&
    process.env.GEORGIAN_DISABLE_PRO_FALLBACK !== '1';

  let modelName = primaryModel;
  const genAI = new GoogleGenerativeAI(apiKey);
  let model = genAI.getGenerativeModel({ model: modelName });
  const ds = await initPg();
  const s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  const limit = parseSyncLimit();
  const fromId = parseSyncFromId();
  const force = process.argv.includes('--force');

  const params: number[] = [];
  const where: string[] = [
    `lang = 'ka'`,
    `ai_tutor IS NOT NULL`,
    `TRIM(ai_tutor) <> ''`,
  ];
  if (fromId > 0) {
    params.push(fromId);
    where.push(`id >= $${params.length}`);
  }

  let limitSql = '';
  if (limit > 0) {
    params.push(limit);
    limitSql = `LIMIT $${params.length}`;
  }

  const rows = (await ds.query(
    `SELECT id, lang, ai_tutor, audio
     FROM questions
     WHERE ${where.join(' AND ')}
     ORDER BY id ASC
     ${limitSql}`,
    params,
  )) as QuestionKaDoc[];

  console.log(
    `Georgian TTS | model=${modelName} | voice=${VOICE_NAME} | bucket=${bucket} region=${region}`,
  );
  if (fallbackEnabled) {
    console.log(
      `Fallback: after ${SWITCH_AFTER_429}×429 on Flash → ${fallbackModel} (Pro ~2× cost, ~50 RPD)`,
    );
  }
  console.log(`Keys: audio/ka/tutor_{id}.wav (prefer) | .mp3 fallback`);
  console.log(
    `Delays: ok→next=${REQUEST_DELAY_MS / 1000}s | 429 base=${RATE_LIMIT_BASE_MS / 1000}s max=${RATE_LIMIT_MAX_MS / 1000}s | streak stop=${MAX_429_STREAK || 'off'}`,
  );
  if (fromId > 0) console.log(`From id >= ${fromId} (--from / GEORGIAN_SYNC_FROM)`);
  if (limit > 0) console.log(`Limit ${limit} doc(s) (--limit / GEORGIAN_SYNC_LIMIT)`);
  if (force) console.log('Mode: --force (regenerate even when S3 file exists)');
  console.log(`Queue size: ${rows.length}`);

  let processed = 0;
  let linked = 0;
  let clearedDead = 0;
  let skippedOk = 0;
  let consecutive429 = 0;

  docLoop: for (const doc of rows) {
    const raw = (doc.ai_tutor ?? '').trim();
    if (!raw) continue;

    let currentAudio = (doc.audio ?? '').trim();
    const text = prepareGeorgianText(raw);
    const baseKey = `audio/ka/tutor_${doc.id}`;

    // Drop dead DB URLs (e.g. id 2 pointed at missing tutor_2.mp3)
    if (currentAudio && !force) {
      const key = keyFromPublicAudioUrl(currentAudio, bucket, region);
      if (key && !(await s3ObjectExists(s3, bucket, key))) {
        console.warn(`[${doc.id}] dead URL → clear (${key})`);
        await ds.query(
          `UPDATE questions SET audio = NULL WHERE id = $1 AND lang = 'ka'`,
          [doc.id],
        );
        currentAudio = '';
        clearedDead++;
      }
    }

    const reuse = force
      ? null
      : await findReusableS3AudioUrl(s3, bucket, region, baseKey);
    if (reuse) {
      if (currentAudio !== reuse) {
        await ds.query(
          `UPDATE questions SET audio = $1 WHERE id = $2 AND lang = 'ka'`,
          [reuse, doc.id],
        );
        linked++;
        console.log(
          `[${doc.id}] linked ${reuse.endsWith('.wav') ? 'wav' : 'mp3'}`,
        );
      } else {
        skippedOk++;
      }
      continue;
    }

    let done = false;
    let attempt = 0;

    while (!done && attempt < MAX_AUDIO_GENERATION_ATTEMPTS) {
      attempt++;
      try {
        if (DEBUG) {
          console.log(
            `[${doc.id}] gen ${attempt}/${MAX_AUDIO_GENERATION_ATTEMPTS} (${modelName})`,
          );
        } else {
          console.log(
            `[${doc.id}] generating… (${attempt}/${MAX_AUDIO_GENERATION_ATTEMPTS}) [${modelName.includes('pro') ? 'pro' : 'flash'}]`,
          );
        }

        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['audio'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: VOICE_NAME },
              },
            },
          },
        } as any);
        consecutive429 = 0;

        const cand = result.response?.candidates?.[0];
        if (DEBUG && cand) {
          console.log(`  candidates=${result.response?.candidates?.length} finish=${cand.finishReason}`);
        }

        if (cand?.finishReason === 'SAFETY' || cand?.finishReason === 'OTHER') {
          console.warn(`[${doc.id}] blocked (${cand.finishReason})`);
          done = true;
          continue docLoop;
        }

        const extracted = extractAudioFromTtsResponse(result);
        const key = `${baseKey}.${extracted.fileExtension}`;
        const url = getPublicUrl(bucket, region, key);

        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: extracted.buffer,
            ContentType: extracted.contentType,
          }),
        );
        await ds.query(
          `UPDATE questions SET audio = $1 WHERE id = $2 AND lang = 'ka'`,
          [url, doc.id],
        );

        console.log(
          `[${doc.id}] ok ${extracted.fileExtension} ${extracted.buffer.length}b → ${key}`,
        );
        processed++;
        done = true;
        await sleep(REQUEST_DELAY_MS);
      } catch (err) {
        if (isRateLimitError(err)) {
          consecutive429++;
          const onPrimary = modelName === primaryModel;
          if (
            fallbackEnabled &&
            onPrimary &&
            consecutive429 >= SWITCH_AFTER_429
          ) {
            console.warn(
              `Flash hit ${consecutive429}×429 (likely daily ~100 RPD) — switching to Pro (${fallbackModel})`,
            );
            modelName = fallbackModel;
            model = genAI.getGenerativeModel({ model: modelName });
            consecutive429 = 0;
            attempt--;
            await sleep(Math.min(RATE_LIMIT_BASE_MS, 30_000));
            continue;
          }
          if (MAX_429_STREAK > 0 && consecutive429 >= MAX_429_STREAK) {
            console.error(
              `Stopping: ${consecutive429} consecutive 429 on ${modelName}. Daily quota exhausted — resume tomorrow (Flash RPD resets).`,
            );
            process.exit(0);
          }
          const exp = Math.min(consecutive429 - 1, 8);
          const backoffMs = Math.min(
            RATE_LIMIT_BASE_MS * 2 ** exp,
            RATE_LIMIT_MAX_MS,
          );
          console.warn(
            `[${doc.id}] 429 (#${consecutive429}${MAX_429_STREAK ? `/${MAX_429_STREAK}` : ''}) [${modelName.includes('pro') ? 'pro' : 'flash'}] → sleep ${Math.round(backoffMs / 1000)}s`,
          );
          await sleep(backoffMs);
          attempt--;
        } else {
          console.error(`[${doc.id}]`, err);
          await sleep(REQUEST_DELAY_MS);
          if (attempt >= MAX_AUDIO_GENERATION_ATTEMPTS) done = true;
        }
      }
    }
  }

  await ds.destroy();
  console.log(
    `Done. skippedOk=${skippedOk} linkedFromS3=${linked} clearedDead=${clearedDead} uploaded/regenerated=${processed}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
