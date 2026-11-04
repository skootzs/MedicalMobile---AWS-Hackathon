"""Runtime entry point for the provisional shared LogicModel JSON Schema.

This checks JSON structure only. Evaluator/checker validation and human review
are required before any clinical content can be approved or compiled.
"""

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator


SCHEMA_PATH = Path(__file__).parent / "src" / "logic-model.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
Draft7Validator.check_schema(SCHEMA)
VALIDATOR = Draft7Validator(SCHEMA)


def validate_logic_model(value: Any) -> dict[str, Any]:
    """Return a structurally valid model, or raise ValueError with its path."""
    errors = list(VALIDATOR.iter_errors(value))
    if errors:
        first = errors[0]
        path = "$" + "".join(
            f"[{part}]" if isinstance(part, int) else f".{part}"
            for part in first.absolute_path
        )
        raise ValueError(f"LogicModel validation failed at {path}: {first.message}")
    return value
