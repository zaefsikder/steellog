"""FastAPI application: serves the workout catalogue, the set-logging API,
and (optionally) the static frontend from a single origin.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import programs
from app.config import CORS_ORIGINS
from app.database import Base, SessionLocal, engine, get_db
from app.models import Program as ProgramRow
from app.models import SetLog
from app.schemas import (
    ExerciseStats,
    Program,
    ProgramInput,
    ProgramSummary,
    SetLogCreate,
    SetLogOut,
)


def seed_programs_if_empty() -> None:
    """On first run, import the two original programs from programs.json.

    They are inserted verbatim (same program/exercise ids) so existing logs
    still match, and marked origin="seed" so they can be reset but not deleted.
    """
    with SessionLocal() as db:
        if db.scalar(select(func.count()).select_from(ProgramRow)):
            return
        for order, doc in enumerate(programs.seed_programs()):
            db.add(
                ProgramRow(
                    id=doc["id"],
                    name=doc["name"],
                    subtitle=doc.get("subtitle", ""),
                    origin="seed",
                    days=doc["days"],
                    sort_order=order,
                )
            )
        db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables on boot. For this small schema this is simpler than
    # wiring up migrations; swap in Alembic later if the schema grows.
    Base.metadata.create_all(bind=engine)
    seed_programs_if_empty()
    yield


app = FastAPI(title="Workout Schedule API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Program catalogue -----------------------------------------------------
def _program_detail(row: ProgramRow) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "subtitle": row.subtitle,
        "origin": row.origin,
        "days": row.days,
    }


def _get_program_row(program_id: str, db: Session) -> ProgramRow:
    row = db.get(ProgramRow, program_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Program not found")
    return row


@app.get("/api/programs", response_model=list[ProgramSummary])
def list_programs(db: Session = Depends(get_db)) -> list[ProgramSummary]:
    rows = db.scalars(
        select(ProgramRow).order_by(ProgramRow.sort_order, ProgramRow.created_at)
    )
    return [
        ProgramSummary(
            id=r.id,
            name=r.name,
            subtitle=r.subtitle,
            origin=r.origin,
            day_count=len(r.days),
            exercise_count=sum(len(d["exercises"]) for d in r.days),
        )
        for r in rows
    ]


@app.get("/api/programs/{program_id}", response_model=Program)
def get_program(program_id: str, db: Session = Depends(get_db)) -> dict:
    return _program_detail(_get_program_row(program_id, db))


@app.post("/api/programs", response_model=Program, status_code=201)
def create_program(
    payload: ProgramInput, db: Session = Depends(get_db)
) -> dict:
    taken = set(db.scalars(select(ProgramRow.id)))
    program_id = programs.new_program_id(payload.name, taken)
    # Create always mints fresh ids: a new routine (even one duplicated from an
    # existing program) must not reuse another program's exercise ids, or logs
    # would cross-link. Editing (PUT) is where ids are preserved.
    fresh_days = []
    for d in payload.days:
        day = d.model_dump()
        day["id"] = None
        day["exercises"] = [{**e, "id": None} for e in day["exercises"]]
        fresh_days.append(day)
    days = programs.assign_ids(program_id, fresh_days)
    next_order = (db.scalar(select(func.max(ProgramRow.sort_order))) or 0) + 1
    row = ProgramRow(
        id=program_id,
        name=payload.name,
        subtitle=payload.subtitle,
        origin="custom",
        days=days,
        sort_order=next_order,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _program_detail(row)


@app.put("/api/programs/{program_id}", response_model=Program)
def update_program(
    program_id: str, payload: ProgramInput, db: Session = Depends(get_db)
) -> dict:
    row = _get_program_row(program_id, db)
    row.name = payload.name
    row.subtitle = payload.subtitle
    row.days = programs.assign_ids(
        program_id, [d.model_dump() for d in payload.days]
    )
    db.commit()
    db.refresh(row)
    return _program_detail(row)


@app.delete("/api/programs/{program_id}", status_code=204)
def delete_program(program_id: str, db: Session = Depends(get_db)) -> None:
    row = _get_program_row(program_id, db)
    if row.origin == "seed":
        raise HTTPException(
            status_code=409,
            detail="Original programs can't be deleted — reset it instead.",
        )
    db.delete(row)
    db.commit()


@app.post("/api/programs/{program_id}/reset", response_model=Program)
def reset_program(program_id: str, db: Session = Depends(get_db)) -> dict:
    row = _get_program_row(program_id, db)
    original = programs.original_program(program_id)
    if row.origin != "seed" or original is None:
        raise HTTPException(
            status_code=409, detail="Only original programs can be reset."
        )
    row.name = original["name"]
    row.subtitle = original.get("subtitle", "")
    row.days = original["days"]
    db.commit()
    db.refresh(row)
    return _program_detail(row)


# --- Set logging -----------------------------------------------------------
@app.post("/api/logs", response_model=SetLogOut, status_code=201)
def create_log(payload: SetLogCreate, db: Session = Depends(get_db)) -> SetLogOut:
    data = payload.model_dump(exclude_none=True)
    log = SetLog(**data)
    db.add(log)
    db.commit()
    db.refresh(log)
    return SetLogOut.model_validate(log)


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
    return [SetLogOut.model_validate(log) for log in db.scalars(stmt)]


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
    latest = logs[0]
    return ExerciseStats(
        exercise_id=exercise_id,
        total_sets=len(logs),
        best_weight=max(weights) if weights else None,
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
