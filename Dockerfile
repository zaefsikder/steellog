# syntax=docker/dockerfile:1
FROM python:3.14-slim

# uv for fast, reproducible installs from uv.lock
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Install runtime deps only (openpyxl is dev-only, used at build time).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# App code (programs.json is committed, so no xlsx parsing needed at runtime).
COPY app ./app

ENV PATH="/app/.venv/bin:$PATH"
# Hosts inject $PORT; default to 8000 for local `docker run`.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
