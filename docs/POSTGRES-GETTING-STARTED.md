# PostgreSQL — დასაწყისი (Windows)

> **ისტორიული დოკუმენტი.** მიგრაცია დასრულებულია — აპი მხოლოდ PostgreSQL-ზე მუშაობს.
> `db:migrate-*` სკრიპტები და Mongo/MySQL პაკეტები ამოღებულია. მიმდინარე setup-ისთვის
> იხილე [README](../README.md) და [DEPLOY_NOTES](../DEPLOY_NOTES.md).

## 1. PostgreSQL-ის დაყენება

### ვარიანტი A — ოფიციალური ინსტალერი (რეკომენდებული სწავლისთვის)

1. გადადი: https://www.postgresql.org/download/windows/
2. დააყენე **PostgreSQL 17** (EDB installer).
3. ინსტალაციისას:
   - **Port:** `5432` (default)
   - **Password:** დაიმახსოვრე `postgres` user-ის პაროლი
   - **Locale:** default
4. დააყენე **pgAdmin 4** (ინსტალერთან ერთად მოდის) — გрафიკული UI DB-სთვის.

### ვარიანტი B — winget (სწრაფი)

PowerShell **Administrator**-ით:

```powershell
winget install PostgreSQL.PostgreSQL.17 --accept-package-agreements --accept-source-agreements
```

დაყენების შემდეგ გადატვირთე ტერმინალი. შეამოწმე:

```powershell
psql --version
```

---

## 2. ბაზის შექმნა

**SQL Shell (psql)** ან **pgAdmin** → Query Tool:

```sql
CREATE DATABASE driving_theory_back;
```

ან პროექტიდან (თუ `psql` PATH-შია):

```powershell
psql -U postgres -f scripts/init-postgres.sql
```

---

## 3. `.env` — PostgreSQL ბლოკი

დაამატე `.env`-ში (MySQL/Mongo ხაზები **დატოვე** — ჯერ ორივე გვჭირდება):

```env
# PostgreSQL (migration target)
DB_TYPE=postgres
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=YOUR_POSTGRES_PASSWORD
DB_DATABASE=driving_theory_back
DB_SYNCHRONIZE=true

# ან ერთი URL (Neon/Supabase cloud-ისთვის):
# DATABASE_URL=postgresql://user:pass@host:5432/driving_theory_back?sslmode=require
# DATABASE_SSL=true
```

**მნიშვნელოვანი:** სანამ migration არ დასრულდება, NestJS-ის `start:dev` **არ** გადააქციო `DB_TYPE=postgres`-ზე — ჯერ მხოლოდ სკრიპტები გამოიყენე.

---

## 4. კავშირის ტესტი

PostgreSQL დაყენების და `.env` შევსების შემდეგ:

```powershell
npm run db:test-pg
```

წარმატება:

```
Connected successfully.
  database: driving_theory_back
```

---

## 5. კითხვების გადატანა Mongo → PostgreSQL

MongoDB კავშირი (`.env`-ში უკვე გაქვს) + PostgreSQL მზად რომ იყოს:

```powershell
npm run db:migrate-questions-to-pg
```

ეს:
- შექმნის `questions` ცხრილს
- დააკოპირებს ~5,400 row MongoDB-დან
- დაამატებს GIN index-ს `categories` array-ზე

---

## 6. სასარგებლო ბრძანებები

| ბრძანება | რას აკეთებს |
|----------|-------------|
| `psql -U postgres -d driving_theory_back` | ტერმინალიდან DB-ში შესვლა |
| `\dt` | ცხრილების სია |
| `SELECT lang, COUNT(*) FROM questions GROUP BY lang;` | კითხვების რაოდენობა ენებით |
| `npm run db:test-pg` | კავშირის შემოწმება |
| `npm run db:migrate-questions-to-pg` | Mongo → PG questions |

---

## 7. Migration roadmap (შემდეგი ეტაპები)

1. ✅ PostgreSQL driver + `Question` entity + migration script
2. ⬜ `questions.service.ts` → TypeORM (PG)
3. ⬜ `categories`, `exams` entities + migration
4. ⬜ `question-sampling.service` → SQL
5. ⬜ MySQL tables → PostgreSQL
6. ⬜ MongoDB/Mongoose ამოღება

---

## Cloud ალტერნativa (ლოკალური ინსტალის გარეშე)

თუ არ გინდა Windows-ზე დაყენება:

- **Neon** (https://neon.tech) — free tier, `DATABASE_URL` copy/paste
- **Supabase** (https://supabase.com) — free tier + UI

`.env`-ში მხოლოდ `DATABASE_URL` + `DB_TYPE=postgres` + `DATABASE_SSL=true`.
