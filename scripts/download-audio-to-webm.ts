/**
 * Download tutor audio from S3 into Desktop language folders, then convert to WebM.
 *
 * Layout:
 *   %USERPROFILE%\Desktop\audio\{en,ru,ka}\tutor_{id}.wav|mp3
 *   %USERPROFILE%\Desktop\audio-webm\{en,ru,ka}\tutor_{id}.webm
 *
 * Usage:
 *   npm run audio:local-webm
 *   npx ts-node -r tsconfig-paths/register scripts/download-audio-to-webm.ts --skip-download
 *
 * Needs AWS_* in .env. ffmpeg comes from ffmpeg-static (or FFMPEG_PATH / PATH).
 */
import 'dotenv/config';
import { createWriteStream, existsSync } from 'fs';
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
} from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

type S3AudioObject = {
  key: string;
  size: number;
};

const DEFAULT_BUCKET = 'prava-ge-assets';
const DEFAULT_PREFIX = 'audio/';
const DESKTOP = path.join(os.homedir(), 'Desktop');
const DEFAULT_ORIGINAL_DIR = path.join(DESKTOP, 'audio');
const DEFAULT_WEBM_DIR = path.join(DESKTOP, 'audio-webm');
const LANGS = ['en', 'ru', 'ka'] as const;
const MIN_BYTES = Number(process.env.AUDIO_MIN_S3_BYTES ?? 1000);
const MIN_WEBM_BYTES = 400;

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function resolveFfmpeg(): string {
  if (process.env.FFMPEG_PATH?.trim()) return process.env.FFMPEG_PATH.trim();
  try {
    const require = createRequire(__filename);
    const fromStatic = require('ffmpeg-static') as string | null;
    if (fromStatic) return fromStatic;
  } catch {
    /* optional */
  }
  return 'ffmpeg';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
}

function parseAudioKey(key: string): { lang: string; file: string } | null {
  const m = key.replace(/\\/g, '/').match(/^audio\/(en|ru|ka)\/([^/]+)$/i);
  if (!m) return null;
  return { lang: m[1].toLowerCase(), file: m[2] };
}

function originalPath(originalDir: string, key: string): string | null {
  const parsed = parseAudioKey(key);
  if (!parsed) return null;
  return path.join(originalDir, parsed.lang, parsed.file);
}

function webmPathFromOriginal(
  originalDir: string,
  webmDir: string,
  src: string,
): string {
  const rel = path.relative(originalDir, src);
  const parsed = path.parse(rel);
  return path.join(webmDir, parsed.dir, `${parsed.name}.webm`);
}

async function listAudioObjects(
  s3: S3Client,
  bucket: string,
  prefix: string,
  langFilter: string | undefined,
): Promise<S3AudioObject[]> {
  const objects: S3AudioObject[] = [];
  let token: string | undefined;
  const scopedPrefix = langFilter
    ? `${prefix}${langFilter.replace(/\/$/, '')}/`
    : prefix;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: scopedPrefix,
        ContinuationToken: token,
      }),
    );
    for (const obj of page.Contents ?? []) {
      const key = obj.Key;
      const size = obj.Size ?? 0;
      if (!key || key.endsWith('/')) continue;
      if (size < MIN_BYTES) continue;
      if (!/\.(wav|mp3|webm|ogg|m4a)$/i.test(key)) continue;
      objects.push({ key, size });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  objects.sort((a, b) => a.key.localeCompare(b.key, 'en'));
  return objects;
}

async function downloadObject(
  s3: S3Client,
  bucket: string,
  obj: S3AudioObject,
  dest: string,
): Promise<'downloaded' | 'skipped'> {
  if (existsSync(dest)) {
    const st = await stat(dest);
    if (st.size === obj.size && st.size >= MIN_BYTES) return 'skipped';
  }
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: obj.key }),
  );
  if (!res.Body) throw new Error(`Empty S3 body for ${obj.key}`);
  await pipeline(res.Body as Readable, createWriteStream(tmp));
  const st = await stat(tmp);
  if (st.size < MIN_BYTES) {
    await unlink(tmp).catch(() => undefined);
    throw new Error(`Downloaded ${obj.key} is too small (${st.size} bytes)`);
  }
  await rename(tmp, dest);
  return 'downloaded';
}

function runFfmpeg(
  ffmpeg: string,
  args: string[],
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ ok: false, stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({ ok: code === 0, stderr });
    });
  });
}

async function convertToWebm(
  ffmpeg: string,
  src: string,
  dest: string,
): Promise<'converted' | 'skipped'> {
  if (existsSync(dest)) {
    const st = await stat(dest);
    if (st.size >= MIN_WEBM_BYTES) return 'skipped';
  }
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part.webm`;

  if (src.toLowerCase().endsWith('.webm')) {
    await copyFile(src, dest);
    return 'converted';
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    src,
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    process.env.AUDIO_WEBM_BITRATE || '48k',
    '-vbr',
    'on',
    '-application',
    'voip',
    tmp,
  ];
  const result = await runFfmpeg(ffmpeg, args);
  if (!result.ok) {
    await unlink(tmp).catch(() => undefined);
    throw new Error(
      `ffmpeg failed for ${path.basename(src)}: ${result.stderr.trim() || 'unknown error'}`,
    );
  }
  const st = await stat(tmp);
  if (st.size < MIN_WEBM_BYTES) {
    await unlink(tmp).catch(() => undefined);
    throw new Error(`WebM too small for ${src} (${st.size} bytes)`);
  }
  await rename(tmp, dest);
  return 'converted';
}

async function listLocalOriginals(originalDir: string): Promise<string[]> {
  if (!existsSync(originalDir)) return [];
  const files: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (/\.(wav|mp3|webm|ogg|m4a)$/i.test(e.name)) files.push(full);
    }
  }
  await walk(originalDir);
  return files;
}

async function main() {
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_S3_BUCKET || DEFAULT_BUCKET;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const originalDir = path.resolve(
    argValue('original-dir') || DEFAULT_ORIGINAL_DIR,
  );
  const webmDir = path.resolve(argValue('webm-dir') || DEFAULT_WEBM_DIR);
  const lang = argValue('lang')?.trim().toLowerCase();
  const limitRaw = argValue('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 0;
  const skipDownload = hasFlag('skip-download');
  const downloadConcurrency = Number.parseInt(
    argValue('download-concurrency') || '8',
    10,
  );
  const convertConcurrency = Number.parseInt(
    argValue('convert-concurrency') || '2',
    10,
  );
  const ffmpeg = resolveFfmpeg();

  if (!skipDownload && (!region || !accessKeyId || !secretAccessKey)) {
    throw new Error(
      'Missing AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env',
    );
  }

  console.log(`Originals: ${originalDir}\\{en,ru,ka}`);
  console.log(`WebM:      ${webmDir}\\{en,ru,ka}`);
  console.log(`ffmpeg: ${ffmpeg}`);
  if (!skipDownload) {
    console.log(`s3://${bucket}/${DEFAULT_PREFIX}${lang ? lang + '/' : ''}`);
  }

  const probe = await runFfmpeg(ffmpeg, ['-version']);
  if (!probe.ok) {
    throw new Error(
      'ffmpeg is not available. Install ffmpeg-static (`npm i -D ffmpeg-static`) or set FFMPEG_PATH.',
    );
  }

  for (const l of LANGS) {
    if (lang && lang !== l) continue;
    await mkdir(path.join(originalDir, l), { recursive: true });
    await mkdir(path.join(webmDir, l), { recursive: true });
  }

  let downloaded = 0;
  let downloadSkipped = 0;
  let downloadFailed = 0;
  const localFiles: string[] = [];

  if (!skipDownload) {
    const s3 = new S3Client({
      region: region!,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    });
    let objects = await listAudioObjects(s3, bucket, DEFAULT_PREFIX, lang);
    if (limit > 0) objects = objects.slice(0, limit);
    console.log(`S3 objects: ${objects.length}`);

    await mapPool(objects, downloadConcurrency, async (obj, i) => {
      const dest = originalPath(originalDir, obj.key);
      if (!dest) return;
      try {
        const result = await downloadObject(s3, bucket, obj, dest);
        if (result === 'downloaded') downloaded++;
        else downloadSkipped++;
        localFiles.push(dest);
        if ((i + 1) % 50 === 0 || i + 1 === objects.length) {
          console.log(
            `download ${i + 1}/${objects.length} (new=${downloaded} skip=${downloadSkipped} fail=${downloadFailed})`,
          );
        }
      } catch (err) {
        downloadFailed++;
        console.error(`download fail ${obj.key}: ${(err as Error).message}`);
        await sleep(250);
      }
    });
  } else {
    const found = await listLocalOriginals(originalDir);
    const filtered = lang
      ? found.filter((f) => f.replace(/\\/g, '/').includes(`/${lang}/`))
      : found;
    localFiles.push(...(limit > 0 ? filtered.slice(0, limit) : filtered));
    console.log(`Local originals: ${localFiles.length}`);
  }

  let converted = 0;
  let convertSkipped = 0;
  let convertFailed = 0;

  await mapPool(localFiles, convertConcurrency, async (src, i) => {
    const rel = path.relative(originalDir, src).replace(/\\/g, '/');
    const dest = webmPathFromOriginal(originalDir, webmDir, src);
    try {
      const result = await convertToWebm(ffmpeg, src, dest);
      if (result === 'converted') converted++;
      else convertSkipped++;
      if ((i + 1) % 50 === 0 || i + 1 === localFiles.length) {
        console.log(
          `convert ${i + 1}/${localFiles.length} (new=${converted} skip=${convertSkipped} fail=${convertFailed})`,
        );
      }
    } catch (err) {
      convertFailed++;
      console.error(`convert fail ${rel}: ${(err as Error).message}`);
    }
  });

  console.log('Done.');
  console.table({
    downloaded,
    downloadSkipped,
    downloadFailed,
    converted,
    convertSkipped,
    convertFailed,
    originalDir,
    webmDir,
  });

  if (downloadFailed || convertFailed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
