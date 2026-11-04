"""Conservative model checks and comparisons with independently supplied cases.

The exhaustive analysis here only supports a small bounded input space. It
returns inconclusive for unsupported domains or when the limit is exceeded.
It cannot establish clinical correctness, author identity, or source quality.
"""

from __future__ import annotations

import itertools
from datetime import date
from typing import Any

from packages.evaluator.evaluate import evaluate_logic_model
from packages.schema.validate import validate_logic_model


def _finite_domains(model: dict[str, Any], max_combinations: int) -> tuple[list[tuple[str, list[Any]]], str | None]:
    """Return complete supported input domains, or explain why proof is unavailable."""
    if model["context"]:
        return [], "Context fields have no finite declared domain in LogicModel v1."
    if any("relevantWhen" in question for question in model["questions"]):
        return [], "Question relevance and hidden-value behavior require further verification."
    domains: list[tuple[str, list[Any]]] = []
    count = 1
    for question in model["questions"]:
        kind = question["type"]
        if kind == "boolean":
            values = [None, False, True]
        elif kind == "select_one":
            values = [None, *[option["id"] for option in question["options"]]]
        elif kind == "integer" and "min" in question and "max" in question:
            size = question["max"] - question["min"] + 2  # plus missing
            if size <= 0 or size > max_combinations:
                return [], f"Integer domain for {question['id']} exceeds the analysis limit."
            values = [None, *range(question["min"], question["max"] + 1)]
        else:
            return [], f"No supported finite domain for {question['id']} ({kind})."
        count *= len(values)
        if count > max_combinations:
            return [], f"Input space exceeds the {max_combinations} combination limit."
        domains.append((question["id"], values))
    return domains, None


def check_logic_model(
    model: dict[str, Any],
    golden_cases: list[dict[str, Any]],
    as_of: date,
    max_combinations: int = 10000,
) -> dict[str, Any]:
    """Return checks and evidence; no model can self-approve through this API.

    Each golden case supplies `id`, `answers`, and `expectedOutcome` written
    separately from the evaluator. Reviewer identity and source approval must be
    verified by the surrounding workflow, not inferred from these fields.
    """
    if not isinstance(golden_cases, list) or type(as_of) is not date:
        raise ValueError("golden_cases must be a list and as_of must be a date")
    if not isinstance(max_combinations, int) or isinstance(max_combinations, bool) or max_combinations < 1:
        raise ValueError("max_combinations must be a positive integer")

    report: dict[str, Any] = {
        "status": "inconclusive",
        "structure": {"status": "pass"},
        "goldenCases": {"status": "inconclusive", "results": []},
        "overlap": {"status": "inconclusive"},
        "reachability": {"status": "inconclusive"},
        "coverage": {"status": "inconclusive", "reason": "Clinical completeness requires guideline-derived evidence and review."},
    }
    try:
        validate_logic_model(model)
        # The evaluator's preflight validates references and blocking issues,
        # even when no actual answers have been entered.
        evaluate_logic_model(model, {}, as_of)
    except (ValueError, TypeError, KeyError) as exc:
        report["structure"] = {"status": "fail", "reason": str(exc)}
        report["status"] = "fail"
        return report

    results = []
    for case in golden_cases:
        if not isinstance(case, dict) or not isinstance(case.get("id"), str) or not isinstance(case.get("answers"), dict) or not isinstance(case.get("expectedOutcome"), str):
            results.append({"id": case.get("id", "<missing>") if isinstance(case, dict) else "<invalid>", "status": "fail", "reason": "Case needs id, answers, and expectedOutcome."})
            continue
        try:
            actual = evaluate_logic_model(model, case["answers"], as_of)["outcomeId"]
            results.append({"id": case["id"], "status": "pass" if actual == case["expectedOutcome"] else "fail", "expectedOutcome": case["expectedOutcome"], "actualOutcome": actual})
        except (ValueError, TypeError, KeyError) as exc:
            results.append({"id": case["id"], "status": "fail", "reason": str(exc)})
    report["goldenCases"] = {
        "status": "inconclusive" if not results else "fail" if any(item["status"] == "fail" for item in results) else "pass",
        "independentReviewVerified": False,
        "note": "Results compare supplied expectations only; source and reviewer approval must be verified separately.",
        "results": results,
    }

    domains, limitation = _finite_domains(model, max_combinations)
    if limitation:
        report["overlap"] = {"status": "inconclusive", "reason": limitation}
        report["reachability"] = {"status": "inconclusive", "reason": limitation}
    else:
        row_count = len(model["decisionTables"][0]["rows"])
        reached_rows: set[int] = set()
        fallback_witness = None
        overlap_witness = None
        checked = 0
        for combination in itertools.product(*(values for _, values in domains)):
            inputs = dict(zip((field for field, _ in domains), combination))
            checked += 1
            try:
                evaluation = evaluate_logic_model(model, inputs, as_of)
            except ValueError as exc:
                if "multiple matching rows" in str(exc):
                    overlap_witness = inputs
                    break
                report["overlap"] = {"status": "inconclusive", "reason": f"Could not evaluate all inputs: {exc}"}
                report["reachability"] = {"status": "inconclusive", "reason": f"Could not evaluate all inputs: {exc}"}
                break
            matched = [row["index"] for row in evaluation["trace"]["rows"] if row["condition"]["result"] == "true"]
            if len(matched) > 1:
                overlap_witness = inputs
                break
            if matched:
                reached_rows.add(matched[0])
            elif fallback_witness is None:
                fallback_witness = inputs
        else:
            report["overlap"] = {"status": "pass", "checkedCombinations": checked}
            report["reachability"] = {
                "status": "pass" if len(reached_rows) == row_count else "fail",
                "unreachableRowIndexes": sorted(set(range(row_count)) - reached_rows),
                "checkedCombinations": checked,
            }
            report["coverage"]["fallbackWitness"] = fallback_witness
        if overlap_witness is not None:
            if model["decisionTables"][0]["hitPolicy"] == "unique":
                report["overlap"] = {"status": "fail", "witness": overlap_witness, "checkedCombinations": checked}
            else:
                report["overlap"] = {"status": "inconclusive", "reason": "First-hit overlap needs review of priority semantics.", "witness": overlap_witness, "checkedCombinations": checked}
            report["reachability"] = {"status": "inconclusive", "reason": "Enumeration stopped at an overlap."}

    checks = [report[name]["status"] for name in ("structure", "goldenCases", "overlap", "reachability", "coverage")]
    report["status"] = "fail" if "fail" in checks else "inconclusive" if "inconclusive" in checks else "pass"
    return report
