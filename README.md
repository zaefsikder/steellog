# Workout Schedule

A personal, mobile-first workout tracker. It ships with two training programs
(parsed from the source spreadsheets), lets you build and edit your own, and
logs every set to a database so you can see previous performance and beat it —
across your phone and laptop.

- **Backend:** FastAPI + SQLAlchemy (SQLite locally; SQLite-on-volume or Postgres in prod)
- **Frontend:** no-build vanilla HTML/CSS/JS ("Steel Log" industrial theme), served as static files
- **Programs:** stored in the database. On first run the two originals are seeded
  from `app/data/programs.json` (derived from `hypertrophy.xlsx` /
  `hybrid_training.xlsx`); they stay editable and resettable but can't be
  deleted. Custom routines are full create/edit/delete.

## Project layout

```
app/
  main.py          FastAPI app: program catalogue + set-logging API + static frontend
  config.py        Env-driven config (DATABASE_URL, CORS_ORIGINS)
  database.py      SQLAlchemy engine / session / Base
  models.py        Program and SetLog tables
  schemas.py       Pydantic request/response models
  programs.py      Seed catalogue source + builder id helpers
  data/
    programs.json  Seed programs (committed; generated from the xlsx)
  static/          Frontend (index.html, styles.css, app.js, config.js)
scripts/
  parse_workouts.py  Build-time: xlsx -> app/data/programs.json
Dockerfile         Container image (Fly.io / Render)
fly.toml           Fly.io deploy (SQLite on a persistent volume)
render.yaml        Render deploy (Docker web service + free managed Postgres)
```

## Run locally

```bash
uv run uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000 — FastAPI serves both the API and the frontend, so
there's no CORS to worry about in dev. A `workouts.db` SQLite file is created on
first run (gitignored).

### Regenerate program data from the spreadsheets

Only needed if you edit the `.xlsx` files. `openpyxl` is a dev-only dependency.

```bash
uv run --group dev python scripts/parse_workouts.py
```

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET | `/api/programs` | List programs (id, name, subtitle, origin, counts) |
| GET | `/api/programs/{program_id}` | Full program with days + exercises |
| POST | `/api/programs` | Create a routine (server assigns fresh ids) |
| PUT | `/api/programs/{program_id}` | Edit a routine (existing day/exercise ids are preserved) |
| DELETE | `/api/programs/{program_id}` | Delete a custom routine (409 for a seed) |
| POST | `/api/programs/{program_id}/reset` | Reset a seed routine to its original (409 for custom) |
| POST | `/api/logs` | Log a performed set |
| GET | `/api/logs?exercise_id=&program_id=&limit=` | Recent logs (newest first) |
| DELETE | `/api/logs/{id}` | Delete a logged set |
| GET | `/api/exercises/{exercise_id}/stats` | Totals, best load, last set |
| GET | `/api/health` | Health check |

Each program has an `origin`: `seed` (the two originals — editable + resettable,
not deletable) or `custom` (user-built — full CRUD). On edit, send each existing
day/exercise's `id` back so logged history stays attached; omit `id` on new
items and the server assigns one.

## Configuration (environment variables)

| Var | Default | Notes |
| --- | ------- | ----- |
| `DATABASE_URL` | `sqlite:///./workouts.db` | Any SQLAlchemy URL. Fly volume: `sqlite:////data/workouts.db`. Postgres: `postgresql+psycopg://...` |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins. Set to your frontend origin in prod. |

## Deploy (free tiers)

> Heads-up: a **Render/Koyeb free web service has an ephemeral disk**, so plain
> SQLite would be wiped on cold starts. The primary path below uses a separate
> free-forever Postgres so your logs persist.

### Primary — Render (or Koyeb) + Neon/Supabase Postgres (no card)

The Postgres driver (`psycopg`) is already a dependency, and pasting the DB URL
is all the config you need — `app/config.py` adds the `+psycopg` driver prefix
for you.

1. Create a free Postgres at [neon.tech](https://neon.tech) (or
   [supabase.com](https://supabase.com)) and copy its connection string
   (`postgres://...`).
2. Push this repo to GitHub.
3. **Render:** dashboard → **New + → Blueprint** → pick this repo (`render.yaml`
   defines the Docker web service). When prompted, set:
   - `DATABASE_URL` = the Neon/Supabase connection string (pasted as-is)
   - `CORS_ORIGINS` = your frontend origin, only if hosted separately (else leave unset for `*`)
4. **Koyeb:** create a Docker service from this repo and set the same two env
   vars in its dashboard (no blueprint file needed).

### Alternative — Fly.io (keeps SQLite, needs a card on signup)

```bash
fly launch --no-deploy                        # keep the included fly.toml
fly volumes create data --size 1 --region <your-region>
fly secrets set CORS_ORIGINS="https://<you>.github.io"   # only if the frontend is hosted separately
fly deploy
```

The volume mounts at `/data` and `DATABASE_URL` points SQLite there, so logs
survive restarts and redeploys.

## Frontend hosting

By default the frontend is served by FastAPI from `app/static/` (single origin,
no CORS). To host it separately on **GitHub Pages** instead, copy `app/static/`
to your Pages site and set the backend URL in `app/static/config.js`:

```js
window.API_BASE = "https://<your-backend-host>";
```
