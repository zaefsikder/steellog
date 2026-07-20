"""FastAPI application: serves the workout catalogue, the set-logging API,
and (optionally) the static frontend from a single origin.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import programs
from app.auth import User, current_user
from app.config import CORS_ORIGINS, OWNER_EMAIL
from app.database import Base, engine, get_db
from app.models import PlannedDay
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables on boot. For this small schema this is simpler than
    # wiring up migrations; swap in Alembic later if the schema grows.
    Base.metadata.create_all(bind=engine)
    yield


def _maybe_seed_owner(user: User, db: Session) -> None:
    """Seed the two starter programs into the owner account's first visit.

    Only the account whose email matches OWNER_EMAIL gets them, and only if it
    has no programs yet. Every other account starts empty.
    """
    if not OWNER_EMAIL or user.email != OWNER_EMAIL:
        return
    has_any = db.scalar(
        select(func.count())
        .select_from(ProgramRow)
        .where(ProgramRow.user_id == user.id)
    )
    if has_any:
        return
    for order, doc in enumerate(programs.seed_programs()):
        db.add(
            ProgramRow(
                user_id=user.id,
                id=doc["id"],
                name=doc["name"],
                subtitle=doc.get("subtitle", ""),
                origin="seed",
                days=doc["days"],
                sort_order=order,
            )
        )
    db.commit()


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


def _get_program_row(user: User, program_id: str, db: Session) -> ProgramRow:
    row = db.get(ProgramRow, (user.id, program_id))
    if row is None:
        raise HTTPException(status_code=404, detail="Program not found")
    return row


@app.get("/api/me")
def me(user: User = Depends(current_user)) -> dict:
    return {"id": user.id, "email": user.email}


@app.get("/api/programs", response_model=list[ProgramSummary])
def list_programs(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[ProgramSummary]:
    _maybe_seed_owner(user, db)
    rows = db.scalars(
        select(ProgramRow)
        .where(ProgramRow.user_id == user.id)
        .order_by(ProgramRow.sort_order, ProgramRow.created_at)
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
def get_program(
    program_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    return _program_detail(_get_program_row(user, program_id, db))


@app.post("/api/programs", response_model=Program, status_code=201)
def create_program(
    payload: ProgramInput,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    taken = set(
        db.scalars(select(ProgramRow.id).where(ProgramRow.user_id == user.id))
    )
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
    next_order = (
        db.scalar(
            select(func.max(ProgramRow.sort_order)).where(
                ProgramRow.user_id == user.id
            )
        )
        or 0
    ) + 1
    row = ProgramRow(
        user_id=user.id,
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
    program_id: str,
    payload: ProgramInput,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    row = _get_program_row(user, program_id, db)
    row.name = payload.name
    row.subtitle = payload.subtitle
    row.days = programs.assign_ids(
        program_id, [d.model_dump() for d in payload.days]
    )
    db.commit()
    db.refresh(row)
    return _program_detail(row)


@app.delete("/api/programs/{program_id}", status_code=204)
def delete_program(
    program_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    row = _get_program_row(user, program_id, db)
    if row.origin == "seed":
        raise HTTPException(
            status_code=409,
            detail="Original programs can't be deleted — reset it instead.",
        )
    db.delete(row)
    db.commit()


@app.post("/api/programs/{program_id}/reset", response_model=Program)
def reset_program(
    program_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    row = _get_program_row(user, program_id, db)
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
def create_log(
    payload: SetLogCreate,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> SetLogOut:
    data = payload.model_dump(exclude_none=True)
    log = SetLog(**data, user_id=user.id)
    db.add(log)
    db.commit()
    db.refresh(log)
    return SetLogOut.model_validate(log)


@app.get("/api/logs", response_model=list[SetLogOut])
def list_logs(
    exercise_id: str | None = Query(default=None),
    program_id: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[SetLogOut]:
    stmt = select(SetLog).where(SetLog.user_id == user.id)
    if exercise_id:
        stmt = stmt.where(SetLog.exercise_id == exercise_id)
    if program_id:
        stmt = stmt.where(SetLog.program_id == program_id)
    stmt = stmt.order_by(SetLog.performed_at.desc()).limit(limit)
    return [SetLogOut.model_validate(log) for log in db.scalars(stmt)]


@app.delete("/api/logs/{log_id}", status_code=204)
def delete_log(
    log_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    log = db.get(SetLog, log_id)
    if log is None or log.user_id != user.id:
        raise HTTPException(status_code=404, detail="Log not found")
    db.delete(log)
    db.commit()


@app.get("/api/exercises/{exercise_id}/stats", response_model=ExerciseStats)
def exercise_stats(
    exercise_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> ExerciseStats:
    logs = list(
        db.scalars(
            select(SetLog)
            .where(SetLog.user_id == user.id, SetLog.exercise_id == exercise_id)
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


# --- Planned training days (calendar) --------------------------------------
@app.get("/api/plans", response_model=list[date])
def list_plans(
    user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[date]:
    return list(
        db.scalars(
            select(PlannedDay.day)
            .where(PlannedDay.user_id == user.id)
            .order_by(PlannedDay.day)
        )
    )


@app.put("/api/plans/{day}", status_code=204)
def add_plan(
    day: date,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    # Idempotent: marking an already-planned day is a no-op.
    if db.get(PlannedDay, (user.id, day)) is None:
        db.add(PlannedDay(user_id=user.id, day=day))
        db.commit()


@app.delete("/api/plans/{day}", status_code=204)
def remove_plan(
    day: date,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> None:
    row = db.get(PlannedDay, (user.id, day))
    if row is not None:
        db.delete(row)
        db.commit()


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
