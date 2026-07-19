"""The seed program catalogue (programs.json) plus ID helpers for the builder.

programs.json remains the immutable source for the two original programs: it is
used to seed the database on first run and to reset a seed program back to its
original form. User-built and edited programs live in the ``programs`` table.
"""

from __future__ import annotations

import json
import re
import secrets
import unicodedata
from copy import deepcopy
from functools import lru_cache
from pathlib import Path

DATA_PATH = Path(__file__).parent / "data" / "programs.json"


@lru_cache(maxsize=1)
def _load() -> dict:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def seed_programs() -> list[dict]:
    """Fresh deep copies of the original programs, in catalogue order."""
    return deepcopy(_load()["programs"])


def original_program(program_id: str) -> dict | None:
    """The pristine seed document for one program id (for reset), or None."""
    for program in _load()["programs"]:
        if program["id"] == program_id:
            return deepcopy(program)
    return None


def slugify(*parts: str) -> str:
    text = " ".join(p for p in parts if p)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = text.lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text or "item"


def new_program_id(name: str, taken: set[str]) -> str:
    """A unique program id: slug of the name plus a short random suffix."""
    base = slugify(name) or "routine"
    pid = f"{base}-{secrets.token_hex(3)}"
    while pid in taken:
        pid = f"{base}-{secrets.token_hex(3)}"
    return pid


def assign_ids(program_id: str, days: list[dict]) -> list[dict]:
    """Ensure every day and exercise has a stable, unique id within the program.

    Existing ids are preserved (so logged history stays attached even when an
    exercise is renamed); items without an id get a fresh one.
    """
    seen: set[str] = set()

    def unique(base: str) -> str:
        """Return `base` if free, else `base` with a short suffix; reserve it."""
        candidate = base
        while candidate in seen:
            candidate = f"{base}-{secrets.token_hex(2)}"
        seen.add(candidate)
        return candidate

    out: list[dict] = []
    for day in days:
        day = dict(day)
        day["id"] = unique(day.get("id") or f"{program_id}-{slugify(day.get('label', 'day'))}")
        exercises = []
        for ex in day.get("exercises", []):
            ex = dict(ex)
            ex["id"] = unique(ex.get("id") or f"{day['id']}-{slugify(ex.get('name', 'exercise'))}")
            exercises.append(ex)
        day["exercises"] = exercises
        out.append(day)
    return out
