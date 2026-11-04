#!/usr/bin/env python3
"""Bridge to R4's evaluator: evaluate a batch of cases against a logic model.

Usage:
  python3 expected.py --model <logic.json> --cases <cases.json> --as-of YYYY-MM-DD

<cases.json> is a JSON array of {"id": str, "answers": {<input id>: value}}; a
key omitted from answers means "unanswered". Prints a JSON array on stdout, one
result per case, in input order:

  {id, ok:true, outcomeId, referral, followUpDays, followUpDate,
   matchedRows:[row index whose condition is "true"], appliedOtherwise:bool}
  {id, ok:false, error:"<ExceptionType>: <message>"}

One bad case never aborts the others.

Evaluator root resolution (ONE root prepended to sys.path), in order:
  1. EVALUATOR_ROOT env;
  2. the repo's packages/ (../../packages/evaluator/evaluate.py relative to
     packages/verification), i.e. R4's code after merge;
  3. the vendored copy at vendor/r4.
The chosen root must contain the five required files; otherwise fall through.
If none works, exit 2. Python < 3.10 or missing jsonschema also exits 2.
"""
import argparse
import json
import os
import sys
from datetime import date

REQUIRED_FILES = [
    "packages/schema/validate.py",
    "packages/schema/src/logic-model.schema.json",
    "packages/evaluator/evaluate.py",
    "packages/evaluator/condition_evaluator.py",
    "packages/checker/check_model.py",
]


def die(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.exit(2)


def root_has_required(root: str) -> bool:
    return all(os.path.isfile(os.path.join(root, f)) for f in REQUIRED_FILES)


def resolve_root() -> "tuple[str, str]":
    """Return (root, source). source in env|repo|vendored-zip-unpinned."""
    here = os.path.dirname(os.path.abspath(__file__))  # packages/verification/python
    verification = os.path.dirname(here)  # packages/verification
    candidates = []
    env_root = os.environ.get("EVALUATOR_ROOT")
    if env_root:
        candidates.append((env_root, "env"))
    # repo packages/ : ../../packages relative to packages/verification -> repo root's packages
    repo_packages_parent = os.path.dirname(os.path.dirname(verification))  # repo root
    candidates.append((repo_packages_parent, "repo"))
    candidates.append((os.path.join(verification, "vendor", "r4"), "vendored-zip-unpinned"))
    for root, source in candidates:
        if root_has_required(root):
            return root, source
    die(
        "could not resolve an evaluator root with the five required files "
        "(tried EVALUATOR_ROOT, repo packages/, vendor/r4)"
    )


def main() -> None:
    if sys.version_info < (3, 10):
        die(f"Python 3.10+ required; found {sys.version.split()[0]}")

    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--cases", required=True)
    ap.add_argument("--as-of", required=True)
    args = ap.parse_args()

    root, source = resolve_root()
    sys.path.insert(0, root)

    try:
        import jsonschema  # noqa: F401
    except Exception as e:  # noqa: BLE001
        die(f"jsonschema is required but not importable: {type(e).__name__}: {e}")

    try:
        from importlib.metadata import version as _pkg_version
        jsonschema_version = _pkg_version("jsonschema")
    except Exception:  # noqa: BLE001
        jsonschema_version = "unknown"
    python_version = "%d.%d.%d" % sys.version_info[:3]

    try:
        from packages.evaluator.evaluate import evaluate_logic_model
    except Exception as e:  # noqa: BLE001
        die(f"could not import evaluator from {root}: {type(e).__name__}: {e}")

    with open(args.model) as f:
        model = json.load(f)
    with open(args.cases) as f:
        cases = json.load(f)
    y, m, d = (int(x) for x in args.as_of.split("-"))
    as_of = date(y, m, d)

    outcomes = {o["id"]: o for o in model.get("outcomes", [])}

    results = []
    for case in cases:
        cid = case.get("id")
        answers = case.get("answers", {})
        try:
            r = evaluate_logic_model(model, answers, as_of)
            outcome_id = r["outcomeId"]
            outcome = outcomes.get(outcome_id, r.get("outcome", {}))
            rows = r.get("trace", {}).get("rows", [])
            matched = [
                row.get("index", i)
                for i, row in enumerate(rows)
                if row.get("condition", {}).get("result") == "true"
            ]
            applied_otherwise = len(matched) == 0
            results.append({
                "id": cid,
                "ok": True,
                "outcomeId": outcome_id,
                "referral": outcome.get("referral", "none"),
                "followUpDays": outcome.get("followUp", {}).get("afterDays"),
                "followUpDate": r.get("followUpDate"),
                "matchedRows": matched,
                "appliedOtherwise": applied_otherwise,
            })
        except Exception as e:  # noqa: BLE001
            results.append({"id": cid, "ok": False, "error": f"{type(e).__name__}: {e}"})

    # Emit a wrapper with resolution metadata on stderr so the caller can record
    # it, and the results array on stdout.
    sys.stderr.write(
        json.dumps({
            "evaluatorRoot": root,
            "evaluatorSource": source,
            "pythonVersion": python_version,
            "jsonschemaVersion": jsonschema_version,
        })
        + "\n"
    )
    sys.stdout.write(json.dumps(results))


if __name__ == "__main__":
    main()
