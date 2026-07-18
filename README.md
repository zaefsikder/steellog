# Workout Schedule

A personal, mobile-first workout tracker. It renders two training programs
(parsed from the source spreadsheets) and logs every set to a database so you
can see previous performance and beat it — across your phone and laptop.

- **Backend:** FastAPI + SQLAlchemy (SQLite locally; SQLite-on-volume or Postgres in prod)
- **Frontend:** no-build vanilla HTML/CSS/JS ("Steel Log" industrial theme), served as static files
- **Data:** `hypertrophy.xlsx` and `hybrid_training.xlsx` → normalized `app/data/programs.json`

## Project layout

```
app/
  main.py          FastAPI app: program catalogue + set-logging API + static frontend
  config.py        Env-driven config (DATABASE_URL, CORS_ORIGINS)
  database.py      SQLAlchemy engine / session / Base
  models.py        SetLog table
  schemas.py       Pydantic request/response models
  programs.py      Loads programs.json
  data/
    programs.json  Normalized program catalogue (committed; generated from the xlsx)
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
| GET | `/api/programs` | List programs (id, name, subtitle, counts) |
| GET | `/api/programs/{program_id}` | Full program with days + exercises |
| POST | `/api/logs` | Log a performed set |
| GET | `/api/logs?exercise_id=&program_id=&limit=` | Recent logs (newest first) |
| DELETE | `/api/logs/{id}` | Delete a logged set |
| GET | `/api/exercises/{exercise_id}/stats` | Totals, best load, best est. 1RM, last set |
| GET | `/api/health` | Health check |

`est_1rm` is the Epley estimate (`weight * (1 + reps/30)`); it's `null` for
bodyweight sets (no weight entered).

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
