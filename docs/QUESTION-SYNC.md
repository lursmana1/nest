# Question Sync (Master Sync)

Syncs the driving exam database using Gemini: **Georgian (`ka`) is the only source of truth** for law text.

## Overview

- One API call per `id` (saves quota).
- **Source:** `ka.question` + `ka.question_explained` (must be non-empty).
- **Gemini outputs:** formal `question_explained` for **Russian and English** (from Georgian law), plus **AI Tutor** in **ka, ru, en**.
- **Updates:**
  - `ka`: `ai_tutor` only (Georgian legal text unchanged).
  - `ru`: `question_explained` + `ai_tutor`
  - `en`: `question_explained` + `ai_tutor`
- **5-second** delay between IDs (~12 RPM, under 15 RPM).
- **Skips** IDs where `ai_tutor` is already set on **ka, ru, and en** (saves daily quota).
- **Retries** 429 / 503 with API-suggested wait.

## Schema

`question_explained` and `ai_tutor` are columns on `questions`, which has the composite
primary key `(id, lang)` — so each language is its own row:

```sql
ALTER TABLE questions ADD COLUMN ai_tutor TEXT;
```

## Environment

```env
GEMINI_API_KEY=your_key
GEMINI_MODEL=gemini-3.1-flash-lite-preview   # optional; internal API id (not display name)
DATABASE_URL=postgres://...
```

## Usage

### Test (5 IDs)

```bash
npm run sync:questions -- 5
```

### Day 1 (IDs 1–1,200)

```bash
npm run sync:questions -- 1200
```

### Day 2 (IDs 1,201–1,800)

```bash
npm run sync:questions -- 600 1200
```

## Free tier (typical)

- ~1,500 requests/day, ~15 requests/minute — **5s delay** stays under RPM.
- **Cost:** $0 on free tier for this workload split across two days.

## Re-running with new “master” logic

If you already ran the old sync, IDs with all three `ai_tutor` fields filled are **skipped**. To regenerate from Georgian only, clear `ai_tutor` (and optionally `ru`/`en` `question_explained`) for those IDs in Postgres, then run again.

## Progress

Logs: `[50/1200] Processed ID 42`.
