/**
 * Archive outdated question IDs out of live `questions`.
 *
 * - Creates `questions_archived` (same columns + archived_at, archive_reason)
 * - Moves all rows for those IDs (ka/ru/en) into the archive table
 * - Writes a JSON dump under backups/
 * - Live site + TTS only read `questions`, so archived IDs disappear from the app
 *
 * Usage:
 *   npm run db:archive-outdated -- --dry-run
 *   npm run db:archive-outdated
 *   npm run db:archive-outdated -- --ids-file=outdated-question-ids-to-remove.json
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { initPg } from './lib/pg-data-source';

function loadIds(filePath: string): number[] {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  const arr = Array.isArray(raw)
    ? raw
    : (raw as { removeIds?: unknown[]; ids?: unknown[] }).removeIds ??
      (raw as { ids?: unknown[] }).ids;
  if (!Array.isArray(arr)) {
    throw new Error(`Expected array of ids in ${filePath}`);
  }
  const ids = [
    ...new Set(
      arr
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ].sort((a, b) => a - b);
  if (ids.length === 0) throw new Error(`No ids found in ${filePath}`);
  return ids;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const idsArg = process.argv.find((a) => a.startsWith('--ids-file='));
  const idsFile = path.resolve(
    idsArg?.slice('--ids-file='.length) ||
      path.join(process.cwd(), 'outdated-question-ids-to-remove.json'),
  );

  if (!fs.existsSync(idsFile)) {
    throw new Error(
      `Ids file not found: ${idsFile}. Run compare-legit-question-ids.ts first.`,
    );
  }

  const ids = loadIds(idsFile);
  const reason = 'outdated_after_georgian_rules_update';
  const ds = await initPg();

  try {
    await ds.query(`
      CREATE TABLE IF NOT EXISTS questions_archived (
        id int NOT NULL,
        lang varchar(5) NOT NULL,
        question text NOT NULL,
        question_explained text,
        "hasImg" smallint NOT NULL DEFAULT 0,
        correct_answer varchar(10),
        answer_1 text,
        answer_2 text,
        answer_3 text,
        answer_4 text,
        subject int,
        categories int[] NOT NULL DEFAULT '{}',
        audio varchar(512),
        ai_tutor text,
        img varchar(512),
        archived_at timestamptz NOT NULL DEFAULT NOW(),
        archive_reason text,
        PRIMARY KEY (id, lang)
      )
    `);

    const before = await ds.query(
      `SELECT COUNT(*)::int AS cnt FROM questions WHERE id = ANY($1::int[])`,
      [ids],
    );
    const liveDistinct = await ds.query(
      `SELECT COUNT(DISTINCT id)::int AS cnt FROM questions`,
    );
    const rowCount = Number(before[0]?.cnt ?? 0);

    console.log(
      JSON.stringify(
        {
          dryRun,
          idsFile,
          outdatedIds: ids.length,
          liveRowsToMove: rowCount,
          liveDistinctIdsBefore: Number(liveDistinct[0]?.cnt ?? 0),
        },
        null,
        2,
      ),
    );

    if (rowCount === 0) {
      console.log('Nothing to archive — no matching rows in questions.');
      return;
    }

    const dumpRows = await ds.query(
      `SELECT * FROM questions WHERE id = ANY($1::int[]) ORDER BY id, lang`,
      [ids],
    );

    const backupsDir = path.join(process.cwd(), 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dumpPath = path.join(
      backupsDir,
      `questions-archived-${stamp}.json`,
    );
    fs.writeFileSync(
      dumpPath,
      JSON.stringify(
        {
          archivedAt: new Date().toISOString(),
          reason,
          idCount: ids.length,
          ids,
          rows: dumpRows,
        },
        null,
        2,
      ),
    );
    console.log(`Dump written: ${dumpPath} (${dumpRows.length} rows)`);

    if (dryRun) {
      console.log('Dry run — no DB changes.');
      return;
    }

    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(
        `DELETE FROM questions_archived WHERE id = ANY($1::int[])`,
        [ids],
      );

      const inserted = await qr.query(
        `
        INSERT INTO questions_archived (
          id, lang, question, question_explained, "hasImg", correct_answer,
          answer_1, answer_2, answer_3, answer_4, subject, categories,
          audio, ai_tutor, img, archived_at, archive_reason
        )
        SELECT
          id, lang, question, question_explained, "hasImg", correct_answer,
          answer_1, answer_2, answer_3, answer_4, subject, categories,
          audio, ai_tutor, img, NOW(), $2
        FROM questions
        WHERE id = ANY($1::int[])
        RETURNING id, lang
        `,
        [ids, reason],
      );

      const deleted = await qr.query(
        `DELETE FROM questions WHERE id = ANY($1::int[]) RETURNING id, lang`,
        [ids],
      );

      await qr.commitTransaction();
      console.log(
        `Archived ${inserted.length} rows; removed ${deleted.length} from live questions.`,
      );
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }

    const archivedCount = await ds.query(
      `SELECT COUNT(*)::int AS cnt FROM questions_archived WHERE id = ANY($1::int[])`,
      [ids],
    );
    const stillLive = await ds.query(
      `SELECT COUNT(*)::int AS cnt FROM questions WHERE id = ANY($1::int[])`,
      [ids],
    );
    const afterDistinct = await ds.query(
      `SELECT COUNT(DISTINCT id)::int AS cnt FROM questions`,
    );
    const byLang = await ds.query(
      `SELECT lang, COUNT(*)::int AS cnt FROM questions GROUP BY lang ORDER BY lang`,
    );

    console.log(
      JSON.stringify(
        {
          archivedRowsForIds: Number(archivedCount[0]?.cnt ?? 0),
          stillLiveForIds: Number(stillLive[0]?.cnt ?? 0),
          liveDistinctIdsAfter: Number(afterDistinct[0]?.cnt ?? 0),
          liveByLang: byLang,
          dumpPath,
        },
        null,
        2,
      ),
    );

    if (Number(stillLive[0]?.cnt ?? 0) > 0) {
      throw new Error(
        'Archive incomplete: some outdated ids still in live questions',
      );
    }
  } finally {
    await ds.destroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
