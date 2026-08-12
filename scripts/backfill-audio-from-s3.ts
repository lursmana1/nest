/**
 * Link questions.audio to existing S3 objects (no TTS).
 *
 * Layout (bucket prava-ge-assets, eu-north-1):
 *   audio/en/tutor_{id}.mp3
 *   audio/ru/tutor_{id}.mp3
 *   audio/ka/tutor_{id}.wav  (prefer) or .mp3
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-audio-from-s3.ts
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-audio-from-s3.ts --lang=ka
 *   npx ts-node -r tsconfig-paths/register scripts/backfill-audio-from-s3.ts --lang=en,ru
 */
import 'dotenv/config';
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { initPg } from './lib/pg-data-source';

type Lang = 'ka' | 'en' | 'ru';

const MIN_S3_BYTES = Number(process.env.AUDIO_MIN_S3_BYTES ?? 1000);

function getPublicUrl(bucket: string, region: string, key: string): string {
  const base =
    process.env.AWS_PUBLIC_BASE_URL ||
    `https://${bucket}.s3.${region}.amazonaws.com`;
  return `${base.replace(/\/$/, '')}/${key}`;
}

function parseLangs(): Lang[] {
  const arg = process.argv.find((a) => a.startsWith('--lang='));
  const raw = (arg?.slice(7) || process.env.AUDIO_BACKFILL_LANGS || 'en,ru,ka')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowed: Lang[] = ['en', 'ru', 'ka'];
  const langs = raw.filter((l): l is Lang => allowed.includes(l as Lang));
  return langs.length ? langs : allowed;
}

/** Prefer wav for Georgian, mp3 for en/ru. */
function extensionsFor(lang: Lang): Array<'wav' | 'mp3'> {
  return lang === 'ka' ? ['wav', 'mp3'] : ['mp3'];
}

async function listExistingTutorKeys(
  s3: S3Client,
  bucket: string,
  lang: Lang,
): Promise<Map<number, string>> {
  const prefix = `audio/${lang}/`;
  const byId = new Map<number, string>();
  const prefer = extensionsFor(lang);
  let token: string | undefined;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of page.Contents ?? []) {
      const key = obj.Key;
      const size = obj.Size ?? 0;
      if (!key || size < MIN_S3_BYTES) continue;
      const m = key.match(/tutor_(\d+)\.(wav|mp3)$/i);
      if (!m) continue;
      const id = Number(m[1]);
      const ext = m[2].toLowerCase() as 'wav' | 'mp3';
      const prev = byId.get(id);
      if (!prev) {
        byId.set(id, key);
        continue;
      }
      const prevExt = prev.split('.').pop()!.toLowerCase();
      const prevRank = prefer.indexOf(prevExt as 'wav' | 'mp3');
      const nextRank = prefer.indexOf(ext);
      if (nextRank >= 0 && (prevRank < 0 || nextRank < prevRank)) {
        byId.set(id, key);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  return byId;
}

async function main() {
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_S3_BUCKET || 'prava-ge-assets';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env',
    );
  }

  const langs = parseLangs();
  const s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  const ds = await initPg();

  console.log(
    `Backfill audio from s3://${bucket}/audio/{lang}/ | region=${region}`,
  );
  console.log(`Public base: ${process.env.AWS_PUBLIC_BASE_URL || '(derived)'}`);
  console.log(`Langs: ${langs.join(', ')}`);

  const summary: Record<string, { onS3: number; updated: number; already: number }> =
    {};

  for (const lang of langs) {
    const onS3 = await listExistingTutorKeys(s3, bucket, lang);
    console.log(`[${lang}] ${onS3.size} tutor_* files on S3`);

    let updated = 0;
    let already = 0;

    for (const [id, key] of onS3) {
      const url = getPublicUrl(bucket, region, key);
      const rows = (await ds.query(
        `SELECT audio FROM questions WHERE id = $1 AND lang = $2`,
        [id, lang],
      )) as { audio: string | null }[];

      if (!rows.length) continue;
      const current = (rows[0].audio ?? '').trim();
      if (current === url) {
        already++;
        continue;
      }

      await ds.query(
        `UPDATE questions SET audio = $1 WHERE id = $2 AND lang = $3`,
        [url, id, lang],
      );
      updated++;
    }

    summary[lang] = { onS3: onS3.size, updated, already };
    console.log(
      `[${lang}] updated=${updated} alreadyOk=${already} missingInDbSkipped=${Math.max(0, onS3.size - updated - already)}`,
    );
  }

  console.table(summary);
  await ds.destroy();
  console.log('Done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
