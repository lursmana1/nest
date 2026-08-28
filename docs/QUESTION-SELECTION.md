# Question Selection

How exam questions are chosen for each attempt.

---

## Table of Contents

1. [Overview](#overview)
2. [Code Structure](#code-structure)
3. [Levels and Ratios](#levels-and-ratios)
4. [Weakness Computation](#weakness-computation)
5. [Selection Logic](#selection-logic)
6. [Data Flow](#data-flow)
7. [Performance](#performance)
8. [Filter Options](#filter-options)
9. [Constants Reference](#constants-reference)
10. [API Reference](#api-reference)
11. [Edge Cases](#edge-cases)
12. [Future Extensions](#future-extensions)

---

## Overview

The system selects questions in three buckets:

| Bucket | Description |
|--------|-------------|
| **Random** | Questions from the full pool (all subjects) |
| **Mistakes** | Questions or subjects where the user has more wrong than right |
| **Success** | Questions or subjects where the user has more right than wrong |

Ratios depend on how much answer history the user has. New users get 100% random; users with more data get increasingly personalized mixes.

---

## Code Structure

```
src/exam-attempts/question-selection/
├── selection.types.ts           # Types, ratios, constants
├── weakness.service.ts          # Answer history → mistake/success IDs
├── question-sampling.service.ts # Random + weighted sampling
└── question-selection.service.ts # Orchestrator: level → sampling → shuffle
```

Everything here runs on PostgreSQL through the TypeORM query builder.

| File | Responsibility |
|------|----------------|
| `selection.types.ts` | `SelectionOptions`, `WeaknessIds`, `SelectionRatios`, `FULL_RATIOS`, `LIGHT_RATIOS` |
| `weakness.service.ts` | `getTotalAnswerCount()`, `getWeaknessIds()` |
| `question-sampling.service.ts` | `buildMatchFilter()`, `countMatching()`, `sampleRandom()`, `sampleWeighted()` |
| `question-selection.service.ts` | `selectQuestions()` — orchestrates level check, sampling, shuffle |

---

## Levels and Ratios

| Level | Total answers | Random | Mistakes | Success |
|-------|---------------|--------|----------|---------|
| 0 | &lt; 100 | 100% | 0% | 0% |
| 1 | 100–499 | 70% | 25% | 5% |
| 2 | 500+ | 50% | 40% | 10% |

**Example for 30 questions:**

- Level 0: 30 random
- Level 1: 21 random, 7–8 mistakes, 1–2 success
- Level 2: 15 random, 12 mistakes, 3 success

---

## Weakness Computation

**Data source:** PostgreSQL `user_answers` table, joined with `exam_attempts` on `attemptId`.

**Query:** Last `MAX_HISTORY_FOR_WEIGHTING` answers (newest first), selecting only `questionId`, `subject`, `correct`.

**Per answer:**
- Wrong: `+1`
- Correct: `-1`

**Per question and per subject:** Sum these values over all answers.

**Classification:**
- **Mistakes:** `sum > 0` → more wrong than right
- **Success:** `sum < 0` → more right than wrong
- **Tie:** `sum = 0` → ignored (not used in selection)

**Example:**
- Question 42: 3 wrong, 1 correct → sum = 2 → **mistake**
- Subject 18: 5 wrong, 7 correct → sum = -2 → **success**

**Same question multiple times:** All answers for that question are summed. A question can appear in many attempts (correct and wrong); the net sum decides whether it is a mistake or success.

**Output:** `WeaknessIds` with `mistakeIds`, `successIds`, `mistakeSubjects`, `successSubjects`. Each array is capped at `MAX_WEAKNESS_IDS_CAP` to keep the `IN (...)` / `NOT IN (...)` lists short.

---

## Selection Logic

### 1. Mistakes bucket

Questions where:
- `id ∈ mistakeIds` **or** `subject ∈ mistakeSubjects`

### 2. Success bucket

Questions where:
- `id ∉ mistakeIds` (no overlap with mistakes)
- and (`id ∈ successIds` **or** `subject ∈ successSubjects`)

### 3. Random bucket

Questions from the full pool matching the base filter, excluding IDs already chosen for mistakes and success.

### Deduplication

- Success excludes all `mistakeIds`, so no question is both mistake and success.
- Random excludes `selectedIds` (mistakes + success), so no overlap.

### Order of selection

1. Sample mistakes and success in parallel (two queries via `Promise.all`)
2. Sample random excluding selected
3. Combine: `[mistakes, success, random]`
4. Shuffle final list

---

## Data Flow

```
1. Count total answers → choose level
2. If level 0: one random sample → shuffle → return
3. If level 1 or 2:
   a. Fetch weakness (last 500 answers) → compute mistake/success IDs (capped at 100 each)
   b. Sample mistakes and success in parallel (two queries)
   c. Sample random, excluding what was already selected
   d. If fewer than count: fallback random sample
   e. Shuffle final list → return
```

---

## Performance

Every step is a Postgres round trip, so the query count is what matters:

| Scenario | Queries |
|----------|---------|
| &lt; 100 answers | 1 count + 1 random sample |
| ≥ 100 answers | 1 count + 1 weakness query + 2 parallel samples + 1 random sample |
| Fallback (pool too small) | +1 random sample |

**Optimizations:**
- `MAX_HISTORY_FOR_WEIGHTING = 500` — bounds the weakness query
- `MAX_WEAKNESS_IDS_CAP = 100` — keeps the `IN (...)` lists short
- Mistake and success samples run concurrently, so they cost one round trip, not two
- Each sample selects only `q.id`, never whole question rows
- `idx_questions_categories_gin` — GIN index for the `categories && ARRAY[...]` overlap test
- `idx_user_answers_attempt_created` — backs the weakness history query

---

## Filter Options

`SelectionOptions` controls which questions are eligible:

| Option | Type | Description |
|--------|------|-------------|
| `userId` | number | Required. User whose history is used. |
| `lang` | string | Required. Question language. |
| `count` | number | Optional. Default 30. |
| `subjects` | number[] | Optional. Restrict to these subjects. |
| `categories` | number[] | Optional. Restrict to these categories. |
| `allSubjects` | boolean | Optional. If true, `subjects` is ignored. |

**Match filter** (`applyQuestionFilters` in `src/questions/question-query.util.ts`):
- `q.lang = :lang` — always applied
- `q.categories && ARRAY[:...categories]::int[]` — array overlap, if `categories` provided
- `q.subject IN (:...subjects)` — if `subjects` provided and not `allSubjects`

---

## Constants Reference

**File:** `src/common/constants/exam.constants.ts`

| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_ANSWERS_FOR_PERSONALIZATION` | 100 | Start any personalization |
| `MIN_ANSWERS_FOR_FULL_PERSONALIZATION` | 500 | Use full 50/40/10 split |
| `MAX_HISTORY_FOR_WEIGHTING` | 500 | Last N answers for weakness |
| `MAX_WEAKNESS_IDS_CAP` | 100 | Max IDs per bucket |
| `DEFAULT_QUESTION_COUNT` | 30 | Default questions per exam |

**File:** `src/exam-attempts/question-selection/selection.types.ts`

| Constant | Values | Description |
|----------|--------|-------------|
| `FULL_RATIOS` | random: 0.5, mistakes: 0.4, success: 0.1 | Level 2 (500+ answers) |
| `LIGHT_RATIOS` | random: 0.7, mistakes: 0.25, success: 0.05 | Level 1 (100–499 answers) |

---

## API Reference

### QuestionSelectionService

**`selectQuestions(options: SelectionOptions): Promise<number[]>`**

Main entry point. Returns an array of question IDs in random order.

### WeaknessService

**`getTotalAnswerCount(userId: number): Promise<number>`**

Total answer count for the user. Used for level selection.

**`getWeaknessIds(userId: number): Promise<WeaknessIds>`**

Returns `{ mistakeIds, successIds, mistakeSubjects, successSubjects }` from answer history.

### QuestionSamplingService

**`buildMatchFilter(lang, subjects?, categories?, allSubjects?): QuestionFilterOpts`**

Builds the filter options for the base pool.

**`countMatching(filter): Promise<number>`**

Counts questions matching the filter. Used to detect a pool smaller than the requested count.

**`sampleRandom(filter, limit, exclude?): Promise<number[]>`**

Samples random question IDs via `ORDER BY RANDOM() LIMIT n`.

**`sampleWeighted(filter, count, weakness, ratios): Promise<number[]>`**

Samples mistakes + success + random according to ratios.

---

## Edge Cases

| Case | Behavior |
|------|----------|
| No mistake/success candidates | Those buckets return 0; random fills the rest. |
| Pool smaller than count | Fallback random sample adds more (broader match if needed). |
| Empty `mistakeIds` and `mistakeSubjects` | Mistake query is skipped entirely, returning 0 rows. |
| Empty `successIds` and `successSubjects` | Success query is skipped entirely, returning 0 rows. |
| Question in both mistake subject and success by id | Treated as mistake (question-level wins). |
| All answers tied (sum = 0) | No mistake/success IDs; selection is effectively random. |

---

## Future Extensions

- Add more levels (e.g. 1000+ answers for stronger personalization)
- Adjust ratios per level
- Add difficulty/adaptive logic when enough data exists
- Cache weakness per user for a short TTL
