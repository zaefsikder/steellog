"""Pydantic request/response models for the API."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# --- Program catalogue -----------------------------------------------------
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
    origin: str
    day_count: int
    exercise_count: int


class Program(BaseModel):
    id: str
    name: str
    subtitle: str
    origin: str
    days: list[Day]


# --- Builder (create / edit routines) --------------------------------------
# On input, day/exercise ids are optional: existing items keep their id (so
# logged history stays attached), new items get one assigned by the server.
class ExerciseIn(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1)
    category: str = ""
    sets: str = ""
    reps: str = ""
    weight: str = ""
    notes: str = ""


class DayIn(BaseModel):
    id: str | None = None
    label: str = Field(min_length=1)
    title: str = ""
    exercises: list[ExerciseIn] = Field(default_factory=list)


class ProgramInput(BaseModel):
    name: str = Field(min_length=1)
    subtitle: str = ""
    days: list[DayIn] = Field(default_factory=list)


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


class ExerciseStats(BaseModel):
    exercise_id: str
    total_sets: int
    best_weight: float | None = None
    last_performed_at: datetime | None = None
    last_weight: float | None = None
    last_reps: int | None = None
