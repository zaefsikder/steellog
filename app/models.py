"""Database models. A single table logs every set performed."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


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
