"""Database models: the program catalogue and the set log."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Program(Base):
    """A workout routine, stored as a JSON document.

    `days` mirrors the shape the frontend consumes: a list of
    ``{"id", "label", "title", "exercises": [{"id", "name", "category",
    "sets", "reps", "weight", "notes"}]}``. Keeping it as a document (rather
    than normalized tables) matches how the client reads programs and means a
    log's ``exercise_id`` string is the only link back to an exercise — no
    foreign keys to migrate.
    """

    __tablename__ = "programs"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    subtitle: Mapped[str] = mapped_column(String(300), default="")

    # "seed" = imported from programs.json (editable, but not deletable and
    # resettable to the original); "custom" = user-built (editable + deletable).
    origin: Mapped[str] = mapped_column(String(16), default="custom")

    days: Mapped[list] = mapped_column(JSON, default=list)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class SetLog(Base):
    __tablename__ = "set_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Which program / day / exercise this set belongs to. These match the ids
    # in app/data/programs.json so the frontend can join logs back to exercises.
    program_id: Mapped[str] = mapped_column(String(64), index=True)
    day_id: Mapped[str] = mapped_column(String(96), index=True)
    exercise_id: Mapped[str] = mapped_column(String(160), index=True)
    exercise_name: Mapped[str] = mapped_column(String(200))

    # weight is nullable so bodyweight moves (pull-ups, dips, holds) can be logged.
    weight: Mapped[float | None] = mapped_column(Float, nullable=True)
    reps: Mapped[int] = mapped_column(Integer)
    notes: Mapped[str] = mapped_column(Text, default="")

    performed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, index=True
    )
