"""Evaluate provisional LogicModel conditions using three-valued logic.

This evaluates conditions only. It does not select a clinical outcome, evaluate
an entire decision table, validate a full LogicModel, or approve a guideline.
The compiler's exact field and value representations must be agreed before
integration. Inputs should contain synthetic examples, not real patient data.
"""

from __future__ import annotations

import math
import operator
from typing import Any


TRUE = "true"
FALSE = "false"
UNKNOWN = "unknown"
_KINDS = {"boolean", "integer", "decimal", "select_one", "context_integer", "derived_boolean"}
_COMPARISONS = {
    "eq": operator.eq,
    "neq": operator.ne,
    "lt": operator.lt,
    "lte": operator.le,
    "gt": operator.gt,
    "gte": operator.ge,
}


def _is_missing(value: Any) -> bool:
    """None or an empty string represents an unanswered value in this draft."""
    return value is None or value == ""


def _check_value(value: Any, kind: str) -> None:
    """Require a typed value; Python bool must never count as a number."""
    if kind in {"boolean", "derived_boolean"}:
        valid = isinstance(value, bool)
    elif kind in {"integer", "context_integer"}:
        valid = isinstance(value, int) and not isinstance(value, bool)
    elif kind == "decimal":
        valid = isinstance(value, (int, float)) and not isinstance(value, bool)
        valid = valid and math.isfinite(value)
    elif kind == "select_one":
        valid = isinstance(value, str) and bool(value)
    else:
        raise ValueError(f"Unsupported field type: {kind!r}")
    if not valid:
        raise ValueError(f"Value {value!r} is invalid for field type {kind!r}")


def evaluate_condition(
    condition: dict[str, Any],
    answers: dict[str, Any],
    field_types: dict[str, str],
    field_options: dict[str, set[str]] | None = None,
) -> dict[str, Any]:
    """Return the condition's truth value and a trace of its child results.

    `answers` uses typed values: booleans are True/False, numbers are int/float,
    and select-one answers are option IDs. Missing fields, None, and empty
    strings are unknown for comparisons. The special `answered` condition is
    false for missing values and true for present valid values.
    """
    if not isinstance(condition, dict) or len(condition) != 1:
        raise ValueError("A condition must be an object with exactly one operator")
    if not isinstance(answers, dict) or not isinstance(field_types, dict):
        raise ValueError("answers and field_types must be objects")
    operator, operand = next(iter(condition.items()))

    if operator in {"and", "or"}:
        if not isinstance(operand, list) or not operand:
            raise ValueError(f"{operator} requires a non-empty list of conditions")
        # Evaluate all children so unsupported rules cannot hide behind a
        # short-circuit. The trace also shows every child result.
        children = [evaluate_condition(child, answers, field_types, field_options) for child in operand]
        values = [child["result"] for child in children]
        if operator == "and":
            result = FALSE if FALSE in values else UNKNOWN if UNKNOWN in values else TRUE
        else:
            result = TRUE if TRUE in values else UNKNOWN if UNKNOWN in values else FALSE
        return {"operator": operator, "result": result, "children": children}

    if operator == "not":
        child = evaluate_condition(operand, answers, field_types, field_options)
        result = {TRUE: FALSE, FALSE: TRUE, UNKNOWN: UNKNOWN}[child["result"]]
        return {"operator": operator, "result": result, "children": [child]}

    if operator == "answered":
        if not isinstance(operand, str) or not operand:
            raise ValueError("answered requires a field ID")
        kind = field_types.get(operand)
        if kind not in _KINDS:
            raise ValueError(f"Unknown field or unsupported type: {operand!r}")
        if kind == "derived_boolean":
            raise ValueError("answered applies to questions and context, not derived values")
        value = answers.get(operand)
        if _is_missing(value):
            result = FALSE
        else:
            _check_value(value, kind)
            if kind == "select_one" and (not field_options or value not in field_options.get(operand, set())):
                raise ValueError(f"Unknown option for field {operand!r}")
            result = TRUE
        return {"operator": operator, "field": operand, "result": result}

    if operator not in _COMPARISONS:
        raise ValueError(f"Unsupported condition operator: {operator!r}")
    if not isinstance(operand, list) or len(operand) != 2:
        raise ValueError(f"{operator} requires [field ID, literal]")
    field_id, literal = operand
    if not isinstance(field_id, str) or not field_id:
        raise ValueError("Comparison field ID must be non-empty text")
    kind = field_types.get(field_id)
    if kind not in _KINDS:
        raise ValueError(f"Unknown field or unsupported type: {field_id!r}")
    if operator in {"lt", "lte", "gt", "gte"} and kind not in {"integer", "decimal", "context_integer"}:
        raise ValueError(f"{operator} requires a numeric field")
    # The compiler permits numeric literals for numeric fields, even when the
    # field itself stores whole numbers. The answer is checked separately.
    literal_kind = "decimal" if kind in {"integer", "context_integer"} else kind
    _check_value(literal, literal_kind)
    if kind == "select_one" and (not field_options or literal not in field_options.get(field_id, set())):
        raise ValueError(f"Unknown option for field {field_id!r}")

    actual = answers.get(field_id)
    if _is_missing(actual):
        result = UNKNOWN
    else:
        _check_value(actual, kind)
        if kind == "select_one" and (not field_options or actual not in field_options.get(field_id, set())):
            raise ValueError(f"Unknown option for field {field_id!r}")
        result = TRUE if _COMPARISONS[operator](actual, literal) else FALSE
    return {"operator": operator, "field": field_id, "result": result}
