"""Load and index the static program catalogue from programs.json."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

DATA_PATH = Path(__file__).parent / "data" / "programs.json"


@lru_cache(maxsize=1)
def _load() -> dict:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def all_programs() -> list[dict]:
    return _load()["programs"]


def get_program(program_id: str) -> dict | None:
    for program in all_programs():
        if program["id"] == program_id:
            return program
    return None
