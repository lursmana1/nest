# driving-theory-back


Backend API for a Georgian driving license theory exam app. Supports all license categories (AM, A, B, C, C1, D, D1, and more), multilingual questions (Georgian, Russian, English), personalized exam selection, and user weakness statistics.

Built with **NestJS** and **PostgreSQL** (TypeORM).

## Features

- **5,400+ questions** across 3 languages (`ka`, `ru`, `en`)
- **10 license categories** with official exam rules (question count and pass threshold per category)
- **Exam simulator** with timed attempts, per-answer scoring, and pass/fail evaluation
- **Personalized question selection** based on user history (weak questions and weak subjects)
- **User statistics** — top wrong questions and weakest subjects
- **Auth** — JWT + Google OAuth
- **Blogs, leaderboard, file uploads** (S3)

## Tech stack

| Layer | Technology |
|-------|------------|
| Framework | NestJS 11 |
| Database | PostgreSQL (Neon / Docker) |
| ORM | TypeORM |
| Auth | Passport (JWT, Google OAuth) |
| Storage | AWS S3 |

## Getting started

### Prerequisites

- Node.js 20+
- PostgreSQL 16+ (local Docker, or a hosted provider like [Neon](https://neon.tech))

### Install

```bash
git clone <repo-url>
cd driving-theory-back
npm install
cp .env.example .env
# Edit .env with your database URL and secrets
```

### Run locally

```bash
npm run start:dev
```

API listens on `http://localhost:3000` by default (`PORT` env var overrides).

### Verify database connection

```bash
npm run db:test-pg
```

### Seed categories (first-time setup)

```bash
npm run db:seed-categories
```

## Environment variables

Copy `.env.example` and configure:

| Variable | Description |
|----------|-------------|
| `DB_TYPE` | `postgres` |
| `DATABASE_URL` | PostgreSQL connection string (recommended for Neon/Render) |
| `DB_SYNCHRONIZE` | `false` in production |
| `JWT_SECRET` | Secret for signing JWT tokens |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth |
| `GOOGLE_CALLBACK_URL` | OAuth redirect URL |
| `FRONTEND_ORIGIN` | Allowed CORS origins (comma-separated) |
| `AWS_*` | S3 bucket for images/audio |

Local fallback when `DATABASE_URL` is unset: `PG_HOST`, `PG_PORT`, `PG_USERNAME`, `PG_PASSWORD`, `PG_DATABASE`.

## API overview

All routes are at the root (no global prefix). Protected routes require:

```
Authorization: Bearer <jwt>
```

### Public

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/categories` | List license categories |
| `GET` | `/categories/:id` | Category detail with subjects |
| `GET` | `/questions?lang=ka&category=0&page=1&size=20` | Paginated questions |
| `GET` | `/questions/random?lang=ka&count=10&category=0` | Random practice set |
| `GET` | `/questions/:id?lang=ka` | Single question |
| `POST` | `/auth/register` | Register |
| `POST` | `/auth/login` | Login |
| `GET` | `/auth/google` | Google OAuth |

Language: `?lang=ka|ru|en` or `Accept-Language` header.

### Exam attempts (authenticated)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/exam-attempts/rules` | All category exam rules |
| `GET` | `/exam-attempts/rules?category=0` | Rules for one category |
| `POST` | `/exam-attempts/start?categories=0&lang=ka` | Start exam (personalized selection) |
| `POST` | `/exam-attempts/:id/answer` | Submit answer `{ questionId, chosenAnswer }` |
| `POST` | `/exam-attempts/:id/finish` | Finish attempt early |
| `GET` | `/exam-attempts` | Attempt history (`?page=1&size=10`). Includes `counts` for all attempts (passed/failed/incomplete/passRate) — do not derive those from `data` alone. |
| `GET` | `/exam-attempts/:id` | Attempt detail |
| `GET` | `/exam-attempts/stats?limit=1000` | Raw answer log |

**Start exam query params:** `categories`, `subjects`, `lang`, `allSubjects`.

**Start response** includes `questionCount`, `minCorrectToPass`, and `categoryId` — use these on the frontend instead of hardcoded values.

Returns `400 Insufficient questions` when the filtered pool is smaller than the required ticket size.

### User statistics (authenticated)

| Method | Endpoint | When to call |
|--------|----------|--------------|
| `GET` | `/user-stats/summary?category=1` | **First paint** — tiny stats-grid payload (score, coverage, pool) |
| `GET` | `/user-stats/readiness?category=1` | Detail / diagnostics (no deprecated alias fields) |
| `GET` | `/user-stats/question-pool?category=1` | Only if you need pool alone (already in `summary`) |
| `GET` | `/user-stats/subject-progress?category=1` | Subject picker screen (lazy) |
| `GET` | `/user-stats/weak-questions?category=1` | Weak list below the fold (lazy) — compact `preview` only |
| `GET` | `/user-stats/weak-subjects?category=1` | Weak topics below the fold (lazy) |

**Do not** fire `readiness` + `question-pool` + `weak-questions` + `exam-attempts` on first paint — that blocks the main thread (TBT) while parsing several large JSON responses. Use:

1. `GET /user-stats/summary?category=1` (+ cached `GET /users/me` / `GET /categories`) for the hero grid  
2. Lazy-load `weak-questions`, `weak-subjects`, `exam-attempts` after first paint (Intersection Observer / route idle)

`weak-questions` returns `{ questionId, wrongCount, totalAttempts, preview }` — no answer choices or explanations. Fetch `GET /questions/:id` only when the user opens a question.

## Exam rules (Georgia, 2026)

Rules follow [sa.gov.ge](https://sa.gov.ge/p/driver-license/theoretical-test). Exam duration is **30 minutes** for all categories.

| Category | ID | Questions | Min correct to pass |
|----------|----|-----------|---------------------|
| AM | 0 | 20 | 18 |
| B (B1) | 1 | 30 | 25 |
| A (A1/A2) | 2 | 30 | 27 |
| C | 3 | 40 | 36 |
| D | 4 | 40 | 36 |
| C1 | 5 | 35 | 32 |
| D1 | 6 | 35 | 32 |
| Military / T | 7 | 30 | 27 |
| Tram | 8 | 30 | 27 |
| T / S | 9 | 35 | 32 |

Category **names and exam rules** are defined in `src/common/constants/category.constants.ts` and `georgian-exam-rules.util.ts`. `GET /categories` returns both even if DB rows still say "Category 1".

### Readiness score (მზაობის ქულა)

`GET /user-stats/readiness?category=1` (auth required) returns 0–100 per category:

1. **Core** = 65% recent exam accuracy (last 10, early fails discounted) + 35% answer accuracy
2. **Coverage factor** = `0.25 + 0.75 × (coveredTopics / topicsTotal)`  
   A topic is **covered** only after answering **≥70%** of its distinct questions.

So 0 covered topics keeps at most **20%** of the core score (your ~18% core → ~**4%** final).

`readyForExam: true` when score ≥ 70, last exam passed, and ≥70% of topics covered.

Implemented in `src/user-stats/readiness.util.ts`.

## Personalized question selection

When a user starts an exam, questions are selected based on answer history:

| Total answers | Random | Mistakes | Success |
|---------------|--------|----------|---------|
| &lt; 100 | 100% | 0% | 0% |
| 100–499 | 70% | 25% | 5% |
| 500+ | 50% | 40% | 10% |

See [docs/QUESTION-SELECTION.md](docs/QUESTION-SELECTION.md) for details.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run build` | Production build |
| `npm run start:prod` | Run built app |
| `npm test` | Unit tests |
| `npm run db:seed-categories` | Seed/update categories from questions |
| `npm run db:verify-questions` | Verify question import |
| `npm run db:fix-am-category-tags` | Sync `categories` array from ka → en/ru |
| `npm run import:questions` | Import from CSV (`--ka`, `--ru`, `--en`) |

Migration scripts (`db:migrate-*`) are for one-time data moves from legacy MySQL/MongoDB.

## Deployment

Production setup: **Render** (API) + **Neon** (PostgreSQL).

```env
DB_TYPE=postgres
DATABASE_URL=postgresql://...@...neon.tech/neondb?sslmode=require
DB_SYNCHRONIZE=false
```

| Render setting | Value |
|----------------|-------|
| Build Command | `npm ci && npm run build` |
| Start Command | `npm run start:prod` |
| Root Directory | *(empty — repo root)* |

Full checklist: [DEPLOY_NOTES.md](DEPLOY_NOTES.md) and [docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md).

## Project structure

```
src/
├── auth/              # JWT + Google OAuth
├── categories/        # License categories
├── questions/         # Question bank + filters
├── exams/             # Generated exam tickets
├── exam-attempts/     # Attempts, scoring, question selection
│   └── question-selection/
│       ├── weakness.service.ts
│       └── question-selection.service.ts
├── user-stats/        # Weak questions / weak subjects
├── users/             # User accounts
├── blogs/
├── leaderboard/
├── uploads/           # S3 uploads
└── common/
    └── utils/
        └── georgian-exam-rules.util.ts
scripts/               # DB migration, import, sync utilities
docs/                  # Additional documentation
```

## License

Private — see `package.json` (`UNLICENSED`).
