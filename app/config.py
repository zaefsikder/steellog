"""Runtime configuration, driven entirely by environment variables.

Defaults are geared toward local development (SQLite file, permissive CORS).
On a deployed host you override DATABASE_URL and CORS_ORIGINS.
"""

from __future__ import annotations

import os
from urllib.parse import urlsplit

# Load local env files for development (Neon writes .env.local via `neon env
# pull`). Real environment variables (e.g. Render's dashboard) always win —
# override=False — so this only fills gaps locally and is a no-op in prod.
try:
    from dotenv import load_dotenv

    load_dotenv(".env.local", override=False)
    load_dotenv(".env", override=False)
except ImportError:
    pass


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


# --- Authentication (Neon Auth / Better Auth) ------------------------------
# `neon env pull` provides NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL. Tokens are
# EdDSA-signed, and their `iss`/`aud` claims are the base URL's *origin*
# (scheme://host), so we derive those from the base URL unless overridden.
NEON_AUTH_BASE_URL = os.environ.get("NEON_AUTH_BASE_URL", "").rstrip("/")
NEON_AUTH_JWKS_URL = os.environ.get("NEON_AUTH_JWKS_URL", "")

_auth_origin = ""
if NEON_AUTH_BASE_URL:
    _parts = urlsplit(NEON_AUTH_BASE_URL)
    _auth_origin = f"{_parts.scheme}://{_parts.netloc}"

NEON_AUTH_ISSUER = os.environ.get("NEON_AUTH_ISSUER", "") or _auth_origin
NEON_AUTH_AUDIENCE = os.environ.get("NEON_AUTH_AUDIENCE", "") or _auth_origin or None

# The one account that owns the two starter programs (Hypertrophy + Hybrid);
# they seed to this email on its first login. Everyone else starts empty.
OWNER_EMAIL = os.environ.get("OWNER_EMAIL", "").strip().lower()

# Dev escape hatch: when no JWKS URL is configured (local dev), trust an
# `X-Dev-User` header so the app is usable and testable without Neon Auth.
# This is refused whenever NEON_AUTH_JWKS_URL is set, so it can never weaken
# a real deployment.
AUTH_DEV_MODE = not NEON_AUTH_JWKS_URL
