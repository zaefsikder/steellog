"""Pydantic request/response models for the API."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# --- Program catalogue (static, from programs.json) ------------------------
class Exercise(BaseModel):
    id: str
    name: str
    category: str = ""
    sets: str = ""
    reps: str = ""
    weight: str = ""
    notes: str = ""


class Day(BaseModel):
    id: str
    label: str
    title: str
    exercises: list[Exercise]


class ProgramSummary(BaseModel):
    id: str
    name: str
    subtitle: str
    day_count: int
    exercise_count: int


class Program(BaseModel):
    id: str
    name: str
    subtitle: str
    days: list[Day]


# --- Set logging -----------------------------------------------------------
class SetLogCreate(BaseModel):
    program_id: str
    day_id: str
    exercise_id: str
    exercise_name: str
    weight: float | None = None
    reps: int = Field(ge=0)
    notes: str = ""
    performed_at: datetime | None = None


class SetLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    program_id: str
    day_id: str
    exercise_id: str
    exercise_name: str
    weight: float | None
    reps: int
    notes: str
    performed_at: datetime
    est_1rm: float | None = None


class ExerciseStats(BaseModel):
    exercise_id: str
    total_sets: int
    best_weight: float | None = None
    best_est_1rm: float | None = None
    last_performed_at: datetime | None = None
    last_weight: float | None = None
    last_reps: int | None = None
