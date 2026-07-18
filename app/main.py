"""FastAPI application: serves the workout catalogue, the set-logging API,
and (optionally) the static frontend from a single origin.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import programs
from app.config import CORS_ORIGINS
from app.database import Base, engine, get_db
from app.models import SetLog
from app.schemas import (
    ExerciseStats,
    Program,
    ProgramSummary,
    SetLogCreate,
    SetLogOut,
)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables on boot. For a single-table app this is simpler than
    # wiring up migrations; swap in Alembic later if the schema grows.
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="Workout Schedule API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


def epley_1rm(weight: float | None, reps: int) -> float | None:
    """Estimated one-rep max via the Epley formula: w * (1 + reps/30)."""
    if not weight or weight <= 0 or reps <= 0:
        return None
    return round(weight * (1 + reps / 30), 1)


def _to_out(log: SetLog) -> SetLogOut:
    out = SetLogOut.model_validate(log)
    out.est_1rm = epley_1rm(log.weight, log.reps)
    return out


# --- Program catalogue -----------------------------------------------------
@app.get("/api/programs", response_model=list[ProgramSummary])
def list_programs() -> list[ProgramSummary]:
    result = []
    for p in programs.all_programs():
        exercise_count = sum(len(d["exercises"]) for d in p["days"])
        result.append(
            ProgramSummary(
                id=p["id"],
                name=p["name"],
                subtitle=p["subtitle"],
                day_count=len(p["days"]),
                exercise_count=exercise_count,
            )
        )
    return result


@app.get("/api/programs/{program_id}", response_model=Program)
def get_program(program_id: str) -> dict:
    program = programs.get_program(program_id)
    if program is None:
        raise HTTPException(status_code=404, detail="Program not found")
    return program


# --- Set logging -----------------------------------------------------------
@app.post("/api/logs", response_model=SetLogOut, status_code=201)
def create_log(payload: SetLogCreate, db: Session = Depends(get_db)) -> SetLogOut:
    data = payload.model_dump(exclude_none=True)
    log = SetLog(**data)
    db.add(log)
    db.commit()
    db.refresh(log)
    return _to_out(log)


@app.get("/api/logs", response_model=list[SetLogOut])
def list_logs(
    exercise_id: str | None = Query(default=None),
    program_id: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> list[SetLogOut]:
    stmt = select(SetLog)
    if exercise_id:
        stmt = stmt.where(SetLog.exercise_id == exercise_id)
    if program_id:
        stmt = stmt.where(SetLog.program_id == program_id)
    stmt = stmt.order_by(SetLog.performed_at.desc()).limit(limit)
    return [_to_out(log) for log in db.scalars(stmt)]


@app.delete("/api/logs/{log_id}", status_code=204)
def delete_log(log_id: int, db: Session = Depends(get_db)) -> None:
    log = db.get(SetLog, log_id)
    if log is None:
        raise HTTPException(status_code=404, detail="Log not found")
    db.delete(log)
    db.commit()


@app.get("/api/exercises/{exercise_id}/stats", response_model=ExerciseStats)
def exercise_stats(
    exercise_id: str, db: Session = Depends(get_db)
) -> ExerciseStats:
    logs = list(
        db.scalars(
            select(SetLog)
            .where(SetLog.exercise_id == exercise_id)
            .order_by(SetLog.performed_at.desc())
        )
    )
    if not logs:
        return ExerciseStats(exercise_id=exercise_id, total_sets=0)

    weights = [log.weight for log in logs if log.weight is not None]
    est_1rms = [
        v for log in logs if (v := epley_1rm(log.weight, log.reps)) is not None
    ]
    latest = logs[0]
    return ExerciseStats(
        exercise_id=exercise_id,
        total_sets=len(logs),
        best_weight=max(weights) if weights else None,
        best_est_1rm=max(est_1rms) if est_1rms else None,
        last_performed_at=latest.performed_at,
        last_weight=latest.weight,
        last_reps=latest.reps,
    )


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


# --- Static frontend -------------------------------------------------------
# Mounted last so it never shadows the /api routes. When deployed on a single
# host this serves the SPA; on GitHub Pages the frontend is served separately
# and this mount is simply unused.
_STATIC_DIR = Path(__file__).parent / "static"
if _STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="static")
