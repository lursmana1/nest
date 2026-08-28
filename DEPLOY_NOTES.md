# Deployment Notes

## Render — PostgreSQL (Neon)

The app uses **PostgreSQL only** via TypeORM. MongoDB and MySQL are no longer used at runtime.

### Required env vars

```env
DATABASE_URL=postgresql://USER:PASS@HOST/neondb?sslmode=require
DB_SYNCHRONIZE=false
JWT_SECRET=<strong random string>
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
API_PUBLIC_URL=https://YOUR-API.onrender.com
GOOGLE_CALLBACK_URL=https://YOUR-API.onrender.com/auth/google/callback
GOOGLE_REDIRECT_AFTER_LOGIN=https://prava.ucos.ge
FRONTEND_ORIGIN=https://prava.ucos.ge
AWS_REGION=...
AWS_S3_BUCKET=...
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_PUBLIC_BASE_URL=...
```

`DATABASE_URL` is read first (Neon connection string). SSL is enabled automatically when the URL contains `neon.tech` or `sslmode=require`.

### Do not set on Render

- `MONGODB_URI` / `MONGODB_DB` — the Mongo/Mongoose packages are gone
- `DB_TYPE`, MySQL `DB_HOST` / `DB_PORT` — the MySQL branch was removed; Postgres is the only driver

### Checklist after deploy

- [ ] `DATABASE_URL` set (Neon production branch)
- [ ] `DB_SYNCHRONIZE=false`
- [ ] `JWT_SECRET` set
- [ ] `FRONTEND_ORIGIN` includes your production frontend URL (CORS + credentials)
- [ ] Google OAuth URLs point to production API + frontend

### Google Cloud Console (fix `Error 400: invalid_request`)

In [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → your OAuth 2.0 Client:

**Authorized JavaScript origins**
```
https://prava.ucos.ge
https://YOUR-API.onrender.com
```

**Authorized redirect URIs** (must match `GOOGLE_CALLBACK_URL` exactly)
```
https://YOUR-API.onrender.com/auth/google/callback
```

If the API is on a custom domain (e.g. `api.prava.ucos.ge`), use that URL instead of Render.

Also check **OAuth consent screen** → App domain = `prava.ucos.ge`, support email set, and your Google account added under **Test users** while the app is in Testing mode.

After deploy, verify: `GET https://YOUR-API/auth/config` should return the same `googleCallbackUrl` you registered in Google Console.

**Frontend:** redirect users to `googleLoginUrl` from `/auth/config` — not to `prava.ucos.ge/auth/google` unless that domain proxies to the API.
- [ ] AWS S3 vars set (blog uploads)
- [ ] `GET /categories` returns 10 categories
- [ ] `GET /questions?lang=ka&category=1&page=1` returns `total > 0` with Georgian text

## Timezones (read before moving hosts)

All date columns are `timestamptz`, so Postgres stores absolute instants and the
server's timezone no longer changes what a stored date *means*. This was migrated
from `timestamp without time zone`, where values were written in the writing
process's local zone — which silently broke arithmetic between two dates.

**When moving to Hetzner (or any non-UTC+4 host):**

- [ ] Set `TZ=UTC` on the app process/container. Not required for correctness any
      more, but it keeps logs and any `AT TIME ZONE` usage unambiguous.
- [ ] Do **not** reintroduce `timestamp` (without time zone) columns. New date
      columns must be `@CreateDateColumn({ type: 'timestamptz' })` or
      `@Column({ type: 'timestamptz' })`.
- [ ] Germany observes DST (Europe/Berlin, UTC+1/+2). A fixed offset constant
      cannot correct for it — this is why the old `GEORGIA_OFFSET_SECONDS` hack
      was removed rather than re-tuned.
- [ ] Verify after deploy: finish an exam attempt and confirm `durationSeconds`
      matches the real elapsed time.

Re-run the check any time (dry run, read-only):

```bash
npm run db:migrate-timestamptz
```

It reports every naive timestamp column it finds and exits without changing
anything unless passed `--confirm`. It should report zero columns.

### Build / start (Render)

| Setting | Value |
|--------|--------|
| Root Directory | *(empty)* |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm run start:prod` |

Production entry: **`dist/main.js`** (repo root).
