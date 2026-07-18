"""Runtime configuration, driven entirely by environment variables.

Defaults are geared toward local development (SQLite file, permissive CORS).
On a deployed host you override DATABASE_URL and CORS_ORIGINS.
"""

from __future__ import annotations

import os


def _normalize_db_url(url: str) -> str:
    """Make a pasted Postgres URL work with the psycopg (v3) driver.

    Neon/Supabase hand you a URL like ``postgres://...`` or
    ``postgresql://...``. SQLAlchemy needs an explicit driver, so we rewrite the
    scheme to ``postgresql+psycopg://`` unless one is already specified.
    """
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix) :]
    return url


# SQLAlchemy connection string.
#   Local dev (SQLite file):   sqlite:///./workouts.db
#   Fly.io volume (SQLite):    sqlite:////data/workouts.db
#   Neon/Supabase (Postgres):  paste the dashboard URL as-is (postgres://...);
#                              the driver prefix is added automatically.
DATABASE_URL = _normalize_db_url(
    os.environ.get("DATABASE_URL", "sqlite:///./workouts.db")
)

# Comma-separated list of allowed browser origins for the API.
# "*" is fine for local dev; set your GitHub Pages / frontend origin in prod.
_origins = os.environ.get("CORS_ORIGINS", "*")
CORS_ORIGINS = [o.strip() for o in _origins.split(",") if o.strip()]
