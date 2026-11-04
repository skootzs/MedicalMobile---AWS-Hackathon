"""Evaluate one provisional LogicModel using typed synthetic inputs.

This implementation returns a trace for review. It is not an approval gate:
the checker, compiler comparison, and qualified clinical review are required.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from packages.schema.validate import validate_logic_model
from packages.evaluator.condition_evaluator import evaluate_condition


def evaluate_logic_model(model: dict[str, Any], answers: dict[str, Any], as_of: date) -> dict[str, Any]:
    """Evaluate a model. `as_of` is explicit so follow-up dates are reproducible."""
    validate_logic_model(model)
    if not isinstance(answers, dict) or type(as_of) is not date:
        raise ValueError("answers must be a dictionary and as_of must be a date")

    types: dict[str, str] = {}
    options: dict[str, set[str]] = {}
    known_inputs: set[str] = set()

    def add_field(field_id: str, kind: str, *, is_input: bool) -> None:
        if field_id in types:
            raise ValueError(f"Duplicate field ID: {field_id}")
        types[field_id] = kind
        if is_input:
            known_inputs.add(field_id)

    def check_condition(condition: dict[str, Any]) -> None:
        # With empty answers, this still checks every operator, reference,
        # literal and option against the fields currently in scope.
        evaluate_condition(condition, {}, types, options)

    source_ids = [source["id"] for source in model["sources"]]
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("Duplicate source ID")
    source_id_set = set(source_ids)
    def check_source(source: Any) -> None:
        if source is not None and source["sourceId"] not in source_id_set:
            raise ValueError(f"Unknown source ID: {source['sourceId']}")

    for context in model["context"]:
        add_field(context["id"], "context_integer", is_input=True)
    applicability = model.get("applicability")
    if applicability is not None:
        check_condition(applicability["when"])
        check_source(applicability.get("source"))

    pages = model.get("pages")
    page_ids = [page["id"] for page in pages] if pages is not None else []
    if len(page_ids) != len(set(page_ids)):
        raise ValueError("Duplicate page ID")
    for question in model["questions"]:
        if pages is not None and question.get("page") not in page_ids:
            raise ValueError(f"Question {question['id']} has no declared page")
        if pages is None and "page" in question:
            raise ValueError("A question names a page but no pages were declared")
        if "relevantWhen" in question:
            check_condition(question["relevantWhen"])
        check_source(question.get("source"))
        if "min" in question and "max" in question and question["min"] > question["max"]:
            raise ValueError(f"Question {question['id']} has min greater than max")
        if question["type"] == "select_one":
            option_ids = [option["id"] for option in question["options"]]
            if len(option_ids) != len(set(option_ids)):
                raise ValueError(f"Duplicate option in {question['id']}")
            options[question["id"]] = set(option_ids)
        add_field(question["id"], question["type"], is_input=True)

    for derived in model["derived"]:
        check_condition(derived["when"])
        check_source(derived.get("source"))
        add_field(derived["id"], "derived_boolean", is_input=False)

    outcomes = {outcome["id"]: outcome for outcome in model["outcomes"]}
    if len(outcomes) != len(model["outcomes"]):
        raise ValueError("Duplicate outcome ID")
    table = model["decisionTables"][0]
    for row in table["rows"]:
        check_condition(row["when"])
        check_source(row.get("source"))
        if row["outcome"] not in outcomes:
            raise ValueError(f"Unknown outcome: {row['outcome']}")
    required_outcomes = [table["otherwise"]]
    if applicability:
        required_outcomes.extend([applicability["notApplicableOutcome"], applicability["unknownOutcome"]])
    if any(outcome not in outcomes for outcome in required_outcomes):
        raise ValueError("Applicability or otherwise refers to an unknown outcome")
    ambiguity_ids = [ambiguity["id"] for ambiguity in model["ambiguities"]]
    if len(ambiguity_ids) != len(set(ambiguity_ids)):
        raise ValueError("Duplicate ambiguity ID")
    for ambiguity in model["ambiguities"]:
        check_source(ambiguity.get("sourceRef"))
        if ambiguity["status"] == "open" and ambiguity["blocking"]:
            raise ValueError(f"Open blocking ambiguity: {ambiguity['id']}")

    unknown_inputs = set(answers) - known_inputs
    if unknown_inputs:
        raise ValueError(f"Unknown or derived input fields: {sorted(unknown_inputs)}")

    values = {field_id: answers.get(field_id) for field_id in known_inputs}
    for field_id in known_inputs:
        evaluate_condition({"answered": field_id}, values, types, options)
    question_trace: list[dict[str, Any]] = []
    derived_trace: list[dict[str, Any]] = []
    row_trace: list[dict[str, Any]] = []
    applicability_trace = None
    chosen_outcome = None

    if applicability:
        applicability_trace = evaluate_condition(applicability["when"], values, types, options)
        if applicability_trace["result"] == "false":
            chosen_outcome = applicability["notApplicableOutcome"]
        elif applicability_trace["result"] == "unknown":
            chosen_outcome = applicability["unknownOutcome"]

    if chosen_outcome is None:
        for question in model["questions"]:
            relevance = evaluate_condition(question["relevantWhen"], values, types, options) if "relevantWhen" in question else None
            is_visible = relevance is None or relevance["result"] == "true"
            value = values[question["id"]]
            if not is_visible and value is not None and value != "":
                raise ValueError(f"Answer supplied for non-visible question: {question['id']}")
            if is_visible and value is not None and value != "":
                # `answered` validates the answer's type and select-one option.
                evaluate_condition({"answered": question["id"]}, values, types, options)
                if "min" in question and value < question["min"]:
                    raise ValueError(f"Answer below minimum: {question['id']}")
                if "max" in question and value > question["max"]:
                    raise ValueError(f"Answer above maximum: {question['id']}")
            question_trace.append({"id": question["id"], "visible": is_visible, "relevance": relevance})

        for derived in model["derived"]:
            result = evaluate_condition(derived["when"], values, types, options)
            values[derived["id"]] = {"true": True, "false": False, "unknown": None}[result["result"]]
            derived_trace.append({"id": derived["id"], "condition": result})

        matches = []
        for index, row in enumerate(table["rows"]):
            result = evaluate_condition(row["when"], values, types, options)
            row_trace.append({"index": index, "outcome": row["outcome"], "condition": result})
            if result["result"] == "true":
                matches.append(row["outcome"])
        if table["hitPolicy"] == "unique" and len(matches) > 1:
            raise ValueError("Unique decision table has multiple matching rows")
        chosen_outcome = matches[0] if matches else table["otherwise"]

    outcome = outcomes[chosen_outcome]
    follow_up_days = outcome.get("followUp", {}).get("afterDays")
    return {
        "outcomeId": chosen_outcome,
        "outcome": outcome,
        "followUpDate": (as_of + timedelta(days=follow_up_days)).isoformat() if follow_up_days is not None else None,
        "trace": {"applicability": applicability_trace, "questions": question_trace, "derived": derived_trace, "rows": row_trace},
    }
